// Network policy for provider endpoints. Endpoints are chosen by users, so the server must not become a
// proxy for internal services (SSRF: the collab internal API, Postgres, cloud metadata). Every endpoint is
// checked when it is saved and again before each request. A request connects only to the addresses that
// passed the check (the pinned fetch below), so a DNS answer that changes between the check and the connect
// (DNS rebinding) cannot send the request somewhere else. Redirects are never followed.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { LlmError } from './errors.ts'

export interface UrlPolicy {
  /**
   * Loopback, private, shared (CGNAT) and other non-public addresses are allowed when true.
   * Link-local and cloud-metadata addresses are refused either way.
   */
  allowPrivate: boolean
}

export interface ResolvedAddress {
  address: string
  family: number
}

/** Resolves a host name to every address it has. Injected by tests. */
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>

export const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'multicast'
  | 'broadcast'
  | 'reserved'

const DESCRIPTION: Record<Exclude<AddressClass, 'public'>, string> = {
  loopback: 'a loopback address',
  private: 'a private network address',
  cgnat: 'a shared (CGNAT) network address',
  'link-local': 'a link-local address',
  metadata: 'a cloud metadata address',
  unspecified: 'an unspecified address',
  multicast: 'a multicast address',
  broadcast: 'a broadcast address',
  reserved: 'a reserved address',
}

/** Classes that are refused even when the policy allows private addresses. */
const ALWAYS_REFUSED: ReadonlySet<AddressClass> = new Set<AddressClass>(['link-local', 'metadata'])

const METADATA_V6 = [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54] // fd00:ec2::254

