import 'dotenv/config'
import { pool } from './db.js'
import { promoteAdmin } from './admin-operations.js'

async function main() {
  const email = await promoteAdmin(pool.query.bind(pool), process.argv[2])
  console.info(`Promoted ${email} to admin`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => pool.end())
