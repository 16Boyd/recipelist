import express, { type NextFunction, type Request, type Response, type RequestHandler } from 'express'
import { blankInstructionsPredicateSql } from './instructions-sql.js'
import { validateAppData, validateRecipe, validateRecipeInstructions } from './validation.js'

export type ServerSession = {
  user: { id: string; email: string; name: string }
  session: { id: string }
}

export type ServerQueryResult<Row = Record<string, unknown>> = {
  rows: Row[]
  rowCount: number | null
}

export type ServerPool = {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<ServerQueryResult<Row>>
}

export type ServerAppOptions = {
  baseURL: string | URL
  production?: boolean
  trustProxy?: boolean
  authHandler: RequestHandler
  getSession: (headers: Request['headers']) => Promise<ServerSession | null>
  pool: ServerPool
  staticRoot?: string
}

type AuthedRequest = Request & { recipeListSession?: ServerSession; recipeListRole?: 'member' | 'admin' }

/** Configure the API, authentication, security middleware, and optional production static hosting. */
export function createServerApp(options: ServerAppOptions) {
  const { pool } = options
  const baseURL = new URL(options.baseURL)
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', options.trustProxy ? 1 : false)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (baseURL.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    next()
  })

  // Preserve the raw request body for Better Auth and discard legacy trusted-device cookies.
  app.use('/api/auth', (req, _res, next) => {
    const cookieHeader = req.headers.cookie
    if (cookieHeader) {
      req.headers.cookie = cookieHeader
        .split(';')
        .filter((cookie) => cookie.trim().split('=', 1)[0]?.split('.').at(-1) !== 'trust_device')
        .join(';')
    }
    next()
  })
  app.all('/api/auth/*splat', options.authHandler)
  app.use(express.json({ limit: '1mb', strict: true, type: 'application/json' }))

  /** Require JSON requests from the configured origin before state-changing API routes. */
  function rejectOriginAndContentType(req: Request, res: Response, next: NextFunction) {
    const contentType = req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') return res.status(415).json({ error: 'Expected application/json' })
    const origin = req.get('origin')
    if (!origin) return res.status(403).json({ error: 'Origin is required' })
    try {
      if (new URL(origin).origin !== baseURL.origin && !(options.production !== true && origin === 'http://localhost:5173')) {
        return res.status(403).json({ error: 'Origin is not trusted' })
      }
    } catch {
      return res.status(403).json({ error: 'Origin is not trusted' })
    }
    next()
  }

  /** Resolve the request session and load its configured application role. */
  async function loadSession(req: AuthedRequest, res: Response, next: NextFunction) {
    try {
      const session = await options.getSession(req.headers)
      if (!session) return res.status(401).json({ error: 'Authentication required' })
      req.recipeListSession = session
      const result = await pool.query<{ role: 'member' | 'admin' }>(
        'SELECT role FROM user_roles WHERE user_id = $1', [session.user.id],
      )
      if (!result.rows[0]) return res.status(403).json({ error: 'Account role is not configured' })
      req.recipeListRole = result.rows[0].role
      next()
    } catch (error) { next(error) }
  }

  /** Require a session assurance record matching the user’s current MFA enrollment. */
  async function requireFreshMfa(req: AuthedRequest, res: Response, next: NextFunction) {
    const session = req.recipeListSession!
    try {
      const result = await pool.query(
        `SELECT 1
           FROM "user" auth_user
           JOIN user_mfa_sessions assurance
             ON assurance.user_id = auth_user.id
            AND assurance.session_id = $2
            AND assurance.mfa_enabled_at = auth_user.mfa_enabled_at
          WHERE auth_user.id = $1
            AND auth_user."twoFactorEnabled" IS TRUE
            AND auth_user.mfa_enabled_at IS NOT NULL`,
        [session.user.id, session.session.id],
      )
      if (!result.rowCount) return res.status(403).json({ error: 'Verify your authenticator before opening your kitchen' })
      next()
    } catch (error) { next(error) }
  }

  app.get('/api/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1')
      res.json({ status: 'ok' })
    } catch { res.status(503).json({ status: 'unavailable' }) }
  })

  app.get('/api/me', loadSession, async (req: AuthedRequest, res) => {
    const session = req.recipeListSession!
    let needsMfaReauthentication = false
    const factorState = await pool.query<{ two_factor_enabled: boolean }>(
      'SELECT "twoFactorEnabled" AS two_factor_enabled FROM "user" WHERE id = $1', [session.user.id],
    )
    if (factorState.rows[0]?.two_factor_enabled === true) {
      const result = await pool.query(
        `SELECT 1
           FROM "user" auth_user
           JOIN user_mfa_sessions assurance
             ON assurance.user_id = auth_user.id
            AND assurance.session_id = $2
            AND assurance.mfa_enabled_at = auth_user.mfa_enabled_at
          WHERE auth_user.id = $1
            AND auth_user."twoFactorEnabled" IS TRUE
            AND auth_user.mfa_enabled_at IS NOT NULL`,
        [session.user.id, session.session.id],
      )
      needsMfaReauthentication = !result.rowCount
    }
    res.json({
      user: { id: session.user.id, email: session.user.email, name: session.user.name, twoFactorEnabled: factorState.rows[0]?.two_factor_enabled === true },
      role: req.recipeListRole,
      needsMfaReauthentication,
    })
  })

  app.post('/api/mfa/complete-setup', rejectOriginAndContentType, loadSession, async (req: AuthedRequest, res, next) => {
    try {
      const result = await pool.query(
        `SELECT 1
           FROM "user" auth_user
           JOIN user_mfa_sessions assurance
             ON assurance.user_id = auth_user.id
            AND assurance.session_id = $2
            AND assurance.mfa_enabled_at = auth_user.mfa_enabled_at
          WHERE auth_user.id = $1
            AND auth_user."twoFactorEnabled" IS TRUE
            AND auth_user.mfa_enabled_at IS NOT NULL`,
        [req.recipeListSession!.user.id, req.recipeListSession!.session.id],
      )
      if (!result.rowCount) return res.status(403).json({ error: 'Authenticator verification is not recorded for this session' })
      res.status(204).end()
    } catch (error) { next(error) }
  })

  app.get('/api/profile', loadSession, requireFreshMfa, async (req: AuthedRequest, res, next) => {
    try {
      const result = await pool.query<{ app_data: unknown }>(
        'SELECT app_data FROM user_profiles WHERE user_id = $1', [req.recipeListSession!.user.id],
      )
      if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found' })
      res.json(result.rows[0].app_data)
    } catch (error) { next(error) }
  })

  app.put('/api/profile', rejectOriginAndContentType, loadSession, requireFreshMfa, async (req: AuthedRequest, res, next) => {
    if (!validateAppData(req.body)) return res.status(400).json({ error: 'Invalid profile data' })
    try {
      const result = await pool.query(
        'UPDATE user_profiles SET app_data = $2::jsonb, updated_at = NOW() WHERE user_id = $1 RETURNING app_data',
        [req.recipeListSession!.user.id, JSON.stringify(req.body)],
      )
      if (!result.rowCount) return res.status(404).json({ error: 'Profile not found' })
      res.json(result.rows[0].app_data)
    } catch (error) { next(error) }
  })

  app.get('/api/recipes', loadSession, requireFreshMfa, async (_req, res, next) => {
    try {
      const result = await pool.query('SELECT id, title, source, category, time, servings, image, description, instructions, ingredients FROM recipes ORDER BY title, id')
      res.json(result.rows)
    } catch (error) { next(error) }
  })

  app.put('/api/recipes/:id/instructions', rejectOriginAndContentType, loadSession, requireFreshMfa, async (req: AuthedRequest, res, next) => {
    if (req.recipeListRole !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    if (!req.body || !validateRecipeInstructions(req.body.instructions)) return res.status(400).json({ error: 'Invalid recipe instructions' })
    try {
      const result = await pool.query<{ id: string; instructions: string }>(
        `UPDATE recipes SET instructions = $2 WHERE id = $1 AND ${blankInstructionsPredicateSql.replace('%column%', 'instructions')} RETURNING id, instructions`,
        [req.params.id, req.body.instructions],
      )
      if (result.rows[0]) return res.json(result.rows[0])
      const existing = await pool.query<{ id: string }>('SELECT id FROM recipes WHERE id = $1', [req.params.id])
      if (!existing.rows[0]) return res.status(404).json({ error: 'Recipe not found' })
      return res.status(409).json({ error: 'Recipe instructions have already been added' })
    } catch (error) { next(error) }
  })

  app.post('/api/recipes', rejectOriginAndContentType, loadSession, requireFreshMfa, async (req: AuthedRequest, res, next) => {
    if (req.recipeListRole !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    if (!validateRecipe(req.body)) return res.status(400).json({ error: 'Invalid recipe' })
    const recipe = req.body
    try {
      const result = await pool.query(
        `INSERT INTO recipes(id, title, source, category, time, servings, image, description, instructions, ingredients, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, title, source, category, time, servings, image, description, instructions, ingredients`,
        [recipe.id, recipe.title.trim(), recipe.source.trim(), recipe.category.trim(), recipe.time, recipe.servings, recipe.image, recipe.description, recipe.instructions, JSON.stringify(recipe.ingredients), req.recipeListSession!.user.id],
      )
      if (!result.rowCount) return res.status(409).json({ error: 'A recipe with this ID already exists' })
      res.status(201).json(result.rows[0])
    } catch (error) { next(error) }
  })

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }))
  if (options.production && options.staticRoot) {
    app.use(express.static(options.staticRoot, { index: false, maxAge: '1h', setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
    } }))
    app.get(/.*/, (_req, res) => res.sendFile(`${options.staticRoot}/index.html`))
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Request failed', error)
    if (res.headersSent) return
    res.status(500).json({ error: 'Internal server error' })
  })
  return app
}