function classifyV4(a: number, b: number, c: number, d: number): AddressClass {
  if (a === 0) return 'unspecified' // 0.0.0.0/8
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local' // includes 169.254.169.254 (cloud metadata)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved' // 240.0.0.0/4
  // Documentation and benchmarking ranges: never a real provider.
  if ((a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
    return 'reserved'
  }
  return 'public'
}

/** Parses an IPv6 literal (without zone id) into 16 bytes. Null when it is not valid. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase()
  let v4: number[] | null = null
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null
    v4 = tail.split('.').map(Number)
    s = `${s.slice(0, lastColon + 1)}0:0`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const words = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const p of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null
      out.push(parseInt(p, 16))
    }
    return out
  }
  const head = words(halves[0] ?? '')
  const rest = halves.length === 2 ? words(halves[1] ?? '') : []
  if (!head || !rest) return null
  let all: number[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    all = [...head, ...new Array<number>(missing).fill(0), ...rest]
  } else {
    all = head
  }
  if (all.length !== 8) return null
  const bytes: number[] = []
  for (const w of all) bytes.push(w >> 8, w & 0xff)
  if (v4) bytes.splice(12, 4, ...v4)
  return bytes
}

function classifyV6(b: number[]): AddressClass {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zeros(0, 16)) return 'unspecified'
  if (zeros(0, 15) && b[15] === 1) return 'loopback'
  if (METADATA_V6.every((x, i) => b[i] === x)) return 'metadata'
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the embedded IPv4.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b[12]!, b[13]!, b[14]!, b[15]!)
  if (zeros(0, 12)) return classifyV4(b[12]!, b[13]!, b[14]!, b[15]!)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return classifyV4(b[12]!, b[13]!, b[14]!, b[15]!)
  // 6to4 (2002::/16) routes to the IPv4 address in bits 16 to 48.
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b[2]!, b[3]!, b[4]!, b[5]!)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local' // fe80::/10
  if ((b[0]! & 0xfe) === 0xfc) return 'private' // fc00::/7 unique local
  if (b[0] === 0xff) return 'multicast' // ff00::/8
  // Global unicast is 2000::/3. Documentation (2001:db8::/32) and Teredo (2001::/32) are refused.
  if ((b[0]! & 0xe0) === 0x20) {
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'reserved'
    return 'public'
  }
  return 'reserved'
}

/** The class of one IP address (v4 or v6, with or without a zone id). Unparseable input is 'reserved'. */
export function classifyAddress(raw: string): AddressClass {
  const address = raw.split('%')[0]!.trim()
  const family = isIP(address)
  if (family === 4) {
    const p = address.split('.').map(Number)
    return classifyV4(p[0]!, p[1]!, p[2]!, p[3]!)
  }
  if (family === 6) {
    const bytes = parseIPv6(address)
    return bytes ? classifyV6(bytes) : 'reserved'
  }
  return 'reserved'
}

const HINT = 'A provider added by an administrator for the workspace may use it. On a single-user setup, set LLM_USER_ALLOW_PRIVATE_URLS=1.'

/** The noun phrase that says why an address class is refused, or null when it is allowed. */
export function refusalFor(cls: AddressClass, policy: UrlPolicy): string | null {
  if (cls === 'public') return null
  if (ALWAYS_REFUSED.has(cls)) return `${DESCRIPTION[cls]}, which is never allowed`
  if (!policy.allowPrivate) return `${DESCRIPTION[cls]}, which is not allowed for this provider. ${HINT}`
  return null
}

export interface VettedEndpoint {
  url: URL
  /** Every address the host resolved to. All of them passed the policy. */
  addresses: ResolvedAddress[]
}

function refuse(message: string): LlmError {
  return new LlmError('bad-request', message)
}

/**
 * Checks an endpoint URL against the policy. The host is resolved (unless it is an IP literal) and every
 * resulting address is checked: one refused address refuses the endpoint. Returns the parsed URL and the
 * vetted addresses, which the pinned fetch connects to.
 */
export async function assertAllowedEndpoint(input: string, policy: UrlPolicy, lookup: LookupFn = defaultLookup): Promise<VettedEndpoint> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw refuse('The endpoint is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('The endpoint must start with http:// or https://.')
  if (url.username || url.password) throw refuse('The endpoint must not contain a user name or password. Put the key in the API key field.')
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  if (!host) throw refuse('The endpoint has no host name.')

  const literal = isIP(host) !== 0
  let addresses: ResolvedAddress[]
  if (literal) {
    addresses = [{ address: host, family: isIP(host) }]
  } else {
    if (!policy.allowPrivate && (host === 'localhost' || host.endsWith('.localhost'))) {
      throw refuse(`"${host}" resolves to ${DESCRIPTION.loopback}, which is not allowed for this provider. ${HINT}`)
    }
    try {
      addresses = await lookup(host)
    } catch (err) {
      throw new LlmError('bad-request', `The host name "${host}" could not be resolved.`, { cause: err })
    }
    if (addresses.length === 0) throw refuse(`The host name "${host}" could not be resolved.`)
  }

  for (const { address } of addresses) {
    const reason = refusalFor(classifyAddress(address), policy)
    if (reason) throw refuse(literal ? `The address ${host} is ${reason}.` : `"${host}" resolves to ${reason}.`)
  }
  return { url, addresses }
}

function pinnedLookup(addresses: ResolvedAddress[]) {
  // Answers only with the vetted addresses. Node asks for the list when `all` is set, otherwise for one address.
  return (_hostname: string, options: unknown, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    if (all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  }
}

export interface PinnedFetchOptions {
  lookup?: LookupFn
}

/**
 * A fetch that checks the URL against the policy, then sends the request to the vetted addresses only.
 * The Host header and TLS server name stay the original host name. Redirects are returned as they are
 * (never followed), so the adapters treat a 3xx status as an error.
 */
export function createPinnedFetch(policy: UrlPolicy, options: PinnedFetchOptions = {}): typeof fetch {
  const lookup = options.lookup ?? defaultLookup
  const pinned = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { url, addresses } = await assertAllowedEndpoint(href, policy, lookup)
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) } as never })
    try {
      const response = await undiciFetch(url, { ...(init as Record<string, unknown> | undefined), redirect: 'manual', dispatcher } as never)
      return response as unknown as Response
    } finally {
      // Closes once the in-flight response has finished. Not awaited, so the body can still be read.
      dispatcher.close().catch(() => undefined)
    }
  }
  return pinned as typeof fetch
}
