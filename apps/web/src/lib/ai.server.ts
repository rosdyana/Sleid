// The assistant's request path, shared by the ability server function and the chat route.
// Order of checks: signed in, editor on the deck, rate limit, provider, deck, the run, the usage row.
// Everything that can fail with a user-facing message throws an LlmError, which the callers show as-is.
import { ABILITY_NAMES, LlmError, runAbility, scrubError, type AbilityEnv, type AbilityInputs, type AbilityName, type ImagePart, type Usage } from '@sleid/llm'
import { canEdit, countLlmRequestsSince, getAssetWithDeck, getDeckRole, recordLlmUsage, readDeck, type Db, type LiveDeckSource } from '@sleid/db'
import type { Deck, Op } from '@sleid/model'
import type { StorageDriver } from '@sleid/storage'
import { rateLimitFromEnv, type RateLimit } from './llm-config.server'
import { resolveProvider, type AiUser, type ResolvedProvider, type SettingsDeps } from './llm-settings.server'

export interface AiDeps extends SettingsDeps {
  live?: LiveDeckSource | undefined
  storage?: StorageDriver | undefined
  /** Aborts the model call (for example when the browser disconnects). */
  signal?: AbortSignal
}

export interface ProviderInfoOut {
  id: string
  name: string
  kind: string
  model: string
}

/** Counts requests in the window and refuses past the limit. Failed requests count too. */
export async function checkRateLimit(db: Db, userId: string, env: NodeJS.ProcessEnv, now = new Date(), limit: RateLimit = rateLimitFromEnv(env)): Promise<void> {
  const used = await countLlmRequestsSince(db, userId, new Date(now.getTime() - limit.windowMs))
  if (used >= limit.max) {
    const minutes = Math.ceil(limit.windowMs / 60000)
    throw new LlmError('rate-limit', `You have used the assistant ${used} times in the last ${minutes} minutes. Try again shortly.`)
  }
}

/** Editors and owners may use the assistant. Viewers and commenters may not. Missing decks say so. */
export async function requireEditorOn(db: Db, userId: string, deckId: string): Promise<void> {
  const role = await getDeckRole(db, userId, deckId)
  if (!role) throw new LlmError('bad-request', 'Deck not found')
  if (!canEdit(role)) throw new LlmError('auth', 'The assistant changes the deck, so it needs editor access.')
}

/** The live deck when the collab service has it, otherwise the saved one. */
export async function loadDeck(deps: AiDeps, deckId: string): Promise<Deck> {
  const { deck } = await readDeck(deps.db, deckId, deps.live ? { live: deps.live } : {})
  return deck
}

const DATA_URL = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/
const ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

/**
 * Image bytes for alt text: only for elements of this deck, only when the provider sees pictures.
 * data: URLs are decoded. Asset URLs are read from storage when the asset belongs to the deck.
 */
