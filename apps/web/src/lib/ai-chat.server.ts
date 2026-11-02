// POST /api/decks/:deckId/ai/chat. Streams the assistant's reply as NDJSON, one event per line:
// text deltas, tool calls, proposals, an error, and a final done. Each proposal carries the provider
// and model, and the editor shows it as a card. Nothing is applied on the server.
import { z } from 'zod'
import { LlmError, runChat, scrubError, type Usage } from '@sleid/llm'
import type { Deck } from '@sleid/model'
import { abilityEnv, checkRateLimit, loadDeck, recordUsage, requireEditorOn, type AiDeps } from './ai.server'
import { resolveProvider, type AiUser } from './llm-settings.server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ChatBody = z.object({
  providerId: z.string().max(64).nullable().optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(12),
  focusSlideId: z.string().max(64).optional(),
  selectionIds: z.array(z.string().max(64)).max(50).optional(),
})

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function statusFor(err: LlmError): number {
  if (err.kind === 'rate-limit') return 429
  if (err.kind === 'auth') return 403
  if (err.kind === 'not-configured') return 409
  return 400
}

export async function handleAiChat(request: Request, deckId: string, deps: AiDeps & { user: AiUser | null }): Promise<Response> {
  if (!UUID.test(deckId)) return json(404, { error: 'Deck not found' })
  if (!deps.user) return json(401, { error: 'Sign in to use the assistant' })
  const user = deps.user

  let body: z.infer<typeof ChatBody>
  try {
    body = ChatBody.parse(await request.json())
  } catch {
    return json(400, { error: 'Send the conversation as JSON: { messages: [{ role, content }] }' })
  }

  let deck: Deck
  let resolved: Awaited<ReturnType<typeof resolveProvider>>
  try {
    await requireEditorOn(deps.db, user.id, deckId)
    await checkRateLimit(deps.db, user.id, deps.env)
    resolved = await resolveProvider(deps, user, body.providerId ?? null)
    deck = await loadDeck(deps, deckId)
  } catch (err) {
    if (err instanceof LlmError) return json(statusFor(err), { error: err.message })
    return json(400, { error: err instanceof Error ? err.message : 'The assistant is not available' })
  }

  const signal = deps.signal ?? request.signal
  const providerInfo = { id: resolved.info.id, name: resolved.info.name, kind: resolved.info.kind, model: resolved.info.model }
  const encoder = new TextEncoder()
  const started = Date.now()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
      let ok = false
      const send = (event: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }
      try {
        const events = runChat(abilityEnv(resolved, deck, signal), {
          messages: body.messages,
          ...(body.focusSlideId ? { focusSlideId: body.focusSlideId } : {}),
          ...(body.selectionIds ? { selectionIds: body.selectionIds } : {}),
        })
        for await (const ev of events) {
          if (ev.type === 'proposal') send({ type: 'proposal', proposal: ev.proposal, provider: providerInfo })
          else send(ev)
          if (ev.type === 'done') {
            usage = ev.usage
            ok = true
          }
          if (ev.type === 'error') send({ type: 'error', message: ev.message })
        }
      } catch (err) {
        send({ type: 'error', message: scrubError(err, resolved.secrets) })
      } finally {
        await recordUsage(deps.db, {
          userId: user.id,
          deckId,
          providerId: resolved.info.id === 'env' ? null : resolved.info.id,
          ability: 'chat',
          usage,
          latencyMs: Date.now() - started,
          ok,
        }).catch(() => undefined)
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            // The client already went away.
          }
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  })
}
