import { describe, expect, it } from 'vitest'
import { createDeck, createSlide, type Deck } from '@sleid/model'
import { logoOverlayHtml, renderSlideHtml } from './render.ts'

const ASSET = '/api/assets/0f9f9d8e-1111-4222-8333-444455556666'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function branded(slides: 'all' | 'all-but-title' | 'none', src = ASSET): Deck {
  const deck = createDeck('Branded')
  deck.slides = [createSlide('title', deck.theme), createSlide('title-content', deck.theme)]
  deck.brand = {
    brandKitId: 'kit',
    logo: { src, placement: { corner: 'tr', widthPct: 12, margin: 48, slides } },
  }
  return deck
}

describe('brand logo overlay', () => {
  it('is drawn on every slide when the placement says all', () => {
    const deck = branded('all')
    for (const slide of deck.slides) expect(renderSlideHtml(slide, deck)).toContain('class="sleid-brand-logo"')
  })

  it('skips the title layout when the placement says all but title', () => {
    const deck = branded('all-but-title')
    expect(renderSlideHtml(deck.slides[0]!, deck)).not.toContain('sleid-brand-logo')
    expect(renderSlideHtml(deck.slides[1]!, deck)).toContain('sleid-brand-logo')
  })

  it('is never drawn when the placement says none, or when there is no kit', () => {
    const none = branded('none')
    expect(renderSlideHtml(none.slides[1]!, none)).not.toContain('sleid-brand-logo')
    const plain = createDeck('Plain')
    expect(renderSlideHtml(plain.slides[0]!, plain)).not.toContain('sleid-brand-logo')
  })

  it('places the logo at the corner, with the margin and width, and never takes pointer events', () => {
    const deck = branded('all')
    const html = logoOverlayHtml(deck.slides[1]!, deck)
    expect(html).toContain('right:48px;top:48px')
    expect(html).toContain('width:12%')
    expect(html).toContain('pointer-events:none')
    expect(html).toContain(`src="${ASSET}"`)
  })

  it('is drawn from its file in an export bundle (the asset URL rewritten to assets/<id>.<ext>), and a path that escapes it is refused', () => {
    const bundled = 'assets/0f9f9d8e-1111-4222-8333-444455556666.png'
    const deck = branded('all', bundled)
    expect(logoOverlayHtml(deck.slides[1]!, deck)).toContain(`src="${bundled}"`)
    const escaping = branded('all', 'assets/../secret.png')
    expect(logoOverlayHtml(escaping.slides[1]!, escaping)).toBe('')
  })

  it('accepts a raster data URL and refuses a remote or SVG data URL', () => {
    expect(logoOverlayHtml(branded('all', PNG).slides[1]!, branded('all', PNG))).toContain('data:image/png')
    const remote = branded('all', 'https://evil.example/logo.png')
    expect(logoOverlayHtml(remote.slides[1]!, remote)).toBe('')
    const svg = branded('all', 'data:image/svg+xml;base64,PHN2Zy8+')
    expect(logoOverlayHtml(svg.slides[1]!, svg)).toBe('')
  })
})
