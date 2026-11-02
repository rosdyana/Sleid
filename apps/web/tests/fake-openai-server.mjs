// A fake OpenAI-compatible server for the browser checks (tests/ai.mjs). No model is involved:
// every reply is canned, chosen from the request. It handles:
//   - the connection test ("Reply with the single word OK")
//   - structured calls, by response_format name: slide, rewrite, chart, theme
//   - streamed chat turns: a tool call for "slide" or "chart" requests, then a closing reply
// Usage from another script: const fake = await startFakeOpenAI(); fake.url, await fake.close()
// Run alone for a manual check: node tests/fake-openai-server.mjs 4011
import { createServer } from 'node:http'

const HEX = /#[0-9a-fA-F]{6}\b/

function lastUserText(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  if (!user) return ''
  if (typeof user.content === 'string') return user.content
  return (user.content ?? []).map((p) => p.text ?? '').join(' ')
}

/** The JSON a structured call should return, by schema name. */
function structuredReply(name, system, userText) {
  switch (name) {
    case 'slide':
      return {
        layout: 'title-content',
        title: 'Our three pricing plans',
        bullets: ['Starter: for small teams', 'Pro: for growing companies', 'Enterprise: for scale'],
        notes: 'Walk through each plan and who it suits.',
      }
    case 'rewrite':
      return { paragraphs: system.includes('Shorten') ? ['Short text.'] : ['A clearer sentence.'] }
    case 'chart':
      return {
        chartType: 'bar',
        title: 'Monthly sales',
        legend: false,
        columns: ['Month', 'Sales'],
        rows: [
          ['Jan', 12],
          ['Feb', 18],
          ['Mar', 15],
        ],
      }
    case 'theme': {
      // The brand colour the user typed becomes the accent. The muted grey is too light on white on purpose,
      // so the contrast rule has something to adjust and report.
      const brand = HEX.exec(userText)?.[0] ?? '#0b57d0'
      return {
        name: 'Brand Calm',
        background: '#ffffff',
        surface: '#f5f7fb',
        text: '#1c1f26',
        muted: '#b5bac4',
        accent: brand,
        accent2: '#188038',
        accent3: '#e37400',
        accent4: '#a142f4',
        headingFont: 'Georgia, serif',
        bodyFont: 'Arial, sans-serif',
      }
    }
    default:
      return { paragraphs: ['OK'] }
  }
}

function completion(message, finish) {
  return {
    id: 'cmpl-fake',
    object: 'chat.completion',
    model: 'fake-local',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  }
}

function streamFrames(text, toolCall) {
  if (toolCall) {
    return [
      {
        model: 'fake-local',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${toolCall.name}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }] } }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
  }
  const half = Math.ceil(text.length / 2)
  return [
    { model: 'fake-local', choices: [{ index: 0, delta: { content: text.slice(0, half) } }] },
    { choices: [{ index: 0, delta: { content: text.slice(half) } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
  ]
}

export function respond(body) {
  const messages = body.messages ?? []
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  const userText = lastUserText(messages)
  const name = body.response_format?.json_schema?.name
  const sawToolResult = messages.some((m) => m.role === 'tool')

  if (userText.includes('Reply with the single word OK')) {
    return { kind: 'text', text: 'OK' }
  }
  if (!body.stream) {
    if (name) return { kind: 'json', value: structuredReply(name, system, userText) }
    return { kind: 'text', text: 'OK' }
  }
  if (sawToolResult) {
    return { kind: 'stream', text: 'Here is the proposal. Review it in the card below, then Preview or Apply it.' }
  }
  if (/chart/i.test(userText)) {
    return { kind: 'stream', tool: { name: 'generate_chart', input: { prompt: userText } } }
  }
  if (/slide/i.test(userText)) {
    return { kind: 'stream', tool: { name: 'generate_slide', input: { prompt: userText } } }
  }
  return { kind: 'stream', text: 'I can add slides, charts and themes. Tell me what you need.' }
}

export async function startFakeOpenAI(port = 0) {
  const seen = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body })
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const reply = respond(body)
    if (reply.kind === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completion({ role: 'assistant', content: JSON.stringify(reply.value) }, 'stop')))
      return
    }
    if (reply.kind === 'text') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completion({ role: 'assistant', content: reply.text }, 'stop')))
      return
    }
    if (body.stream) {
      const frames = streamFrames(reply.text ?? '', reply.tool)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completion({ role: 'assistant', content: reply.text ?? 'OK' }, 'stop')))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// Manual run: node tests/fake-openai-server.mjs 4011
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeOpenAI(Number(process.argv[2] ?? 4011))
  console.log(`fake OpenAI-compatible server on ${fake.url}`)
}
