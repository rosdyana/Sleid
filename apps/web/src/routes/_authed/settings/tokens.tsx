import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createApiTokenFn, listApiTokensFn, revokeApiTokenFn } from '~/lib/api-tokens.functions'
import { listRecentDecksFn } from '~/lib/decks.functions'

export const Route = createFileRoute('/_authed/settings/tokens')({
  loader: async () => {
    const [tokens, decks] = await Promise.all([listApiTokensFn(), listRecentDecksFn()])
    return { tokens: tokens.tokens, decks: decks.filter((d) => d.role === 'owner' || d.role === 'editor') }
  },
  component: TokenSettings,
})

type Scope = 'decks:read' | 'decks:write' | 'decks:create' | 'exports' | 'ai'
type Token = Awaited<ReturnType<typeof listApiTokensFn>>['tokens'][number]

const SCOPES: Array<{ id: Scope; label: string; help: string }> = [
  { id: 'decks:read', label: 'Read decks', help: 'List and read decks, render slides.' },
  { id: 'decks:write', label: 'Edit decks', help: 'Change slides, text, charts and themes, and share decks. Needs editor access on each deck.' },
  { id: 'decks:create', label: 'Create decks', help: 'Create new decks that you own.' },
  { id: 'exports', label: 'Export', help: 'Start exports and get one-time download links.' },
  { id: 'ai', label: 'AI assistant', help: 'Ask the assistant for proposals (uses your AI provider and its limits).' },
]

