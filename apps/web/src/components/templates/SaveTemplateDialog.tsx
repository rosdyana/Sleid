// File ▸ Save as template…: saves the open deck as a template (owned by the caller). Success shows a link to the gallery.
import { useState, type FormEvent } from 'react'
import { TEMPLATE_CATEGORIES, type TemplateCategory } from '@sleid/model'
import { saveTemplateFromDeckFn } from '~/lib/templates.functions'
import { CATEGORY_LABEL } from './TemplateCard'

type Visibility = 'private' | 'instance'

const inputClass = 'mt-1 w-full rounded border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-accent'

export function SaveTemplateDialog({ deckId, defaultName, onClose }: { deckId: string; defaultName: string; onClose: () => void }) {
  const [name, setName] = useState(defaultName.trim() || 'Untitled template')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<TemplateCategory>('general')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Give the template a name.')
    setBusy(true)
    setError(null)
    try {
      const { id } = await saveTemplateFromDeckFn({ data: { deckId, name: name.trim(), description: description.trim(), category, visibility } })
      setSaved(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The template could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Save as template"
        data-testid="save-template-dialog"
        className="w-[30rem] max-w-[calc(100vw-2rem)] rounded-lg bg-white p-5 shadow-xl"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 className="text-base font-medium">Save as template</h2>

        {saved ? (
          <div className="mt-4 space-y-3 text-[13px]" role="status" data-testid="save-template-success">
            <p>Saved. The template is in the gallery.</p>
            <p>
              <a href="/?gallery=mine" target="_blank" rel="noopener" className="font-medium text-accent hover:underline" data-testid="save-template-gallery-link">
                Open the template gallery
              </a>
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:brightness-95">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 space-y-3 text-[13px]">
              <label className="block">
                <span className="text-ink-muted">Name</span>
                <input data-testid="save-template-name" className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block">
                <span className="text-ink-muted">Description</span>
                <textarea
                  data-testid="save-template-description"
                  className={inputClass}
                  rows={3}
                  maxLength={1000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-ink-muted">Category</span>
                <select data-testid="save-template-category" className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory)}>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="space-y-1">
                <legend className="text-ink-muted">Who can use it</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="template-visibility"
                    data-testid="save-template-visibility-private"
                    checked={visibility === 'private'}
                    onChange={() => setVisibility('private')}
                  />
                  Only me
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="template-visibility"
                    data-testid="save-template-visibility-instance"
                    checked={visibility === 'instance'}
                    onChange={() => setVisibility('instance')}
                  />
                  Everyone on this server
                </label>
              </fieldset>
              <p className="text-[12px] text-ink-muted">The template keeps the deck's theme and slides. Images are copied into it. A brand kit is not part of a template.</p>
            </div>
            {error && (
              <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-[13px] text-red-800">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
                Cancel
              </button>
              <button type="submit" data-testid="save-template-submit" disabled={busy} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
