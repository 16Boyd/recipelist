import { useEffect, useRef, useState, type FormEvent } from 'react'
import { hasTotpAal2, supabase } from './supabase'

type AssuranceStatus = 'checking' | 'aal1' | 'aal2' | 'error'
type GateStep = 'loading' | 'error' | 'setup' | 'replace' | 'enrollment' | 'challenge'

type PendingFactor = {
  id: string
  factor_type: string
  status: string
}

type Enrollment = {
  userId: string
  factorId: string
  qrCode: string
  secret: string
}

export default function MfaGate({ userId, email, assuranceStatus, assuranceError, onRetryAssurance, onAssuranceVerified, onSignOut, signingOut, accountError }: {
  userId: string
  email: string
  assuranceStatus: AssuranceStatus
  assuranceError: string
  onRetryAssurance: () => void
  onAssuranceVerified: (userId: string) => void
  onSignOut: () => void
  signingOut: boolean
  accountError: string
}) {
  const [step, setStep] = useState<GateStep>('loading')
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null)
  const [pendingFactors, setPendingFactors] = useState<PendingFactor[]>([])
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [factorRefresh, setFactorRefresh] = useState(0)
  const factorRequest = useRef(0)
  const enrollmentRequest = useRef(0)
  const currentUserId = useRef(userId)
  currentUserId.current = userId

  useEffect(() => {
    return () => { enrollmentRequest.current += 1 }
  }, [])

  useEffect(() => {
    factorRequest.current += 1
    enrollmentRequest.current += 1
    setStep('loading')
    setVerifiedFactorId(null)
    setPendingFactors([])
    setEnrollment(null)
    setCode('')
    setMessage('')
    setBusy(false)
  }, [userId])

  useEffect(() => {
    if (assuranceStatus !== 'aal1' || !supabase) return
    const request = ++factorRequest.current
    setStep('loading')
    setMessage('')
    setEnrollment(null)
    setCode('')
    setBusy(false)

    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (request !== factorRequest.current) return
      if (error) throw error
      const verified = data.totp[0]
      const pending = data.all.filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified')
      setPendingFactors(pending)
      setVerifiedFactorId(verified?.id ?? null)
      setStep(verified ? 'challenge' : pending.length > 0 ? 'replace' : 'setup')
    }).catch((error: unknown) => {
      if (request !== factorRequest.current) return
      setMessage(error instanceof Error ? error.message : 'We could not check your authenticator setup. Please try again.')
      setStep('error')
    })

    return () => { factorRequest.current += 1 }
  }, [assuranceStatus, factorRefresh, userId])

  async function beginEnrollment() {
    if (!supabase || busy) return
    const client = supabase
    const requestUserId = userId
    const request = ++enrollmentRequest.current
    const isCurrent = () => request === enrollmentRequest.current && currentUserId.current === requestUserId
    const isCurrentSession = async () => {
      if (!isCurrent()) return false
      const { data, error } = await client.auth.getSession()
      if (error) throw error
      return isCurrent() && data.session?.user.id === requestUserId
    }

    factorRequest.current += 1
    setBusy(true)
    setMessage('')
    setCode('')
    try {
      for (const factor of pendingFactors) {
        if (!(await isCurrentSession())) return
        const { error } = await client.auth.mfa.unenroll({ factorId: factor.id })
        if (!(await isCurrentSession())) return
        if (error) throw error
      }

      if (!(await isCurrentSession())) return
      const { data, error } = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'RecipeList authenticator',
      })
      if (!(await isCurrentSession())) return
      if (error) throw error
      setEnrollment({ userId: requestUserId, factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
      setStep('enrollment')
    } catch (error) {
      if (!isCurrent()) return
      const errorMessage = error instanceof Error ? error.message : 'We could not start authenticator setup. Please try again.'
      try {
        if (!(await isCurrentSession())) return
        const { data, error: listError } = await client.auth.mfa.listFactors()
        if (!(await isCurrentSession())) return
        if (!listError && isCurrent()) {
          const verified = data.totp[0]
          const pending = data.all.filter((factor) => factor.factor_type === 'totp' && factor.status === 'unverified')
          setPendingFactors(pending)
          setVerifiedFactorId(verified?.id ?? null)
          setStep(verified ? 'challenge' : pending.length > 0 ? 'replace' : 'setup')
        }
      } catch {
        // Keep the original setup error visible; the next explicit retry rechecks factors.
      }
      if (isCurrent()) setMessage(errorMessage)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || busy) return
    if (!/^\d{6}$/.test(code)) {
      setMessage('Enter the 6-digit code from your authenticator app.')
      return
    }

    const factorId = enrollment?.factorId ?? verifiedFactorId
    if (!factorId) {
      setMessage('We could not find an authenticator factor for this account. Reload the setup and try again.')
      return
    }

    setBusy(true)
    setMessage('')
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
      if (challengeError) throw challengeError

      const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
      if (verifyError) throw verifyError

      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (assuranceError) throw assuranceError
      if (!hasTotpAal2(assurance)) {
        throw new Error('The code was accepted, but this session has not completed authenticator-app verification. Please try again.')
      }

      setEnrollment(null)
      setCode('')
      onAssuranceVerified(userId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We could not verify that code. Check it and try again.')
    } finally {
      setBusy(false)
    }
  }

  const title = assuranceStatus === 'error'
    ? 'We couldn’t confirm your session.'
    : assuranceStatus === 'checking'
      ? 'Checking your account…'
      : step === 'challenge'
        ? 'Verify your authenticator.'
        : step === 'enrollment'
          ? 'Add RecipeList to your app.'
          : 'Secure your account.'

  return <main className="auth-screen">
    <section className="auth-card mfa-card" aria-labelledby="mfa-title">
      <div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div>
      <div className="section-kicker">{assuranceStatus === 'aal1' ? 'AUTHENTICATOR APP REQUIRED' : 'ACCOUNT SECURITY'}</div>
      <h1 id="mfa-title">{title}</h1>
      <p className="auth-intro">{assuranceStatus === 'aal1' && email ? `Signed in as ${email}. ` : ''}{step === 'challenge' ? 'Enter the current 6-digit code from your authenticator app to continue.' : step === 'enrollment' ? 'Scan this QR code with an authenticator app, or enter the setup key manually.' : assuranceStatus === 'checking' ? 'We are checking the security level of your current sign-in.' : assuranceStatus === 'error' ? 'RecipeList could not verify the security level of this sign-in.' : 'An authenticator app is required before your recipes and kitchen profile can be opened.'}</p>

      {assuranceStatus === 'checking' && <p className="mfa-progress" role="status">Checking your sign-in security…</p>}
      {assuranceStatus === 'error' && <>
        <p className="auth-message" role="alert">{assuranceError || 'We could not check your sign-in security.'}</p>
        <button className="button button-dark auth-submit" type="button" onClick={onRetryAssurance}>Try again</button>
      </>}

      {assuranceStatus === 'aal1' && <>
        {step === 'loading' && <p className="mfa-progress" role="status">Checking authenticator setup…</p>}
        {step === 'error' && <>
          <p className="auth-message" role="alert">{message}</p>
          <button className="button button-dark auth-submit" type="button" onClick={() => setFactorRefresh((refresh) => refresh + 1)}>Try again</button>
        </>}
        {step === 'setup' && <>
          <p className="mfa-instructions">Use any TOTP-compatible authenticator app. RecipeList will ask for a code to finish setup.</p>
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="button" onClick={() => { void beginEnrollment() }} disabled={busy}>{busy ? 'Preparing setup…' : 'Set up authenticator app'}</button>
        </>}
        {step === 'replace' && <>
          <p className="mfa-instructions">An unfinished authenticator setup was found. Replace it to get a fresh QR code and setup key.</p>
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="button" onClick={() => { void beginEnrollment() }} disabled={busy}>{busy ? 'Replacing setup…' : 'Replace unfinished setup'}</button>
        </>}
        {step === 'enrollment' && enrollment?.userId === userId && <>
          <div className="mfa-qr-frame"><img src={enrollment.qrCode} alt="QR code for setting up RecipeList in an authenticator app" /></div>
          <div className="mfa-secret"><span>Manual setup key</span><code>{enrollment.secret}</code></div>
          <form className="auth-form mfa-code-form" onSubmit={verifyCode}>
            <label className="form-field"><span>6-digit code</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label>
            {message && <p className="auth-message" role="alert">{message}</p>}
            <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify and finish setup'}</button>
          </form>
        </>}
        {step === 'challenge' && <form className="auth-form mfa-code-form" onSubmit={verifyCode}>
          <label className="form-field"><span>6-digit code</span><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label>
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Continue'}</button>
        </form>}
      </>}

      {accountError && <p className="auth-message mfa-account-error" role="alert">{accountError}</p>}
      <button className="auth-switch mfa-signout" type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
      <p className="auth-storage-note">Your authenticator setup key is shown only during setup and is not saved in RecipeList.</p>
    </section>
  </main>
}
