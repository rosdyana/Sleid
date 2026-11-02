import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** Serves one directory on 127.0.0.1 on a free port. Only files inside the directory are served. */
export async function serveDirectory(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const base = resolve(root)
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    let path: string
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (path.includes('\0')) return void res.writeHead(400).end()
    const relative = path === '/' ? 'index.html' : path.slice(1)
    const full = resolve(base, relative)
    if (!full.startsWith(base + sep)) return void res.writeHead(403).end()
    let stat
    try {
      stat = statSync(full)
    } catch {
      return void res.writeHead(404).end()
    }
    if (!stat.isFile()) return void res.writeHead(404).end()
    res.writeHead(200, {
      'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(full).pipe(res)
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('static server has no port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}
