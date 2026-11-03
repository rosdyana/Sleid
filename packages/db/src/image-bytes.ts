// Image type checks and pixel sizes, read from the bytes themselves. Pure functions: no database, no storage.

export const ASSET_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** Checks the first bytes against the claimed type. SVG must be text with no active content. */
export function bytesMatchMime(mime: string, bytes: Uint8Array): boolean {
  const head = (n: number) => Array.from(bytes.subarray(0, n))
  switch (mime) {
    case 'image/png':
      return head(8).join(',') === '137,80,78,71,13,10,26,10'
    case 'image/jpeg':
      return head(3).join(',') === '255,216,255'
    case 'image/gif': {
      const s = new TextDecoder().decode(bytes.subarray(0, 6))
      return s === 'GIF87a' || s === 'GIF89a'
    }
    case 'image/webp': {
      const riff = new TextDecoder().decode(bytes.subarray(0, 4))
      const webp = new TextDecoder().decode(bytes.subarray(8, 12))
      return riff === 'RIFF' && webp === 'WEBP'
    }
    case 'image/svg+xml': {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 2_000_000)
      if (!/<svg[\s>]/i.test(text)) return false
      return !/<script|<!entity|<!doctype[^>]*\[|javascript:|\son[a-z]+\s*=|<foreignobject|<iframe|<embed|<object/i.test(text)
    }
    default:
      return false
  }
}

export interface ImageSize {
  width: number
  height: number
}

/**
 * The pixel size of an image, read from its header, or null when the header cannot be read.
 * PNG: IHDR. GIF: logical screen. JPEG: the first SOF0 or SOF2 frame. WebP: VP8, VP8L or VP8X chunk.
 * SVG: the width and height attributes (unitless or px), otherwise the viewBox.
 */
export function imageSize(mime: string, bytes: Uint8Array): ImageSize | null {
  let size: ImageSize | null
  switch (mime) {
    case 'image/png':
      size = pngSize(bytes)
      break
    case 'image/gif':
      size = gifSize(bytes)
      break
    case 'image/jpeg':
      size = jpegSize(bytes)
      break
    case 'image/webp':
      size = webpSize(bytes)
      break
    case 'image/svg+xml':
      size = svgSize(bytes)
      break
    default:
      return null
  }
  return size && size.width > 0 && size.height > 0 ? size : null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 24 || !bytesMatchMime('image/png', bytes) || ascii(bytes, 12, 16) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 10 || !bytesMatchMime('image/gif', bytes)) return null
  return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) }
}

/** Walks the marker segments until the first SOF0 or SOF2 frame header. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    let marker = bytes[i + 1]!
    i += 2
    // Fill bytes: any run of 0xFF before the marker byte is padding.
    while (marker === 0xff && i < bytes.length) {
      marker = bytes[i]!
      i++
    }
    // Markers with no length field: SOI, TEM, and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    // EOI or start of scan before any frame header: there is no size to read.
    if (marker === 0xd9 || marker === 0xda) return null
    if (i + 2 > bytes.length) return null
    const length = (bytes[i]! << 8) | bytes[i + 1]!
    if (length < 2) return null
    if (marker === 0xc0 || marker === 0xc2) {
      // Segment: length (2), precision (1), height (2), width (2).
      if (i + 7 > bytes.length) return null
      return { width: (bytes[i + 5]! << 8) | bytes[i + 6]!, height: (bytes[i + 3]! << 8) | bytes[i + 4]! }
    }
    i += length
  }
  return null
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 16 || !bytesMatchMime('image/webp', bytes)) return null
  const chunk = ascii(bytes, 12, 16)
  if (chunk === 'VP8 ') {
    // Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height, little-endian.
    if (bytes.byteLength < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f, then 14-bit width-1 and height-1 packed into 32 bits.
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return null
    const packed = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    // Extended: canvas width-1 and height-1 as 24-bit little-endian integers.
    if (bytes.byteLength < 30) return null
    return {
      width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
      height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
    }
  }
  return null
}

function svgSize(bytes: Uint8Array): ImageSize | null {
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 256 * 1024))
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!tag) return null
  const attr = (name: string): string | null => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)
    return m ? m[1]! : null
  }
  const width = parsePixels(attr('width'))
  const height = parsePixels(attr('height'))
  if (width && height) return { width: Math.round(width), height: Math.round(height) }
  const viewBox = attr('viewBox')
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) return { width: Math.round(parts[2]!), height: Math.round(parts[3]!) }
  }
  return null
}

/** A unitless or px length as a number. Percentages and other units are not pixels here, so they give null. */
function parsePixels(value: string | null): number | null {
  if (!value) return null
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value)
  return m ? Number(m[1]) : null
}
