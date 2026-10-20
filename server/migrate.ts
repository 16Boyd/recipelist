import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from './auth.js'
import { pool } from './db.js'
import { appMigrations, applyAppMigrations, assertSafeMigrationPlan } from './migration-operations.js'

async function migrate() {
  const plan = await getMigrations(authOptions)
  assertSafeMigrationPlan(plan)
  await plan.runMigrations()

  const client = await pool.connect()
  await applyAppMigrations(client, appMigrations, (file) => readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'))
  console.info('Database migrations are up to date')
}

migrate()
  .catch((error: unknown) => {
    console.error('Database migration failed', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end())
