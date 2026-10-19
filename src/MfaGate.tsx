import { useEffect, useState, type FormEvent } from 'react'
import * as QRCode from 'qrcode'
import { apiRequest, errorMessage } from './api'
import { authClient } from './authClient'

type Enrollment = { totpURI: string; qrCode: string; backupCodes: string[] }

export default function MfaGate({ userId, email, onSetupComplete, onSignOut, signingOut, accountError }: {
  userId: string
  email: string
  onSetupComplete: () => void
  onSignOut: () => void
  signingOut: boolean
  accountError: string
}) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [backupCodesSaved, setBackupCodesSaved] = useState(false)

  useEffect(() => {
    setPassword('')
    setCode('')
    setEnrollment(null)
    setMessage('')
    setBackupCodesSaved(false)
  }, [userId])

  async function beginEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await authClient.twoFactor.enable({ password, method: 'totp' })
      if (result.error) throw result.error
      if (!result.data || result.data.method !== 'totp') {
        throw new Error('The authenticator setup did not return TOTP enrollment details.')
      }
      const totpURI = result.data.totpURI
      const qrCode = await QRCode.toDataURL(totpURI, { errorCorrectionLevel: 'M', margin: 2, width: 240 })
      const backupCodes = result.data.backupCodes
      setEnrollment({ totpURI, qrCode, backupCodes })
      setPassword('')
    } catch (error) {
      setMessage(errorMessage(error, 'We could not start authenticator setup. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      setMessage('Enter the 6-digit code from your authenticator app.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
      if (result.error) throw result.error
      await apiRequest('/api/mfa/complete-setup', { method: 'POST', body: JSON.stringify({}) })
      onSetupComplete()
    } catch (error) {
      setMessage(errorMessage(error, 'We could not verify that code. Check it and try again.'))
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-screen">
    <section className="auth-card mfa-card" aria-labelledby="mfa-title">
      <div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div>
      <div className="section-kicker">AUTHENTICATOR APP REQUIRED</div>
      <h1 id="mfa-title">{enrollment ? 'Add RecipeList to your app.' : 'Secure your account.'}</h1>
      <p className="auth-intro">{email ? `Signed in as ${email}. ` : ''}{enrollment ? 'Scan this QR code with an authenticator app, then enter a current code to finish setup.' : 'Set up an authenticator app before opening your recipes and kitchen profile.'}</p>

      {!enrollment && <>
        <p className="mfa-instructions">Use any TOTP-compatible authenticator app. RecipeList will confirm your authenticator before opening your kitchen.</p>
        <form className="auth-form" onSubmit={beginEnrollment}>
          <label className="form-field"><span>Confirm your password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Preparing setup…' : 'Set up authenticator app'}</button>
        </form>
      </>}

      {enrollment && <>
        <div className="mfa-qr-frame"><img src={enrollment.qrCode} alt="QR code for setting up RecipeList in an authenticator app" /></div>
        <div className="mfa-secret"><span>Manual setup key</span><code>{new URL(enrollment.totpURI).searchParams.get('secret') ?? 'Open the QR code in your authenticator app.'}</code></div>
        {enrollment.backupCodes.length > 0 && <div className="mfa-backup-codes">
          <strong>Save your backup codes</strong>
          <p>Store these somewhere private. Each code can be used once if you lose access to your authenticator.</p>
          <ul>{enrollment.backupCodes.map((backupCode) => <li key={backupCode}><code>{backupCode}</code></li>)}</ul>
          <label><input type="checkbox" checked={backupCodesSaved} onChange={(event) => setBackupCodesSaved(event.target.checked)} /> I saved these codes</label>
        </div>}
        <form className="auth-form mfa-code-form" onSubmit={verifyCode}>
          <label className="form-field"><span>6-digit code</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required disabled={busy} /></label>
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy || (enrollment.backupCodes.length > 0 && !backupCodesSaved)}>{busy ? 'Verifying…' : 'Verify and finish setup'}</button>
        </form>
      </>}

      {accountError && <p className="auth-message mfa-account-error" role="alert">{accountError}</p>}
      <button className="auth-switch mfa-signout" type="button" onClick={onSignOut} disabled={signingOut || busy}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
      <p className="auth-storage-note">Your authenticator setup key is shown only during setup. Kitchen data remains on this RecipeList server.</p>
    </section>
  </main>
}
