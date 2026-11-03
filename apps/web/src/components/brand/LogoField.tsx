// The logo input of the brand kit editor: choose a PNG, JPEG or SVG (2 MB), see the chosen file, or the saved logo's
// state, and remove a saved logo. The file is uploaded when the kit is saved.
import type { LogoMime } from './logo-file'
import { LOGO_MIME, logoProblem } from './logo-file'

export function LogoField({
  file,
  hasSavedLogo,
  savedSrc,
  removeSaved,
  onFile,
  onRemoveSaved,
  onProblem,
}: {
  file: File | null
  hasSavedLogo: boolean
  /** The saved logo's URL (the kit's logo route), shown as a preview when no new file is chosen. */
  savedSrc: string | null
  removeSaved: boolean
  onFile: (file: File | null) => void
  onRemoveSaved: (remove: boolean) => void
  onProblem: (message: string) => void
}) {
  const accept: LogoMime[] = [...LOGO_MIME]
  let status = 'No logo.'
  if (file) status = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB), saved when you save the kit.`
  else if (removeSaved) status = 'The saved logo will be removed when you save.'
  else if (hasSavedLogo) status = 'A logo is saved. Choose a file to replace it.'

  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded border border-accent px-3 py-1.5 font-medium text-accent hover:bg-hover">
          Choose a logo
          <input
            type="file"
            accept={accept.join(',')}
            data-testid="kit-logo-input"
            aria-label="Logo file"
            className="sr-only"
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null
              e.target.value = ''
              if (!chosen) return
              const problem = logoProblem(chosen)
              if (problem) return onProblem(problem)
              onRemoveSaved(false)
              onFile(chosen)
            }}
          />
        </label>
        {(file || (hasSavedLogo && !removeSaved)) && (
          <button
            type="button"
            data-testid="kit-logo-remove"
            onClick={() => {
              onFile(null)
              if (hasSavedLogo) onRemoveSaved(true)
            }}
            className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover"
          >
            Remove logo
          </button>
        )}
      </div>
      {savedSrc && !file && (
        <div className="flex h-14 w-40 items-center justify-center overflow-hidden rounded border border-rule-soft bg-hover p-1">
          <img data-testid="kit-logo-saved" src={savedSrc} alt="Saved logo" className="h-10 w-auto max-w-full object-contain" />
        </div>
      )}
      <p className="text-ink-muted" data-testid="kit-logo-status">
        {status}
      </p>
    </div>
  )
}
