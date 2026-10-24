import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appMigrations, applyAppMigrations, assertSafeMigrationPlan } from '../../server/migration-operations.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

suite('PostgreSQL migration integration (dedicated TEST_DATABASE_URL required)', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  let productionPool: typeof import('../../server/db.js').pool | undefined

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    // Import after setting DATABASE_URL because the production auth module
    // creates its PostgreSQL pool during module evaluation.
    process.env.DATABASE_URL = databaseUrl
    process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
    process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-at-least-32-characters'
    const { authOptions } = await import('../../server/auth.js')
    const db = await import('../../server/db.js')
    productionPool = db.pool
    const plan = await getMigrations(authOptions)
    assertSafeMigrationPlan(plan)
    await plan.runMigrations()
    const client = await pool.connect()
    await applyAppMigrations(client, appMigrations, (file) =>
      readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'),
    )
  })

  afterAll(async () => {
    await Promise.all([
      pool.end(),
      productionPool?.end(),
    ])
  })

  it('applies both schemas with matching FK types and preserves recipe IDs as text', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('user_roles', 'user_id'), ('user_profiles', 'user_id'),
          ('user_mfa_sessions', 'session_id'), ('user_mfa_sessions', 'user_id'),
          ('recipes', 'created_by'), ('recipes', 'id')
        )
    `)
    const types = new Map(rows.map(({ table_name, column_name, data_type }) => [`${table_name}.${column_name}`, data_type]))
    expect(types.get('user_roles.user_id')).toBe('uuid')
    expect(types.get('user_profiles.user_id')).toBe('uuid')
    expect(types.get('user_mfa_sessions.session_id')).toBe('uuid')
    expect(types.get('user_mfa_sessions.user_id')).toBe('uuid')
    expect(types.get('recipes.created_by')).toBe('uuid')
    expect(types.get('recipes.id')).toBe('text')
    await expect(pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('not-a-uuid', 'x', 'x@example.invalid', false, now(), now())`)).rejects.toThrow()
  })

  async function createLegacyAppSchema() {
    await pool.query(`
      DROP TABLE IF EXISTS user_roles, user_profiles, recipes, user_mfa_sessions CASCADE;
      DROP TABLE IF EXISTS app_migrations;
      CREATE TABLE user_roles (user_id text PRIMARY KEY, role text NOT NULL DEFAULT 'member');
      CREATE TABLE user_profiles (user_id text PRIMARY KEY);
      CREATE TABLE recipes (id text PRIMARY KEY, created_by text);
      CREATE TABLE user_mfa_sessions (session_id text PRIMARY KEY, user_id text NOT NULL, mfa_enabled_at timestamptz NOT NULL, verified_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE app_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO app_migrations(version) VALUES ('0001_app_data_and_recipe_catalog'), ('0002_mfa_session_assurance');
    `)
  }

  async function applyPendingAppMigrations() {
    const client = await pool.connect()
    await applyAppMigrations(client, appMigrations, (file) =>
      readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'),
    )
  }

  it('upgrades legacy text columns, restores all auth FKs and leaves recipe identifiers text', async () => {
    await createLegacyAppSchema()
    const userId = 'ce5ea668-7252-4db8-bd68-96cbf1b0c001'
    const sessionId = 'ce5ea668-7252-4db8-bd68-96cbf1b0c002'
    await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'x', 'legacy@example.invalid', false, now(), now())`, [userId])
    await pool.query(`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ($1, now() + interval '1 day', 'legacy-token', now(), now(), $2)`, [sessionId, userId])
    // The previously installed app trigger models the normal role/profile rows.
    await pool.query('INSERT INTO user_mfa_sessions(session_id, user_id, mfa_enabled_at) VALUES ($1, $2, now())', [sessionId, userId])
    await pool.query('INSERT INTO recipes(id, created_by) VALUES ($1, $2)', ['recipe-stays-text', userId])
    await applyPendingAppMigrations()
    const { rows } = await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND ((table_name, column_name) IN (('user_roles','user_id'),('user_profiles','user_id'),('user_mfa_sessions','session_id'),('user_mfa_sessions','user_id'),('recipes','created_by'),('recipes','id')))`)
    const types = new Map(rows.map((row: { table_name: string; column_name: string; data_type: string }) => [`${row.table_name}.${row.column_name}`, row.data_type]))
    expect(types.get('recipes.id')).toBe('text')
    expect(types.get('recipes.created_by')).toBe('uuid')
    expect(types.get('user_roles.user_id')).toBe('uuid')
    expect(types.get('user_profiles.user_id')).toBe('uuid')
    expect(types.get('user_mfa_sessions.session_id')).toBe('uuid')
    expect(types.get('user_mfa_sessions.user_id')).toBe('uuid')
    const { rows: persisted } = await pool.query('SELECT id, created_by FROM recipes')
    expect(persisted).toEqual([{ id: 'recipe-stays-text', created_by: userId }])
    const { rows: foreignKeys } = await pool.query<{ table_name: string; column_name: string; target_table: string; delete_action: string }>(`
      SELECT source.relname AS table_name, source_column.attname AS column_name,
             target.relname AS target_table, constraint_row.confdeltype AS delete_action
      FROM pg_constraint constraint_row
      JOIN pg_class source ON source.oid=constraint_row.conrelid
      JOIN pg_class target ON target.oid=constraint_row.confrelid
      JOIN pg_attribute source_column ON source_column.attrelid=source.oid AND source_column.attnum=constraint_row.conkey[1]
      WHERE constraint_row.contype='f'
        AND (source.relname, source_column.attname) IN (
          ('user_roles','user_id'), ('user_profiles','user_id'),
          ('user_mfa_sessions','session_id'), ('user_mfa_sessions','user_id'), ('recipes','created_by')
        )
    `)
    expect(foreignKeys).toHaveLength(5)
    const fks = new Map(foreignKeys.map((fk) => [`${fk.table_name}.${fk.column_name}`, fk]))
    expect(fks.get('user_roles.user_id')).toMatchObject({ target_table: 'user', delete_action: 'c' })
    expect(fks.get('user_profiles.user_id')).toMatchObject({ target_table: 'user', delete_action: 'c' })
    expect(fks.get('user_mfa_sessions.session_id')).toMatchObject({ target_table: 'session', delete_action: 'c' })
    expect(fks.get('user_mfa_sessions.user_id')).toMatchObject({ target_table: 'user', delete_action: 'c' })
    expect(fks.get('recipes.created_by')).toMatchObject({ target_table: 'user', delete_action: 'n' })
  })

  it('rolls back malformed UUID conversion without recording migration 0003', async () => {
    await createLegacyAppSchema()
    await pool.query(`INSERT INTO user_roles(user_id) VALUES ('not-a-uuid')`)
    await expect(applyPendingAppMigrations()).rejects.toThrow('invalid value not-a-uuid')
    const { rows: migrationRows } = await pool.query('SELECT version FROM app_migrations WHERE version=$1', ['0003_auth_foreign_keys_uuid'])
    expect(migrationRows).toHaveLength(0)
    const { rows: typeRows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='user_id'`)
    expect(typeRows).toEqual([{ data_type: 'text' }])
  })
})
