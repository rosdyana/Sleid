import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { deleteBrandKitFn, listBrandKitsFn } from '~/lib/brand-kits.functions'
import { listTemplatesFn } from '~/lib/templates.functions'
import { AppHeader } from '~/components/AppHeader'
import { SettingsNav } from '~/components/settings/SettingsNav'
import { BrandKitForm, PALETTE_KEYS, type KitView } from '~/components/brand/BrandKitForm'

export const Route = createFileRoute('/_authed/settings/brand-kits')({
  loader: async () => ({ kits: await listBrandKitsFn(), templates: await listTemplatesFn() }),
  component: BrandKitSettings,
})

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function BrandKitSettings() {
  const loaded = Route.useLoaderData()
  const [kits, setKits] = useState<KitView[]>(loaded.kits)
  const [templates, setTemplates] = useState(loaded.templates)
  const [editing, setEditing] = useState<KitView | 'new' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const [nextKits, nextTemplates] = await Promise.all([listBrandKitsFn(), listTemplatesFn()])
    setKits(nextKits)
    setTemplates(nextTemplates)
  }

  async function done(message: string) {
    setEditing(null)
    setNotice(message)
    setError(null)
    try {
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function remove(kit: KitView) {
    if (!window.confirm(`Delete the brand kit "${kit.name}"? Decks that use it keep their theme and logo.`)) return
    setError(null)
    setNotice(null)
    try {
      await deleteBrandKitFn({ data: { kitId: kit.id } })
      await refresh()
      setNotice(`Deleted "${kit.name}".`)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const userTemplates = templates.filter((t) => !t.builtIn)

  return (
    <div className="min-h-screen">
      <AppHeader title="Brand kits" />

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <SettingsNav />
        <p className="text-[14px] text-ink-muted">
          A brand kit is a palette, two fonts and an optional logo. Applying a kit to a deck replaces its theme and places the logo on the slides. The assistant
          may use only the kit's colours and fonts for that deck.
        </p>

        {notice && (
          <p role="status" className="rounded bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {error}
          </p>
        )}

        {editing === null && (
          <div>
            <button
              type="button"
              data-testid="kit-new"
              onClick={() => {
                setEditing('new')
                setNotice(null)
              }}
              className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:brightness-95"
            >
              New brand kit
            </button>
          </div>
        )}

        {editing !== null && (
          <BrandKitForm
            key={editing === 'new' ? 'new' : editing.id}
            kit={editing === 'new' ? null : editing}
            templates={userTemplates}
            onDone={(message) => void done(message)}
            onCancel={() => setEditing(null)}
          />
        )}

        {kits.length === 0 ? (
          <p className="text-[14px] text-ink-muted">No brand kits yet. Create one to keep a palette, fonts and a logo for your decks.</p>
        ) : (
          <ul className="space-y-3" data-testid="kit-list">
            {kits.map((kit) => (
              <li key={kit.id} data-testid={`kit-row-${kit.id}`} className="flex flex-wrap items-center gap-4 rounded-lg border border-rule bg-white p-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium" data-testid="kit-row-name">
                      {kit.name}
                    </span>
                    {!kit.owned && <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">Shared with you</span>}
                    {kit.visibility === 'instance' && <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">On this server</span>}
                  </div>
                  <div className="flex flex-wrap gap-1" aria-label="Palette">
                    {PALETTE_KEYS.map((key) => (
                      <span key={key} title={`${key} ${kit.tokens.palette[key]}`} className="size-4 rounded-sm border border-rule" style={{ background: kit.tokens.palette[key] }} />
                    ))}
                  </div>
                  <p className="text-[12px] text-ink-muted">
                    Heading {kit.tokens.fonts.heading} · Body {kit.tokens.fonts.body}
                    {' · '}
                    {kit.hasLogo ? 'Has a logo' : 'No logo'}
                  </p>
                </div>
                {kit.owned && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid={`kit-edit-${kit.id}`}
                      onClick={() => {
                        setEditing(kit)
                        setNotice(null)
                        setError(null)
                      }}
                      className="rounded border border-rule px-3 py-1.5 hover:bg-hover"
                    >
                      Edit
                    </button>
                    <button type="button" data-testid={`kit-delete-${kit.id}`} onClick={() => void remove(kit)} className="rounded px-3 py-1.5 text-red-700 hover:bg-red-50">
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
