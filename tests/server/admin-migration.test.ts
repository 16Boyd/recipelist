import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { promoteAdmin, validateAdminEmail } from '../../server/admin-operations.js'
import { appMigrations, applyAppMigrations, assertSafeMigrationPlan } from '../../server/migration-operations.js'

describe('migration operations', () => {
  it('keeps the app migrations ordered and defines the expected database constraints', async () => {
    expect(appMigrations.map(({ version }) => version)).toEqual([
      '0001_app_data_and_recipe_catalog',
      '0002_mfa_session_assurance',
    ])
    const [appSchema, mfaSchema] = await Promise.all(appMigrations.map(({ file }) =>
      readFile(resolve(process.cwd(), 'server/migrations', file), 'utf8'),
    ))
    expect(appSchema).toContain("role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'))")
    expect(appSchema).toContain('app_data jsonb NOT NULL')
    expect(appSchema).toContain('time integer NOT NULL CHECK (time BETWEEN 1 AND 1440)')
    expect(appSchema).toContain('CHECK (jsonb_typeof(ingredients) = \'array\')')
    expect(mfaSchema).toContain('CREATE TABLE IF NOT EXISTS user_mfa_sessions')
    expect(mfaSchema).toContain('session_id text PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE')
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
    const readMigration = vi.fn(async (file: string) => `-- ${file}`)
    await applyAppMigrations(client, appMigrations, readMigration)
    expect(readMigration).toHaveBeenCalledTimes(1)
    expect(readMigration).toHaveBeenCalledWith(appMigrations[1].file)
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
