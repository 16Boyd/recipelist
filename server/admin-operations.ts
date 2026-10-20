export function validateAdminEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export async function promoteAdmin(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ email: string }>; rowCount: number | null }>,
  input: unknown,
): Promise<string> {
  const email = typeof input === 'string' ? input.trim() : ''
  if (!validateAdminEmail(email)) throw new Error('Usage: npm run admin:promote -- user@example.com')
  const result = await query(
    `UPDATE user_roles role_row
       SET role = 'admin'
       FROM "user" auth_user
      WHERE role_row.user_id = auth_user.id
        AND lower(auth_user.email) = lower($1)
      RETURNING auth_user.email`,
    [email],
  )
  if (!result.rowCount) throw new Error(`No RecipeList account found for ${email}`)
  return result.rows[0].email
}