const EXPIRY: Array<{ days: number; label: string }> = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days (default)' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year (maximum)' },
]

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function TokenSettings() {
  const loaded = Route.useLoaderData()
  const [tokens, setTokens] = useState<Token[]>(loaded.tokens)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['decks:read', 'decks:write', 'decks:create', 'exports'])
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [allDecks, setAllDecks] = useState(true)
  const [deckIds, setDeckIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ secret: string; name: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // The origin is read after mount, so the server render and the first client render match.
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const mcpUrl = `${origin}/mcp`

  async function reload() {
    const next = await listApiTokensFn()
    setTokens(next.tokens)
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (scopes.length === 0) return setError('Choose at least one scope.')
    if (!allDecks && deckIds.length === 0) return setError('Pick at least one deck, or allow all decks.')
    setBusy(true)
    try {
      const result = await createApiTokenFn({
        data: { name: name.trim(), scopes, expiresInDays, deckIds: allDecks ? null : deckIds },
      })
      setCreated({ secret: result.secret, name: result.token.name })
      setName('')
      await reload()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(token: Token) {
    if (!window.confirm(`Revoke “${token.name}”? Any agent using it stops working at once.`)) return
    setError(null)
    try {
      await revokeApiTokenFn({ data: { id: token.id } })
      await reload()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000)
    } catch {
      setError('Could not copy. Select the text and copy it by hand.')
    }
  }

  const toggleScope = (scope: Scope) => setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  const toggleDeck = (id: string) => setDeckIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]))

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-rule bg-white px-4">
        <div className="flex items-center gap-2">
          <Link to="/" className="grid size-8 place-items-center rounded bg-accent font-semibold text-white" aria-label="Back to decks">
            S
          </Link>
          <h1 className="text-lg font-medium">MCP access tokens</h1>
        </div>
        <Link to="/" className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
          Back to decks
        </Link>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <section className="space-y-2 text-[14px] text-ink-muted">
          <p>
            A token lets an AI agent (Claude Code, Claude Desktop, or any MCP client) work on your decks as you. Its MCP server is at{' '}
            <code className="rounded bg-hover px-1">{mcpUrl}</code>. A token can do only what its scopes allow, and only on decks you can reach. Your
            deck roles are checked on every call.
          </p>
          <p>
            Tokens are shown once. Sleid stores only a hash. Revoke a token you no longer use, and create a new one with the smallest scopes that do the job.
          </p>
        </section>

        {error && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
            {error}
          </p>
        )}

        {created && (
          <section aria-label="New token" role="region" className="space-y-4 rounded-lg border border-accent bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium">Copy “{created.name}” now</h2>
                <p className="text-[13px] text-ink-muted">This is the only time the token is shown. Store it somewhere safe.</p>
              </div>
              <button type="button" onClick={() => setCreated(null)} className="rounded px-2 py-1 text-ink-muted hover:bg-hover">
                Close
              </button>
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                aria-label="Token"
                value={created.secret}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded border border-rule bg-hover px-2 font-mono text-[13px]"
              />
              <button type="button" onClick={() => void copy('token', created.secret)} className="rounded border border-rule px-3 hover:bg-hover">
                {copied === 'token' ? 'Copied' : 'Copy token'}
              </button>
            </div>
            <CopyBlock
              label="Claude Code"
              note="Run this in a terminal. It adds the server to Claude Code."
              text={`claude mcp add --transport http sleid ${mcpUrl} --header "Authorization: Bearer ${created.secret}"`}
              copied={copied === 'claude'}
              onCopy={() => copy('claude', `claude mcp add --transport http sleid ${mcpUrl} --header "Authorization: Bearer ${created.secret}"`)}
            />
            <CopyBlock
              label="Other HTTP MCP clients (JSON)"
              note="For clients that read an mcpServers file. Put the headers in the client's config."
              text={JSON.stringify({ mcpServers: { sleid: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${created.secret}` } } } }, null, 2)}
              copied={copied === 'json'}
              onCopy={() =>
                copy(
                  'json',
                  JSON.stringify({ mcpServers: { sleid: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${created.secret}` } } } }, null, 2),
                )
              }
            />
          </section>
        )}

        <form aria-label="Create token" onSubmit={create} className="space-y-4 rounded-lg border border-rule bg-white p-4">
          <h2 className="text-base font-medium">Create a token</h2>
          <Field id="tok-name" label="Name (so you can tell it apart later)">
            <input id="tok-name" required maxLength={80} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Laptop Claude Code" />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-[13px] text-ink-muted">Scopes</legend>
            {SCOPES.map((s) => (
              <label key={s.id} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={scopes.includes(s.id)} onChange={() => toggleScope(s.id)} />
                <span>
                  <span className="font-medium">{s.label}</span> <code className="text-[12px] text-ink-muted">{s.id}</code>
                  <span className="block text-[13px] text-ink-muted">{s.help}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Field id="tok-expiry" label="Expires">
            <select id="tok-expiry" className={inputClass} value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
              {EXPIRY.map((e) => (
                <option key={e.days} value={e.days}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-[13px] text-ink-muted">Decks</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="tok-decks" checked={allDecks} onChange={() => setAllDecks(true)} />
              <span>All decks I can access</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="tok-decks" checked={!allDecks} onChange={() => setAllDecks(false)} />
              <span>Only these decks (owned or edited by me)</span>
            </label>
            {!allDecks && (
              <ul className="ml-6 max-h-48 divide-y divide-rule-soft overflow-auto rounded border border-rule">
                {loaded.decks.length === 0 && <li className="px-3 py-2 text-ink-muted">No decks you own or edit yet.</li>}
                {loaded.decks.map((d) => (
                  <li key={d.id}>
                    <label className="flex items-center gap-2 px-3 py-1.5">
                      <input type="checkbox" checked={deckIds.includes(d.id)} onChange={() => toggleDeck(d.id)} />
                      <span className="truncate">{d.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <div className="flex justify-end">
            <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60">
              {busy ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </form>

        <section aria-label="Tokens" className="space-y-3">
          <h2 className="text-base font-medium">Your tokens</h2>
          {tokens.length === 0 && <p className="text-ink-muted">No tokens yet.</p>}
          <ul className="divide-y divide-rule-soft rounded-lg border border-rule bg-white">
            {tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="font-mono text-[12px] text-ink-muted">…{t.hint}</span>
                    <StatusBadge status={t.status} />
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    {t.scopes.join(', ')} · {t.deckIds ? `${t.deckIds.length} deck(s)` : 'all decks'}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    Created {formatDate(t.createdAt)} · Expires {formatDate(t.expiresAt)} · Last used {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'never'}
                  </p>
                </div>
                {t.status === 'active' && (
                  <button type="button" onClick={() => void revoke(t)} className="rounded px-2.5 py-1 text-red-700 hover:bg-red-50">
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function StatusBadge({ status }: { status: Token['status'] }) {
  if (status === 'active') return <span className="rounded bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-[#001d35]">Active</span>
  return <span className="rounded bg-hover px-2 py-0.5 text-[11px] text-ink-muted">{status === 'revoked' ? 'Revoked' : 'Expired'}</span>
}

function CopyBlock({ label, note, text, copied, onCopy }: { label: string; note: string; text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        <button type="button" onClick={onCopy} className="rounded border border-rule px-2.5 py-1 text-[13px] hover:bg-hover">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-[12px] text-ink-muted">{note}</p>
      <pre className="overflow-auto rounded bg-hover p-2 font-mono text-[12px] whitespace-pre-wrap break-all">{text}</pre>
    </div>
  )
}

const inputClass = 'h-9 w-full rounded border border-rule bg-white px-2 text-[14px] outline-none focus:border-accent disabled:bg-hover'

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="block space-y-1">
      <label htmlFor={id} className="block text-[13px] text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  )
}
