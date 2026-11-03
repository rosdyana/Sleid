// The phone-remote panel of the presenter view: a QR code for a short-lived remote link, the link itself, a
// closing button, and the follow link for the audience. The QR code is an SVG made by the qrcode library from
// our own URL; it is inserted as markup only because the library returns markup, never user input.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { closeRemoteSessionFn, createRemoteSessionFn } from '~/lib/remote.functions'
import { followUrl } from './present-channel'

type Session = { status: 'idle' } | { status: 'loading' } | { status: 'open'; url: string; svg: string; expiresAt: number } | { status: 'closed' } | { status: 'error'; message: string }

export function RemotePanel({ deckId, sid, origin }: { deckId: string; sid: string; origin: string }) {
  const [session, setSession] = useState<Session>({ status: 'idle' })
  const [copied, setCopied] = useState<string | null>(null)
  const follow = `${origin}${followUrl(deckId, sid)}`

  async function open() {
    setSession({ status: 'loading' })
    try {
      const created = await createRemoteSessionFn({ data: { deckId, sid } })
      const url = `${origin}${created.path}`
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
      setSession({ status: 'open', url, svg, expiresAt: created.expiresAt })
    } catch (err) {
      setSession({ status: 'error', message: err instanceof Error ? err.message : 'Could not start the phone remote' })
    }
  }

  async function close() {
    try {
      await closeRemoteSessionFn({ data: { deckId, sid } })
    } finally {
      setSession({ status: 'closed' })
    }
  }

  // Closing the presenter window also closes the remote, so a phone cannot keep a presentation after its owner left.
  useEffect(() => {
    if (session.status !== 'open') return
    const onHide = () => {
      void closeRemoteSessionFn({ data: { deckId, sid } }).catch(() => undefined)
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [session.status, deckId, sid])

  async function copy(text: string, label: string) {
    await navigator.clipboard?.writeText(text).catch(() => undefined)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <section aria-label="Phone remote" className="flex flex-col gap-3 text-[13px] text-white">
      {session.status === 'idle' || session.status === 'closed' || session.status === 'error' ? (
        <div className="flex flex-col gap-2">
          <p className="text-white/70">Use your phone as a clicker. Scan the code, and the link works for 30 minutes.</p>
          <button type="button" onClick={open} className="self-start rounded bg-accent px-3 py-1.5 font-medium text-white hover:brightness-110">
            {session.status === 'closed' ? 'Start the remote again' : 'Phone remote'}
          </button>
          {session.status === 'closed' && <p className="text-white/70">The remote is closed.</p>}
          {session.status === 'error' && <p role="alert" className="text-red-300">{session.message}</p>}
        </div>
      ) : session.status === 'loading' ? (
        <p className="text-white/70">Starting the remote…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div role="img" aria-label="QR code for the phone remote" data-testid="remote-qr" className="w-44 rounded bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: session.svg }} />
          <p className="text-white/70">Open this on your phone. Expires {new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
          <code data-testid="remote-url" className="break-all rounded bg-white/10 px-2 py-1 text-[10px] leading-snug">{session.url}</code>
          <div className="flex gap-2">
            <button type="button" onClick={() => copy(session.url, 'remote')} className="rounded bg-white/15 px-2 py-1 hover:bg-white/25">
              {copied === 'remote' ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" onClick={close} className="rounded bg-white/15 px-2 py-1 hover:bg-white/25">
              Close remote
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1 border-t border-white/15 pt-3">
        <span className="text-white/70">Audience follow link (read only, for viewers)</span>
        <div className="flex items-center gap-2">
          <code data-testid="follow-url" className="min-w-0 flex-1 truncate rounded bg-white/10 px-2 py-1 text-[11px]">{follow}</code>
          <button type="button" onClick={() => copy(follow, 'follow')} className="shrink-0 rounded bg-white/15 px-2 py-1 hover:bg-white/25">
            {copied === 'follow' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </section>
  )
}
