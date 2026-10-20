const factorVerificationPaths = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
])

const passwordCreationPaths = new Set(['/sign-up/email', '/change-password', '/reset-password'])

export function isFactorVerificationPath(path: string | undefined): path is string {
  return path !== undefined && factorVerificationPaths.has(path)
}

export function isPasswordCreationPath(path: string | undefined): path is string {
  return path !== undefined && passwordCreationPaths.has(path)
}

export function meetsPasswordPolicy(password: unknown): password is string {
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 128
    && /^(?=.*\p{Ll})(?=.*\p{Lu})(?=.*\p{N})(?=.*[^\p{L}\p{N}]).{12,128}$/u.test(password)
}

export function passwordFromRequest(path: string | undefined, body: unknown): unknown {
  if (!isPasswordCreationPath(path) || typeof body !== 'object' || body === null) return undefined
  const fields = body as Record<string, unknown>
  return path === '/sign-up/email' ? fields.password : fields.newPassword
}

export function requestsTrustedDevice(path: string | undefined, body: unknown): boolean {
  return isFactorVerificationPath(path)
    && typeof body === 'object'
    && body !== null
    && 'trustDevice' in body
    && (body as { trustDevice?: unknown }).trustDevice === true
}
