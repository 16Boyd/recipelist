import 'dotenv/config'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { resolve } from 'node:path'
import { createServerApp } from './app.js'
import { auth } from './auth.js'
import { pool } from './db.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const baseURL = new URL(process.env.BETTER_AUTH_URL!)

const app = createServerApp({
  baseURL,
  production: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY === 'true',
  staticRoot: resolve(process.cwd(), 'dist'),
  authHandler: toNodeHandler(auth),
  getSession: (headers) => auth.api.getSession({ headers: fromNodeHeaders(headers) }),
  pool,
})

const server = app.listen(port, host, () => console.info(`RecipeList listening on ${host}:${port}`))

/** Close the HTTP listener and drain PostgreSQL connections during process shutdown. */
async function shutdown() {
  server.close()
  await pool.end()
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
