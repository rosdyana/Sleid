import { LIMITS } from './limits.ts'

/** Splits text on paragraph breaks into pieces of about `size` characters. A paragraph longer than `size` is cut. */
export function chunkText(text: string, size: number = LIMITS.chunkChars): string[] {
  const chunks: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const paragraph of text.split(/\n{2,}/)) {
    let piece = paragraph
    while (piece.length > size) {
      if (current) push()
      chunks.push(piece.slice(0, size).trim())
      piece = piece.slice(size)
    }
    if (current && current.length + piece.length + 2 > size) push()
    current = current ? `${current}\n\n${piece}` : piece
  }
  push()
  return chunks
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
