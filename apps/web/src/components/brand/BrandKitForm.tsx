// Create or edit a brand kit: name, palette, heading and body fonts, the logo and where it goes, visibility and the
// default template. The logo is uploaded after the kit row is saved (a new kit needs its id first).
import { useState, type FormEvent } from 'react'
import { BUILT_IN_THEMES, LOGO_CORNERS, LOGO_SLIDES, type BrandTokens, type LogoPlacement } from '@sleid/model'
import { FONT_FAMILIES } from '~/lib/brand-fonts'
import { createBrandKitFn, listBrandKitsFn, removeBrandLogoFn, updateBrandKitFn, uploadBrandLogoFn } from '~/lib/brand-kits.functions'
import type { TemplateItem } from '~/components/templates/TemplateCard'
import { LogoField } from './LogoField'
import { PlacementPreview } from './PlacementPreview'
import { readAsBase64, useObjectUrl } from './logo-file'

export type KitView = Awaited<ReturnType<typeof listBrandKitsFn>>[number]

/** The palette keys the brand schema uses (the same names as the theme's colours). */
export const PALETTE_KEYS = ['background', 'surface', 'text', 'muted', 'accent', 'accent2', 'accent3', 'accent4'] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]

const CORNER_LABEL: Record<(typeof LOGO_CORNERS)[number], string> = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }
const SLIDES_LABEL: Record<(typeof LOGO_SLIDES)[number], string> = { all: 'All slides', 'all-but-title': 'All except title slides', none: 'No slides' }
const DEFAULT_PLACEMENT: LogoPlacement = { corner: 'tr', widthPct: 12, margin: 48, slides: 'all-but-title' }
const inputClass = 'mt-1 w-full rounded border border-rule bg-white px-2 py-1.5 text-[13px] outline-none focus:border-accent'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'The brand kit could not be saved.'
}

function paletteOf(kit: KitView | null): Record<PaletteKey, string> {
  const source: Record<string, string> = kit ? { ...kit.tokens.palette } : { ...BUILT_IN_THEMES[0]!.colors }
  return Object.fromEntries(PALETTE_KEYS.map((k) => [k, source[k] ?? '#000000'])) as Record<PaletteKey, string>
}

