import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
})

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error', error)
})
