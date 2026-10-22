import { describe, expect, it, vi } from 'vitest'

const authClientMocks = vi.hoisted(() => {
  const plugin = { name: 'two-factor-plugin' }
  const client = { name: 'auth-client' }
  const state: { pluginCreated: boolean; options?: unknown } = { pluginCreated: false }
  return {
    createAuthClient: vi.fn((options: unknown) => { state.options = options; return client }),
    twoFactorClient: vi.fn(() => { state.pluginCreated = true; return plugin }),
    plugin,
    client,
    state,
  }
})

vi.mock('better-auth/react', () => ({ createAuthClient: authClientMocks.createAuthClient }))
vi.mock('better-auth/client/plugins', () => ({ twoFactorClient: authClientMocks.twoFactorClient }))

import { authClient } from '../../src/authClient'

describe('authentication client configuration', () => {
  it('registers the two-factor plugin with the same-origin auth client', () => {
    expect(authClientMocks.state.pluginCreated).toBe(true)
    expect(authClientMocks.state.options).toEqual({ plugins: [authClientMocks.plugin] })
    expect(authClient).toBe(authClientMocks.client)
  })
})
