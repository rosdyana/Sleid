// Client-side checks and helpers for a brand logo. The server checks the bytes again (checkLogoBytes).
import { useEffect, useState } from 'react'

export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_MIME = ['image/png', 'image/jpeg', 'image/svg+xml'] as const
export type LogoMime = (typeof LOGO_MIME)[number]

/** A message when the file cannot be a logo, or null when it can. */
export function logoProblem(file: File): string | null {
  if (!(LOGO_MIME as readonly string[]).includes(file.type)) return 'A logo must be a PNG, JPEG or SVG file.'
  if (file.size === 0) return 'The logo file is empty.'
  if (file.size > LOGO_MAX_BYTES) return 'The logo is larger than 2 MB.'
  return null
}

/** The file's bytes as base64 (no data: prefix), the form the upload function takes. */
export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}

/** An object URL for a file, revoked when the file changes or the component unmounts. */
export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) return setUrl(null)
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}
