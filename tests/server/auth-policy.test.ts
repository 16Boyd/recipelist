import { describe, expect, it } from 'vitest'
import { isFactorVerificationPath, isPasswordCreationPath, meetsPasswordPolicy, passwordFromRequest, requestsTrustedDevice } from '../../server/auth-policy.js'

describe('auth policy helpers', () => {
  it('enforces Unicode-aware password length and character classes', () => {
    expect(meetsPasswordPolicy('Abcdefghij1!')).toBe(true)
    expect(meetsPasswordPolicy('Äbcdefghij1!')).toBe(true)
    expect(meetsPasswordPolicy('Abcdefghij١!')).toBe(true)
    expect(meetsPasswordPolicy('Abcdefghijk!')).toBe(false)
    expect(meetsPasswordPolicy('abcdefghij1!')).toBe(false)
    expect(meetsPasswordPolicy('ABCDEFGHIJ1!')).toBe(false)
    expect(meetsPasswordPolicy('Abcdefghijkl!')).toBe(false)
    expect(meetsPasswordPolicy(`Abcdefghij1!${'a'.repeat(116)}`)).toBe(true)
    expect(meetsPasswordPolicy(`Abcdefghij1!${'a'.repeat(117)}`)).toBe(false)
    expect(meetsPasswordPolicy(null)).toBe(false)
  })

  it('uses the correct password field for signup, password change, and reset', () => {
    expect(isPasswordCreationPath('/sign-up/email')).toBe(true)
    expect(passwordFromRequest('/sign-up/email', { password: 'ValidPass123!' })).toBe('ValidPass123!')
    expect(passwordFromRequest('/change-password', { newPassword: 'ValidPass123!' })).toBe('ValidPass123!')
    expect(passwordFromRequest('/reset-password', { newPassword: 'ValidPass123!' })).toBe('ValidPass123!')
    expect(passwordFromRequest('/sign-in/email', { password: 'ValidPass123!' })).toBeUndefined()
    expect(passwordFromRequest('/change-password', null)).toBeUndefined()
  })

  it('recognizes only supported factor verification paths and rejects trusted-device opt-in there', () => {
    for (const path of ['/two-factor/verify-totp', '/two-factor/verify-backup-code', '/two-factor/verify-otp']) {
      expect(isFactorVerificationPath(path)).toBe(true)
      expect(requestsTrustedDevice(path, { trustDevice: true })).toBe(true)
      expect(requestsTrustedDevice(path, { trustDevice: false })).toBe(false)
    }
    expect(isFactorVerificationPath('/two-factor/enable')).toBe(false)
    expect(requestsTrustedDevice('/two-factor/enable', { trustDevice: true })).toBe(false)
  })
})
