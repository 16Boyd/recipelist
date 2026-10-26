import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { promoteAdmin, validateAdminEmail } from '../../server/admin-operations.js'
import { appMigrations, applyAppMigrations, assertSafeMigrationPlan } from '../../server/migration-operations.js'
import { demoRecipes } from '../../src/data.js'

function migrationFile(version: string): string {
  const migration = appMigrations.find((candidate) => candidate.version === version)
  if (!migration) throw new Error(`Missing app migration ${version}`)
  return migration.file
}

describe('migration operations', () => {
  it('keeps the app migrations ordered and defines the expected database constraints', async () => {
    expect(appMigrations.map(({ version }) => version)).toEqual([
      '0001_app_data_and_recipe_catalog',
      '0002_mfa_session_assurance',
      '0003_auth_foreign_keys_uuid',
      '0004_recipe_instructions',
      '0005_recipe_instruction_backfill',
    ])
    const [appSchema, mfaSchema] = await Promise.all([
      migrationFile('0001_app_data_and_recipe_catalog'),
      migrationFile('0002_mfa_session_assurance'),
    ].map((file) => readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8')))
    expect(appSchema).toContain("role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'))")
    expect(appSchema).toContain('app_data jsonb NOT NULL')
    expect(appSchema).toContain('time integer NOT NULL CHECK (time BETWEEN 1 AND 1440)')
    expect(appSchema).toContain('CHECK (jsonb_typeof(ingredients) = \'array\')')
    expect(appSchema).toContain('user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE')
    expect(appSchema).toContain('created_by uuid REFERENCES "user"(id) ON DELETE SET NULL')
    expect(appSchema).toContain('id text PRIMARY KEY')
    expect(mfaSchema).toContain('CREATE TABLE IF NOT EXISTS user_mfa_sessions')
    expect(mfaSchema).toContain('session_id uuid PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE')
    expect(mfaSchema).toContain('user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE')
    const fkSql = [appSchema, mfaSchema].join('\n').match(/\b(?:user_id|session_id|created_by)\s+\w+(?:\s+NOT NULL)?\s+(?:PRIMARY KEY\s+)?REFERENCES\s+"(?:user|session)"\(id\)/g) ?? []
    expect(fkSql).toHaveLength(5)
    expect(fkSql.every((declaration) => declaration.includes('uuid'))).toBe(true)
    const upgradeSchema = await readFile(resolve(process.cwd(), 'server/migrations', migrationFile('0003_auth_foreign_keys_uuid')), 'utf8')
    expect(upgradeSchema).toContain('ALTER COLUMN user_id TYPE uuid')
    expect(upgradeSchema).toContain('ALTER COLUMN session_id TYPE uuid')
    const instructionsSchema = await readFile(resolve(process.cwd(), 'server/migrations', migrationFile('0004_recipe_instructions')), 'utf8')
    expect(instructionsSchema).toContain("ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT ''")
    expect(instructionsSchema).toContain('CHECK (length(instructions) <= 12000)')
    const backfillSchema = await readFile(resolve(process.cwd(), 'server/migrations', migrationFile('0005_recipe_instruction_backfill')), 'utf8')
    for (const recipe of demoRecipes) {
      expect(backfillSchema).toContain(`SET instructions = '${recipe.instructions.replaceAll("'", "''")}'\nWHERE id = '${recipe.id}' AND instructions ~ '^[[:space:]]*$';`)
    }
    expect(backfillSchema.split("AND instructions ~ '^[[:space:]]*$';").length - 1).toBe(demoRecipes.length)
  })

  it('blocks schema problems and unsafe changes before migrations run', () => {
    expect(() => assertSafeMigrationPlan({ schemaProblems: [], unsafeChanges: [] })).not.toThrow()
    expect(() => assertSafeMigrationPlan({ schemaProblems: ['missing column'], unsafeChanges: [] })).toThrow('Better Auth schema problems: missing column')
    expect(() => assertSafeMigrationPlan({ schemaProblems: [], unsafeChanges: ['drop table'] })).toThrow('Unsafe Better Auth schema changes: drop table')
  })

  it('skips applied migrations and commits pending migrations in a released transaction', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        return { rows: [], rowCount: sql.startsWith('SELECT') && values?.[0] === appMigrations[0].version ? 1 : 0 }
      }),
      release: vi.fn(),
    }
    const migrations = appMigrations.slice(0, 2)
    const readMigration = vi.fn(async (file: string) => `-- ${file}`)
    await applyAppMigrations(client, migrations, readMigration)
    expect(readMigration).toHaveBeenCalledTimes(1)
    expect(readMigration).toHaveBeenCalledWith(migrations[1].file)
    expect(calls.some(({ sql }) => sql.includes('-- 0001'))).toBe(false)
    expect(calls.some(({ sql }) => sql.includes('-- 0002'))).toBe(true)
    expect(calls.at(-1)?.sql).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rolls back and releases when applying a migration fails', async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql === 'bad sql') throw new Error('migration failed')
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    await expect(applyAppMigrations(client, [{ version: 'v1', file: 'bad.sql' }], async () => 'bad sql')).rejects.toThrow('migration failed')
    expect(calls).toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('admin promotion', () => {
  it('validates email inputs and parameterizes the promotion query', async () => {
    expect(validateAdminEmail(' person@example.com ')).toBe(true)
    expect(validateAdminEmail('invalid')).toBe(false)
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ email: 'person@example.com' }], rowCount: 1 }))
    await expect(promoteAdmin(query, ' person@example.com ')).resolves.toBe('person@example.com')
    expect(query.mock.calls[0][1]).toEqual(['person@example.com'])
    expect(query.mock.calls[0][0]).toContain('lower($1)')
  })

  it('reports invalid input and accounts that are not present', async () => {
    await expect(promoteAdmin(vi.fn(), 'bad')).rejects.toThrow('Usage: npm run admin:promote -- user@example.com')
    await expect(promoteAdmin(vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 })), 'nobody@example.com'))
      .rejects.toThrow('No RecipeList account found for nobody@example.com')
  })
})
