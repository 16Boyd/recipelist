import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

// Capture this before Supabase Auth consumes and clears invite callback tokens from the URL.
export const inviteRedirectDetected = (() => {
  if (typeof window === 'undefined') return false
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const isInvite = search.get('type') === 'invite' || hash.get('type') === 'invite'
  const hasAuthCallback = ['code', 'access_token'].some((key) => search.has(key) || hash.has(key))
  return isInvite && hasAuthCallback
})()

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export function hasTotpAal2(assurance: {
  currentLevel: string | null
  currentAuthenticationMethods: unknown[]
}): boolean {
  return assurance.currentLevel === 'aal2'
    && assurance.currentAuthenticationMethods.some((method) => {
      if (typeof method === 'string') return method === 'totp'
      return Boolean(method && typeof method === 'object' && 'method' in method && method.method === 'totp')
    })
}

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
