export type MigrationPlanSafety = { schemaProblems: string[]; unsafeChanges: string[] }

/** Reject Better Auth migration plans containing schema problems or unsafe changes. */
export function assertSafeMigrationPlan(plan: MigrationPlanSafety): void {
  if (plan.schemaProblems.length) throw new Error(`Better Auth schema problems: ${plan.schemaProblems.join('; ')}`)
  if (plan.unsafeChanges.length) throw new Error(`Unsafe Better Auth schema changes: ${plan.unsafeChanges.join('; ')}`)
}

export type AppMigration = { version: string; file: string }
export const appMigrations: AppMigration[] = [
  { version: '0001_app_data_and_recipe_catalog', file: '0001_app_data_and_recipe_catalog.sql' },
  { version: '0002_mfa_session_assurance', file: '0002_mfa_session_assurance.sql' },
  { version: '0003_auth_foreign_keys_uuid', file: '0003_auth_foreign_keys_uuid.sql' },
  { version: '0004_recipe_instructions', file: '0004_recipe_instructions.sql' },
]

type MigrationClient = {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
  release(): void
}

/** Apply unapplied SQL migrations in one transaction and always release the database client. */
export async function applyAppMigrations(
  client: MigrationClient,
  migrations: AppMigration[],
  readMigration: (file: string) => Promise<string>,
): Promise<void> {
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM app_migrations WHERE version = $1', [migration.version])
      if ((applied.rowCount ?? 0) > 0) continue
      const sql = await readMigration(migration.file)
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
}