export function BrandKitForm({
  kit,
  templates,
  onDone,
  onCancel,
}: {
  /** The kit being edited, or null for a new kit. */
  kit: KitView | null
  /** The user templates a kit may default to (built-ins cannot be a default). */
  templates: TemplateItem[]
  /** Called after a save. `notice` says what happened; it names a logo that could not be saved. */
  onDone: (notice: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(kit?.name ?? '')
  const [visibility, setVisibility] = useState<'private' | 'instance'>(kit?.visibility ?? 'private')
  const [palette, setPalette] = useState<Record<PaletteKey, string>>(() => paletteOf(kit))
  const [heading, setHeading] = useState(kit?.tokens.fonts.heading ?? 'Inter')
  const [body, setBody] = useState(kit?.tokens.fonts.body ?? 'Inter')
  const [placement, setPlacement] = useState<LogoPlacement>(kit?.logoPlacement ?? DEFAULT_PLACEMENT)
  const [defaultTemplateId, setDefaultTemplateId] = useState(kit?.defaultTemplateId ?? '')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [removeSaved, setRemoveSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logoUrl = useObjectUrl(logoFile)
  /** The logo saved on the kit, read through the kit's logo route. Null when there is none or it is being removed. */
  const savedLogoSrc = kit?.hasLogo && !removeSaved ? `/api/brand-kits/${encodeURIComponent(kit.id)}/logo` : null

  const fontOptions = [...new Set([...FONT_FAMILIES, heading, body])]
  const knownDefault = defaultTemplateId === '' || templates.some((t) => t.id === defaultTemplateId)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError('Give the brand kit a name.')
    setBusy(true)
    setError(null)
    const tokens: BrandTokens = {
      ...(kit?.tokens ?? {}),
      palette,
      fonts: { ...(kit?.tokens.fonts ?? {}), heading, body },
    } as BrandTokens
    const input = { name: name.trim(), visibility, tokens, logoPlacement: placement, defaultTemplateId: defaultTemplateId || null }
    try {
      let kitId: string
      if (kit) {
        await updateBrandKitFn({ data: { kitId: kit.id, patch: input } })
        kitId = kit.id
      } else {
        kitId = (await createBrandKitFn({ data: input })).id
      }
      let notice = kit ? 'Brand kit saved.' : 'Brand kit created.'
      try {
        if (kit && removeSaved && kit.hasLogo) await removeBrandLogoFn({ data: { kitId } })
        if (logoFile) {
          const contentBase64 = await readAsBase64(logoFile)
          await uploadBrandLogoFn({ data: { kitId, mime: logoFile.type as 'image/png' | 'image/jpeg' | 'image/svg+xml', contentBase64 } })
        }
      } catch (logoErr) {
        notice = `Saved, but the logo was not: ${messageOf(logoErr)}`
      }
      onDone(notice)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} data-testid="kit-editor" aria-label={kit ? 'Edit brand kit' : 'New brand kit'} className="space-y-5 rounded-lg border border-rule bg-white p-5 text-[13px]">
      <h2 className="text-base font-medium">{kit ? `Edit ${kit.name}` : 'New brand kit'}</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-ink-muted">Name</span>
          <input data-testid="kit-name" className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-ink-muted">Visibility</span>
          <select data-testid="kit-visibility" className={inputClass} value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'instance')}>
            <option value="private">Only me</option>
            <option value="instance">Everyone on this server</option>
          </select>
        </label>
      </div>

      <fieldset>
        <legend className="mb-2 font-medium">Colours</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PALETTE_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="color"
                data-testid={`kit-color-${key}`}
                aria-label={key}
                value={palette[key]}
                onChange={(e) => setPalette((p) => ({ ...p, [key]: e.target.value }))}
                className="h-8 w-10 cursor-pointer rounded border border-rule"
              />
              <span className="text-ink-muted">{key}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-ink-muted">Heading font</span>
          <select data-testid="kit-font-heading" className={inputClass} value={heading} onChange={(e) => setHeading(e.target.value)}>
            {fontOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-ink-muted">Body font</span>
          <select data-testid="kit-font-body" className={inputClass} value={body} onChange={(e) => setBody(e.target.value)}>
            {fontOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-[1fr_1.2fr]">
        <legend className="mb-2 font-medium">Logo</legend>
        <div className="space-y-4">
          <LogoField
            file={logoFile}
            hasSavedLogo={kit?.hasLogo ?? false}
            savedSrc={savedLogoSrc}
            removeSaved={removeSaved}
            onFile={setLogoFile}
            onRemoveSaved={setRemoveSaved}
            onProblem={setError}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-ink-muted">Corner</span>
              <select data-testid="kit-placement-corner" className={inputClass} value={placement.corner} onChange={(e) => setPlacement((p) => ({ ...p, corner: e.target.value as LogoPlacement['corner'] }))}>
                {LOGO_CORNERS.map((c) => (
                  <option key={c} value={c}>
                    {CORNER_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-ink-muted">Size (% of width)</span>
              <input
                type="number"
                min={2}
                max={30}
                data-testid="kit-placement-size"
                className={inputClass}
                value={placement.widthPct}
                onChange={(e) => setPlacement((p) => ({ ...p, widthPct: Number(e.target.value) }))}
              />
            </label>
            <label className="block">
              <span className="text-ink-muted">Margin (px)</span>
              <input
                type="number"
                min={0}
                max={200}
                data-testid="kit-placement-margin"
                className={inputClass}
                value={placement.margin}
                onChange={(e) => setPlacement((p) => ({ ...p, margin: Number(e.target.value) }))}
              />
            </label>
            <label className="block">
              <span className="text-ink-muted">Slides</span>
              <select data-testid="kit-placement-slides" className={inputClass} value={placement.slides} onChange={(e) => setPlacement((p) => ({ ...p, slides: e.target.value as LogoPlacement['slides'] }))}>
                {LOGO_SLIDES.map((s) => (
                  <option key={s} value={s}>
                    {SLIDES_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <PlacementPreview placement={placement} logoSrc={logoUrl ?? savedLogoSrc} />
      </fieldset>

      <label className="block">
        <span className="text-ink-muted">Default template for new decks with this kit</span>
        <select data-testid="kit-default-template" className={inputClass} value={defaultTemplateId} onChange={(e) => setDefaultTemplateId(e.target.value)}>
          <option value="">No default</option>
          {!knownDefault && <option value={defaultTemplateId}>A template that is no longer available</option>}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-800">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
          Cancel
        </button>
        <button type="submit" data-testid="kit-save" disabled={busy} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
          {busy ? 'Saving…' : kit ? 'Save changes' : 'Create brand kit'}
        </button>
      </div>
    </form>
  )
}
