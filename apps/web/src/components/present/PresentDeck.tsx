// Full-page presentation with reveal.js from the npm package (bundled by Vite,
// not loaded from a CDN). Slide markup comes from @sleid/render, the same
// renderer used for export. The notes plugin is on, so S opens the speaker view.
import { useEffect, useMemo, useRef } from 'react'
import 'reveal.js/dist/reveal.css'
import type { Deck } from '@sleid/model'
import { BASE_CSS, renderSlideHtml, themeCssVariables } from '@sleid/render'

interface RevealInstance {
  initialize(): Promise<unknown>
  slide(h: number): void
  destroy(): void
}

export function PresentDeck({ deck, startSlide }: { deck: Deck; startSlide?: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const css = useMemo(() => `${themeCssVariables(deck.theme)}\n${BASE_CSS}`, [deck.theme])
  const slidesHtml = useMemo(() => deck.slides.map((s) => renderSlideHtml(s, deck)).join('\n'), [deck])
  const firstSlide = useRef(startSlide)

  useEffect(() => {
    let cancelled = false
    let reveal: RevealInstance | undefined
    void (async () => {
      const [{ default: Reveal }, { default: RevealNotes }] = await Promise.all([
        import('reveal.js/dist/reveal.esm.js'),
        import('reveal.js/plugin/notes/notes.esm.js'),
      ])
      if (cancelled || !hostRef.current) return
      reveal = new (Reveal as unknown as new (el: HTMLElement, opts: object) => RevealInstance)(hostRef.current, {
        width: 1920,
        height: 1080,
        margin: 0,
        hash: false,
        plugins: [RevealNotes],
      })
      await reveal.initialize()
      const start = firstSlide.current
      if (start && start > 1) reveal.slide(Math.min(start, deck.slides.length) - 1)
    })()
    return () => {
      cancelled = true
      reveal?.destroy()
    }
  }, [slidesHtml, deck.slides.length])

  return (
    <div className="fixed inset-0 bg-black">
      <style>{css}</style>
      <div className="reveal" ref={hostRef} data-testid="present-root">
        <div className="slides" dangerouslySetInnerHTML={{ __html: slidesHtml }} />
      </div>
    </div>
  )
}
