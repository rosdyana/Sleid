import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth } from '~/lib/auth.server'

export type SessionUser = { id: string; name: string; email: string; image: string | null }

/** Current Better Auth session user, or null when signed out. Server-only. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!result) return null
  const { id, name, email, image } = result.user
  return { id, name, email, image: image ?? null }
}

/** Like getSessionUser, but throws when signed out. Use inside every server function that touches data. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw new Error('Not signed in')
  return user
}

/** The signed-in user id for a raw request (used by /api routes), or null. */
export async function sessionUserIdFromRequest(request: Request): Promise<string | null> {
  const result = await auth.api.getSession({ headers: request.headers })
  return result?.user.id ?? null
}

/** The signed-in user (id and email) for a raw request (used by /api routes), or null. */
export async function sessionUserFromRequest(request: Request): Promise<{ id: string; email: string } | null> {
  const result = await auth.api.getSession({ headers: request.headers })
  return result ? { id: result.user.id, email: result.user.email } : null
}
