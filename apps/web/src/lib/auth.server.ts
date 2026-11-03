import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { account, session, user, verification } from '@sleid/db'
import { db } from '~/db/client'

const isProduction = process.env.NODE_ENV === 'production'
const testAuth = process.env.SLEID_TEST_AUTH === '1'

// Hard guard: the email+password test login must never be reachable in production.
if (testAuth && isProduction) {
  throw new Error('SLEID_TEST_AUTH=1 is not allowed when NODE_ENV=production')
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // Refresh tokens, so the Drive import can get a new access token later (M8). Drive itself is requested with
      // linkSocial({ scopes }) when the user connects it, not at sign-in.
      accessType: 'offline',
    },
  },
  // Test-only path for Playwright. Only enabled when SLEID_TEST_AUTH=1 outside production.
  emailAndPassword: { enabled: testAuth && !isProduction, minPasswordLength: 8 },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  plugins: [tanstackStartCookies()],
})
