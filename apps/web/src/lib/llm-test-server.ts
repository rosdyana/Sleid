// A small fake OpenAI-compatible server for the web tests. The reply for each request comes from
// a queue. A stream request gets SSE frames, and anything else gets a chat/completions JSON body.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SeenRequest {
  url: string
  headers: IncomingMessage['headers']
  body: any
}

export type FakeReply = { status?: number; text?: string; toolCall?: { name: string; arguments: string } } | { status: number; error: string }

export interface LlmTestServer {
  url: string
  seen: SeenRequest[]
  queue: FakeReply[]
  close(): Promise<void>
}

export async function startLlmTestServer(initial: FakeReply[] = []): Promise<LlmTestServer> {
  const seen: SeenRequest[] = []
  const queue = [...initial]
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ url: req.url ?? '', headers: req.headers, body })
    const reply: FakeReply = queue.shift() ?? { text: 'OK' }
    if ('error' in reply) {
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.error } }))
      return
    }
    const message = reply.toolCall
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: reply.toolCall }] }
      : { role: 'assistant', content: reply.text ?? 'OK' }
    const finish = reply.toolCall ? 'tool_calls' : 'stop'
    if (body.stream) {
      const frames: unknown[] = reply.toolCall
        ? [
            { model: 'fake-local', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
          ]
        : [
            { model: 'fake-local', choices: [{ index: 0, delta: { content: String(reply.text ?? 'OK').slice(0, 6) } }] },
            { choices: [{ index: 0, delta: { content: String(reply.text ?? 'OK').slice(6) } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
            { choices: [], usage: { prompt_tokens: 40, completion_tokens: 8 } },
          ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'fake-local',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    queue,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
