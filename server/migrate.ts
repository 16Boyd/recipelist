import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from './auth.js'
import { pool } from './db.js'

async function migrate() {
  const plan = await getMigrations(authOptions)
  if (plan.schemaProblems.length) {
    throw new Error(`Better Auth schema problems: ${plan.schemaProblems.join('; ')}`)
  }
  if (plan.unsafeChanges.length) {
    throw new Error(`Unsafe Better Auth schema changes: ${plan.unsafeChanges.join('; ')}`)
  }
  await plan.runMigrations()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const appMigrations = [
      { version: '0001_app_data_and_recipe_catalog', file: '0001_app_data_and_recipe_catalog.sql' },
      { version: '0002_mfa_session_assurance', file: '0002_mfa_session_assurance.sql' },
    ]
    for (const migration of appMigrations) {
      const applied = await client.query('SELECT 1 FROM app_migrations WHERE version = $1', [migration.version])
      if ((applied.rowCount ?? 0) > 0) continue
      const sql = await readFile(resolve(process.cwd(), 'server/migrations', migration.file), 'utf8')
      await client.query(sql)
      await client.query('INSERT INTO app_migrations(version) VALUES ($1)', [migration.version])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  console.info('Database migrations are up to date')
}

migrate()
  .catch((error: unknown) => {
    console.error('Database migration failed', error)
    process.exitCode = 1
  })
  .finally(async () => pool.end())
