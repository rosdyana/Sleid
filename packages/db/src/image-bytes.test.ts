import { describe, expect, it } from 'vitest'
import { bytesMatchMime, imageSize } from './image-bytes.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const b = (...values: number[]) => Uint8Array.from(values)
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** A real 1x1 PNG. */
const PNG_1X1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

/** PNG signature, then an IHDR chunk with the given size. The CRC is not read, so it is zeros. */
function pngHeader(width: number, height: number): Uint8Array {
  const u32 = (n: number) => b((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  return concat(
    b(137, 80, 78, 71, 13, 10, 26, 10),
    u32(13),
    enc('IHDR'),
    u32(width),
    u32(height),
    b(8, 2, 0, 0, 0),
    u32(0),
  )
}

/** JFIF APP0, then a frame header (SOF0 or SOF2 marker) for the given size, then EOI. */
function jpeg(marker: number, width: number, height: number): Uint8Array {
  return concat(
    b(0xff, 0xd8),
    b(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00),
    b(0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03),
    b(0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01),
    b(0xff, 0xd9),
  )
}

describe('imageSize', () => {
  it('reads the size of a real 1x1 PNG', () => {
    expect(imageSize('image/png', PNG_1X1)).toEqual({ width: 1, height: 1 })
  })

  it('reads a PNG IHDR with a larger size', () => {
    expect(imageSize('image/png', pngHeader(300, 200))).toEqual({ width: 300, height: 200 })
  })

  it('refuses a PNG with no IHDR chunk, and a truncated one', () => {
    expect(imageSize('image/png', concat(pngHeader(3, 3).subarray(0, 8), enc('XXXX________________')))).toBeNull()
    expect(imageSize('image/png', pngHeader(3, 3).subarray(0, 20))).toBeNull()
  })

  it('reads a baseline JPEG (SOF0)', () => {
    expect(imageSize('image/jpeg', jpeg(0xc0, 20, 10))).toEqual({ width: 20, height: 10 })
  })

  it('reads a progressive JPEG (SOF2)', () => {
    expect(imageSize('image/jpeg', jpeg(0xc2, 640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('refuses a JPEG with no frame header before the scan', () => {
    const noFrame = concat(b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00), b(0xff, 0xda, 0x00, 0x02))
    expect(imageSize('image/jpeg', noFrame)).toBeNull()
  })

  it('reads a GIF logical screen size', () => {
    expect(imageSize('image/gif', concat(enc('GIF89a'), b(3, 0, 2, 0, 0, 0, 0, 0)))).toEqual({ width: 3, height: 2 })
  })

  it('reads a lossy WebP (VP8)', () => {
    const webp = concat(enc('RIFF'), b(0, 0, 0, 0), enc('WEBP'), enc('VP8 '), b(0, 0, 0, 0), b(0x10, 0x00, 0x00), b(0x9d, 0x01, 0x2a), b(30, 0), b(40, 0))
    expect(imageSize('image/webp', webp)).toEqual({ width: 30, height: 40 })
  })

  it('reads a lossless WebP (VP8L): width-1 and height-1 packed into 32 bits', () => {
    // width-1 = 7 (8 px), height-1 = 4 (5 px): 7 | (4 << 14) = 65543
    const webp = concat(enc('RIFF'), b(0, 0, 0, 0), enc('WEBP'), enc('VP8L'), b(5, 0, 0, 0), b(0x2f), b(0x07, 0x00, 0x01, 0x00))
    expect(imageSize('image/webp', webp)).toEqual({ width: 8, height: 5 })
  })

  it('reads an extended WebP (VP8X) canvas', () => {
    // canvas width-1 = 19 (20 px), height-1 = 9 (10 px), as 24-bit little-endian
    const webp = concat(enc('RIFF'), b(0, 0, 0, 0), enc('WEBP'), enc('VP8X'), b(10, 0, 0, 0), b(0x10, 0, 0, 0), b(19, 0, 0), b(9, 0, 0))
    expect(imageSize('image/webp', webp)).toEqual({ width: 20, height: 10 })
  })

  it('reads SVG width and height attributes, with or without px', () => {
    expect(imageSize('image/svg+xml', enc('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"/>'))).toEqual({ width: 120, height: 60 })
    expect(imageSize('image/svg+xml', enc("<svg width='12.5px' height='8px'></svg>"))).toEqual({ width: 13, height: 8 })
  })

  it('falls back to the viewBox when the width or height is a percentage or missing', () => {
    expect(imageSize('image/svg+xml', enc('<svg width="100%" height="100%" viewBox="0 0 200 100"></svg>'))).toEqual({ width: 200, height: 100 })
    expect(imageSize('image/svg+xml', enc('<svg viewBox="0,0,64,32"></svg>'))).toEqual({ width: 64, height: 32 })
  })

  it('does not read stroke-width as the width', () => {
    expect(imageSize('image/svg+xml', enc('<svg stroke-width="4" viewBox="0 0 10 20"></svg>'))).toEqual({ width: 10, height: 20 })
  })

  it('returns null for an SVG with no size, and for an unknown type', () => {
    expect(imageSize('image/svg+xml', enc('<svg></svg>'))).toBeNull()
    expect(imageSize('image/bmp', PNG_1X1)).toBeNull()
  })
})

describe('bytesMatchMime', () => {
  it('accepts real signatures and refuses mismatches', () => {
    expect(bytesMatchMime('image/png', PNG_1X1)).toBe(true)
    expect(bytesMatchMime('image/png', jpeg(0xc0, 1, 1))).toBe(false)
    expect(bytesMatchMime('image/jpeg', b(0xff, 0xd8, 0xff, 0xe0))).toBe(true)
    expect(bytesMatchMime('image/gif', enc('GIF89a....'))).toBe(true)
    expect(bytesMatchMime('image/webp', enc('RIFF\0\0\0\0WEBPVP8 '))).toBe(true)
  })

  it('refuses an SVG with active content', () => {
    expect(bytesMatchMime('image/svg+xml', enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe(false)
    expect(bytesMatchMime('image/svg+xml', enc('<svg onload="x()"></svg>'))).toBe(false)
  })
})
