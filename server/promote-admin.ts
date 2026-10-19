import 'dotenv/config'
import { pool } from './db.js'

async function main() {
  const email = process.argv[2]?.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run admin:promote -- user@example.com')
  }
  const result = await pool.query(
    `UPDATE user_roles role_row
       SET role = 'admin'
       FROM "user" auth_user
      WHERE role_row.user_id = auth_user.id
        AND lower(auth_user.email) = lower($1)
      RETURNING auth_user.email`,
    [email],
  )
  if (!result.rowCount) throw new Error(`No RecipeList account found for ${email}`)
  console.info(`Promoted ${result.rows[0].email} to admin`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => pool.end())
