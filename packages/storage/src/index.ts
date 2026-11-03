// Blob storage for uploaded assets and finished exports. The database keeps the metadata
// (assets, exports tables); the driver keeps the bytes under a storage key.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface StorageDriver {
  readonly kind: 'local' | 's3'
  /** Writes (or overwrites) the object at `key`. */
  put(key: string, data: Uint8Array): Promise<void>
  /** The bytes at `key`, or null when there is no such object. */
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

// Keys are relative paths made of safe characters. No absolute paths, no "..", no backslashes.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}){0,3}$/

export function assertStorageKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`invalid storage key: ${key}`)
  return key
}

/** Keeps every object under `root`. Writes go to a temp file first, then rename, so readers never see half a file. */
export function createLocalStorage(root: string): StorageDriver {
  const base = resolve(root)
  const pathFor = (key: string) => {
    const full = resolve(base, assertStorageKey(key))
    if (!full.startsWith(base + sep)) throw new Error(`storage key escapes its root: ${key}`)
    return full
  }
  return {
    kind: 'local',
    async put(key, data) {
      const target = pathFor(key)
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, data)
      await rename(temp, target)
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true })
    },
  }
}

export interface S3StorageConfig {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Interface stub for an S3-compatible driver. Not implemented in M3: selecting it throws, so a
 * deployment cannot silently write to the local disk while it believes it uses S3.
 */
export function createS3Storage(_config: S3StorageConfig): StorageDriver {
  throw new Error('S3-compatible storage is not implemented yet (the local driver is the only one in M3)')
}

/** The repository root: the closest parent directory that has pnpm-workspace.yaml, or `start` when none. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

/**
 * A data directory from an environment value. Relative values resolve against the repository root, so
 * the web app and the worker (which run in different folders) agree on where files are.
 */
export function resolveDataDir(value: string | undefined, fallback: string, cwd: string = process.cwd()): string {
  const raw = value && value.trim() !== '' ? value.trim() : fallback
  return isAbsolute(raw) ? raw : resolve(findRepoRoot(cwd), raw)
}

export interface StorageEnv {
  /** `local` (default) or `s3` (not implemented). */
  STORAGE_DRIVER?: string
  ASSET_DIR?: string
  EXPORT_DIR?: string
}

export function assetStorageFromEnv(env: StorageEnv = process.env as StorageEnv, cwd?: string): StorageDriver {
  const driver = (env.STORAGE_DRIVER ?? 'local').trim()
  if (driver === 's3') return createS3Storage({ bucket: '', region: '', accessKeyId: '', secretAccessKey: '' })
  if (driver !== 'local') throw new Error(`STORAGE_DRIVER must be local or s3, not ${driver}`)
  return createLocalStorage(resolveDataDir(env.ASSET_DIR, 'data/assets', cwd))
}

export function exportStorageFromEnv(env: StorageEnv = process.env as StorageEnv, cwd?: string): StorageDriver {
  const driver = (env.STORAGE_DRIVER ?? 'local').trim()
  if (driver === 's3') return createS3Storage({ bucket: '', region: '', accessKeyId: '', secretAccessKey: '' })
  if (driver !== 'local') throw new Error(`STORAGE_DRIVER must be local or s3, not ${driver}`)
  return createLocalStorage(resolveDataDir(env.EXPORT_DIR, 'data/exports', cwd))
}
