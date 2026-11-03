// The Import dialog, used by the dashboard (New ▸ Import file…) and the editor (File ▸ Import slides…).
// File tab: a .pptx, .md or .json, uploaded as raw bytes. Google Slides tab: a public link, and the Drive Picker
// when it is configured. Progress is polled from getImportFn; the result lists warnings and opens the deck.
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { authClient } from '~/lib/auth-client'
import { drivePickerTokenFn, googleImportConfigFn, importFromDriveFn, importGoogleSlidesFn } from '~/lib/import.functions'
import { pickPresentationFromDrive } from './google-picker'
import { IMPORT_ACCEPT, IMPORT_HINT, STATUS_TEXT, formatForFileName, pollImport, uploadImport, type ImportView } from './import-client'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export type Tab = 'file' | 'google'
type GoogleConfig = { pickerEnabled: boolean; pickerApiKey?: string; projectNumber?: string; driveConnected: boolean }

export interface ImportDialogProps {
  onClose: () => void
  /** Editor: the new deck opens in a new tab, so the current deck stays open. Dashboard: in this tab. */
  openInNewTab: boolean
  /** The tab shown first. The dashboard's New menu opens File or Google Slides directly. */
  initialTab?: Tab
}

export function ImportDialog({ onClose, openInNewTab, initialTab = 'file' }: ImportDialogProps) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [starting, setStarting] = useState<string | null>(null)
  const [view, setView] = useState<ImportView | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [url, setUrl] = useState('')
  const [google, setGoogle] = useState<GoogleConfig>({ pickerEnabled: false, driveConnected: false })
  const [driveBusy, setDriveBusy] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    void googleImportConfigFn()
      .then((config) => {
        if (!cancelled.current) setGoogle(config as GoogleConfig)
      })
      .catch(() => undefined)
    return () => {
      cancelled.current = true
    }
  }, [])

  /** Starts one import (upload or link), then follows it until it finishes. */
  async function start(label: string, begin: () => Promise<{ importId: string }>) {
    setStartError(null)
    setView(null)
    setStarting(label)
    try {
      const { importId } = await begin()
      setStarting(null)
      setView({ status: 'queued' })
      await pollImport(
        importId,
        (next) => {
          if (!cancelled.current) setView(next)
        },
        () => cancelled.current,
      )
    } catch (err) {
      setStarting(null)
      setStartError(err instanceof Error ? err.message : 'The import could not be started.')
    }
  }

  function chooseFile(file: File) {
    const format = formatForFileName(file.name)
    if (!format) {
      setStartError(`"${file.name}" is not a file this import reads. Choose a ${IMPORT_HINT} file.`)
      return
    }
    void start('Uploading…', () => uploadImport(file, format))
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) chooseFile(file)
  }

  function importLink(event: FormEvent) {
    event.preventDefault()
    void start('Fetching the presentation from Google Slides…', () => importGoogleSlidesFn({ data: { url: url.trim() } }))
  }

  async function connectDrive() {
    setStartError(null)
    try {
      // Incremental consent: Better Auth adds the drive.file scope to the existing Google account and comes back here.
      await authClient.linkSocial({ provider: 'google', scopes: [DRIVE_SCOPE], callbackURL: window.location.href })
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Google Drive could not be connected.')
    }
  }

  async function pickFromDrive() {
    if (!google.pickerEnabled || !google.pickerApiKey || !google.projectNumber) return
    setStartError(null)
    setDriveBusy(true)
    try {
      const { accessToken } = await drivePickerTokenFn()
      const fileId = await pickPresentationFromDrive({ apiKey: google.pickerApiKey, projectNumber: google.projectNumber, accessToken })
      setDriveBusy(false)
      if (!fileId) return
      void start('Exporting the presentation from Google Drive…', () => importFromDriveFn({ data: { fileId } }))
    } catch (err) {
      setDriveBusy(false)
      setStartError(err instanceof Error ? err.message : 'The Google Picker could not be opened.')
    }
  }

  function reset() {
    setView(null)
    setStartError(null)
  }

  const busy = starting !== null || (view !== null && view.status !== 'done' && view.status !== 'failed')

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import slides"
        className="flex max-h-[85vh] w-[34rem] flex-col rounded-lg bg-white p-5 shadow-xl"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 className="text-base font-medium">Import slides</h2>

        {starting === null && view === null && (
          <>
            <div role="tablist" aria-label="Import source" className="mt-3 flex gap-1 border-b border-rule">
              {(
                [
                  ['file', 'File'],
                  ['google', 'Google Slides'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`import-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`import-panel-${id}`}
                  onClick={() => {
                    setTab(id)
                    setStartError(null)
                  }}
                  className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${tab === id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'file' && (
              <div role="tabpanel" id="import-panel-file" aria-labelledby="import-tab-file" className="mt-4">
                <div
                  data-testid="import-dropzone"
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center text-[13px] ${dragging ? 'border-accent bg-accent-soft' : 'border-rule'}`}
                >
                  <p>Drop a file here</p>
                  <p className="text-ink-muted">{IMPORT_HINT}</p>
                  <label className="mt-2 cursor-pointer rounded border border-accent px-3 py-1.5 font-medium text-accent hover:bg-hover">
                    Choose a file
                    <input
                      type="file"
                      accept={IMPORT_ACCEPT}
                      aria-label="Choose a file to import"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (file) chooseFile(file)
                      }}
                    />
                  </label>
                  <p className="text-[12px] text-ink-muted">PowerPoint files up to 50 MB; Markdown and JSON up to 5 MB. The file's content is checked, not only its name.</p>
                </div>
              </div>
            )}

            {tab === 'google' && (
              <div role="tabpanel" id="import-panel-google" aria-labelledby="import-tab-google" className="mt-4 space-y-4 text-[13px]">
                <form onSubmit={importLink} className="space-y-2">
                  <label className="block">
                    <span className="text-ink-muted">Google Slides link</span>
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      aria-label="Google Slides link"
                      placeholder="https://docs.google.com/presentation/d/…"
                      className="mt-1 w-full rounded border border-rule px-2 py-1.5"
                    />
                  </label>
                  <p className="text-ink-muted">The presentation must be shared as “Anyone with the link”. Otherwise choose it from Google Drive.</p>
                  <div className="flex justify-end">
                    <button type="submit" disabled={url.trim() === '' || busy} className="rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
                      Import link
                    </button>
                  </div>
                </form>
                {google.pickerEnabled && (
                  <div className="border-t border-rule pt-4">
                    {google.driveConnected ? (
                      <button
                        type="button"
                        onClick={() => void pickFromDrive()}
                        disabled={driveBusy}
                        className="rounded border border-accent px-3 py-1.5 font-medium text-accent hover:bg-hover disabled:opacity-50"
                      >
                        {driveBusy ? 'Opening Google Drive…' : 'Choose from Google Drive'}
                      </button>
                    ) : (
                      <button type="button" onClick={() => void connectDrive()} className="rounded border border-accent px-3 py-1.5 font-medium text-accent hover:bg-hover">
                        Connect Google Drive
                      </button>
                    )}
                    <p className="mt-2 text-ink-muted">
                      {google.driveConnected
                        ? 'Pick a presentation from your Drive. Sleid reads only the files you pick.'
                        : 'Connecting asks Google for permission to read the presentations you pick (drive.file). After Google sends you back, open Import again and choose the file.'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {startError && (
          <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-[13px] text-red-800">
            {startError}
          </p>
        )}

        {starting !== null && (
          <p role="status" className="mt-4 text-[13px] text-ink-muted">
            {starting}
          </p>
        )}

        {starting === null && view !== null && view.status !== 'done' && view.status !== 'failed' && (
          <p role="status" className="mt-4 text-[13px] text-ink-muted">
            {STATUS_TEXT[view.status]}
          </p>
        )}

        {view?.status === 'done' && view.deckId && (
          <ImportResult
            deckId={view.deckId}
            warnings={view.warnings ?? []}
            openInNewTab={openInNewTab}
            onClose={onClose}
            onOpen={() => {
              void navigate({ to: '/d/$deckId', params: { deckId: view.deckId! } })
            }}
          />
        )}

        {view?.status === 'failed' && (
          <div className="mt-4 space-y-3">
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-[13px] text-red-800">
              {view.error ?? STATUS_TEXT.failed}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={reset} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
                Try again
              </button>
              <button type="button" onClick={onClose} className="rounded bg-accent px-3 py-1.5 font-medium text-white">
                Close
              </button>
            </div>
          </div>
        )}

        {starting === null && view === null && (
          <div className="mt-5 flex justify-end">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ImportResult({
  deckId,
  warnings,
  openInNewTab,
  onClose,
  onOpen,
}: {
  deckId: string
  warnings: string[]
  openInNewTab: boolean
  onClose: () => void
  onOpen: () => void
}) {
  return (
    <div className="mt-4 space-y-3 text-[13px]">
      <p className="font-medium">Your deck is ready.</p>
      {warnings.length === 0 ? (
        <p className="text-ink-muted">Nothing was left out.</p>
      ) : (
        <details className="rounded border border-rule px-3 py-2" data-testid="import-warnings">
          <summary className="cursor-pointer font-medium">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-muted">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-ink-muted hover:bg-hover">
          Close
        </button>
        {openInNewTab ? (
          <a
            href={`/d/${deckId}`}
            target="_blank"
            rel="noopener"
            className="rounded bg-accent px-3 py-1.5 font-medium text-white no-underline hover:brightness-95"
          >
            Open deck
          </a>
        ) : (
          <button type="button" onClick={onOpen} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:brightness-95">
            Open deck
          </button>
        )}
      </div>
    </div>
  )
}
