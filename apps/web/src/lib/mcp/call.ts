// The per-call machinery of the MCP server: the Call class (role checks, reads, writes through collab), defineTool (scope,
// audit and error wrapping), and the small helpers the tool modules share. Every tool module registers through a
// ServerContext built in server.ts.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { normalizeElementInput, parseOps, type Deck } from '@sleid/model'
import { getDeckRole, getExportJob, getImportJob, type ImportJobRow, markExportFailed, readDeck, recordMcpAudit, roleAtLeast, tokenAllowsDeck, tokenHasScope, type DeckRole, type TokenScope, type VerifiedToken } from '@sleid/db'
import { isLlmError } from '@sleid/llm'
import { CollabInternalError } from '~/lib/collab-client.server'
import { LibraryError } from '~/lib/templates.server'
import { ToolError } from './errors.ts'
import type { McpDeps } from './deps.ts'
import type { BrandDeps } from '~/lib/brand-kits.server'
import type { ImportDeps } from '~/lib/import.server'
import type { TemplateDeps } from '~/lib/templates.server'
import type { WizardDeps } from '~/lib/wizard.server'

export const NOT_FOUND = 'Deck not found.'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const RENDER_POLL_MS = 250

/** What a tool returns to the agent. Images are MCP image content, not base64 text. */
export type Output = CallToolResult

export const asText = (value: unknown): Output => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
export const asError = (message: string): Output => ({ content: [{ type: 'text', text: message }], isError: true })

/** Everything a tool module needs from the server: the SDK server, the dependencies, the token, and the helpers. */
export interface ServerContext {
  server: McpServer
  deps: McpDeps
  principal: VerifiedToken
  tool: <S extends z.ZodRawShape>(name: string, spec: ToolSpec<S>, run: (args: z.infer<z.ZodObject<S>>, call: Call) => Promise<Output>) => void
  /** The wizard's dependencies for this token's user. */
  wizardDepsFor: () => Promise<WizardDeps>
  /** The importer's dependencies. The queue is reached lazily. */
  importDepsFor: () => ImportDeps
  /** Templates (M9): the same database, storage and collab as the rest of this server. */
  templateDepsFor: () => TemplateDeps
  /** Brand kits (M9). */
  brandDepsFor: () => BrandDeps
}

export interface ToolSpec<S extends z.ZodRawShape> {
  description: string
  shape: S
  scope?: TokenScope
  readOnly?: boolean
}

/** Element defaults for ops that add elements: the input form (guide-elements.md) becomes the stored form. */
function normalizeOpInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const op = raw as { op?: unknown; element?: unknown; slide?: { elements?: unknown } }
  if (op.op === 'addElement' && typeof op.element === 'object' && op.element !== null) {
    return { ...op, element: normalizeElementInput(op.element) }
  }
  if (op.op === 'addSlide' && Array.isArray(op.slide?.elements)) {
    return { ...op, slide: { ...op.slide, elements: op.slide.elements.map((el, i) => normalizeElementInput(el, i)) } }
  }
  return raw
}

/** The per-call context: the token's owner, and what the call touched (for the audit row). */
export class Call {
  deckId: string | null = null

  constructor(
    readonly deps: McpDeps,
    readonly principal: VerifiedToken,
  ) {}

  /** Throws unless the token allows the deck and the user is a member with at least `min`. Returns the role. */
  async role(deckId: string, min: DeckRole): Promise<DeckRole> {
    this.deckId = deckId
    if (!UUID.test(deckId) || !tokenAllowsDeck(this.principal, deckId)) throw new ToolError(NOT_FOUND)
    const role = await getDeckRole(this.deps.db, this.principal.userId, deckId)
    if (!role) throw new ToolError(NOT_FOUND)
    if (!roleAtLeast(role, min)) {
      throw new ToolError(`Your role on this deck is ${role}. This action needs ${min} access or more. Ask the owner for a higher role.`)
    }
    return role
  }

  /** The current deck for a viewer: live from the collab service when it is up, otherwise the saved state. */
  async read(deckId: string): Promise<Deck> {
    await this.role(deckId, 'viewer')
    const { deck } = await readDeck(this.deps.db, deckId, {
      ...(this.deps.live ? { live: this.deps.live } : {}),
      onFallback: (reason) => this.deps.logger.warn(`collab service unavailable for read: ${String(reason)}`),
    })
    return deck
  }

  /** The current deck for an editor. */
  async edit(deckId: string): Promise<Deck> {
    await this.role(deckId, 'editor')
    return this.read(deckId)
  }

  /**
   * Applies ops through the collab service, so connected editors see them. All or nothing. Nothing is written
   * to the database here: when collab is down, the call fails and nothing changes. Element defaults are filled
   * in first, so every path (convenience tools and apply_ops) accepts the documented short forms.
   */
  async write(deckId: string, ops: unknown[]): Promise<unknown[]> {
    this.deckId = deckId
    let parsed: ReturnType<typeof parseOps>
    try {
      parsed = parseOps(ops.map(normalizeOpInput))
    } catch (err) {
      throw new ToolError(`An operation is not valid: ${zodMessage(err)}`)
    }
    const collab = this.deps.collab
    if (!collab) throw new ToolError('The live editing service is not configured on this server, so nothing was changed.')
    try {
      const { results } = await collab.applyOps(deckId, `mcp:${this.principal.tokenId}`, parsed, this.principal.userId)
      return results
    } catch (err) {
      if (err instanceof CollabInternalError && err.status === 422) {
        const detail = (err.body as { error?: { opIndex?: number; opName?: string; reason?: string } } | null)?.error
        throw new ToolError(`Operation ${(detail?.opIndex ?? 0) + 1} (${detail?.opName ?? 'unknown'}) was refused: ${detail?.reason ?? 'invalid'}. Nothing was applied.`)
      }
      if (err instanceof CollabInternalError && err.status === 404) throw new ToolError(NOT_FOUND)
      this.deps.logger.error('collab applyOps failed', err)
      throw new ToolError('The live editing service did not accept the change, so nothing was changed. Try again shortly.')
    }
  }
}

