import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { getSessionFn } from '~/lib/session.functions'

/** Pathless layout: every child route requires a Better Auth session. */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
    const session = await getSessionFn()
    if (!session) throw redirect({ to: '/login' })
    return { session }
  },
  component: () => <Outlet />,
})
