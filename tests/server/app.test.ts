import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerApp, type ServerPool, type ServerQueryResult, type ServerSession } from '../../server/app.js'

const session: ServerSession = {
  user: { id: 'user-1', email: 'user@example.com', name: 'Recipe User' },
  session: { id: 'session-1' },
}
const recipe = {
  id: 'chicken-soup', title: 'Chicken soup', source: 'Kitchen', category: 'Dinner', time: 30, servings: 4,
  image: '', description: 'Soup', instructions: 'Simmer until ready.', ingredients: [{ name: 'Chicken', amount: '1 lb' }],
}
const appData = { recipes: [], pantry: ['salt'], shopping: [] }

describe('HTTP app factory', () => {
  let server: Server
  let base: string
  let staticRoot: string
  let state: {
    authenticated: boolean
    role: 'member' | 'admin' | null
    mfa: boolean
    profile: unknown
    recipeRows: unknown[]
    inserted: unknown
    insertValues: unknown[]
    instructionUpdateValues: unknown[]
    failOn: string
    authCookie: string
  }

  beforeEach(async () => {
    state = { authenticated: true, role: 'member', mfa: true, profile: appData, recipeRows: [recipe], inserted: recipe, insertValues: [], instructionUpdateValues: [], failOn: '', authCookie: '' }
    staticRoot = await mkdtemp(join(tmpdir(), 'recipelist-test-'))
    await mkdir(join(staticRoot, 'assets'))
    await writeFile(join(staticRoot, 'index.html'), '<main>RecipeList test shell</main>')
    await writeFile(join(staticRoot, 'assets', 'app.js'), 'globalThis.testApp = true')
    const pool: ServerPool = {
      async query<Row>(sql: string, values?: unknown[]): Promise<ServerQueryResult<Row>> {
        if (state.failOn && sql.includes(state.failOn)) throw new Error('fake database failure')
        if (sql === 'SELECT 1') return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT role FROM user_roles')) return { rows: (state.role ? [{ role: state.role }] : []) as Row[], rowCount: state.role ? 1 : 0 }
        if (sql.includes('user_mfa_sessions')) return { rows: state.mfa ? [{ verified: 1 }] as Row[] : [], rowCount: state.mfa ? 1 : 0 }
        if (sql.includes('SELECT "twoFactorEnabled"')) return { rows: [{ two_factor_enabled: true }] as Row[], rowCount: 1 }
        if (sql.includes('SELECT app_data FROM user_profiles')) {
          expect(values).toEqual([session.user.id])
          return { rows: state.profile === null ? [] : [{ app_data: state.profile }] as Row[], rowCount: state.profile === null ? 0 : 1 }
        }
        if (sql.includes('UPDATE user_profiles')) {
          expect(values?.[0]).toBe(session.user.id)
          state.profile = JSON.parse(String(values?.[1]))
          return { rows: [{ app_data: state.profile }] as Row[], rowCount: 1 }
        }
        if (sql.includes('SELECT id, title, source')) return { rows: state.recipeRows as Row[], rowCount: state.recipeRows.length }
        if (sql.startsWith('UPDATE recipes SET instructions = $2')) {
          state.instructionUpdateValues = values ?? []
          const id = values?.[0]
          const instructions = values?.[1]
          const rowIndex = state.recipeRows.findIndex((row) => Boolean(row) && typeof row === 'object' && (row as { id?: unknown }).id === id)
          const current = rowIndex >= 0 ? state.recipeRows[rowIndex] as { id: string; instructions?: string } : undefined
          const isSqlWhitespace = (value: string) => value.trim() === ''
          if (!current || !isSqlWhitespace(current.instructions ?? '') || typeof instructions !== 'string') return { rows: [], rowCount: 0 }
          const updated = { ...current, instructions }
          state.recipeRows = state.recipeRows.map((row, index) => index === rowIndex ? updated : row)
          return { rows: [{ id: updated.id, instructions: updated.instructions }] as Row[], rowCount: 1 }
        }
        if (sql === 'SELECT id FROM recipes WHERE id = $1') {
          const row = state.recipeRows.find((item) => Boolean(item) && typeof item === 'object' && (item as { id?: unknown }).id === values?.[0])
          return { rows: row ? [{ id: (row as { id: string }).id }] as Row[] : [], rowCount: row ? 1 : 0 }
        }
        if (sql.includes('INSERT INTO recipes')) {
          state.insertValues = values ?? []
          if (state.inserted === null) return { rows: [], rowCount: 0 }
          return { rows: [state.inserted] as Row[], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const app = createServerApp({
      baseURL: 'https://recipelist.example', production: true,
      staticRoot,
      authHandler: (req, res) => { state.authCookie = req.headers.cookie ?? ''; res.status(200).end() },
      getSession: async () => state.authenticated ? session : null,
      pool,
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(staticRoot, { recursive: true, force: true })
  })

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${base}${path}`, init)
  }
  const jsonHeaders = { 'content-type': 'application/json', origin: 'https://recipelist.example' }

  it('sets security headers, serves health status, and reports an unavailable database', async () => {
    const response = await request('/api/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
    state.failOn = 'SELECT 1'
    expect((await request('/api/healthz')).status).toBe(503)
  })

  it('strips legacy trusted-device cookies before forwarding auth requests', async () => {
    const response = await request('/api/auth/get-session', {
      headers: { cookie: 'better-auth.session_token=s1; better-auth.trust_device=old; __Secure.better-auth.trust_device=old; other=ok' },
    })
    expect(response.status).toBe(200)
    expect(state.authCookie).toBe('better-auth.session_token=s1; other=ok')
  })

  it('serves production assets and the application shell for client routes', async () => {
    const asset = await request('/assets/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('globalThis.testApp = true')
    expect(asset.headers.get('cache-control')).toContain('max-age=3600')

    const page = await request('/pantry')
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<main>RecipeList test shell</main>')
  })

  it('reports MFA reauthentication state and gates completion on a verified session', async () => {
    const verified = await request('/api/me')
    expect(await verified.json()).toMatchObject({ user: { twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
    state.mfa = false
    const stale = await request('/api/me')
    expect(await stale.json()).toMatchObject({ needsMfaReauthentication: true })

    state.mfa = true
    const complete = await request('/api/mfa/complete-setup', { method: 'POST', headers: jsonHeaders, body: '{}' })
    expect(complete.status).toBe(204)
    state.mfa = false
    const unverified = await request('/api/mfa/complete-setup', { method: 'POST', headers: jsonHeaders, body: '{}' })
    expect(unverified.status).toBe(403)
    expect(await unverified.json()).toEqual({ error: 'Authenticator verification is not recorded for this session' })
  })

  it('rejects missing and untrusted origin and non-JSON mutation requests', async () => {
    expect((await request('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(appData) })).status).toBe(403)
    expect((await request('/api/profile', { method: 'PUT', headers: { ...jsonHeaders, origin: 'https://evil.example' }, body: JSON.stringify(appData) })).status).toBe(403)
    expect((await request('/api/profile', { method: 'PUT', headers: { origin: 'https://recipelist.example', 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
  })

  it('enforces authentication, configured role, and fresh MFA gates', async () => {
    state.authenticated = false
    expect((await request('/api/profile')).status).toBe(401)
    state.authenticated = true
    state.role = null
    expect((await request('/api/profile')).status).toBe(403)
    state.role = 'member'
    state.mfa = false
    const response = await request('/api/profile')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Verify your authenticator before opening your kitchen' })
  })

  it('scopes profile reads and writes to the authenticated user and validates profile data', async () => {
    const read = await request('/api/profile')
    expect(await read.json()).toEqual(appData)
    const changed = { recipes: [], pantry: ['pepper'], shopping: [] }
    const write = await request('/api/profile', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(changed) })
    expect(write.status).toBe(200)
    expect(await write.json()).toEqual(changed)
    const invalid = await request('/api/profile', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ recipes: [], pantry: [null], shopping: [] }) })
    expect(invalid.status).toBe(400)
    state.profile = null
    expect((await request('/api/profile')).status).toBe(404)
  })

  it('allows recipe catalog reads and requires admin role for validated creation', async () => {
    const read = await request('/api/recipes')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual([recipe])
    const memberCreate = await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(recipe) })
    expect(memberCreate.status).toBe(403)
    state.role = 'admin'
    expect((await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...recipe, servings: 0 }) })).status).toBe(400)
    state.inserted = null
    expect((await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(recipe) })).status).toBe(409)
    state.inserted = recipe
    const created = await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(recipe) })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(recipe)
    expect(state.insertValues[8]).toBe(recipe.instructions)
    expect(state.insertValues[9]).toBe(JSON.stringify(recipe.ingredients))
    const { instructions: _legacyInstructions, ...legacyRecipe } = recipe
    expect((await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(legacyRecipe) })).status).toBe(400)
    expect((await request('/api/recipes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...recipe, instructions: '' }) })).status).toBe(400)
  })

  it('lets only admins complete blank shared recipe instructions without overwriting completed text', async () => {
    const legacyRecipe = { ...recipe, instructions: '\t\n ' }
    state.recipeRows = [legacyRecipe]
    const body = JSON.stringify({ instructions: 'Roast the vegetables.\nServe warm.' })
    expect((await request('/api/recipes/chicken-soup/instructions', { method: 'PUT', headers: jsonHeaders, body })).status).toBe(403)
    expect(state.instructionUpdateValues).toEqual([])

    state.role = 'admin'
    const completed = await request('/api/recipes/chicken-soup/instructions', { method: 'PUT', headers: jsonHeaders, body })
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ id: recipe.id, instructions: 'Roast the vegetables.\nServe warm.' })
    expect(state.instructionUpdateValues).toEqual([recipe.id, 'Roast the vegetables.\nServe warm.'])
    expect(state.recipeRows).toEqual([{ ...recipe, instructions: 'Roast the vegetables.\nServe warm.' }])

    const conflict = await request('/api/recipes/chicken-soup/instructions', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ instructions: 'Replace these steps.' }) })
    expect(conflict.status).toBe(409)
    expect(state.recipeRows).toEqual([{ ...recipe, instructions: 'Roast the vegetables.\nServe warm.' }])
  })

  it.each(['\uFEFF', '\u00A0', '\u1680', '\u2003', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000'])('completes shared recipes whose legacy instructions contain only trim whitespace (%s)', async (blankInstructions) => {
    state.role = 'admin'
    state.recipeRows = [{ ...recipe, instructions: blankInstructions }]
    const instructions = 'Brown the chicken.\nServe warm.'
    const completed = await request('/api/recipes/chicken-soup/instructions', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ instructions }),
    })
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ id: recipe.id, instructions })
    expect(state.instructionUpdateValues).toEqual([recipe.id, instructions])
    expect(state.recipeRows).toEqual([{ ...recipe, instructions }])
  })

  it('rejects invalid instruction completion and returns 404 for unknown shared recipes', async () => {
    state.role = 'admin'
    const headers = jsonHeaders
    expect((await request('/api/recipes/chicken-soup/instructions', { method: 'PUT', headers, body: JSON.stringify({ instructions: ' \n\t ' }) })).status).toBe(400)
    expect((await request('/api/recipes/chicken-soup/instructions', { method: 'PUT', headers, body: JSON.stringify({ instructions: 'x'.repeat(12001) }) })).status).toBe(400)
    const missing = await request('/api/recipes/no-such-recipe/instructions', { method: 'PUT', headers, body: JSON.stringify({ instructions: 'Add a step.' }) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Recipe not found' })
  })

  it('returns API 404 and masks unexpected route failures as a generic 500', async () => {
    const missing = await request('/api/missing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'API route not found' })
    state.failOn = 'SELECT role FROM user_roles'
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = await request('/api/profile')
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Internal server error' })
    expect(errorLog).toHaveBeenCalledWith('Request failed', expect.any(Error))
  })
})
