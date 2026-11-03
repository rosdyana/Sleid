import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { acceptInvitesFn } from '~/lib/sharing.functions'
import { getSessionFn } from '~/lib/session.functions'

/** Pathless layout: every child route requires a Better Auth session. Signed-out users go to /login and come back. */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    const session = await getSessionFn()
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } })
    // Pending invites for this email become memberships at sign-in.
    await acceptInvitesFn()
    return { session }
  },
  component: () => <Outlet />,
})
