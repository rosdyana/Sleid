import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import type { Deck, Element, RichNode, TextElement } from '@sleid/model'
import { fullDeck } from '../../../model/src/fixtures.ts'
import { deckToPptx, type PptxAsset } from '../index.ts'
import { pptxToDeck, PptxImportError } from './index.ts'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG: PptxAsset = { data: Uint8Array.from(Buffer.from(PNG_B64, 'base64')), mime: 'image/png' }

const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function plain(nodes: RichNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : plain(n.content)))
    .join('')
}

/** Paragraph breaks and spacing collapsed, so the exporter's paragraph splits do not count. */
function textOf(el: Element): string {
  return el.type === 'text' ? (el.content.content ?? []).map((p) => plain(p.content)).join(' ').replace(/\s+/g, ' ').trim() : ''
}


// ---------------------------------------------------------------------------
// Round trip: our own exporter, then the importer
// ---------------------------------------------------------------------------

describe('round trip through deckToPptx', () => {
  it('keeps slide count, titles, text, positions, notes, tables and chart data', async () => {
    const source = fullDeck()
    const bytes = await deckToPptx(source, { resolveAsset: async () => PNG })
    const { deck, warnings } = await pptxToDeck(bytes)

    expect(deck.slides).toHaveLength(source.slides.length)
    expect(warnings.some((w) => w.includes('not 16:9'))).toBe(false)

    source.slides.forEach((slide, i) => {
      const imported = deck.slides[i]!
      // Hidden slides are kept and marked, as the exporter writes them.
      expect(imported.hidden).toBe(slide.hidden)
      if (slide.notes) expect(imported.notes).toBe(slide.notes)

      const titleIn = slide.elements.find((e) => e.type === 'text' && e.role === 'title')
      // Empty placeholders are not imported, by design.
      if (titleIn && textOf(titleIn).trim() !== '') {
        const titleOut = imported.elements.find((e) => e.type === 'text' && e.role === 'title')
        expect(titleOut && textOf(titleOut)).toBe(textOf(titleIn))
      }

      for (const el of slide.elements) {
        if (el.type !== 'text' || textOf(el).trim() === '') continue
        const match = imported.elements.find((e) => e.type === 'text' && textOf(e) === textOf(el))
        expect(match, `text "${textOf(el).slice(0, 30)}" on slide ${i + 1}`).toBeDefined()
        if (!match) continue
        expect(Math.abs(match.x - Math.round(el.x))).toBeLessThanOrEqual(2)
        expect(Math.abs(match.y - Math.round(el.y))).toBeLessThanOrEqual(2)
        expect(Math.abs(match.w - Math.round(el.w))).toBeLessThanOrEqual(2)
      }

      for (const el of slide.elements) {
        if (el.type === 'table') {
          const out = imported.elements.find((e) => e.type === 'table')
          expect(out && out.type === 'table' ? out.rows : null).toEqual(el.rows)
        }
        if (el.type === 'chart' && (el.chartType === 'bar' || el.chartType === 'line' || el.chartType === 'area')) {
          const out = imported.elements.find((e) => e.type === 'chart')
          expect(out?.type === 'chart' ? out.data.rows : null).toEqual(
            el.data.rows.map((r) => r.map((cell) => (cell === null ? 0 : cell))).map((r, ri) => [String(el.data.rows[ri]![0] ?? ''), ...r.slice(1)]),
          )
          expect(out?.type === 'chart' ? out.data.columns.slice(1) : null).toEqual(el.data.columns.slice(1))
        }
      }
    })
  })

  it('reads the theme part, although the exporter writes no theme of its own', async () => {
    const bytes = await deckToPptx(fullDeck(), { resolveAsset: async () => PNG })
    const { deck } = await pptxToDeck(bytes)
    // The exporter writes no colour scheme, so the imported palette is pptxgenjs's default.
    // Only the structure is checked here; the colours are covered by the hand-written fixture.
    expect(deck.theme.colors.background).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(deck.theme.fonts.body.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// A hand-written package
// ---------------------------------------------------------------------------

interface Parts {
  [name: string]: string
}

async function buildPackage(parts: Parts): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, body] of Object.entries(parts)) zip.file(name, body)
  return zip.generateAsync({ type: 'uint8array' })
}

function replaceBytes(bytes: Uint8Array, from: string, to: string): Uint8Array {
  expect(from.length).toBe(to.length)
  const out = Uint8Array.from(bytes)
  const needle = Buffer.from(from)
  const replacement = Buffer.from(to)
  let at = Buffer.from(out).indexOf(needle)
  while (at >= 0) {
    out.set(replacement, at)
    at = Buffer.from(out).indexOf(needle, at + replacement.length)
  }
  return out
}

const REL_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const rels = (items: string[]) =>
  `${REL_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
const rel = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const THEME = `${REL_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture theme"><a:themeElements>
<a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FAFAFA"/></a:lt1>
<a:dk2><a:srgbClr val="333344"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
<a:accent1><a:srgbClr val="E4572E"/></a:accent1><a:accent2><a:srgbClr val="17BEBB"/></a:accent2><a:accent3><a:srgbClr val="FFC914"/></a:accent3><a:accent4><a:srgbClr val="2E282A"/></a:accent4>
<a:accent5><a:srgbClr val="000000"/></a:accent5><a:accent6><a:srgbClr val="000000"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`

// The layout gives the title a position. The slide's title has no xfrm and inherits it.
const LAYOUT = `${REL_HEAD}<p:sldLayout ${NS} type="title"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr anchor="ctr"/><a:p><a:r><a:t>Click to edit</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>`

const MASTER = `${REL_HEAD}<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`

const NOTES = `${REL_HEAD}<p:notes ${NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="1" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Speaker note here</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`

const SLIDE = `${REL_HEAD}<p:sld ${NS}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1" sz="4000"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Quarterly review</a:t></a:r></a:p></p:txBody></p:sp>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Box in group"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></p:spPr></p:sp>
</p:grpSp>
<p:sp><p:nvSpPr><p:cNvPr id="5" name="Star"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="100000" y="5000000"/><a:ext cx="500000" cy="500000"/></a:xfrm><a:prstGeom prst="star5"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill></p:spPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="6" name="Link box"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="3000000" y="3000000"/><a:ext cx="3000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="rId3"/></a:rPr><a:t>Visit</a:t></a:r><a:r><a:t> the site</a:t></a:r></a:p></p:txBody></p:sp>
<p:contentPart r:id="rId9"/>
</p:spTree></p:cSld></p:sld>`

const PRESENTATION_4X3 = `${REL_HEAD}<p:presentation ${NS}><p:sldMasterIdLst/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

function fixtureParts(overrides: Parts = {}): Parts {
  return {
    '[Content_Types].xml': `${REL_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    'ppt/presentation.xml': PRESENTATION_4X3,
    'ppt/_rels/presentation.xml.rels': rels([rel('rId1', `${T}/slide`, 'slides/slide1.xml')]),
    'ppt/slides/slide1.xml': SLIDE,
    'ppt/slides/_rels/slide1.xml.rels': rels([
      rel('rId1', `${T}/slideLayout`, '../slideLayouts/slideLayout1.xml'),
      rel('rId2', `${T}/notesSlide`, '../notesSlides/notesSlide1.xml'),
      rel('rId3', `${T}/hyperlink`, 'https://example.com/page', true),
    ]),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([rel('rId1', `${T}/slideMaster`, '../slideMasters/slideMaster1.xml')]),
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([rel('rId1', `${T}/theme`, '../theme/theme1.xml')]),
    'ppt/theme/theme1.xml': THEME,
    'ppt/notesSlides/notesSlide1.xml': NOTES,
    'docProps/core.xml': `${REL_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Minimal fixture</dc:title></cp:coreProperties>`,
    ...overrides,
  }
}

describe('hand-written PPTX fixture', () => {
  it('imports a 4:3 slide with an inherited title position, a group, a hyperlink, notes and a theme', async () => {
    const bytes = await buildPackage(fixtureParts())
    const { deck, warnings } = await pptxToDeck(bytes)

    expect(deck.title).toBe('Minimal fixture')
    expect(deck.slides).toHaveLength(1)
    expect(deck.theme.name).toBe('Fixture theme')
    expect(deck.theme.colors.accent).toBe('#E4572E')
    expect(deck.theme.colors.background).toBe('#FAFAFA')
    expect(deck.theme.fonts.heading).toBe('Georgia')
    expect(deck.theme.fonts.body).toBe('Verdana')

    const slide = deck.slides[0]!
    expect(slide.notes).toBe('Speaker note here')

    // 4:3 onto 1920 x 1080: scale 1080/6858000, centred with 240 px on each side.
    const title = slide.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title')!
    expect(title).toBeDefined()
    expect(Math.abs(title.x - 312)).toBeLessThanOrEqual(1)
    expect(Math.abs(title.w - 1296)).toBeLessThanOrEqual(1)
    expect(textOf(title)).toBe('Quarterly review')
    const run = title.content.content![0]!.content![0]!
    expect(run.marks?.some((m) => m.type === 'bold')).toBe(true)
    expect(run.marks?.some((m) => m.type === 'textStyle' && m.attrs?.color === '#FF0000')).toBe(true)

    // The group is 2x its child space, so the 500000 EMU child box is 1000000 EMU on the slide.
    const box = slide.elements.find((e) => e.type === 'shape' && e.fill === '#00AA00')!
    expect(box).toBeDefined()
    expect(Math.abs(box.x - (240 + 1000000 * (1080 / 6858000)))).toBeLessThanOrEqual(1)
    expect(Math.abs(box.w - 1000000 * (1080 / 6858000))).toBeLessThanOrEqual(1)

    // The external link is a link mark with its target, not a fetch.
    const link = slide.elements.find((e): e is TextElement => e.type === 'text' && textOf(e).startsWith('Visit'))!
    const linkRun = link.content.content![0]!.content![0]!
    expect(linkRun.marks?.find((m) => m.type === 'link')?.attrs).toMatchObject({ href: 'https://example.com/page' })

    // A preset that is not supported is a rectangle, with a warning. The unknown element is skipped.
    const star = slide.elements.find((e) => e.type === 'shape' && e.fill === '#FFCC00')
    expect(star && star.type === 'shape' ? star.shape : null).toBe('rect')
    expect(warnings.some((w) => w.includes('"star5"'))).toBe(true)
    expect(warnings.some((w) => w.includes('p:contentPart'))).toBe(true)
    expect(warnings.some((w) => w.includes('not 16:9'))).toBe(true)
  })

  it('reads a chart and a table from the same kinds of parts the exporter writes', async () => {
    const chart = `${REL_HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>S!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>S!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>S!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>19.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
</c:barChart></c:plotArea><c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>`
    const slide = SLIDE.replace(
      '<p:contentPart r:id="rId9"/>',
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="20" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="500000" y="2000000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/></a:graphicData></a:graphic></p:graphicFrame>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="21" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="5000000" y="2000000"/><a:ext cx="3000000" cy="1000000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>
<a:tblGrid><a:gridCol w="1500000"/><a:gridCol w="1500000"/></a:tblGrid>
<a:tr h="500000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Item</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Count</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr h="500000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Pens</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>4</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    )
    const parts = fixtureParts({
      'ppt/slides/slide1.xml': slide,
      'ppt/slides/_rels/slide1.xml.rels': rels([
        rel('rId1', `${T}/slideLayout`, '../slideLayouts/slideLayout1.xml'),
        rel('rId5', `${T}/chart`, '../charts/chart1.xml'),
      ]),
      'ppt/charts/chart1.xml': chart,
    })
    const { deck } = await pptxToDeck(await buildPackage(parts))
    const els = deck.slides[0]!.elements
    const c = els.find((e) => e.type === 'chart')
    expect(c && c.type === 'chart' ? c.chartType : null).toBe('bar')
    expect(c && c.type === 'chart' ? c.data.columns : null).toEqual(['Category', 'Revenue'])
    expect(c && c.type === 'chart' ? c.data.rows : null).toEqual([
      ['Q1', 12],
      ['Q2', 19.5],
    ])
    expect(c && c.type === 'chart' ? c.options.legend : null).toBe(true)
    const t = els.find((e) => e.type === 'table')
    expect(t && t.type === 'table' ? t.rows : null).toEqual([
      ['Item', 'Count'],
      ['Pens', '4'],
    ])
    expect(t && t.type === 'table' ? t.header : null).toBe(true)
  })

  it('imports a chart type it does not support as a placeholder text with a warning', async () => {
    const chart = `${REL_HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:bubbleChart/></c:plotArea></c:chart></c:chartSpace>`
    const slide = SLIDE.replace(
      '<p:contentPart r:id="rId9"/>',
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="20" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="500000" y="2000000"/><a:ext cx="4000000" cy="3000000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/></a:graphicData></a:graphic></p:graphicFrame>`,
    )
    const parts = fixtureParts({
      'ppt/slides/slide1.xml': slide,
      'ppt/slides/_rels/slide1.xml.rels': rels([rel('rId1', `${T}/slideLayout`, '../slideLayouts/slideLayout1.xml'), rel('rId5', `${T}/chart`, '../charts/chart1.xml')]),
      'ppt/charts/chart1.xml': chart,
    })
    const { deck, warnings } = await pptxToDeck(await buildPackage(parts))
    const placeholder = deck.slides[0]!.elements.find((e) => e.type === 'text' && textOf(e) === '[Chart not imported]')
    expect(placeholder).toBeDefined()
    expect(warnings.some((w) => w.includes('[Chart not imported]'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Limits and refusals
// ---------------------------------------------------------------------------

describe('limits and refusals', () => {
  it('refuses a file over the zip size cap', async () => {
    const bytes = await buildPackage(fixtureParts())
    await expect(pptxToDeck(bytes, { limits: { maxZipBytes: 100 } })).rejects.toThrow(/larger than/)
  })

  it('refuses a package whose declared expansion is over the total cap', async () => {
    const bytes = await buildPackage(fixtureParts())
    await expect(pptxToDeck(bytes, { limits: { maxUncompressedBytes: 1000 } })).rejects.toThrow(/expands to more than/)
  })

  it('refuses a part that is larger than the total budget', async () => {
    const big = `${REL_HEAD}<p:sld ${NS}><p:cSld><p:spTree>${'<p:sp><p:nvSpPr><p:cNvPr id="9" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr></p:sp>'.repeat(2000)}</p:spTree></p:cSld></p:sld>`
    const bytes = await buildPackage(fixtureParts({ 'ppt/slides/slide1.xml': big }))
    await expect(pptxToDeck(bytes, { limits: { maxUncompressedBytes: 20_000 } })).rejects.toThrow(/expands to more than/)
  })

  it('refuses a package with more entries than the cap', async () => {
    const bytes = await buildPackage(fixtureParts())
    await expect(pptxToDeck(bytes, { limits: { maxEntries: 3 } })).rejects.toThrow(/more than 3 entries/)
  })

  it('refuses names that climb out of the package', async () => {
    // JSZip resolves `..` when a file is added, so the name is patched in the raw bytes instead.
    // 'ab/evil.xml' and '../evil.xml' have the same length, so the zip headers stay valid.
    const bytes = await buildPackage(fixtureParts({ 'ab/evil.xml': '<x/>' }))
    const patched = replaceBytes(bytes, 'ab/evil.xml', '../evil.xml')
    await expect(pptxToDeck(patched)).rejects.toThrow(/leaves the package|unsafe path/)
  })

  it('refuses absolute and backslash names', async () => {
    const bytes = await buildPackage(fixtureParts({ '/abs.xml': '<x/>' }))
    await expect(pptxToDeck(bytes)).rejects.toBeInstanceOf(PptxImportError)
    const back = await buildPackage(fixtureParts({ 'ppt\\evil.xml': '<x/>' }))
    await expect(pptxToDeck(back)).rejects.toThrow(/unsafe path/)
  })

  it('refuses bytes that are not a zip', async () => {
    const text = new TextEncoder().encode('Just some notes saved with a .pptx name')
    await expect(pptxToDeck(text)).rejects.toThrow(/not a PowerPoint file/)
  })

  it('refuses a zip that is not a presentation', async () => {
    const bytes = await buildPackage({ 'readme.txt': 'hello' })
    await expect(pptxToDeck(bytes)).rejects.toThrow(/not a PowerPoint presentation/)
  })

  it('refuses malformed XML in a slide with a clear error', async () => {
    const bytes = await buildPackage(fixtureParts({ 'ppt/slides/slide1.xml': '<p:sld><p:cSld>' }))
    await expect(pptxToDeck(bytes)).rejects.toThrow(/not well-formed XML/)
  })

  it('refuses an entity declaration rather than expanding it', async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><p:sld ${NS}><p:cSld><p:spTree/></p:cSld></p:sld>`
    const bytes = await buildPackage(fixtureParts({ 'ppt/slides/slide1.xml': bomb }))
    await expect(pptxToDeck(bytes)).rejects.toThrow(/entity declaration/)
  })

  it('does not fetch an external relationship: the target is kept as text only', async () => {
    const bytes = await buildPackage(fixtureParts())
    const { deck } = await pptxToDeck(bytes)
    const hasImage = deck.slides[0]!.elements.some((e) => e.type === 'image')
    expect(hasImage).toBe(false)
  })
})
