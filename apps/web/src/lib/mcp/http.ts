// POST, GET and DELETE /mcp. Checks the bearer token, the rate limit and the body size, then hands the request to the
// SDK's Streamable HTTP transport. Stateless: no session is kept, so every request stands on its own token check.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyApiToken, type VerifiedToken } from '@sleid/db'
import { createSleidMcpServer } from './server.ts'
import type { McpDeps } from './deps.ts'

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1]! : null
}

/** Reads a request body, stopping once it passes `max` bytes. Returns null when it is too large. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const secret = bearerToken(request.headers.get('authorization'))
  if (!secret) {
    return jsonRpcError(401, -32001, 'Missing bearer token. Create one in Settings › MCP access tokens.', { 'www-authenticate': 'Bearer realm="sleid"' })
  }

  let principal: VerifiedToken | null
  try {
    principal = await verifyApiToken(deps.db, secret)
  } catch (err) {
    deps.logger.error('token check failed', err)
    return jsonRpcError(503, -32003, 'The server could not check the token. Try again shortly.')
  }
  if (!principal) {
    return jsonRpcError(401, -32001, 'The token is not valid. It may be revoked or expired.', {
      'www-authenticate': 'Bearer realm="sleid", error="invalid_token"',
    })
  }

  const limit = deps.limiter.take(principal.tokenId)
  if (!limit.ok) {
    return jsonRpcError(429, -32029, 'Too many requests for this token. Slow down and try again.', { 'retry-after': String(limit.retryAfterSeconds) })
  }

  if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST, GET, DELETE' } })
  }

  let forwarded = request
  if (request.method === 'POST') {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > deps.maxBodyBytes) {
      return jsonRpcError(413, -32600, `The request body is larger than ${deps.maxBodyBytes} bytes.`)
    }
    const body = await readCapped(request, deps.maxBodyBytes)
    if (body === null) return jsonRpcError(413, -32600, `The request body is larger than ${deps.maxBodyBytes} bytes.`)
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    forwarded = new Request(request.url, { method: 'POST', headers, body })
  }

  const server = createSleidMcpServer(deps, principal)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    return await transport.handleRequest(forwarded)
  } catch (err) {
    deps.logger.error('MCP request failed', err)
    return jsonRpcError(500, -32603, 'Internal error.')
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}
