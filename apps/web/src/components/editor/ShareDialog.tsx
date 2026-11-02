// Google-style share dialog: invite by email with a role, the people list (owner changes roles
// and removes people), pending invites, general access, and copy link.
import { useEffect, useState, type FormEvent } from 'react'
import { canInvite, SHARE_ROLES, type ShareRole } from '@sleid/db/permissions'
import { inviteFn, listPeopleFn, removeInviteFn, removeMemberFn, setGeneralAccessFn, setMemberRoleFn } from '~/lib/sharing.functions'
import { getPublishStateFn, setPublishedFn } from '~/lib/publish.functions'

type People = Awaited<ReturnType<typeof listPeopleFn>>

const ROLE_LABEL: Record<ShareRole, string> = { editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}

export function ShareDialog({ deckId, onClose }: { deckId: string; onClose: () => void }) {
  const [people, setPeople] = useState<People | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ShareRole>('editor')
  const [copied, setCopied] = useState(false)

  async function reload() {
    try {
      setPeople(await listPeopleFn({ data: { deckId } }))
    } catch (err) {
      setError(errorText(err))
    }
  }

  useEffect(() => {
    void reload()
    // reload is stable for a deck id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId])

  async function change(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!address) return
    await change(async () => {
      await inviteFn({ data: { deckId, email: address, role: inviteRole } })
      setEmail('')
    })
  }

  const isOwner = people?.myRole === 'owner'
  const mayInvite = people ? canInvite(people.myRole) : false
  const link = people?.access?.token ? `${window.location.origin}/d/${deckId}?share=${people.access.token}` : null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Share deck" className="flex max-h-[85vh] w-[34rem] flex-col rounded-lg bg-white p-5 shadow-xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 className="text-base font-medium">Share deck</h2>

        {mayInvite && (
          <form onSubmit={invite} className="mt-4 flex items-center gap-2" aria-label="Invite people">
            <input
              type="email"
              aria-label="Add people by email"
              placeholder="Add people by email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded border border-rule px-2 outline-none focus:border-accent"
            />
            <select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as ShareRole)} className="h-9 rounded border border-rule px-1">
              {SHARE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy || !email.trim()} className="h-9 rounded bg-accent px-3 font-medium text-white disabled:opacity-50">
              Send invite
            </button>
          </form>
        )}

        {error && <p role="alert" className="mt-3 text-[13px] text-red-700">{error}</p>}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {!people && !error && <p className="text-ink-muted">Loading people…</p>}
          {people && (
            <>
              <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-ink-muted">People with access</p>
              <ul aria-label="People with access" className="divide-y divide-rule-soft">
                {people.members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-3 py-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#7c4dff] text-sm font-medium text-white" aria-hidden>
                      {(m.name.trim().charAt(0) || '?').toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="truncate text-[12px] text-ink-muted">{m.email}</div>
                    </div>
                    {m.role === 'owner' || !isOwner ? (
                      <span className="text-[13px] text-ink-muted">{m.role === 'owner' ? 'Owner' : ROLE_LABEL[m.role as ShareRole] ?? m.role}</span>
                    ) : (
                      <>
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => void change(() => setMemberRoleFn({ data: { deckId, userId: m.userId, role: e.target.value as ShareRole } }))}
                          className="h-8 rounded border border-rule px-1 text-[13px]"
                        >
                          {SHARE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={`Remove ${m.email}`}
                          disabled={busy}
                          onClick={() => void change(() => removeMemberFn({ data: { deckId, userId: m.userId } }))}
                          className="rounded px-2 py-1 text-[13px] text-ink-muted hover:bg-hover"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>

              {people.pending.length > 0 && (
                <>
                  <p className="mb-1 mt-4 text-[12px] font-medium uppercase tracking-wide text-ink-muted">Pending invites</p>
                  <ul aria-label="Pending invites" className="divide-y divide-rule-soft">
                    {people.pending.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1 truncate">{p.email}</div>
                        <span className="text-[12px] text-ink-muted">Pending · {ROLE_LABEL[p.role]}</span>
                        {mayInvite && (
                          <button
                            type="button"
                            aria-label={`Cancel invite for ${p.email}`}
                            disabled={busy}
                            onClick={() => void change(() => removeInviteFn({ data: { deckId, inviteId: p.id } }))}
                            className="rounded px-2 py-1 text-[13px] text-ink-muted hover:bg-hover"
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <p className="mb-1 mt-4 text-[12px] font-medium uppercase tracking-wide text-ink-muted">General access</p>
              <div className="flex items-center gap-3">
                <select
                  aria-label="General access"
                  value={people.access?.role ?? 'restricted'}
                  disabled={!isOwner || busy}
                  onChange={(e) => void change(() => setGeneralAccessFn({ data: { deckId, mode: e.target.value as 'restricted' | ShareRole } }))}
                  className="h-9 rounded border border-rule px-2 disabled:opacity-60"
                >
                  <option value="restricted">Restricted</option>
                  {SHARE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      Anyone with the link: {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <span className="text-[12px] text-ink-muted">
                  {people.access ? 'Anyone with the link can open this deck.' : 'Only people listed above can open this deck.'}
                </span>
              </div>
              {!isOwner && <p className="mt-1 text-[12px] text-ink-muted">Only the owner can change general access.</p>}

              {link && (
                <div className="mt-3 flex items-center gap-2">
                  <input aria-label="Share link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded border border-rule bg-[#f8f9fa] px-2 text-[12px]" />
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))
                    }}
                    className="h-9 rounded border border-rule px-3 font-medium hover:bg-hover"
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <PublishSection deckId={deckId} />

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded bg-accent px-4 py-1.5 font-medium text-white">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

type PublishInfo = { published: boolean; token: string | null; indexable: boolean }

/** "Publish to web": a read-only public link to the presentation. Editors and owners only. */
function PublishSection({ deckId }: { deckId: string }) {
  const [info, setInfo] = useState<PublishInfo | null | 'none'>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getPublishStateFn({ data: { deckId } })
      .then((r) => setInfo(r.canManage ? (r.state ?? { published: false, token: null, indexable: false }) : 'none'))
      .catch((err: unknown) => setError(errorText(err)))
  }, [deckId])

  if (info === 'none') return null

  async function update(next: { published: boolean; indexable?: boolean }) {
    setBusy(true)
    setError(null)
    try {
      setInfo(await setPublishedFn({ data: { deckId, ...next } }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const link = info?.token ? `${window.location.origin}/p/${info.token}` : null
  return (
    <section aria-label="Publish to web" className="mt-5 border-t border-rule-soft pt-4">
      <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-ink-muted">Publish to web</p>
      {!info && !error && <p className="text-ink-muted">Loading…</p>}
      {info && (
        <>
          <label className="flex items-center gap-2">
            <input type="checkbox" role="switch" aria-label="Publish to web" checked={info.published} disabled={busy} onChange={(e) => void update({ published: e.target.checked })} />
            <span>{info.published ? 'Published: anyone with the link can view it, without signing in' : 'Off: the deck is not public'}</span>
          </label>
          {info.published && (
            <>
              <div className="mt-2 flex items-center gap-2">
                <input aria-label="Public link" readOnly value={link ?? ''} onFocus={(e) => e.currentTarget.select()} className="h-9 min-w-0 flex-1 rounded border border-rule bg-[#f8f9fa] px-2 text-[12px]" />
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(link ?? '').then(() => setCopied(true), () => setCopied(false))}
                  className="h-9 rounded border border-rule px-3 font-medium hover:bg-hover"
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
              <label className="mt-2 flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={info.indexable} disabled={busy} onChange={(e) => void update({ published: true, indexable: e.target.checked })} />
                Allow search engines to index this page
              </label>
            </>
          )}
        </>
      )}
      {error && <p role="alert" className="mt-2 text-[13px] text-red-700">{error}</p>}
    </section>
  )
}
