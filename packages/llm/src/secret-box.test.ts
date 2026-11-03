import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, parseSecretKey, SecretBoxError } from './secret-box.ts'

const KEY = randomBytes(32).toString('base64')
const OTHER = randomBytes(32).toString('base64')

describe('secret box (AES-256-GCM)', () => {
  it('round-trips a key and never stores the plaintext', () => {
    const secret = 'sk-test-abcdef-1234567890'
    const sealed = encryptSecret(secret, KEY)
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain(secret)
    expect(decryptSecret(sealed, KEY)).toBe(secret)
  })

  it('uses a fresh IV for every value', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY))
  })

  it('refuses a wrong key with a message that does not reveal the key', () => {
    const sealed = encryptSecret('sk-live-value', KEY)
    let message = ''
    try {
      decryptSecret(sealed, OTHER)
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    expect(message).toMatch(/could not be decrypted/)
    expect(message).not.toContain(OTHER)
  })

  it('detects tampering with the ciphertext, the tag or the format', () => {
    const [v, iv, tag, data] = encryptSecret('sk-live-value', KEY).split(':') as [string, string, string, string]
    const flipped = Buffer.from(data, 'base64')
    flipped[0] = flipped[0]! ^ 0xff
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), KEY)).toThrow(SecretBoxError)
    expect(() => decryptSecret([v, iv, Buffer.alloc(16).toString('base64'), data].join(':'), KEY)).toThrow(SecretBoxError)
    expect(() => decryptSecret('v2:x:y:z', KEY)).toThrow(/unknown format/)
  })

  it('requires a 32-byte base64 key', () => {
    expect(() => parseSecretKey(undefined)).toThrow(/LLM_SECRET_KEY is not set/)
    expect(() => parseSecretKey(randomBytes(16).toString('base64'))).toThrow(/exactly 32 bytes/)
    expect(() => encryptSecret('', KEY)).toThrow(SecretBoxError)
  })
})
