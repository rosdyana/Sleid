// The reveal.js presentation. Used by the audience window (with a remote control handle), the published page,
// and the download-free present route. The speaker-notes popup of the reveal plugin is not loaded: the presenter
// view (components/present/PresenterView.tsx) replaces it, so the S key and the popup do not compete.
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import 'reveal.js/dist/reveal.css'
import type { Deck } from '@sleid/model'
import { BASE_CSS, renderSlideHtml, themeCssVariables } from '@sleid/render'
import { useGoogleFontsLink } from '~/lib/theme-fonts'

interface RevealInstance {
  initialize(): Promise<unknown>
  slide(h: number, v?: number): void
  next(): void
  prev(): void
  on(event: 'slidechanged' | 'ready', listener: () => void): void
  getCurrentSlide(): HTMLElement | null
  getHorizontalSlides(): HTMLElement[]
  destroy(): void
}

/** What a remote control can do to the presentation. Set while the presentation is running. */
export interface PresentControl {
  next(): void
  prev(): void
  first(): void
  last(): void
  /** Moves to the slide with this id. Does nothing when the slide is not shown (for example, hidden). */
  goToSlide(slideId: string): void
}

/** Where the presentation is now. `index` is 1-based and counts every slide in the deck, hidden ones included. */
export interface PresentPosition {
  index: number
  total: number
  slideId: string
}

export function PresentDeck({
  deck,
  startSlide,
  control,
  onPosition,
}: {
  deck: Deck
  startSlide?: number
  control?: MutableRefObject<PresentControl | null>
  onPosition?: (position: PresentPosition) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const css = useMemo(() => `${themeCssVariables(deck.theme)}\n${BASE_CSS}`, [deck.theme])
  useGoogleFontsLink(deck.theme)
  const slidesHtml = useMemo(() => deck.slides.map((s) => renderSlideHtml(s, deck)).join('\n'), [deck])
  const firstSlide = useRef(startSlide)
  const positionListener = useRef(onPosition)
  positionListener.current = onPosition
  const deckRef = useRef(deck)
  deckRef.current = deck

  useEffect(() => {
    let cancelled = false
    let reveal: RevealInstance | undefined
    void (async () => {
      const { default: Reveal } = await import('reveal.js/dist/reveal.esm.js')
      if (cancelled || !hostRef.current) return
      reveal = new (Reveal as unknown as new (el: HTMLElement, opts: object) => RevealInstance)(hostRef.current, {
        width: 1920,
        height: 1080,
        margin: 0,
        hash: false,
      })
      const instance = reveal
      await instance.initialize()
      if (cancelled) return

      const report = () => {
        const id = instance.getCurrentSlide()?.dataset.slideId
        if (!id) return
        const current = deckRef.current
        const index = current.slides.findIndex((s) => s.id === id)
        if (index >= 0) positionListener.current?.({ index: index + 1, total: current.slides.length, slideId: id })
      }
      instance.on('slidechanged', report)
      instance.on('ready', report)

      const horizontal = () => instance.getHorizontalSlides()
      if (control) {
        control.current = {
          next: () => instance.next(),
          prev: () => instance.prev(),
          first: () => instance.slide(0),
          last: () => instance.slide(Math.max(0, horizontal().length - 1)),
          goToSlide: (slideId) => {
            const h = horizontal().findIndex((el) => el.dataset.slideId === slideId)
            if (h >= 0) instance.slide(h)
          },
        }
      }

      const start = firstSlide.current
      if (start && start > 1) instance.slide(Math.min(start, deckRef.current.slides.length) - 1)
      report()
    })()
    return () => {
      cancelled = true
      if (control) control.current = null
      reveal?.destroy()
    }
  }, [slidesHtml, deck.slides.length, control])

  return (
    <div className="fixed inset-0 bg-black">
      <style>{css}</style>
      <div className="reveal" ref={hostRef} data-testid="present-root">
        <div className="slides" dangerouslySetInnerHTML={{ __html: slidesHtml }} />
      </div>
    </div>
  )
}
