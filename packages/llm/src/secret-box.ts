// Encryption for provider API keys at rest: AES-256-GCM with node:crypto.
// Key: LLM_SECRET_KEY, 32 random bytes, base64 (openssl rand -base64 32). Key rotation is not supported yet.
// Format: v1:<iv base64>:<auth tag base64>:<ciphertext base64>. A fresh 96-bit IV per call.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretBoxError'
  }
}

/** Parses a base64 key and checks it is exactly 32 bytes. */
export function parseSecretKey(base64: string | undefined): Buffer {
  if (!base64) throw new SecretBoxError('LLM_SECRET_KEY is not set. Generate one with: openssl rand -base64 32')
  const key = Buffer.from(base64.trim(), 'base64')
  if (key.length !== 32) throw new SecretBoxError('LLM_SECRET_KEY must decode to exactly 32 bytes (openssl rand -base64 32)')
  return key
}

export function encryptSecret(plaintext: string, keyBase64: string | undefined): string {
  if (plaintext.length === 0) throw new SecretBoxError('Nothing to encrypt')
  const key = parseSecretKey(keyBase64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptSecret(ciphertext: string, keyBase64: string | undefined): string {
  const key = parseSecretKey(keyBase64)
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('Stored secret has an unknown format')
  const iv = Buffer.from(parts[1]!, 'base64')
  const tag = Buffer.from(parts[2]!, 'base64')
  const data = Buffer.from(parts[3]!, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretBoxError('Stored secret has an invalid length')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    // Same message for a wrong key and a tampered value: nothing about the key leaks.
    throw new SecretBoxError('Stored secret could not be decrypted. Check LLM_SECRET_KEY.')
  }
}
