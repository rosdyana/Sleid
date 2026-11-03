import { describe, expect, it } from 'vitest'
import type { Db } from '@sleid/db'
import { ImportError } from './import.server'
import { DRIVE_FILE_SCOPE, RECONNECT_DRIVE } from './drive.server'
import { CONNECT_DRIVE_FIRST, driveAccessToken, driveConnected, pickerConfig, scopesOf, type DriveTokenSource } from './google-drive-account'

/** A stand-in for the one query the account rules make: select ... from account where ... limit 1. */
function fakeDb(row: { id: string; scope: string | null } | null): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  }
  return chain as unknown as Db
}

const tokens = (result: { accessToken?: string | null } | Error): DriveTokenSource => ({
  getAccessToken: async () => {
    if (result instanceof Error) throw result
    return result
  },
})

describe('scopesOf', () => {
  it('reads the comma-separated scope column', () => {
    expect(scopesOf(`openid,email,profile,${DRIVE_FILE_SCOPE}`)).toEqual(['openid', 'email', 'profile', DRIVE_FILE_SCOPE])
    expect(scopesOf(' openid , email ,')).toEqual(['openid', 'email'])
    expect(scopesOf(null)).toEqual([])
    expect(scopesOf('')).toEqual([])
  })
})

describe('driveConnected', () => {
  it('is true only when the Google account carries drive.file', async () => {
    expect(await driveConnected(fakeDb({ id: 'a1', scope: `openid,${DRIVE_FILE_SCOPE}` }), 'u1')).toBe(true)
    expect(await driveConnected(fakeDb({ id: 'a1', scope: 'openid,email,profile' }), 'u1')).toBe(false)
    expect(await driveConnected(fakeDb(null), 'u1')).toBe(false)
  })
})

describe('driveAccessToken', () => {
  it('asks the user to connect Drive when there is no Google account or no drive.file scope', async () => {
    const none = await driveAccessToken(fakeDb(null), tokens({ accessToken: 'x' }), 'u1').catch((e: unknown) => e)
    expect(none).toBeInstanceOf(ImportError)
    expect((none as ImportError).message).toBe(CONNECT_DRIVE_FIRST)
    expect((none as ImportError).status).toBe(409)
    const narrow = await driveAccessToken(fakeDb({ id: 'a1', scope: 'openid' }), tokens({ accessToken: 'x' }), 'u1').catch((e: unknown) => e)
    expect((narrow as ImportError).status).toBe(409)
  })

  it('returns the token Better Auth gives for the account', async () => {
    const seenInput: unknown[] = []
    const source: DriveTokenSource = {
      getAccessToken: async (input) => {
        seenInput.push(input)
        return { accessToken: 'fresh-token' }
      },
    }
    const token = await driveAccessToken(fakeDb({ id: 'acc-9', scope: DRIVE_FILE_SCOPE }), source, 'user-7')
    expect(token).toBe('fresh-token')
    expect(seenInput).toEqual([{ accountId: 'acc-9', userId: 'user-7' }])
  })

  it('a refresh that fails (revoked access) becomes the reconnect message', async () => {
    const err = await driveAccessToken(fakeDb({ id: 'a1', scope: DRIVE_FILE_SCOPE }), tokens(new Error('invalid_grant')), 'u1').catch((e: unknown) => e)
    expect((err as ImportError).message).toBe(RECONNECT_DRIVE)
    expect((err as ImportError).status).toBe(403)
  })

  it('an empty token is treated the same way', async () => {
    const err = await driveAccessToken(fakeDb({ id: 'a1', scope: DRIVE_FILE_SCOPE }), tokens({ accessToken: null }), 'u1').catch((e: unknown) => e)
    expect((err as ImportError).message).toBe(RECONNECT_DRIVE)
  })
})

describe('pickerConfig', () => {
  it('is off unless both the browser key and the project number are set', () => {
    expect(pickerConfig({})).toEqual({ pickerEnabled: false })
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: 'key' })).toEqual({ pickerEnabled: false })
    expect(pickerConfig({ GOOGLE_CLOUD_PROJECT_NUMBER: '123456789' })).toEqual({ pickerEnabled: false })
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: 'key', GOOGLE_CLOUD_PROJECT_NUMBER: 'my-project' })).toEqual({ pickerEnabled: false })
  })

  it('is on when both are set, with the values trimmed', () => {
    expect(pickerConfig({ GOOGLE_PICKER_API_KEY: ' AIza-key ', GOOGLE_CLOUD_PROJECT_NUMBER: ' 123456789012 ' })).toEqual({
      pickerEnabled: true,
      pickerApiKey: 'AIza-key',
      projectNumber: '123456789012',
    })
  })
})