export async function imagesForAltText(deps: AiDeps, deck: Deck, provider: ResolvedProvider, elementIds: string[]): Promise<Record<string, ImagePart & { mediaType: string }> | undefined> {
  if (!provider.provider.supportsImages) return undefined
  const out: Record<string, { mediaType: string; base64: string }> = {}
  const elements = new Map<string, Deck['slides'][number]['elements'][number]>()
  for (const slide of deck.slides) for (const el of slide.elements) elements.set(el.id, el)
  for (const id of elementIds.slice(0, 8)) {
    const el = elements.get(id)
    if (!el || el.type !== 'image') continue
    const data = DATA_URL.exec(el.src)
    if (data) {
      out[id] = { mediaType: data[1]!, base64: data[2]! }
      continue
    }
    const asset = ASSET_URL.exec(el.src)
    if (asset && deps.storage) {
      const row = await getAssetWithDeck(deps.db, asset[1]!)
      if (!row || row.deckId !== deck.id || !row.mime.startsWith('image/') || row.mime === 'image/svg+xml') continue
      const bytes = await deps.storage.get(asset[1]!)
      if (bytes) out[id] = { mediaType: row.mime, base64: Buffer.from(bytes).toString('base64') }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function isRunnable(name: string): name is Exclude<AbilityName, 'chat'> {
  return (ABILITY_NAMES as readonly string[]).includes(name) && name !== 'chat'
}

export async function recordUsage(
  db: Db,
  row: { userId: string; deckId: string; providerId: string | null; ability: string; usage: Usage; latencyMs: number; ok: boolean },
): Promise<void> {
  await recordLlmUsage(db, {
    userId: row.userId,
    deckId: row.deckId,
    providerId: row.providerId,
    ability: row.ability,
    inputTokens: row.usage.inputTokens,
    outputTokens: row.usage.outputTokens,
    latencyMs: row.latencyMs,
    ok: row.ok,
  })
}

/** The environment an ability runs in. Local model servers get the compact schemas. */
export function abilityEnv(provider: ResolvedProvider, deck: Deck, signal?: AbortSignal): AbilityEnv {
  return {
    provider: provider.provider,
    deck,
    compact: provider.info.kind === 'openai-compatible',
    ...(signal ? { signal } : {}),
  }
}

export interface AbilityRunResult {
  proposal: {
    id: string
    ability: string
    summary: string
    ops: Op[]
    warnings: string[]
    usage: Usage
    model: string
    focusSlideId?: string
    text?: string
  }
  provider: ProviderInfoOut
}

/** Runs one ability for a deck and records the usage. Throws LlmError for anything the user should see. */
export async function runAbilityForDeck(
  deps: AiDeps,
  user: AiUser,
  args: { deckId: string; providerId: string | null; ability: string; input: Record<string, unknown> },
): Promise<AbilityRunResult> {
  if (!isRunnable(args.ability)) throw new LlmError('bad-request', `There is no assistant action called ${args.ability}.`)
  await requireEditorOn(deps.db, user.id, args.deckId)
  await checkRateLimit(deps.db, user.id, deps.env)
  const resolved = await resolveProvider(deps, user, args.providerId)
  const started = Date.now()
  let deck: Deck | undefined
  try {
    deck = await loadDeck(deps, args.deckId)
    const env = abilityEnv(resolved, deck, deps.signal)
    const input: Record<string, unknown> = { ...args.input }
    if (args.ability === 'altText') {
      const ids = Array.isArray(input.elementIds) ? (input.elementIds as string[]) : []
      const images = await imagesForAltText(deps, deck, resolved, ids)
      if (images) input.images = images
    }
    const outcome = await runAbility(args.ability as keyof AbilityInputs, env, input)
    await recordUsage(deps.db, {
      userId: user.id,
      deckId: args.deckId,
      providerId: resolved.info.id === 'env' ? null : resolved.info.id,
      ability: args.ability,
      usage: outcome.usage,
      latencyMs: Date.now() - started,
      ok: true,
    })
    return {
      proposal: {
        id: crypto.randomUUID(),
        ability: outcome.ability,
        summary: outcome.summary,
        ops: outcome.ops,
        warnings: outcome.warnings,
        usage: outcome.usage,
        model: outcome.model,
        ...(outcome.text !== undefined ? { text: outcome.text } : {}),
        ...(focusOfOutcome(deck, outcome.ops) ? { focusSlideId: focusOfOutcome(deck, outcome.ops) } : {}),
      },
      provider: { id: resolved.info.id, name: resolved.info.name, kind: resolved.info.kind, model: outcome.model },
    }
  } catch (err) {
    await recordUsage(deps.db, {
      userId: user.id,
      deckId: args.deckId,
      providerId: resolved.info.id === 'env' ? null : resolved.info.id,
      ability: args.ability,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
      ok: false,
    }).catch(() => undefined)
    if (err instanceof LlmError) throw new LlmError(err.kind, scrubError(err, resolved.secrets), { ...(err.status ? { status: err.status } : {}) })
    throw new LlmError('bad-request', scrubError(err, resolved.secrets))
  }
}

/** The slide the batch is about: the slide of its first slide-level op, or the added slide. */
function focusOfOutcome(deck: Deck | undefined, ops: readonly Op[]): string | undefined {
  if (!deck) return undefined
  const first = ops[0]
  if (!first) return undefined
  if (first.op === 'addSlide') return first.slide?.id
  return 'slideId' in first ? first.slideId : undefined
}
