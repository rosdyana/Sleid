import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createDeck, createSlide, type Deck } from '@sleid/model'
import { deckToPptx } from './index.ts'

const PNG_BYTES = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

function branded(slides: 'all' | 'all-but-title' | 'none'): Deck {
  const deck = createDeck('Logo')
  deck.slides = [createSlide('title', deck.theme), createSlide('title-content', deck.theme)]
  deck.brand = {
    brandKitId: 'kit',
    logo: { src: '/api/assets/0f9f9d8e-1111-4222-8333-444455556666', placement: { corner: 'br', widthPct: 10, margin: 40, slides } },
  }
  return deck
}

async function slideXml(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
  return Promise.all(names.map((n) => zip.file(n)!.async('string')))
}

const resolveAsset = async () => ({ data: PNG_BYTES, mime: 'image/png' })

describe('brand logo in PPTX', () => {
  it('puts the logo on each slide the placement selects, and not on the title slide', async () => {
    const xml = await slideXml(await deckToPptx(branded('all-but-title'), { resolveAsset }))
    expect(xml[0]).not.toContain('descr="Logo"')
    expect(xml[1]).toContain('descr="Logo"')
  })

  it('puts the logo on every slide for all, and on none for none', async () => {
    const all = await slideXml(await deckToPptx(branded('all'), { resolveAsset }))
    expect(all.every((x) => x.includes('descr="Logo"'))).toBe(true)
    const none = await slideXml(await deckToPptx(branded('none'), { resolveAsset }))
    expect(none.some((x) => x.includes('descr="Logo"'))).toBe(false)
  })

  it('leaves the logo out when the asset cannot be resolved', async () => {
    const xml = await slideXml(await deckToPptx(branded('all'), { resolveAsset: async () => null }))
    expect(xml.some((x) => x.includes('descr="Logo"'))).toBe(false)
  })
})
