import { createServerFn } from '@tanstack/react-start'
import { getSessionUser } from '~/lib/session.server'

export const getSessionFn = createServerFn({ method: 'GET' }).handler(async () => {
  return getSessionUser()
})
