// A template as a card: its thumbnail (from the thumbnail route, or a neutral placeholder when it has none or the
// route answers 404), its name, and its slide count. Used by the dashboard row, the gallery and the wizard.
import { useState } from 'react'
import type { listTemplatesFn } from '~/lib/templates.functions'

export type TemplateItem = Awaited<ReturnType<typeof listTemplatesFn>>[number]

export const CATEGORY_LABEL: Record<TemplateItem['category'], string> = { business: 'Business', education: 'Education', general: 'General' }

export function templateThumbUrl(id: string): string {
  return `/api/templates/${encodeURIComponent(id)}/thumbnail`
}

/** Which gallery tab a template belongs to. Built-in templates are on their own tab; the rest split by owner. */
export function galleryTabOf(t: TemplateItem): 'builtin' | 'mine' | 'shared' {
  if (t.builtIn) return 'builtin'
  return t.owned ? 'mine' : 'shared'
}

export function TemplateThumb({ template }: { template: TemplateItem }) {
  // A user template with no thumbnail yet is not requested at all. Built-ins are requested; a 404 falls back.
  const [failed, setFailed] = useState(!template.builtIn && !template.hasThumbnail)
  if (failed) {
    return (
      <span data-testid="template-thumb-placeholder" className="grid aspect-video w-full place-items-center rounded border border-rule-soft bg-hover text-[12px] text-ink-muted">
        {template.slideCount} {template.slideCount === 1 ? 'slide' : 'slides'}
      </span>
    )
  }
  return (
    <img
      src={templateThumbUrl(template.id)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-video w-full rounded border border-rule-soft bg-white object-cover"
    />
  )
}

/** `className` sets the width: the dashboard row uses a fixed card, the gallery grid stretches it to its column. */
/** `testId` names the surface: the dashboard row and the gallery both show the same templates. */
export function TemplateCard({
  template,
  testId,
  disabled,
  onPick,
  className = 'w-44 shrink-0',
}: {
  template: TemplateItem
  testId: string
  disabled?: boolean
  onPick: (template: TemplateItem) => void
  className?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onPick(template)}
      className={`flex flex-col gap-2 rounded-lg border border-rule bg-white p-2 text-left hover:border-accent hover:shadow-sm disabled:opacity-60 ${className}`}
    >
      <TemplateThumb template={template} />
      <span className="truncate text-[13px] font-medium">{template.name}</span>
      <span className="truncate text-[12px] text-ink-muted">
        {template.slideCount} {template.slideCount === 1 ? 'slide' : 'slides'} · {CATEGORY_LABEL[template.category]}
      </span>
    </button>
  )
}
