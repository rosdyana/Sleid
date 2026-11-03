import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertStorageKey, createLocalStorage, createS3Storage, findRepoRoot, resolveDataDir } from './index.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'sleid-storage-test-'))
}

describe('local storage driver', () => {
  it('round-trips bytes and returns null for a missing key', async () => {
    const root = freshDir()
    const store = createLocalStorage(root)
    await store.put('abc-123', new Uint8Array([1, 2, 3]))
    expect(Array.from((await store.get('abc-123'))!)).toEqual([1, 2, 3])
    expect(await store.get('missing-key')).toBeNull()
    await store.delete('abc-123')
    expect(await store.get('abc-123')).toBeNull()
  })

  it('creates nested keys and overwrites atomically', async () => {
    const root = freshDir()
    const store = createLocalStorage(root)
    await store.put('exports/one/file.pdf', new Uint8Array([9]))
    await store.put('exports/one/file.pdf', new Uint8Array([7, 7]))
    expect(Array.from((await store.get('exports/one/file.pdf'))!)).toEqual([7, 7])
  })

  it('refuses keys that could escape the root', async () => {
    const store = createLocalStorage(freshDir())
    for (const bad of ['../secret', '/etc/passwd', 'a/../../b', 'a\\b', '', '.hidden', 'a//b', 'x'.repeat(300)]) {
      await expect(store.put(bad, new Uint8Array([1]))).rejects.toThrow(/invalid storage key|escapes/)
    }
    expect(() => assertStorageKey('ok/fine.pdf')).not.toThrow()
  })
})

describe('storage configuration', () => {
  it('the S3 driver is a stub that refuses to start', () => {
    expect(() => createS3Storage({ bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 's' })).toThrow(/not implemented/)
  })

  it('resolves relative data dirs against the repository root, not the working directory', () => {
    const root = findRepoRoot()
    expect(resolveDataDir(undefined, 'data/assets', join(root, 'apps', 'web'))).toBe(resolve(root, 'data/assets'))
    expect(resolveDataDir('./elsewhere', 'data/assets', join(root, 'apps', 'worker'))).toBe(resolve(root, 'elsewhere'))
    expect(resolveDataDir('/abs/dir', 'data/assets')).toBe('/abs/dir')
  })

  it('finds the repository root from a nested folder', () => {
    const root = findRepoRoot()
    expect(findRepoRoot(join(root, 'packages', 'storage', 'src'))).toBe(root)
  })
})
