// Google Slides, path B: the rules for the user's Google account. Which scopes it carries, the Picker settings, and the
// access token (through a token source, which is Better Auth in production). No Better Auth import here, so the rules
// can be unit-tested with a stand-in database and token source.
import { and, eq } from 'drizzle-orm'
import { account, type Db } from '@sleid/db'
import { ImportError } from './import.server'
import { DRIVE_FILE_SCOPE, RECONNECT_DRIVE } from './drive.server'

export const CONNECT_DRIVE_FIRST = 'Connect Google Drive first, so this app can read the presentation you pick.'

/** Parses the comma-separated scope column that Better Auth writes. */
export function scopesOf(scope: string | null | undefined): string[] {
  if (!scope) return []
  return scope
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface DriveAccountRow {
  id: string
  scope: string | null
}

/** The user's Google account, or null. */
export async function googleAccount(db: Db, userId: string): Promise<DriveAccountRow | null> {
  const [row] = await db
    .select({ id: account.id, scope: account.scope })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'google')))
    .limit(1)
  return row ?? null
}

/** True when the user's Google account carries the drive.file scope. */
export async function driveConnected(db: Db, userId: string): Promise<boolean> {
  const row = await googleAccount(db, userId)
  return row !== null && scopesOf(row.scope).includes(DRIVE_FILE_SCOPE)
}

/** The Picker settings the browser needs. The API key is a browser key (Google's Picker needs one), so it may be sent. */
export type PickerConfig = { pickerEnabled: false } | { pickerEnabled: true; pickerApiKey: string; projectNumber: string }

export function pickerConfig(env: NodeJS.ProcessEnv = process.env): PickerConfig {
  const apiKey = env.GOOGLE_PICKER_API_KEY?.trim() ?? ''
  const projectNumber = env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim() ?? ''
  if (!apiKey || !/^\d+$/.test(projectNumber)) return { pickerEnabled: false }
  return { pickerEnabled: true, pickerApiKey: apiKey, projectNumber }
}

/** The token-issuing part of Better Auth, so tests can stand in for it. */
export interface DriveTokenSource {
  getAccessToken(input: { accountId: string; userId: string }): Promise<{ accessToken?: string | null }>
}

/**
 * The user's Google access token for Drive. Better Auth refreshes it when it is about to expire. A missing scope asks
 * the user to connect Drive. A refresh that fails (revoked access, for example) asks them to reconnect.
 */
export async function driveAccessToken(db: Db, tokens: DriveTokenSource, userId: string): Promise<string> {
  const row = await googleAccount(db, userId)
  if (!row || !scopesOf(row.scope).includes(DRIVE_FILE_SCOPE)) throw new ImportError(CONNECT_DRIVE_FIRST, 409)
  let accessToken: string | null | undefined
  try {
    accessToken = (await tokens.getAccessToken({ accountId: row.id, userId })).accessToken
  } catch (err) {
    console.error('[drive] could not get an access token', err)
    throw new ImportError(RECONNECT_DRIVE, 403)
  }
  if (!accessToken) throw new ImportError(RECONNECT_DRIVE, 403)
  return accessToken
}

