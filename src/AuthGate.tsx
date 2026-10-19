import { useState, type FormEvent } from 'react'
import { authClient } from './authClient'
import { errorMessage } from './api'

const meetsPasswordPolicy = (password: string) =>
  password.length <= 128 && /^(?=.*\p{Ll})(?=.*\p{Lu})(?=.*\p{N})(?=.*[^\p{L}\p{N}]).{12,128}$/u.test(password)

export default function AuthGate({ notice = '' }: { notice?: string }) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [challenge, setChallenge] = useState(false)
  const [challengeMethod, setChallengeMethod] = useState<'totp' | 'backup'>('totp')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mode === 'sign-up' && !meetsPasswordPolicy(password)) {
      setMessage('Use at least 12 characters with a lowercase letter, an uppercase letter, a number, and a symbol.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'sign-in') {
        const result = await authClient.signIn.email({ email: email.trim(), password })
        if (result.error) throw result.error
        if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect) {
          setChallenge(true)
          setPassword('')
        }
      } else {
        const result = await authClient.signUp.email({ email: email.trim(), password, name: name.trim() })
        if (result.error) throw result.error
        setMode('sign-in')
        setPassword('')
        setMessage('Your account was created. Sign in to set up your authenticator app.')
      }
    } catch (error) {
      setMessage(errorMessage(error, 'We could not sign you in. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function verifySecondFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (challengeMethod === 'totp') {
      if (!/^\d{6}$/.test(code)) {
        setMessage('Enter the 6-digit code from your authenticator app.')
        return
      }
    } else {
      if (!/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(code.trim())) {
        setMessage('Enter one of your 10-character backup codes in XXXXX-XXXXX format.')
        return
      }
    }
    setBusy(true)
    setMessage('')
    try {
      const result = challengeMethod === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
        : await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: false })
      if (result.error) throw result.error
      setCode('')
      setChallenge(false)
      setChallengeMethod('totp')
    } catch (error) {
      setMessage(errorMessage(error, 'We could not verify that code. Check it and try again.'))
    } finally {
      setBusy(false)
    }
  }

  function switchMode() {
    setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
    setChallenge(false)
    setMessage('')
  }

  return <main className="auth-screen">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div>
      <div className="section-kicker">YOUR KITCHEN, WHEREVER YOU ARE</div>
      <h1 id="auth-title">{challenge ? 'Verify your authenticator.' : mode === 'sign-in' ? 'Welcome back.' : 'Create your account.'}</h1>
      <p className="auth-intro">{challenge ? challengeMethod === 'totp' ? `Enter the current 6-digit code for ${email.trim()}.` : `Enter one of the backup codes you saved for ${email.trim()}.` : 'Sign in to keep your recipes, pantry, and shopping list with your profile.'}</p>
      {notice && !challenge && <p className="auth-message" role="status">{notice}</p>}
      {challenge ? <form className="auth-form" onSubmit={verifySecondFactor}>
        <label className="form-field"><span>{challengeMethod === 'totp' ? '6-digit code' : 'Backup code'}</span><input type="text" inputMode={challengeMethod === 'totp' ? 'numeric' : 'text'} autoComplete="one-time-code" pattern={challengeMethod === 'totp' ? '[0-9]{6}' : '[A-Za-z0-9]{5}-[A-Za-z0-9]{5}'} maxLength={challengeMethod === 'totp' ? 6 : 11} value={code} onChange={(event) => setCode(challengeMethod === 'totp' ? event.target.value.replace(/\D/g, '').slice(0, 6) : event.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 11))} required disabled={busy} /></label>
        {message && <p className="auth-message" role="alert">{message}</p>}
        <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Continue'}</button>
        <button className="auth-switch" type="button" onClick={() => { setChallengeMethod(challengeMethod === 'totp' ? 'backup' : 'totp'); setCode(''); setMessage('') }} disabled={busy}>{challengeMethod === 'totp' ? 'Use a backup code' : 'Use an authenticator code'}</button>
        <button className="auth-switch" type="button" onClick={() => { setChallenge(false); setChallengeMethod('totp'); setCode(''); setMessage('') }} disabled={busy}>Back to sign in</button>
      </form> : <>
        <form className="auth-form" onSubmit={submit}>
          {mode === 'sign-up' && <label className="form-field"><span>Name</span><input type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></label>}
          <label className="form-field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label className="form-field"><span>Password</span><input type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} minLength={mode === 'sign-up' ? 12 : undefined} maxLength={mode === 'sign-up' ? 128 : undefined} aria-describedby={mode === 'sign-up' ? 'signup-password-guidance' : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {mode === 'sign-up' && <p id="signup-password-guidance" className="auth-password-hint">Use 12–128 characters with lowercase and uppercase letters, a number, and a symbol.</p>}
          {message && <p className="auth-message" role="alert">{message}</p>}
          <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
        </form>
        <button className="auth-switch" type="button" onClick={switchMode} disabled={busy}>
          {mode === 'sign-in' ? 'New to RecipeList? Create an account' : 'Already have an account? Sign in'}
        </button>
      </>}
      <p className="auth-storage-note">Your recipes and kitchen data are stored on this RecipeList server. Sign-in sessions use a secure server cookie.</p>
    </section>
  </main>
}
