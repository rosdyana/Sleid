import { createFileRoute, redirect } from '@tanstack/react-router'
import { authClient } from '~/lib/auth-client'
import { getSessionFn } from '~/lib/session.functions'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await getSessionFn()
    if (session) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  return (
    <div className="grid min-h-screen place-items-center bg-app-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-rule bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-lg bg-accent text-white text-xl font-semibold">
          S
        </div>
        <h1 className="text-xl font-semibold">Sleid</h1>
        <p className="mt-1 text-ink-muted">Slides for teams. Sign in to continue.</p>
        <button
          type="button"
          onClick={() => authClient.signIn.social({ provider: 'google', callbackURL: '/' })}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded border border-rule bg-white px-4 py-2 font-medium hover:bg-hover"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  )
}
