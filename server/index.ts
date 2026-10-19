import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { resolve } from 'node:path'
import { auth } from './auth.js'
import { pool } from './db.js'
import { validateAppData, validateRecipe } from './validation.js'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const baseURL = new URL(process.env.BETTER_AUTH_URL!)

app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (baseURL.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})

// Better Auth must receive the raw request body for password and TOTP flows.
// Older clients may still send a trusted-device cookie from a previous version.
// Strip it before Better Auth's two-factor after-sign-in hook can inspect it.
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
app.all('/api/auth/*splat', toNodeHandler(auth))
app.use(express.json({ limit: '1mb', strict: true, type: 'application/json' }))

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>
type AuthedRequest = Request & { recipeListSession?: Session; recipeListRole?: 'member' | 'admin' }

function rejectOriginAndContentType(req: Request, res: Response, next: NextFunction) {
  const contentType = req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return res.status(415).json({ error: 'Expected application/json' })
  const origin = req.get('origin')
  if (!origin) return res.status(403).json({ error: 'Origin is required' })
  try {
    if (new URL(origin).origin !== baseURL.origin && !(process.env.NODE_ENV !== 'production' && origin === 'http://localhost:5173')) {
      return res.status(403).json({ error: 'Origin is not trusted' })
    }
  } catch {
    return res.status(403).json({ error: 'Origin is not trusted' })
  }
  next()
}

async function loadSession(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'Authentication required' })
    req.recipeListSession = session
    const result = await pool.query<{ role: 'member' | 'admin' }>(
      'SELECT role FROM user_roles WHERE user_id = $1', [session.user.id],
    )
    if (!result.rows[0]) return res.status(403).json({ error: 'Account role is not configured' })
    req.recipeListRole = result.rows[0].role
    next()
  } catch (error) {
    next(error)
  }
}

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
  } catch (error) {
    next(error)
  }
}

app.get('/api/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok' })
  } catch {
    res.status(503).json({ status: 'unavailable' })
  }
})

app.get('/api/me', loadSession, async (req: AuthedRequest, res) => {
  const session = req.recipeListSession!
  let needsMfaReauthentication = false
  const factorState = await pool.query<{ two_factor_enabled: boolean }>(
    'SELECT "twoFactorEnabled" AS two_factor_enabled FROM "user" WHERE id = $1',
    [session.user.id],
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
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      twoFactorEnabled: factorState.rows[0]?.two_factor_enabled === true,
    },
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
    const result = await pool.query(
      'SELECT id, title, source, category, time, servings, image, description, ingredients FROM recipes ORDER BY title, id',
    )
    res.json(result.rows)
  } catch (error) { next(error) }
})

app.post('/api/recipes', rejectOriginAndContentType, loadSession, requireFreshMfa, async (req: AuthedRequest, res, next) => {
  if (req.recipeListRole !== 'admin') return res.status(403).json({ error: 'Admin access required' })
  if (!validateRecipe(req.body)) return res.status(400).json({ error: 'Invalid recipe' })
  const recipe = req.body
  try {
    const result = await pool.query(
      `INSERT INTO recipes(id, title, source, category, time, servings, image, description, ingredients, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, title, source, category, time, servings, image, description, ingredients`,
      [recipe.id, recipe.title.trim(), recipe.source.trim(), recipe.category.trim(), recipe.time,
        recipe.servings, recipe.image, recipe.description, JSON.stringify(recipe.ingredients), req.recipeListSession!.user.id],
    )
    if (!result.rowCount) return res.status(409).json({ error: 'A recipe with this ID already exists' })
    res.status(201).json(result.rows[0])
  } catch (error) { next(error) }
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }))

if (process.env.NODE_ENV === 'production') {
  const webRoot = resolve(process.cwd(), 'dist')
  app.use(express.static(webRoot, { index: false, maxAge: '1h', setHeaders: (res, path) => {
    if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
  } }))
  app.get(/.*/, (_req, res) => res.sendFile(resolve(webRoot, 'index.html')))
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Request failed', error)
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(port, '0.0.0.0', () => console.info(`RecipeList listening on ${port}`))

async function shutdown() {
  server.close()
  await pool.end()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
