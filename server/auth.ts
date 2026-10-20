import 'dotenv/config'
import { APIError, betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import { PostgresDialect } from 'kysely'
import { pool } from './db.js'
import { isFactorVerificationPath, isPasswordCreationPath, meetsPasswordPolicy, passwordFromRequest, requestsTrustedDevice } from './auth-policy.js'

async function recordMfaAssurance(sessionId: string, userId: string) {
  await pool.query(
    `INSERT INTO user_mfa_sessions(session_id, user_id, mfa_enabled_at, verified_at)
     SELECT auth_session.id, auth_user.id, auth_user.mfa_enabled_at, NOW()
       FROM "user" auth_user
       JOIN "session" auth_session
         ON auth_session.id = $1
        AND auth_session."userId" = auth_user.id
      WHERE auth_user.id = $2
        AND auth_user."twoFactorEnabled" IS TRUE
        AND auth_user.mfa_enabled_at IS NOT NULL
     ON CONFLICT (session_id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           mfa_enabled_at = EXCLUDED.mfa_enabled_at,
           verified_at = NOW()`,
    [sessionId, userId],
  )
}

const mfaAssurancePlugin: BetterAuthPlugin = {
  id: 'recipelist-mfa-assurance',
  version: '1.0.0',
  hooks: {
    before: [{
      matcher: (context: { path?: string }) => isFactorVerificationPath(context.path)
        || isPasswordCreationPath(context.path),
      handler: async (context: { path?: string; body?: unknown }) => {
        if (isPasswordCreationPath(context.path)
          && typeof context.body === 'object'
          && context.body !== null) {
          if (!meetsPasswordPolicy(passwordFromRequest(context.path, context.body))) {
            throw APIError.from('BAD_REQUEST', {
              code: 'PASSWORD_POLICY_NOT_MET',
              message: 'Use 12 to 128 characters with a lowercase letter, an uppercase letter, a number, and a symbol.',
            })
          }
        }
        if (requestsTrustedDevice(context.path, context.body)) {
          throw APIError.from('BAD_REQUEST', {
            code: 'TRUSTED_DEVICE_DISABLED',
            message: 'Remembering this device is disabled. Verify your authenticator every time.',
          })
        }
      },
    }],
  },
}

const baseURL = process.env.BETTER_AUTH_URL
if (!baseURL) throw new Error('BETTER_AUTH_URL is required')

const secret = process.env.BETTER_AUTH_SECRET
if (!secret || secret.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
}

const parsedBaseURL = new URL(baseURL)
if (parsedBaseURL.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedBaseURL.hostname)) {
  throw new Error('BETTER_AUTH_URL must use HTTPS outside localhost')
}

const plugins = [
  twoFactor({
    issuer: 'RecipeList',
    totpOptions: { period: 30, digits: 6 },
    trustDeviceMaxAge: 0,
  }),
  mfaAssurancePlugin,
] satisfies BetterAuthPlugin[]

export const authOptions = {
  appName: 'RecipeList',
  baseURL,
  secret,
  database: new PostgresDialect({ pool }),
  trustedOrigins: [baseURL, ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173'])],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false,
  },
  user: {
    additionalFields: {
      mfaEnabledAt: {
        type: 'date',
        fieldName: 'mfa_enabled_at',
        required: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session: { id: string; userId: string }, context: { path?: string } | null) => {
          if (isFactorVerificationPath(context?.path)) {
            await recordMfaAssurance(session.id, session.userId)
          }
        },
      },
    },
    user: {
      update: {
        after: async (user: { id: string; twoFactorEnabled?: boolean }) => {
          if (user.twoFactorEnabled) {
            await pool.query(
              'UPDATE "user" SET mfa_enabled_at = COALESCE(mfa_enabled_at, NOW()) WHERE id = $1',
              [user.id],
            )
          } else if (user.twoFactorEnabled === false) {
            await pool.query('UPDATE "user" SET mfa_enabled_at = NULL WHERE id = $1', [user.id])
          }
        },
      },
    },
  },
  plugins,
  advanced: {
    useSecureCookies: parsedBaseURL.protocol === 'https:',
    database: { generateId: 'uuid' as const },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 12,
    // Keep Better Auth's session cookie cache disabled. TOTP and a cached
    // pre-MFA session can otherwise bypass freshness checks.
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  },
} satisfies BetterAuthOptions

export const auth = betterAuth(authOptions)
