import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { getMigrations } from 'better-auth/db/migration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appMigrations, applyAppMigrations, assertSafeMigrationPlan } from '../../server/migration-operations.js'
import { assertSafeMigrationTestDatabase } from './migration-test-safety.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const allowSchemaReset = process.env.TEST_DATABASE_ALLOW_SCHEMA_RESET
const suite = databaseUrl ? describe : describe.skip

suite('PostgreSQL migration integration (dedicated TEST_DATABASE_URL and explicit schema-reset opt-in required)', () => {
  const pool = new Pool({ connectionString: databaseUrl })
  let productionPool: typeof import('../../server/db.js').pool | undefined

  beforeAll(async () => {
    await resetPublicSchemaAndBetterAuth()
    const client = await pool.connect()
    await applyAppMigrations(client, appMigrations, (file) =>
      readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'),
    )
  })

  /** Recreate the actual Better Auth schema after the guarded public-schema reset. */
  async function resetPublicSchemaAndBetterAuth() {
    const { rows } = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    const databaseName = rows[0]?.database_name ?? ''
    assertSafeMigrationTestDatabase(databaseName, allowSchemaReset)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    process.env.DATABASE_URL = databaseUrl
    process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'
    process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-at-least-32-characters'
    const { authOptions } = await import('../../server/auth.js')
    const db = await import('../../server/db.js')
    productionPool = db.pool
    const plan = await getMigrations(authOptions)
    assertSafeMigrationPlan(plan)
    await plan.runMigrations()
  }

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

  /** Recreate the pre-fix app tables and mark migrations 0001/0002 as applied. */
  async function createLegacyAppSchema() {
    await pool.query(`
      DROP TRIGGER IF EXISTS recipe_list_user_after_insert ON "user";
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

  /** Apply the registered app migrations on a dedicated connection. */
  async function applyPendingAppMigrations(migrations = appMigrations) {
    const client = await pool.connect()
    await applyAppMigrations(client, migrations, (file) =>
      readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'),
    )
  }

  it('upgrades legacy text columns, restores all auth FKs and leaves recipe identifiers text', async () => {
    await createLegacyAppSchema()
    const userId = 'ce5ea668-7252-4db8-bd68-96cbf1b0c001'
    const sessionId = 'ce5ea668-7252-4db8-bd68-96cbf1b0c002'
    const braceWrappedUserId = `{${userId.replaceAll('-', '').toUpperCase()}}`
    await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'x', 'legacy@example.invalid', false, now(), now())`, [userId])
    await pool.query(`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ($1, now() + interval '1 day', 'legacy-token', now(), now(), $2)`, [sessionId, userId])
    await pool.query('INSERT INTO user_roles(user_id) VALUES ($1)', [userId])
    await pool.query('INSERT INTO user_profiles(user_id) VALUES ($1)', [braceWrappedUserId])
    // Model the role/profile rows that the app trigger created before the upgrade.
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
    const { rows: roleRows } = await pool.query('SELECT user_id FROM user_roles')
    expect(roleRows).toEqual([{ user_id: userId }])
    const { rows: profileRows } = await pool.query('SELECT user_id FROM user_profiles')
    expect(profileRows).toEqual([{ user_id: userId }])
    const { rows: nullability } = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public'
        AND (table_name, column_name) IN (
          ('user_roles','user_id'), ('user_profiles','user_id'),
          ('user_mfa_sessions','session_id'), ('user_mfa_sessions','user_id'),
          ('recipes','created_by')
        )
    `)
    const nullableByColumn = new Map(nullability.map((column) => [`${column.table_name}.${column.column_name}`, column.is_nullable]))
    expect(nullableByColumn.get('user_roles.user_id')).toBe('NO')
    expect(nullableByColumn.get('user_profiles.user_id')).toBe('NO')
    expect(nullableByColumn.get('user_mfa_sessions.session_id')).toBe('NO')
    expect(nullableByColumn.get('user_mfa_sessions.user_id')).toBe('NO')
    expect(nullableByColumn.get('recipes.created_by')).toBe('YES')
    const { rows: primaryKeys } = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
      WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'
        AND (tc.table_name, kcu.column_name) IN (
          ('user_roles','user_id'), ('user_profiles','user_id'), ('user_mfa_sessions','session_id')
        )
    `)
    expect(new Set(primaryKeys.map(({ table_name, column_name }) => `${table_name}.${column_name}`))).toEqual(new Set([
      'user_roles.user_id', 'user_profiles.user_id', 'user_mfa_sessions.session_id',
    ]))
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
    await expect(applyPendingAppMigrations()).resolves.toBeUndefined()
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

  it('backfills blank and whitespace-only seeded recipe instructions while preserving admin text', async () => {
    await createLegacyAppSchema()
    const seedIds = ['tomato-orzo', 'chickpea-bowls', 'miso-salmon', 'lemon-chicken', 'mushroom-tacos', 'sausage-peppers']
    const migrationsThrough0004 = appMigrations.filter(({ version }) =>
      version === '0001_app_data_and_recipe_catalog'
      || version === '0002_mfa_session_assurance'
      || version === '0003_auth_foreign_keys_uuid'
      || version === '0004_recipe_instructions',
    )
    await applyPendingAppMigrations(migrationsThrough0004)
    await pool.query('INSERT INTO recipes(id, created_by) SELECT seed_id, NULL FROM unnest($1::text[]) AS seed(seed_id)', [seedIds])
    await pool.query("UPDATE recipes SET instructions = 'admin text' WHERE id = 'tomato-orzo'")
    await pool.query("UPDATE recipes SET instructions = chr(9) || chr(10) || ' ' WHERE id = 'miso-salmon'")
    await applyPendingAppMigrations(appMigrations.filter(({ version }) => version === '0005_recipe_instruction_backfill'))
    const { rows } = await pool.query<{ id: string; instructions: string }>('SELECT id, instructions FROM recipes ORDER BY id')
    expect(rows).toHaveLength(seedIds.length)
    expect(rows.every(({ instructions }) => instructions.trim().length > 0)).toBe(true)
    expect(rows.find(({ id }) => id === 'tomato-orzo')?.instructions).toBe('admin text')
    expect(rows.find(({ id }) => id === 'miso-salmon')?.instructions.trim()).not.toBe('')
  })

  it('rejects orphaned UUID values before converting columns', async () => {
    await createLegacyAppSchema()
    const missingUserId = 'ce5ea668-7252-4db8-bd68-96cbf1b0c099'
    await pool.query('INSERT INTO user_profiles(user_id) VALUES ($1)', [missingUserId])
    await expect(applyPendingAppMigrations()).rejects.toThrow(`orphaned value ${missingUserId}`)
    const { rows: typeRows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_profiles' AND column_name='user_id'`)
    expect(typeRows).toEqual([{ data_type: 'text' }])
    const { rows: migrationRows } = await pool.query('SELECT version FROM app_migrations WHERE version=$1', ['0003_auth_foreign_keys_uuid'])
    expect(migrationRows).toHaveLength(0)
  })

  it('reports missing and unsupported child columns before conversion', async () => {
    await createLegacyAppSchema()
    await pool.query('ALTER TABLE user_roles ALTER COLUMN user_id TYPE varchar(64)')
    await expect(applyPendingAppMigrations()).rejects.toThrow('user_roles.user_id has unsupported type character varying')
    await createLegacyAppSchema()
    await pool.query('ALTER TABLE recipes DROP COLUMN created_by')
    await expect(applyPendingAppMigrations()).rejects.toThrow('expected column public.recipes.created_by is missing')
  })

  it('reports missing or non-UUID Better Auth parent keys clearly', async () => {
    await resetPublicSchemaAndBetterAuth()
    await createLegacyAppSchema()
    await pool.query('DROP TABLE "session" CASCADE')
    await expect(applyPendingAppMigrations()).rejects.toThrow('expected parent column public.session.id is missing')

    await resetPublicSchemaAndBetterAuth()
    await createLegacyAppSchema()
    await pool.query('DROP TABLE "session" CASCADE; DROP TABLE "user" CASCADE; CREATE TABLE "user" (id text PRIMARY KEY)')
    await expect(applyPendingAppMigrations()).rejects.toThrow('parent key public.user.id has unsupported type text')
    const { rows: typeRows } = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='user_id'`)
    expect(typeRows).toEqual([{ data_type: 'text' }])
  })
})
