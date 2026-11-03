// Fake HTTP servers for the adapter tests. They run on 127.0.0.1 with node:http and record
// every request. A script decides each reply: a status, headers and a body, or a delay.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: any
}

export interface ScriptedHttpReply {
  status?: number
  headers?: Record<string, string>
  /** JSON body (sent with application/json), or a raw string for SSE. */
  body?: unknown
  raw?: string
  /** Wait before answering (for timeout and abort tests). */
  delayMs?: number
}

export interface FakeServer {
  url: string
  requests: RecordedRequest[]
  /** Replies in order. When the list runs out, the last reply repeats. */
  script: ScriptedHttpReply[]
  close(): Promise<void>
}

export async function startFakeServer(handler: (req: RecordedRequest, index: number) => ScriptedHttpReply): Promise<FakeServer> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    }
    requests.push(record)
    const reply = handler(record, requests.length - 1)
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
    if (res.destroyed) return
    res.writeHead(reply.status ?? 200, {
      ...(reply.raw !== undefined ? { 'content-type': 'text/event-stream' } : { 'content-type': 'application/json' }),
      ...(reply.headers ?? {}),
    })
    res.end(reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A server that answers from a script, repeating the last entry when the script is spent. */
export async function scriptedServer(script: ScriptedHttpReply[]): Promise<FakeServer> {
  const list = [...script]
  const fake = await startFakeServer((_req, index) => list[Math.min(index, list.length - 1)] ?? { status: 500, body: { error: 'no script' } })
  fake.script = list
  return fake
}
