import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const authHarness = vi.hoisted(() => {
  const twoFactorPlugin = { id: 'two-factor-test-plugin' }
  const state: { options?: unknown; auth?: unknown; twoFactorOptions?: unknown } = {}
  const pool = {
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 })),
  }
  const twoFactor = vi.fn((options: unknown) => { state.twoFactorOptions = options; return twoFactorPlugin })
  class PostgresDialect {
    constructor(readonly options: unknown) {}
  }
  return {
    state,
    pool,
    twoFactorPlugin,
    twoFactor,
    PostgresDialect,
    betterAuth: vi.fn((options: unknown) => {
      state.options = options
      state.auth = { testAuth: true }
      return state.auth
    }),
  }
})

vi.mock('better-auth', () => ({
  APIError: {
    from: (_status: string, details: { code: string; message: string }) => Object.assign(new Error(details.message), { code: details.code }),
  },
  betterAuth: authHarness.betterAuth,
}))
vi.mock('better-auth/plugins', () => ({ twoFactor: authHarness.twoFactor }))
vi.mock('kysely', () => ({ PostgresDialect: authHarness.PostgresDialect }))
vi.mock('../../server/db.js', () => ({ pool: authHarness.pool }))

type TestAuthOptions = {
  trustedOrigins: string[]
  plugins: Array<{
    id?: string
    options?: { issuer?: string; totpOptions?: { period: number; digits: number }; trustDeviceMaxAge?: number }
    hooks?: {
      before?: Array<{
        matcher: (context: { path?: string }) => boolean
        handler: (context: { path?: string; body?: unknown }) => Promise<void>
      }>
    }
  }>
  databaseHooks: {
    session: { create: { after: (session: { id: string; userId: string }, context: { path?: string } | null) => Promise<void> } }
    user: { update: { after: (user: { id: string; twoFactorEnabled?: boolean }) => Promise<void> } }
  }
}

const environment = {
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  nodeEnv: process.env.NODE_ENV,
}
let authOptions: TestAuthOptions
let auth: unknown

beforeAll(async () => {
  process.env.BETTER_AUTH_URL = 'https://recipelist.example'
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(32)
  process.env.NODE_ENV = 'development'
  const authModule = await import('../../server/auth.js')
  authOptions = authModule.authOptions as unknown as TestAuthOptions
  auth = authModule.auth
})

afterAll(() => {
  if (environment.baseURL === undefined) delete process.env.BETTER_AUTH_URL
  else process.env.BETTER_AUTH_URL = environment.baseURL
  if (environment.secret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = environment.secret
  if (environment.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = environment.nodeEnv
})

describe('Better Auth configuration and security hooks', () => {
  it('configures two-factor verification and trusted origins for the local app', () => {
    expect(authHarness.state.twoFactorOptions).toEqual({
      issuer: 'RecipeList',
      totpOptions: { period: 30, digits: 6 },
      trustDeviceMaxAge: 0,
    })
    expect(authOptions.plugins[0]).toBe(authHarness.twoFactorPlugin)
    expect(authOptions.plugins[1]?.id).toBe('recipelist-mfa-assurance')
    expect(authOptions.trustedOrigins).toEqual(['https://recipelist.example', 'http://localhost:5173'])
    expect(auth).toBe(authHarness.state.auth)
  })

  it('wires password policy checks and rejects trusted-device requests in the auth hook', async () => {
    const hook = authOptions.plugins[1]?.hooks?.before?.[0]
    expect(hook?.matcher({ path: '/sign-up/email' })).toBe(true)
    expect(hook?.matcher({ path: '/two-factor/verify-totp' })).toBe(true)
    expect(hook?.matcher({ path: '/sign-in/email' })).toBe(false)
    await expect(hook?.handler({ path: '/sign-up/email', body: { password: 'weak' } }))
      .rejects.toMatchObject({ code: 'PASSWORD_POLICY_NOT_MET' })
    await expect(hook?.handler({ path: '/sign-up/email', body: { password: 'StrongPassword12!' } })).resolves.toBeUndefined()
    await expect(hook?.handler({ path: '/two-factor/verify-totp', body: { trustDevice: true } }))
      .rejects.toMatchObject({ code: 'TRUSTED_DEVICE_DISABLED' })
  })

  it('records MFA assurance only after factor verification and updates MFA timestamps', async () => {
    const sessionAfter = authOptions.databaseHooks.session.create.after
    await sessionAfter({ id: 'session-1', userId: 'user-1' }, { path: '/two-factor/verify-totp' })
    expect(authHarness.pool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_mfa_sessions'), ['session-1', 'user-1'])
    authHarness.pool.query.mockClear()
    await sessionAfter({ id: 'session-2', userId: 'user-1' }, { path: '/sign-in/email' })
    expect(authHarness.pool.query).not.toHaveBeenCalled()

    const userAfter = authOptions.databaseHooks.user.update.after
    await userAfter({ id: 'user-1', twoFactorEnabled: true })
    expect(authHarness.pool.query).toHaveBeenCalledWith(
      'UPDATE "user" SET mfa_enabled_at = COALESCE(mfa_enabled_at, NOW()) WHERE id = $1', ['user-1'],
    )
    authHarness.pool.query.mockClear()
    await userAfter({ id: 'user-1', twoFactorEnabled: false })
    expect(authHarness.pool.query).toHaveBeenCalledWith('UPDATE "user" SET mfa_enabled_at = NULL WHERE id = $1', ['user-1'])
  })
})
