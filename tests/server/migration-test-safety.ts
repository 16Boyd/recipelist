const testDatabaseName = /(?:^|[_-])test(?:$|[_-])/i

/** Refuse the PostgreSQL suite's schema reset unless its target is explicitly test-only. */
export function assertSafeMigrationTestDatabase(databaseName: string, allowSchemaReset: string | undefined): void {
  if (allowSchemaReset !== '1') {
    throw new Error('PostgreSQL migration tests require TEST_DATABASE_ALLOW_SCHEMA_RESET=1 because they recreate the public schema.')
  }
  if (!testDatabaseName.test(databaseName)) {
    throw new Error(`Refusing PostgreSQL migration tests against database "${databaseName}": its name must contain a delimited "test" token.`)
  }
}
