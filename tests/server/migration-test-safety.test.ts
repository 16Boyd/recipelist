import { describe, expect, it } from 'vitest'
import { assertSafeMigrationTestDatabase } from './migration-test-safety.js'

describe('PostgreSQL migration test safety', () => {
  it('requires the explicit destructive-schema-reset opt-in', () => {
    expect(() => assertSafeMigrationTestDatabase('recipelist_migration_test_reviewer', undefined))
      .toThrow('TEST_DATABASE_ALLOW_SCHEMA_RESET=1')
  })

  it('refuses database names without a delimited test token', () => {
    expect(() => assertSafeMigrationTestDatabase('recipelist_production', '1'))
      .toThrow('must contain a delimited "test" token')
  })

  it('allows an explicitly opted-in test database', () => {
    expect(() => assertSafeMigrationTestDatabase('recipelist_migration_test_reviewer', '1')).not.toThrow()
    expect(() => assertSafeMigrationTestDatabase('test', '1')).not.toThrow()
  })
})
