import { useState, type FormEvent } from 'react'
import { supabase } from './supabase'

const meetsPasswordPolicy = (password: string) =>
  /^(?=.*\p{Ll})(?=.*\p{Lu})(?=.*\p{N})(?=.*[^\p{L}\p{N}]).{12,}$/u.test(password)

export default function AuthGate() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    if (mode === 'sign-up' && !meetsPasswordPolicy(password)) {
      setMessage('Use at least 12 characters with a lowercase letter, an uppercase letter, a number, and a symbol.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const result = mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({ email: email.trim(), password })
      if (result.error) throw result.error
      if (mode === 'sign-up' && !result.data.session) {
        setMessage('Check your email to confirm your account, then sign in.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We could not sign you in. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-screen">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div>
      <div className="section-kicker">YOUR KITCHEN, WHEREVER YOU ARE</div>
      <h1 id="auth-title">{mode === 'sign-in' ? 'Welcome back.' : 'Create your account.'}</h1>
      <p className="auth-intro">Sign in to keep your recipes, pantry, and shopping list with your profile.</p>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label className="form-field"><span>Password</span><input type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} minLength={mode === 'sign-up' ? 12 : undefined} aria-describedby={mode === 'sign-up' ? 'signup-password-guidance' : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {mode === 'sign-up' && <p id="signup-password-guidance" className="auth-password-hint">Use 12 or more characters with lowercase and uppercase letters, a number, and a symbol.</p>}
        {message && <p className="auth-message" role="status">{message}</p>}
        <button className="button button-dark auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="auth-switch" onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setMessage('') }}>
        {mode === 'sign-in' ? 'New to RecipeList? Create an account' : 'Already have an account? Sign in'}
      </button>
      <p className="auth-storage-note">Your recipe and kitchen data is stored in your Supabase profile. Your sign-in session may be remembered in this browser.</p>
    </section>
  </main>
}

export function InvitePasswordSetup({ onComplete, onSignOut, signingOut, accountError }: { onComplete: () => void; onSignOut: () => void; signingOut: boolean; accountError: string }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    if (!meetsPasswordPolicy(password)) {
      setMessage('Use at least 12 characters with a lowercase letter, an uppercase letter, a number, and a symbol.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setPassword('')
      onComplete()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We could not set your password. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-screen">
    <section className="auth-card" aria-labelledby="invite-password-title">
      <div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div>
      <div className="section-kicker">COMPLETE YOUR INVITATION</div>
      <h1 id="invite-password-title">Set your password.</h1>
      <p className="auth-intro">Choose a password before securing your RecipeList account with an authenticator app.</p>
      <form className="auth-form" onSubmit={submit}>
        <label className="form-field"><span>Password</span><input type="password" autoComplete="new-password" minLength={12} aria-describedby="invite-password-guidance" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy || signingOut} /></label>
        <p id="invite-password-guidance" className="auth-password-hint">Use 12 or more characters with lowercase and uppercase letters, a number, and a symbol.</p>
        {message && <p className="auth-message" role="alert">{message}</p>}
        {accountError && <p className="auth-message" role="alert">{accountError}</p>}
        <button className="button button-dark auth-submit" type="submit" disabled={busy || signingOut}>{busy ? 'Please wait…' : 'Set password'}</button>
      </form>
      <button className="auth-switch" type="button" onClick={onSignOut} disabled={busy || signingOut}>{busy ? 'Updating password…' : signingOut ? 'Signing out…' : 'Sign out'}</button>
      <p className="auth-storage-note">Your password is sent directly to Supabase Auth and is not stored in your RecipeList profile.</p>
    </section>
  </main>
}
