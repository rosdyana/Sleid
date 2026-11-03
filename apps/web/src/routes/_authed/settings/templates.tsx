import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { deleteTemplateFn, listTemplatesFn, updateTemplateFn } from '~/lib/templates.functions'
import { AppHeader } from '~/components/AppHeader'
import { SettingsNav } from '~/components/settings/SettingsNav'
import { CATEGORY_LABEL, TemplateThumb, type TemplateItem } from '~/components/templates/TemplateCard'

export const Route = createFileRoute('/_authed/settings/templates')({
  loader: async () => ({ templates: await listTemplatesFn() }),
  component: TemplateSettings,
})

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function TemplateSettings() {
  const loaded = Route.useLoaderData()
  const [templates, setTemplates] = useState<TemplateItem[]>(loaded.templates)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mine = templates.filter((t) => t.owned && !t.builtIn)

  async function refresh() {
    setTemplates(await listTemplatesFn())
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setError(null)
    setNotice(null)
    try {
      await action()
      await refresh()
      setNotice(message)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader title="Templates" />

      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <SettingsNav />
        <p className="text-[14px] text-ink-muted">
          Templates you saved from a deck. Only you can rename, share or delete them. Save a template from a deck with File ▸ Save as template…
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

        {mine.length === 0 ? (
          <p className="text-[14px] text-ink-muted" data-testid="template-empty">
            You have no templates yet.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="template-list">
            {mine.map((t) => (
              <TemplateRow key={t.id} template={t} onRename={(name) => run(() => updateTemplateFn({ data: { templateId: t.id, patch: { name } } }), 'Template renamed.')} onVisibility={(visibility) => run(() => updateTemplateFn({ data: { templateId: t.id, patch: { visibility } } }), 'Sharing changed.')} onDelete={() => {
                if (!window.confirm(`Delete the template "${t.name}"? This cannot be undone.`)) return
                void run(() => deleteTemplateFn({ data: { templateId: t.id } }), `Deleted "${t.name}".`)
              }} />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function TemplateRow({
  template,
  onRename,
  onVisibility,
  onDelete,
}: {
  template: TemplateItem
  onRename: (name: string) => void
  onVisibility: (visibility: 'private' | 'instance') => void
  onDelete: () => void
}) {
  const [name, setName] = useState(template.name)
  const dirty = name.trim() !== '' && name.trim() !== template.name
  return (
    <li data-testid={`template-row-${template.id}`} className="flex flex-wrap items-center gap-4 rounded-lg border border-rule bg-white p-4">
      <div className="w-40 shrink-0">
        <TemplateThumb template={template} />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Template name"
            data-testid="template-name-input"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded border border-rule px-2 text-[14px] outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid="template-rename"
            disabled={!dirty}
            onClick={() => onRename(name.trim())}
            className="rounded border border-rule px-3 py-1 text-[13px] hover:bg-hover disabled:opacity-50"
          >
            Rename
          </button>
        </div>
        <p className="text-[12px] text-ink-muted">
          {template.slideCount} {template.slideCount === 1 ? 'slide' : 'slides'} · {CATEGORY_LABEL[template.category]}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <label className="flex items-center gap-2">
            <span className="text-ink-muted">Who can use it</span>
            <select
              aria-label="Who can use it"
              data-testid="template-visibility"
              value={template.visibility === 'instance' ? 'instance' : 'private'}
              onChange={(e) => onVisibility(e.target.value as 'private' | 'instance')}
              className="h-8 rounded border border-rule bg-white px-2"
            >
              <option value="private">Only me</option>
              <option value="instance">Everyone on this server</option>
            </select>
          </label>
          <button type="button" data-testid="template-delete" onClick={onDelete} className="rounded px-3 py-1 text-red-700 hover:bg-red-50">
            Delete
          </button>
        </div>
      </div>
    </li>
  )
}
