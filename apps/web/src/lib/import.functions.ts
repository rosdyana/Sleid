// Server functions for the deck import. Each checks the session, then calls the plain functions in import.server.ts.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { db } from '~/db/client'
import { requireUser } from './session.server'
import { importDeps } from './import.deps.server'
import * as imports from './import.server'
import { importPublicSlides } from './google-slides.server'
import { betterAuthTokens, driveAccessToken, driveConnected, driveImportDeps, importDriveFile, pickerConfig } from './google-drive.server'

/** Base64 of up to the pptx cap, which is about a third larger once encoded. */
const MAX_BASE64_CHARS = Math.ceil((imports.IMPORT_LIMITS.pptxBytes * 4) / 3) + 16

/** Starts an import of a file sent as base64. Large files should use POST /api/imports (raw bytes). */
export const startImportFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        format: z.enum(['pptx', 'markdown', 'json']),
        fileName: z.string().min(1).max(300),
        contentBase64: z.string().min(1).max(MAX_BASE64_CHARS),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const bytes = imports.decodeBase64(data.contentBase64)
    return imports.startImport(importDeps(), user, { format: data.format, fileName: data.fileName, bytes })
  })

/** The status of one of the caller's imports. Other users get "not found". */
export const getImportFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => z.object({ importId: z.uuid() }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return imports.getImport(importDeps(), user, data.importId)
  })

/** Imports a public Google Slides link (path A). The presentation must be shared as "Anyone with the link". */
export const importGoogleSlidesFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ url: z.string().min(1).max(2000) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return importPublicSlides(importDeps(), user, data.url)
  })

/** What the Import dialog needs to know about Google: whether the Picker is configured, and whether Drive is connected. */
export const googleImportConfigFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  return { ...pickerConfig(), driveConnected: await driveConnected(db, user.id) }
})

/**
 * The access token the browser needs to show the Google Picker (the Picker cannot list Drive without one). Only
 * for a signed-in user with the drive.file scope, and only when the Picker is configured. The token is the user's
 * own and is used for the Picker alone. The Drive export itself runs on the server (importFromDriveFn).
 */
export const drivePickerTokenFn = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser()
  if (!pickerConfig().pickerEnabled) throw new Error('Google Drive import is not set up on this server.')
  return { accessToken: await driveAccessToken(db, betterAuthTokens, user.id) }
})

/** Imports a presentation the user picked in the Google Picker. The server exports it from Drive. */
export const importFromDriveFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => z.object({ fileId: z.string().min(10).max(200).regex(/^[A-Za-z0-9_-]+$/) }).parse(data))
  .handler(async ({ data }) => {
    const user = await requireUser()
    if (!pickerConfig().pickerEnabled) throw new Error('Google Drive import is not set up on this server.')
    return importDriveFile(driveImportDeps(), user, data.fileId)
  })