export function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0]
    return issue ? `${issue.path.map(String).join('.') || 'input'}: ${issue.message}` : 'invalid input'
  }
  return err instanceof Error ? err.message : 'invalid input'
}

/** Runs a check that throws plain errors (validation helpers) and reports its message to the agent. */
export function toolValue<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    throw new ToolError(err instanceof Error ? err.message : 'That input is not valid.')
  }
}

/** What a thrown error means for the agent. Known problems are shown as-is; anything else is logged and hidden. */
export function messageFor(err: unknown, deps: McpDeps, tool: string): string {
  if (err instanceof ToolError) return err.message
  if (isLlmError(err)) return err.message
  // Template and brand kit refusals (M9) are written for the user, like the tool's own messages.
  if (err instanceof LibraryError) return err.message
  if (err instanceof z.ZodError) return `Invalid input: ${zodMessage(err)}`
  deps.logger.error(`tool ${tool} failed`, err)
  return 'Something went wrong on the server. The error was logged. Try again, or check the deck with get_deck.'
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Waits for a queued export to finish, up to `timeoutMs`. Returns the last row seen. */
export async function waitForExport(deps: McpDeps, exportId: string, timeoutMs: number) {
  const started = Date.now()
  for (;;) {
    const row = await getExportJob(deps.db, exportId)
    if (!row) throw new ToolError('The export disappeared before it finished.')
    if (row.status === 'done' || row.status === 'failed') return row
    if (Date.now() - started > timeoutMs) return row
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS))
  }
}

/** Waits for a queued import to finish, up to `timeoutMs`. Returns the last row seen. */
export async function waitForImport(deps: McpDeps, importId: string, timeoutMs: number): Promise<ImportJobRow> {
  const started = Date.now()
  for (;;) {
    const row = await getImportJob(deps.db, importId)
    if (!row) throw new ToolError('The import disappeared before it finished.')
    if (row.status === 'done' || row.status === 'failed') return row
    if (Date.now() - started > timeoutMs) return row
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS))
  }
}

/** Queues an export row for the worker. A failure marks the row failed, so the caller sees why. */
export async function enqueueExport(deps: McpDeps, exportId: string): Promise<void> {
  try {
    const queue = await deps.getQueue()
    await queue.enqueueExport({ exportId })
  } catch (err) {
    deps.logger.error('could not queue the export job', err)
    await markExportFailed(deps.db, exportId, 'The export service is not running. Start the worker and try again.')
    throw new ToolError('The export service is not running, so the export did not start. Try again shortly.')
  }
}

/** The element id a placed element got, read from its raw ops (an addElement, or the element of a new slide). */
export function placedElementId(raw: unknown[]): string | undefined {
  for (const op of raw as Array<{ op: string; element?: { id?: string }; slide?: { elements?: Array<{ id?: string }> } }>) {
    if (op.op === 'addElement') return op.element?.id
    if (op.op === 'addSlide') return op.slide?.elements?.at(-1)?.id
  }
  return undefined
}

/**
 * Registers one tool. The wrapper checks the scope, runs the handler, writes the audit row (ok, time, deck, error)
 * and turns errors into a readable tool error. The audit row is written even when the call fails.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  deps: McpDeps,
  principal: VerifiedToken,
  name: string,
  spec: ToolSpec<S>,
  run: (args: z.infer<z.ZodObject<S>>, call: Call) => Promise<Output>,
): void {
  // The SDK infers the callback's argument type from the shape. The shape here is generic (chosen per tool), so the
  // callback is passed as `never` to the overload, and it receives the SDK's parsed, validated arguments.
  const callback = async (args: unknown): Promise<CallToolResult> => {
    const started = Date.now()
    const call = new Call(deps, principal)
    // The deck the caller named is recorded even when the call is refused, so the audit shows what was attempted.
    const named = (args as { deckId?: unknown } | undefined)?.deckId
    if (typeof named === 'string') call.deckId = named
    let output: Output
    try {
      if (spec.scope && !tokenHasScope(principal, spec.scope)) {
        throw new ToolError(`This token does not have the ${spec.scope} scope, so ${name} is not allowed. Create a token with that scope in Settings › MCP access tokens.`)
      }
      output = await run(args as unknown as z.infer<z.ZodObject<S>>, call)
    } catch (err) {
      output = asError(messageFor(err, deps, name))
    }
    try {
      await recordMcpAudit(deps.db, {
        userId: principal.userId,
        tokenId: principal.tokenId,
        tool: name,
        deckId: call.deckId,
        ok: !output.isError,
        ms: Date.now() - started,
        error: output.isError ? (output.content[0] as { text: string }).text : null,
      })
    } catch (err) {
      deps.logger.error('could not write the MCP audit row', err)
    }
    return output
  }
  server.registerTool(
    name,
    {
      description: spec.description,
      inputSchema: spec.shape,
      ...(spec.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
    callback as never,
  )
}

export const deckIdField = z.uuid().describe('The deck id, from list_decks or create_deck.')
export const slideRef = {
  slideId: z.string().min(1).max(100).optional().describe('Slide id from get_deck.'),
  index: z.number().int().min(0).optional().describe('0-based slide index, as in the get_deck outline.'),
}
