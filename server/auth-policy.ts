const factorVerificationPaths = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
])

const passwordCreationPaths = new Set(['/sign-up/email', '/change-password', '/reset-password'])

/** Identify Better Auth endpoints that verify a second factor. */
export function isFactorVerificationPath(path: string | undefined): path is string {
  return path !== undefined && factorVerificationPaths.has(path)
}

/** Identify Better Auth endpoints that create or replace a password. */
export function isPasswordCreationPath(path: string | undefined): path is string {
  return path !== undefined && passwordCreationPaths.has(path)
}

/** Require 12–128 characters containing lowercase, uppercase, numeric, and symbol characters. */
export function meetsPasswordPolicy(password: unknown): password is string {
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 128
    && /^(?=.*\p{Ll})(?=.*\p{Lu})(?=.*\p{N})(?=.*[^\p{L}\p{N}]).{12,128}$/u.test(password)
}

/** Extract the password field used by a supported sign-up or password-change request. */
export function passwordFromRequest(path: string | undefined, body: unknown): unknown {
  if (!isPasswordCreationPath(path) || typeof body !== 'object' || body === null) return undefined
  const fields = body as Record<string, unknown>
  return path === '/sign-up/email' ? fields.password : fields.newPassword
}

/** Detect an MFA verification request that asks to persist trusted-device status. */
export function requestsTrustedDevice(path: string | undefined, body: unknown): boolean {
  return isFactorVerificationPath(path)
    && typeof body === 'object'
    && body !== null
    && 'trustDevice' in body
    && (body as { trustDevice?: unknown }).trustDevice === true
}
