import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import AuthGate, { InvitePasswordSetup } from './AuthGate'
import { createId, makeRecipe, matchRecipes, normalizeName } from './lib'
import MfaGate from './MfaGate'
import { loadProfile, saveProfile } from './profileStorage'
import { hasTotpAal2, inviteRedirectDetected, supabase, supabaseConfigured } from './supabase'
import { initialAppData } from './data'
import { insertSharedRecipe, loadCurrentUserRole, loadSharedRecipes } from './recipeStorage'
import type { AppData, Ingredient, Recipe, RecipeMatch, UserRole } from './types'

type Section = 'discover' | 'recipes' | 'pantry' | 'shopping'

const sectionLabels: Record<Section, string> = {
  discover: 'Discover',
  recipes: 'Recipes',
  pantry: 'Pantry',
  shopping: 'Shopping list',
}

function Icon({ name, size = 20 }: { name: 'sparkle' | 'book' | 'basket' | 'bag' | 'search' | 'plus' | 'arrow' | 'clock' | 'users' | 'close' | 'check' | 'trash' | 'leaf' | 'chef' | 'chevron'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<string, ReactNode> = {
    sparkle: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" /><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h7M8 10h5" /></>,
    basket: <><path d="m3 10 2 10h14l2-10H3Z" /><path d="m8 10 4-7 4 7M8 14v3M12 14v3M16 14v3" /></>,
    bag: <><path d="M5 8h14l1 13H4L5 8Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /><path d="m9 14 2 2 4-4" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.3 4.3" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    users: <><path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="10" cy="8" r="3.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 15h.5a3.5 3.5 0 0 1 3.5 3.5V20" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3" /></>,
    leaf: <><path d="M20 4c-8 0-14 3-14 10a6 6 0 0 0 6 6c7 0 8-8 8-16Z" /><path d="M4 21c2-5 6-8 12-11" /></>,
    chef: <><path d="M6 20h12l1-10a3.5 3.5 0 0 0-5.2-3A4 4 0 0 0 6 8.5 3.5 3.5 0 0 0 6 10l0 10Z" /><path d="M9 14v2M15 14v2" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
  }
  return <svg {...common}>{paths[name]}</svg>
}

type ProfileStatus = 'loading' | 'ready' | 'error'
type SaveStatus = 'saved' | 'saving' | 'error'
type AssuranceStatus = 'checking' | 'aal1' | 'aal2' | 'error'
// This key stores only the invite password-step flag, never profile or kitchen data.
const INVITE_PASSWORD_SETUP_KEY = 'recipelist.invite-password-setup.'

function hasPendingInvitePasswordSetup(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${INVITE_PASSWORD_SETUP_KEY}${userId}`) === 'pending'
  } catch {
    return false
  }
}

function markInvitePasswordSetupPending(userId: string): void {
  try {
    window.localStorage.setItem(`${INVITE_PASSWORD_SETUP_KEY}${userId}`, 'pending')
  } catch {
    // The in-memory gate still protects the active invitation flow.
  }
}

function clearPendingInvitePasswordSetup(userId: string): void {
  try {
    window.localStorage.removeItem(`${INVITE_PASSWORD_SETUP_KEY}${userId}`)
  } catch {
    // The in-memory gate still protects the active invitation flow.
  }
}

function clearInviteRedirectMarker() {
  const url = new URL(window.location.href)
  if (url.searchParams.get('type') === 'invite') url.searchParams.delete('type')
  if (url.hash) {
    const hash = new URLSearchParams(url.hash.slice(1))
    if (hash.get('type') === 'invite') {
      hash.delete('type')
      url.hash = hash.toString()
    }
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function App() {
  const [authResolved, setAuthResolved] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [assuranceStatus, setAssuranceStatus] = useState<AssuranceStatus>('checking')
  const [assuranceError, setAssuranceError] = useState('')
  const [assuranceAttempt, setAssuranceAttempt] = useState(0)
  const [inviteSetupUserId, setInviteSetupUserId] = useState<string | null>(null)
  const [inviteCallbackPending, setInviteCallbackPending] = useState(inviteRedirectDetected)
  const [data, setData] = useState<AppData | null>(null)
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null)
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('loading')
  const [profileError, setProfileError] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [profileAttempt, setProfileAttempt] = useState(0)
  const [saveAttempt, setSaveAttempt] = useState(0)
  const [accountError, setAccountError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const generation = useRef(0)
  const assuranceRequest = useRef(0)
  const inviteSetupUserIdRef = useRef<string | null>(null)
  const inviteRedirectPending = useRef(inviteRedirectDetected)
  const editRevision = useRef(0)
  const savedRevision = useRef(0)
  const activeUserId = useRef<string | null>(null)
  const saveTimer = useRef<number | null>(null)
  const activeFlush = useRef<Promise<boolean> | null>(null)
  const signingOutRef = useRef(false)
  const profileSnapshot = useRef<{ userId: string | null; data: AppData | null; loadedUserId: string | null; status: ProfileStatus; assuranceStatus: AssuranceStatus; generation: number }>({ userId: null, data: null, loadedUserId: null, status: 'loading', assuranceStatus, generation: 0 })
  profileSnapshot.current = { userId: user?.id ?? null, data, loadedUserId, status: profileStatus, assuranceStatus, generation: generation.current }
  const inviteSetupRequired = Boolean(user && inviteSetupUserId === user.id)

  function captureInviteCallbackUser(event: string | null, userId: string | null) {
    if (event === 'SIGNED_IN' && inviteRedirectPending.current && userId) {
      markInvitePasswordSetupPending(userId)
      inviteSetupUserIdRef.current = userId
      setInviteSetupUserId(userId)
      inviteRedirectPending.current = false
      setInviteCallbackPending(false)
    }
  }

  function expireUnclaimedInviteRedirect() {
    window.setTimeout(() => {
      if (!inviteRedirectPending.current) return
      inviteRedirectPending.current = false
      setInviteCallbackPending(false)
      clearInviteRedirectMarker()
    }, 0)
  }

  function clearInviteSetup() {
    inviteSetupUserIdRef.current = null
    setInviteSetupUserId(null)
  }

  function restoreInviteSetupForUser(userId: string | null) {
    if (userId && hasPendingInvitePasswordSetup(userId)) {
      inviteSetupUserIdRef.current = userId
      setInviteSetupUserId(userId)
    } else if (inviteSetupUserIdRef.current && inviteSetupUserIdRef.current !== userId) {
      clearInviteSetup()
    }
  }

  function resetProfileAccess(nextAssurance: 'aal1' | 'error') {
    generation.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    activeFlush.current = null
    profileSnapshot.current = {
      ...profileSnapshot.current,
      data: null,
      loadedUserId: null,
      status: 'loading',
      assuranceStatus: nextAssurance,
      generation: generation.current,
    }
    setData(null)
    setLoadedUserId(null)
    setProfileStatus('loading')
    setProfileError('')
    setSaveStatus('saved')
  }

  useEffect(() => {
    if (!supabase) return
    let eventReceived = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Keep this callback synchronous. Assurance and profile checks happen in effects below.
      eventReceived = true
      const nextUser = session?.user ?? null
      const nextUserId = nextUser?.id ?? null
      captureInviteCallbackUser(event, nextUserId)
      restoreInviteSetupForUser(nextUserId)
      if (event === 'INITIAL_SESSION' && inviteRedirectPending.current) expireUnclaimedInviteRedirect()
      const userChanged = activeUserId.current !== nextUserId
      assuranceRequest.current += 1
      generation.current += 1
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      // Detach the prior promise. An already-issued update cannot be cancelled,
      // but the generation guard ignores its result and a later retry can queue.
      activeFlush.current = null
      if (userChanged) {
        activeUserId.current = nextUserId
        savedRevision.current = editRevision.current
        setData(null)
        setLoadedUserId(null)
        setProfileStatus('loading')
        setProfileError('')
        setSaveStatus('saved')
        setAccountError('')
      }
      const nextAssurance: AssuranceStatus = nextUser ? 'checking' : 'aal1'
      profileSnapshot.current = {
        ...profileSnapshot.current,
        userId: nextUserId,
        data: userChanged ? null : profileSnapshot.current.data,
        loadedUserId: userChanged ? null : profileSnapshot.current.loadedUserId,
        status: userChanged ? 'loading' : profileSnapshot.current.status,
        assuranceStatus: nextAssurance,
        generation: generation.current,
      }
      setAssuranceStatus(nextAssurance)
      setAssuranceError('')
      if (nextUser) setAssuranceAttempt((attempt) => attempt + 1)
      setUser(nextUser)
      setAuthResolved(true)
    })
    void supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (eventReceived) return
      if (error) setProfileError(error.message)
      const nextUser = session?.user ?? null
      restoreInviteSetupForUser(nextUser?.id ?? null)
      if (inviteRedirectPending.current) expireUnclaimedInviteRedirect()
      activeUserId.current = nextUser?.id ?? null
      setUser(nextUser)
      setAuthResolved(true)
    }).catch((error: unknown) => {
      if (eventReceived) return
      if (inviteRedirectPending.current) expireUnclaimedInviteRedirect()
      setProfileError(error instanceof Error ? error.message : 'Could not check your sign-in session.')
      activeUserId.current = null
      setAuthResolved(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!authResolved || !user || !supabase) return
    let cancelled = false
    const request = ++assuranceRequest.current
    setAssuranceStatus('checking')
    void supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data: assurance, error }) => {
      if (cancelled || request !== assuranceRequest.current) return
      if (error) throw error
      if (hasTotpAal2(assurance)) {
        setAssuranceError('')
        profileSnapshot.current = { ...profileSnapshot.current, assuranceStatus: 'aal2' }
        setAssuranceStatus('aal2')
        return
      }

      generation.current += 1
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      activeFlush.current = null
      profileSnapshot.current = {
        ...profileSnapshot.current,
        data: null,
        loadedUserId: null,
        status: 'loading',
        assuranceStatus: 'aal1',
        generation: generation.current,
      }
      setData(null)
      setLoadedUserId(null)
      setProfileStatus('loading')
      setProfileError('')
      setSaveStatus('saved')
      setAssuranceError('')
      setAssuranceStatus('aal1')
    }).catch((error: unknown) => {
      if (cancelled || request !== assuranceRequest.current) return
      generation.current += 1
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      activeFlush.current = null
      profileSnapshot.current = { ...profileSnapshot.current, assuranceStatus: 'error', generation: generation.current }
      setAssuranceError(error instanceof Error ? error.message : 'Could not verify your sign-in security level.')
      setAssuranceStatus('error')
    })
    return () => {
      cancelled = true
      if (assuranceRequest.current === request) assuranceRequest.current += 1
    }
  }, [authResolved, assuranceAttempt, user?.id])

  useEffect(() => {
    if (!authResolved || !user || assuranceStatus !== 'aal2' || inviteSetupRequired || inviteCallbackPending) return
    const userId = user.id
    if (profileSnapshot.current.userId === userId && profileSnapshot.current.loadedUserId === userId && profileSnapshot.current.status === 'ready' && profileSnapshot.current.data) return
    const requestGeneration = ++generation.current
    savedRevision.current = editRevision.current
    setData(null)
    setLoadedUserId(null)
    setProfileStatus('loading')
    setProfileError('')
    void loadProfile(userId, initialAppData).then((profile) => {
      if (generation.current !== requestGeneration) return
      savedRevision.current = editRevision.current
      setData(profile)
      setLoadedUserId(userId)
      setProfileStatus('ready')
      setSaveStatus('saved')
    }).catch((error: unknown) => {
      if (generation.current !== requestGeneration) return
      setProfileError(error instanceof Error ? error.message : 'Could not load your kitchen profile.')
      setProfileStatus('error')
    })
    return () => { generation.current += 1 }
  }, [authResolved, assuranceStatus, inviteSetupRequired, inviteCallbackPending, user?.id, profileAttempt])

  useEffect(() => {
    if (assuranceStatus !== 'aal2' || !user || !data || loadedUserId !== user.id || profileStatus !== 'ready' || savedRevision.current === editRevision.current) return
    const timeout = window.setTimeout(() => {
      saveTimer.current = null
      void flushSaveRef.current()
    }, 500)
    saveTimer.current = timeout
    return () => {
      window.clearTimeout(timeout)
      if (saveTimer.current === timeout) saveTimer.current = null
    }
  }, [assuranceStatus, data, loadedUserId, profileStatus, saveAttempt, user?.id])

  const flushSaveRef = useRef<() => Promise<boolean>>(async () => true)
  flushSaveRef.current = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (activeFlush.current) return activeFlush.current

    const flush = (async () => {
      while (savedRevision.current < editRevision.current) {
        const snapshot = profileSnapshot.current
        if (snapshot.assuranceStatus !== 'aal2' || !snapshot.userId || snapshot.loadedUserId !== snapshot.userId || snapshot.status !== 'ready' || !snapshot.data) return false
        const revision = editRevision.current
        try {
          setSaveStatus('saving')
          await saveProfile(snapshot.userId, snapshot.data)
          const latest = profileSnapshot.current
          if (latest.userId !== snapshot.userId || latest.generation !== snapshot.generation) return false
          savedRevision.current = Math.max(savedRevision.current, revision)
        } catch (error) {
          const latest = profileSnapshot.current
          if (latest.userId === snapshot.userId && latest.generation === snapshot.generation) {
            setSaveStatus('error')
            setProfileError(error instanceof Error ? error.message : 'Could not save your changes. They are still available here; try again.')
          }
          return false
        }
      }
      setSaveStatus('saved')
      setProfileError('')
      return true
    })()
    activeFlush.current = flush
    void flush.then(() => {
      if (activeFlush.current === flush) activeFlush.current = null
    }, () => {
      if (activeFlush.current === flush) activeFlush.current = null
    })
    return flush
  }

  function updateProfileData(update: (current: AppData) => AppData) {
    const current = profileSnapshot.current.data
    if (!current || profileSnapshot.current.assuranceStatus !== 'aal2' || signingOutRef.current) return
    const next = update(current)
    editRevision.current += 1
    profileSnapshot.current = { ...profileSnapshot.current, data: next }
    setData(next)
    setSaveStatus('saving')
    setProfileError('')
  }

  async function signOut() {
    if (!supabase || signingOutRef.current) return
    signingOutRef.current = true
    setSigningOut(true)
    setAccountError('')
    try {
      // MFA screens have no profile data to save. Keep sign-out available while the
      // session is below AAL2; the normal app still flushes pending edits first.
      const snapshot = profileSnapshot.current
      const hasPendingData = savedRevision.current < editRevision.current
        && snapshot.userId === activeUserId.current
        && snapshot.loadedUserId === snapshot.userId
        && snapshot.data !== null
      if (hasPendingData && snapshot.assuranceStatus !== 'aal2') {
        setAccountError('Please wait for the session security check to finish, then try signing out again so your pending changes can be saved.')
        return
      }
      const saved = snapshot.assuranceStatus === 'aal2' ? await flushSaveRef.current() : true
      if (!saved) return
      const { error } = await supabase.auth.signOut()
      if (error) setAccountError(`Could not sign out: ${error.message}`)
    } catch (error) {
      setAccountError(error instanceof Error ? `Could not sign out: ${error.message}` : 'Could not sign out. Please try again.')
    } finally {
      signingOutRef.current = false
      setSigningOut(false)
    }
  }

  function retryAssurance() {
    assuranceRequest.current += 1
    generation.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    activeFlush.current = null
    profileSnapshot.current = { ...profileSnapshot.current, assuranceStatus: 'checking', generation: generation.current }
    setAssuranceError('')
    setAssuranceStatus('checking')
    setAssuranceAttempt((attempt) => attempt + 1)
  }

  function acceptInvitePassword(userId: string) {
    if (activeUserId.current !== userId || inviteSetupUserIdRef.current !== userId) return
    clearInviteRedirectMarker()
    clearPendingInvitePasswordSetup(userId)
    clearInviteSetup()
  }

  function handleMfaVerified(verifiedUserId: string) {
    if (activeUserId.current !== verifiedUserId || !supabase) return
    const request = ++assuranceRequest.current
    generation.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    activeFlush.current = null
    profileSnapshot.current = { ...profileSnapshot.current, assuranceStatus: 'checking', generation: generation.current }
    setAssuranceStatus('checking')
    setAssuranceError('')
    void supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data: assurance, error }) => {
      if (request !== assuranceRequest.current || activeUserId.current !== verifiedUserId) return
      if (error) throw error
      if (!hasTotpAal2(assurance)) {
        resetProfileAccess('aal1')
        setAssuranceStatus('aal1')
        return
      }
      profileSnapshot.current = { ...profileSnapshot.current, assuranceStatus: 'aal2' }
      setAssuranceStatus('aal2')
    }).catch((error: unknown) => {
      if (request !== assuranceRequest.current || activeUserId.current !== verifiedUserId) return
      resetProfileAccess('error')
      setAssuranceError(error instanceof Error ? error.message : 'Could not verify your sign-in security level.')
      setAssuranceStatus('error')
    })
  }

  if (!supabaseConfigured) return <SetupScreen />
  if (!authResolved) return <StatusScreen title="Checking your account…" />
  if (!user) return <AuthGate />
  if (inviteCallbackPending) return <StatusScreen title="Completing your invitation…" />
  if (inviteSetupRequired) return <InvitePasswordSetup key={user.id} onComplete={() => acceptInvitePassword(user.id)} onSignOut={() => { void signOut() }} signingOut={signingOut} accountError={accountError} />
  if (assuranceStatus !== 'aal2') return <MfaGate key={user.id} userId={user.id} email={user.email ?? ''} assuranceStatus={assuranceStatus} assuranceError={assuranceError} onRetryAssurance={retryAssurance} onAssuranceVerified={handleMfaVerified} onSignOut={() => { void signOut() }} signingOut={signingOut} accountError={accountError} />
  if (profileStatus === 'error') return <StatusScreen title="We couldn’t load your kitchen" message={profileError} onRetry={() => { setProfileStatus('loading'); setProfileError(''); setLoadedUserId(null); setProfileAttempt((attempt) => attempt + 1) }} />
  if (profileStatus === 'loading' || loadedUserId !== user.id || !data) return <StatusScreen title="Loading your kitchen…" />
  return <KitchenApp user={user} data={data} onDataChange={updateProfileData} saveStatus={saveStatus} saveError={profileError} accountError={accountError} signingOut={signingOut} onRetrySave={() => setSaveAttempt((attempt) => attempt + 1)} onSignOut={() => { void signOut() }} />
}

function SetupScreen() {
  return <StatusScreen title="Connect RecipeList to Supabase" message="For local use, run npx supabase start, copy the local API URL and publishable/anon key from npx supabase status into .env.local, then restart the app. The checked-in migration is applied by the local stack. See README.md for hosted setup." />
}

function StatusScreen({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return <main className="auth-screen"><section className="auth-card status-card"><div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div><h1>{title}</h1>{message && <p className="auth-intro" role={onRetry ? 'alert' : undefined}>{message}</p>}{onRetry && <button className="button button-dark auth-submit" onClick={onRetry}>Try again</button>}</section></main>
}

function KitchenApp({ user, data, onDataChange, saveStatus, saveError, accountError, signingOut, onRetrySave, onSignOut }: { user: User; data: AppData; onDataChange: (update: (current: AppData) => AppData) => void; saveStatus: SaveStatus; saveError: string; accountError: string; signingOut: boolean; onRetrySave: () => void; onSignOut: () => void }) {
  const [section, setSection] = useState<Section>('discover')
  const [query, setQuery] = useState('')
  const [pantryEntry, setPantryEntry] = useState('')
  const [shoppingEntry, setShoppingEntry] = useState('')
  const [onlyCookable, setOnlyCookable] = useState(false)
  const [showRecipeForm, setShowRecipeForm] = useState(false)
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null)
  const [toast, setToast] = useState('')
  const [role, setRole] = useState<UserRole | null>(null)
  const [roleUserId, setRoleUserId] = useState<string | null>(null)
  const [roleError, setRoleError] = useState('')
  const [sharedRecipes, setSharedRecipes] = useState<Recipe[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [catalogSaving, setCatalogSaving] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    setRole(null)
    setRoleUserId(null)
    setRoleError('')
    setSharedRecipes([])
    setCatalogError('')
    void loadCurrentUserRole(user.id).then((nextRole) => {
      if (active) { setRole(nextRole); setRoleUserId(user.id) }
    }).catch((error: unknown) => {
      if (active) setRoleError(error instanceof Error ? error.message : 'Could not verify your account role.')
    })
    void loadSharedRecipes().then((recipes) => {
      if (active) { setSharedRecipes(recipes); setCatalogError('') }
    }).catch((error: unknown) => {
      if (active) setCatalogError(error instanceof Error ? error.message : 'Could not load the shared recipe catalog.')
    })
    return () => { active = false }
  }, [user.id, catalogAttempt])

  const closeRecipeForm = useCallback(() => setShowRecipeForm(false), [])
  const closeSelectedRecipe = useCallback(() => setSelectedRecipe(null), [])

  const initials = user.email?.trim().slice(0, 1).toLocaleUpperCase() || 'U'
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timeout)
  }, [toast])
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'k' || showRecipeForm || selectedRecipe) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [showRecipeForm, selectedRecipe])

  const recipes = useMemo(() => {
    const sharedIds = new Set(sharedRecipes.map((recipe) => recipe.id))
    return [...sharedRecipes, ...data.recipes.filter((recipe) => !sharedIds.has(recipe.id))]
  }, [data.recipes, sharedRecipes])
  const matches = useMemo(() => matchRecipes(recipes, data.pantry), [recipes, data.pantry])
  const filteredMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return matches.filter(({ recipe, missing }) => {
      const searchText = [recipe.title, recipe.source, recipe.category, ...recipe.ingredients.map((item) => item.name)].join(' ').toLocaleLowerCase()
      return (!needle || searchText.includes(needle)) && (!onlyCookable || section !== 'recipes' || missing.length === 0)
    })
  }, [matches, onlyCookable, query, section])
  const shoppingCount = data.shopping.filter((item) => !item.checked).length
  const cookableCount = matches.filter((item) => item.missing.length === 0).length
  const bestMatches = matches.slice(0, 3)
  const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toLocaleUpperCase()

  function updateData(update: (current: AppData) => AppData) {
    onDataChange(update)
  }

  function addPantryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = pantryEntry.trim()
    if (!value) return
    if (data.pantry.some((item) => normalizeName(item) === normalizeName(value))) {
      setToast(`${value} is already in your pantry`)
    } else {
      updateData((current) => ({ ...current, pantry: [...current.pantry, value].sort((a, b) => a.localeCompare(b)) }))
      setToast(`${value} added to your pantry`)
    }
    setPantryEntry('')
  }

  function removePantryItem(value: string) {
    updateData((current) => ({ ...current, pantry: current.pantry.filter((item) => item !== value) }))
  }

  function addShoppingItems(values: string[]) {
    const known = new Set(data.shopping.map((item) => normalizeName(item.name)))
    const unique: string[] = []
    values.forEach((value) => {
      const clean = value.trim()
      const normalized = normalizeName(clean)
      if (clean && !known.has(normalized)) {
        known.add(normalized)
        unique.push(clean)
      }
    })
    if (unique.length) {
      updateData((current) => {
        const currentNames = new Set(current.shopping.map((item) => normalizeName(item.name)))
        const additions = unique.filter((name) => {
          const normalized = normalizeName(name)
          if (currentNames.has(normalized)) return false
          currentNames.add(normalized)
          return true
        }).map((name) => ({ id: createId('shop'), name, checked: false }))
        return additions.length ? { ...current, shopping: [...current.shopping, ...additions] } : current
      })
    }
    return unique.length
  }

  function addShoppingEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!shoppingEntry.trim()) return
    setToast(addShoppingItems([shoppingEntry]) ? 'Added to your shopping list' : 'That item is already on your list')
    setShoppingEntry('')
  }

  function addMissing(match: RecipeMatch) {
    if (match.missing.length === 0) {
      setToast('Everything for this recipe is in your pantry')
      return
    }
    const added = addShoppingItems(match.missing.map(({ name }) => name))
    setToast(added ? `${added} ${added === 1 ? 'item' : 'items'} added to your shopping list` : 'Those ingredients are already on your list')
  }

  function toggleShoppingItem(id: string) {
    updateData((current) => ({ ...current, shopping: current.shopping.map((item) => item.id === id ? { ...item, checked: !item.checked } : item) }))
  }

  function clearChecked() {
    updateData((current) => ({ ...current, shopping: current.shopping.filter((item) => !item.checked) }))
  }

  function saveRecipe(recipe: Recipe) {
    updateData((current) => ({ ...current, recipes: [recipe, ...current.recipes] }))
    setShowRecipeForm(false)
    setToast('Recipe added to your library')
  }

  async function saveSharedRecipe(recipe: Recipe) {
    if (role !== 'admin' || roleUserId !== user.id || roleError || catalogSaving) throw new Error('Admin access could not be verified.')
    setCatalogSaving(true)
    try {
      await insertSharedRecipe(recipe)
      setSharedRecipes((current) => current.some((item) => item.id === recipe.id) ? current : [recipe, ...current])
      setShowRecipeForm(false)
      setToast('Recipe added to the shared catalog')
      setCatalogError('')
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Could not add the shared recipe. Please try again.')
      throw error
    } finally {
      setCatalogSaving(false)
    }
  }

  function addRecipeIngredientsToPantry(recipe: Recipe) {
    const known = new Set(data.pantry.map(normalizeName))
    const newItems = recipe.ingredients.map((ingredient) => ingredient.name.trim()).filter((name) => {
      const normalized = normalizeName(name)
      if (!name || known.has(normalized)) return false
      known.add(normalized)
      return true
    })
    if (!newItems.length) {
      setToast('You already have all these ingredients')
      return
    }
    updateData((current) => ({ ...current, pantry: [...current.pantry, ...newItems].sort((a, b) => a.localeCompare(b)) }))
    setToast(`${newItems.length} ${newItems.length === 1 ? 'ingredient' : 'ingredients'} added to your pantry`)
  }

  const heading = section === 'discover' ? 'Your kitchen, sorted.' : sectionLabels[section]

  return (
    <>
    <div className="app-shell" inert={signingOut} aria-busy={signingOut}>
      <aside className="sidebar">
        <a className="brand" href="#discover" onClick={(event) => { event.preventDefault(); setSection('discover') }} aria-label="RecipeList home">
          <span className="brand-mark"><Icon name="leaf" size={22} /></span>
          <span>recipe<span className="brand-light">list</span><small>YOUR KITCHEN COMPANION</small></span>
        </a>

        <div className="side-caption">YOUR SPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {(Object.keys(sectionLabels) as Section[]).map((item) => {
            const iconName = { discover: 'sparkle', recipes: 'book', pantry: 'basket', shopping: 'bag' }[item] as 'sparkle' | 'book' | 'basket' | 'bag'
            return <button key={item} className={`nav-item ${section === item ? 'active' : ''}`} onClick={() => { setSection(item); setQuery('') }} aria-label={sectionLabels[item]} aria-current={section === item ? 'page' : undefined}>
              <Icon name={iconName} size={19} /><span>{sectionLabels[item]}</span>{item === 'shopping' && shoppingCount > 0 && <span className="nav-count">{shoppingCount}</span>}
            </button>
          })}
        </nav>

        <div className="sidebar-spacer" />
        <div className="pantry-status">
          <div className="status-icon"><Icon name="basket" size={18} /></div>
          <div><strong>Your pantry</strong><span>{data.pantry.length} ingredients tracked</span></div>
          <span className={`status-dot ${saveStatus === 'error' ? 'status-error' : ''}`} aria-label={saveStatus === 'saved' ? 'Saved to your profile' : saveStatus === 'saving' ? 'Saving to your profile' : 'Save failed'} title={saveStatus === 'saved' ? 'Saved to your profile' : saveStatus === 'saving' ? 'Saving to your profile' : 'Save failed'} />
        </div>
        <div className="profile-card">
          <div className="profile-avatar">{initials}</div>
          <div><strong>{user.email || 'My kitchen'}</strong><span>{saveStatus === 'saved' ? 'Saved to your profile' : saveStatus === 'saving' ? 'Saving changes…' : 'Save failed'}</span></div>
          <button className="icon-button mini sign-out" aria-label="Sign out" disabled={signingOut} onClick={onSignOut}>{signingOut ? '…' : '↗'}</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><Icon name="leaf" size={20} /></span><strong>recipelist</strong></div>
          <label className="search-box">
            <Icon name="search" size={18} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search recipes or ingredients..." aria-label="Search recipes or ingredients" />
            {query && <button className="clear-search" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={15} /></button>}
            {!query && <kbd>⌘ K</kbd>}
          </label>
          <div className="topbar-actions">
            <button className="button button-primary top-add" onClick={() => setShowRecipeForm(true)}><Icon name="plus" size={17} /><span>Add recipe</span></button>
            <button className="user-avatar account-button" aria-label={`Sign out ${user.email ?? 'of RecipeList'}`} disabled={signingOut} onClick={onSignOut}>{signingOut ? '…' : initials}</button>
          </div>
        </header>

        <nav className="mobile-nav" aria-label="Main navigation">
          {(Object.keys(sectionLabels) as Section[]).map((item) => <button key={item} className={section === item ? 'active' : ''} onClick={() => { setSection(item); setQuery('') }} aria-current={section === item ? 'page' : undefined}>
            <Icon name={{ discover: 'sparkle', recipes: 'book', pantry: 'basket', shopping: 'bag' }[item] as 'sparkle' | 'book' | 'basket' | 'bag'} size={18} /><span>{sectionLabels[item]}</span>
          </button>)}
        </nav>

        <div className="content-wrap">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> {dateLabel} <span className="eyebrow-separator">/</span> GOOD FOOD STARTS HERE</div>
              <h1>{heading}</h1>
              <p>{section === 'discover' ? 'Make something lovely with what you already have.' : pageDescription(section, recipes.length)}</p>
            </div>
            <div className="heading-note"><span className="note-icon"><Icon name="chef" size={18} /></span><span><strong>A good evening to cook</strong><small>What sounds good tonight?</small></span></div>
          </div>

          {section === 'discover' && <DiscoverView
            matches={matches}
            pantryCount={data.pantry.length}
            recipeCount={recipes.length}
            cookableCount={cookableCount}
            query={query}
            filteredMatches={filteredMatches}
            bestMatches={bestMatches}
            onOpen={setSelectedRecipe}
            onAddMissing={addMissing}
            onShowRecipes={() => setSection('recipes')}
            onShowPantry={() => setSection('pantry')}
          />}
          {section === 'recipes' && <RecipesView matches={filteredMatches} total={recipes.length} query={query} onlyCookable={onlyCookable} onToggleCookable={() => setOnlyCookable((value) => !value)} onOpen={setSelectedRecipe} onAddMissing={addMissing} onAddRecipe={() => setShowRecipeForm(true)} />}
          {section === 'pantry' && <PantryView pantry={data.pantry} entry={pantryEntry} onEntryChange={setPantryEntry} onSubmit={addPantryItem} onRemove={removePantryItem} matches={matches} onOpen={setSelectedRecipe} onAddMissing={addMissing} />}
          {section === 'shopping' && <ShoppingView items={data.shopping} entry={shoppingEntry} onEntryChange={setShoppingEntry} onSubmit={addShoppingEntry} onToggle={toggleShoppingItem} onRemove={(id) => updateData((current) => ({ ...current, shopping: current.shopping.filter((item) => item.id !== id) }))} onClearChecked={clearChecked} />}

          <footer className="app-footer"><span>Made for slower evenings & better dinners.</span><span><span className="footer-heart">♥</span> {saveStatus === 'saved' ? `Saved to ${user.email ?? 'your profile'}` : saveStatus === 'saving' ? 'Saving to your profile…' : 'Could not save to your profile'}</span></footer>
          {saveStatus === 'error' && <div className="save-error" role="alert">{saveError || 'Your changes could not be saved.'} <button onClick={onRetrySave}>Try saving again</button></div>}
          {accountError && <div className="save-error" role="alert">{accountError}</div>}
          {catalogError && <div className="save-error catalog-error" role="alert">Shared catalog unavailable: {catalogError} <button onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>Retry catalog</button></div>}
          {roleError && <div className="save-error catalog-error" role="status">Account role could not be verified. Shared recipe publishing is disabled.</div>}
        </div>
      </main>

      {showRecipeForm && <RecipeForm onClose={closeRecipeForm} onSave={saveRecipe} onSaveShared={saveSharedRecipe} isAdmin={role === 'admin' && roleUserId === user.id && !roleError} savingShared={catalogSaving} />}
      {selectedRecipe && <RecipeDetails recipe={selectedRecipe} match={matches.find((item) => item.recipe.id === selectedRecipe.id)} onClose={closeSelectedRecipe} onAddMissing={addMissing} onAddIngredients={addRecipeIngredientsToPantry} />}
      {toast && <div className="toast" role="status"><span className="toast-check"><Icon name="check" size={16} /></span>{toast}</div>}
      <span className="sr-only" aria-live="polite">{`${shoppingCount} items on shopping list`}</span>
    </div>
    {signingOut && <div className="signout-overlay" role="status"><span>Saving your kitchen and signing out…</span></div>}
    </>
  )
}

function pageDescription(section: Section, recipeCount: number) {
  if (section === 'recipes') return `${recipeCount} recipes from your favorite meal kits and your own kitchen.`
  if (section === 'pantry') return 'Keep track of what’s on hand and find recipes that fit.'
  if (section === 'shopping') return 'Everything you need to bring your next meal together.'
  return ''
}

function DiscoverView({ matches, pantryCount, recipeCount, cookableCount, query, filteredMatches, bestMatches, onOpen, onAddMissing, onShowRecipes, onShowPantry }: {
  matches: RecipeMatch[]; pantryCount: number; recipeCount: number; cookableCount: number; query: string; filteredMatches: RecipeMatch[]; bestMatches: RecipeMatch[];
  onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void; onShowRecipes: () => void; onShowPantry: () => void;
}) {
  const heroMatch = matches[0]
  return <>
    {!query && <>
      <section className="welcome-panel">
        <div className="welcome-copy">
          <div className="tiny-label"><Icon name="sparkle" size={14} /> A LITTLE INSPIRATION</div>
          <h2>Tonight’s dinner<br />is <em>closer than you think.</em></h2>
          <p>{heroMatch ? `You’ve already got ${heroMatch.percent}% of the ingredients for ${heroMatch.recipe.title}.` : 'Add a few pantry ingredients and we’ll find something delicious.'}</p>
          {heroMatch && <button className="button button-dark" onClick={() => onOpen(heroMatch.recipe)}>See what you can make <Icon name="arrow" size={17} /></button>}
          {!heroMatch && <button className="button button-dark" onClick={onShowPantry}>Stock your pantry <Icon name="arrow" size={17} /></button>}
          <div className="welcome-dots"><span className="selected" /><span /><span /></div>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <div className="art-leaf leaf-one"><Icon name="leaf" size={52} /></div><div className="art-leaf leaf-two"><Icon name="leaf" size={35} /></div>
          <div className="art-circle"><span>✦</span><strong>eat<br />well</strong><small>every day</small></div>
          <div className="art-pepper">〰</div><div className="art-sun" />
        </div>
        <div className="panel-counter"><strong>01</strong><span>/ 03</span></div>
      </section>

      <section className="stats-grid" aria-label="Your kitchen at a glance">
        <StatCard icon="book" label="In your collection" value={recipeCount.toString().padStart(2, '0')} suffix="recipes" tone="green" />
        <StatCard icon="basket" label="In your pantry" value={pantryCount.toString().padStart(2, '0')} suffix="ingredients" tone="yellow" />
        <StatCard icon="chef" label="Ready to cook" value={cookableCount.toString().padStart(2, '0')} suffix="meals" tone="coral" />
      </section>
    </>}

    <section className="section-block">
      <div className="section-title-row">
        <div><div className="section-kicker">{query ? 'SEARCH RESULTS' : 'BASED ON YOUR PANTRY'}</div><h2>{query ? `Results for “${query}”` : 'A few good ideas'}</h2></div>
        <button className="text-button" onClick={onShowRecipes}>Browse all recipes <Icon name="arrow" size={16} /></button>
      </div>
      {query
        ? filteredMatches.length
          ? <RecipeGrid matches={filteredMatches} onOpen={onOpen} onAddMissing={onAddMissing} />
          : <div className="empty-state"><div className="empty-illustration"><Icon name="search" size={26} /></div><strong>No recipes found</strong><span>Try a different search or turn off the “Ready to cook” filter.</span></div>
        : recipeCount === 0
          ? <div className="empty-state"><div className="empty-illustration"><Icon name="chef" size={28} /></div><strong>Your recipe shelf is waiting</strong><span>Add a recipe to start getting personalized dinner ideas.</span></div>
        : pantryCount === 0
          ? <div className="empty-state"><div className="empty-illustration"><Icon name="basket" size={27} /></div><strong>Your pantry is ready for a fresh start</strong><span>Add a few ingredients you already have to find your closest dinner matches.</span><button className="text-button" onClick={onShowPantry}>Add pantry ingredients <Icon name="arrow" size={15} /></button></div>
        : bestMatches.length
          ? <RecipeGrid matches={bestMatches} onOpen={onOpen} onAddMissing={onAddMissing} />
          : <div className="empty-state"><div className="empty-illustration"><Icon name="chef" size={28} /></div><strong>Your recipe shelf is waiting</strong><span>Add a recipe to start getting personalized dinner ideas.</span></div>}
    </section>

    {!query && <section className="bottom-callout">
      <div className="callout-icon"><Icon name="basket" size={22} /></div><div><strong>A little pantry goes a long way.</strong><span>Update what you have, and we’ll do the meal planning.</span></div><button className="text-button" onClick={onShowPantry}>Update pantry <Icon name="arrow" size={16} /></button>
    </section>}
  </>
}

function StatCard({ icon, label, value, suffix, tone }: { icon: 'book' | 'basket' | 'chef'; label: string; value: string; suffix: string; tone: string }) {
  return <div className="stat-card"><span className={`stat-icon ${tone}`}><Icon name={icon} size={19} /></span><div className="stat-main"><span>{label}</span><div><strong>{value}</strong><small>{suffix}</small></div></div><span className="stat-spark">↗</span></div>
}

function RecipesView({ matches, total, query, onlyCookable, onToggleCookable, onOpen, onAddMissing, onAddRecipe }: {
  matches: RecipeMatch[]; total: number; query: string; onlyCookable: boolean; onToggleCookable: () => void; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void; onAddRecipe: () => void;
}) {
  return <section className="section-block standalone-section">
    <div className="list-toolbar"><div><span className="result-count">{query || onlyCookable ? matches.length : total} {query ? 'matches' : 'recipes'}</span><span className="toolbar-separator">·</span><span className="muted">Sorted by pantry match</span></div><button className={`filter-chip ${onlyCookable ? 'selected' : ''}`} aria-pressed={onlyCookable} onClick={onToggleCookable}><Icon name="check" size={15} />Ready to cook</button></div>
    <RecipeGrid matches={matches} onOpen={onOpen} onAddMissing={onAddMissing} />
    {!matches.length && <div className="empty-state"><div className="empty-illustration"><Icon name="search" size={26} /></div><strong>No recipes found</strong><span>Try a different search or turn off the “Ready to cook” filter.</span></div>}
    <div className="add-recipe-banner"><div className="banner-icon"><Icon name="plus" size={21} /></div><div><strong>Have a recipe you love?</strong><span>Keep everything you cook in one place.</span></div><button className="button button-outline" onClick={onAddRecipe}>Add a recipe <Icon name="arrow" size={15} /></button></div>
  </section>
}

function RecipeGrid({ matches, onOpen, onAddMissing }: { matches: RecipeMatch[]; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void }) {
  return <div className="recipe-grid">{matches.map((match) => <RecipeCard key={match.recipe.id} match={match} onOpen={onOpen} onAddMissing={onAddMissing} />)}</div>
}

function RecipeCard({ match, onOpen, onAddMissing }: { match: RecipeMatch; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void }) {
  const { recipe, percent, missing } = match
  return <article className="recipe-card">
    <button className="card-image" onClick={() => onOpen(recipe)} aria-label={`View ${recipe.title}`} style={{ backgroundImage: `linear-gradient(180deg, transparent 48%, rgba(22, 33, 25, .34)), url("${recipe.image}")` }}>
      <span className="source-pill">{recipe.source}</span><span className="image-time"><Icon name="clock" size={14} />{recipe.time} min</span>
    </button>
    <div className="card-content">
      <div className="card-meta"><span>{recipe.category}</span><span className="meta-dot" />{recipe.servings} servings</div>
      <button className="recipe-title" onClick={() => onOpen(recipe)}>{recipe.title}</button>
      <p className="recipe-description">{recipe.description}</p>
      <div className="match-row"><div className="match-label"><span className="match-icon"><Icon name={percent === 100 ? 'check' : 'leaf'} size={13} /></span><strong>{percent}%</strong> in your pantry</div><span className="match-count">{missing.length === 0 ? 'Ready now' : `${missing.length} to get`}</span></div>
      <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
      <div className="card-footer"><span className="missing-preview">{missing.length ? `Missing: ${missing.slice(0, 2).map((item) => item.name).join(', ')}${missing.length > 2 ? ` +${missing.length - 2}` : ''}` : 'Everything’s in your pantry'}</span><button className="round-arrow" onClick={() => missing.length ? onAddMissing(match) : onOpen(recipe)} aria-label={missing.length ? `Add missing ingredients for ${recipe.title}` : `Open ${recipe.title}`}><Icon name={missing.length ? 'plus' : 'arrow'} size={16} /></button></div>
    </div>
  </article>
}

function PantryView({ pantry, entry, onEntryChange, onSubmit, onRemove, matches, onOpen, onAddMissing }: {
  pantry: string[]; entry: string; onEntryChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onRemove: (value: string) => void; matches: RecipeMatch[]; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void;
}) {
  const cookable = matches.filter((match) => match.missing.length === 0)
  return <div className="pantry-layout">
    <section className="surface-card pantry-card">
      <div className="surface-heading"><div><div className="section-kicker">WHAT’S ON HAND</div><h2>Your ingredients <span className="pill-count">{pantry.length}</span></h2><p>Add the ingredients you have. We’ll match them to your recipes.</p></div><span className="surface-illustration"><Icon name="basket" size={23} /></span></div>
      <form className="inline-add" onSubmit={onSubmit}><label className="sr-only" htmlFor="pantry-item">Add pantry ingredient</label><input id="pantry-item" value={entry} onChange={(event) => onEntryChange(event.target.value)} placeholder="e.g. cherry tomatoes, brown rice..." /><button className="button button-dark" type="submit"><Icon name="plus" size={16} />Add item</button></form>
      {pantry.length ? <div className="ingredient-cloud">{pantry.map((item) => <span className="ingredient-chip" key={item}><span className="ingredient-bullet" />{item}<button onClick={() => onRemove(item)} aria-label={`Remove ${item} from pantry`}><Icon name="close" size={13} /></button></span>)}</div> : <div className="empty-inline"><Icon name="basket" size={20} /><span>Your pantry is empty. Add a few things you already have.</span></div>}
      <div className="pantry-footnote"><Icon name="leaf" size={15} /> Ingredient names are matched flexibly, regardless of capitalization.</div>
    </section>
    <section className="surface-card pantry-suggestions">
      <div className="section-kicker">YOUR NEXT MEAL</div><h2>{cookable.length ? 'You can make these now' : 'Get close to dinner'}</h2><p>{cookable.length ? 'Every ingredient is already in your pantry.' : 'These recipes are your closest pantry matches.'}</p>
      <div className="mini-match-list">{(cookable.length ? cookable.slice(0, 3) : matches.slice(0, 3)).map((match) => <div className="mini-match" key={match.recipe.id}>
        <div className="mini-match-image" style={{ backgroundImage: `url("${match.recipe.image}")` }} />
        <div className="mini-match-copy"><strong>{match.recipe.title}</strong><span>{match.missing.length ? `${match.percent}% ready · ${match.missing.length} missing` : `${match.recipe.time} min · all ingredients ready`}</span></div>
        <button className="round-arrow small" onClick={() => match.missing.length ? onAddMissing(match) : onOpen(match.recipe)} aria-label={match.missing.length ? `Add ingredients for ${match.recipe.title}` : `View ${match.recipe.title}`}><Icon name={match.missing.length ? 'plus' : 'arrow'} size={15} /></button>
      </div>)}</div>
    </section>
  </div>
}

function ShoppingView({ items, entry, onEntryChange, onSubmit, onToggle, onRemove, onClearChecked }: {
  items: AppData['shopping']; entry: string; onEntryChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onToggle: (id: string) => void; onRemove: (id: string) => void; onClearChecked: () => void;
}) {
  const remaining = items.filter((item) => !item.checked)
  const checked = items.filter((item) => item.checked)
  const shoppingDay = new Intl.DateTimeFormat('en-US', { day: '2-digit' }).format(new Date())
  return <section className="shopping-layout">
    <div className="shopping-main surface-card">
      <div className="shopping-topline"><span className="list-date"><span className="date-square">{shoppingDay}</span><span><strong>My shopping list</strong><small>For the week ahead</small></span></span><span className="shopping-total">{remaining.length} {remaining.length === 1 ? 'item' : 'items'} left</span></div>
      <form className="inline-add shopping-add" onSubmit={onSubmit}><label className="sr-only" htmlFor="shopping-item">Add shopping list item</label><input id="shopping-item" value={entry} onChange={(event) => onEntryChange(event.target.value)} placeholder="Add an item to your list..." /><button className="button button-dark" type="submit"><Icon name="plus" size={16} />Add item</button></form>
      {items.length === 0 ? <div className="empty-state shopping-empty"><div className="empty-illustration"><Icon name="bag" size={26} /></div><strong>Your list is all clear</strong><span>Add an item or add missing ingredients from a recipe.</span></div> : <>
        <div className="list-section-label">TO PICK UP <span>{remaining.length}</span></div>
        {remaining.length ? <ul className="shopping-items">{remaining.map((item) => <ShoppingRow key={item.id} item={item} onToggle={onToggle} onRemove={onRemove} />)}</ul> : <div className="list-done"><span className="done-check"><Icon name="check" size={15} /></span>Everything’s checked off. Nice work!</div>}
        {checked.length > 0 && <><div className="checked-heading"><span className="list-section-label">IN YOUR BASKET <span>{checked.length}</span></span><button onClick={onClearChecked}>Clear checked</button></div><ul className="shopping-items checked-items">{checked.map((item) => <ShoppingRow key={item.id} item={item} onToggle={onToggle} onRemove={onRemove} />)}</ul></>}
      </>}
      <div className="shopping-bottom"><Icon name="sparkle" size={15} />Tip: add ingredients from any recipe card in your library.</div>
    </div>
    <aside className="shopping-aside">
      <div className="market-card"><div className="market-shape shape-one" /><div className="market-shape shape-two" /><span className="market-label">A SMALL REMINDER</span><h2>Good meals<br />start with a<br /><em>little planning.</em></h2><span className="market-doodle">✳</span></div>
      <div className="list-summary surface-card"><span className="section-kicker">YOUR LIST</span><div className="summary-numbers"><span><strong>{remaining.length.toString().padStart(2, '0')}</strong><small>to get</small></span><i /><span><strong>{checked.length.toString().padStart(2, '0')}</strong><small>picked up</small></span></div><div className="summary-track"><span style={{ width: `${items.length ? checked.length / items.length * 100 : 0}%` }} /></div><small className="summary-note">{items.length ? `${Math.round(checked.length / items.length * 100)}% of your list is done` : 'Your next shop starts here'}</small></div>
    </aside>
  </section>
}

function ShoppingRow({ item, onToggle, onRemove }: { item: AppData['shopping'][number]; onToggle: (id: string) => void; onRemove: (id: string) => void }) {
  return <li className={`shopping-row ${item.checked ? 'checked' : ''}`}><button className="check-button" onClick={() => onToggle(item.id)} aria-label={item.checked ? `Mark ${item.name} as not picked up` : `Mark ${item.name} as picked up`}><Icon name="check" size={14} /></button><span className="shopping-name">{item.name}</span><button className="remove-shopping" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name} from list`}><Icon name="trash" size={16} /></button></li>
}

function RecipeForm({ onClose, onSave, onSaveShared, isAdmin, savingShared }: { onClose: () => void; onSave: (recipe: Recipe) => void; onSaveShared: (recipe: Recipe) => Promise<void>; isAdmin: boolean; savingShared: boolean }) {
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [category, setCategory] = useState('Dinner')
  const [time, setTime] = useState('30')
  const [servings, setServings] = useState('2')
  const [ingredientsText, setIngredientsText] = useState('')
  const [destination, setDestination] = useState<'personal' | 'shared'>('personal')
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const ingredients: Ingredient[] = ingredientsText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, ...amountParts] = line.split('|')
      return { name: name.trim(), amount: amountParts.join('|').trim() || 'as needed' }
    }).filter((item) => item.name)
    if (!title.trim()) { setError('Give your recipe a name to continue.'); return }
    if (!ingredients.length) { setError('Add at least one ingredient, one per line.'); return }
    const recipe = makeRecipe(title, source, category, Math.max(1, Number(time) || 30), Math.max(1, Number(servings) || 2), ingredients)
    if (destination === 'shared') {
      try { await onSaveShared(recipe) }
      catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Could not save to the shared catalog.') }
    } else onSave(recipe)
  }

  return <Modal onClose={onClose} title="Add a recipe" description="Save a favorite from a meal kit or your own kitchen.">
    <form className="recipe-form" onSubmit={submit}>
      <label className="form-field wide"><span>Recipe name</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Cozy tomato soup" required /></label>
      <label className="form-field"><span>Source <small>Optional</small></span><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="HelloFresh, my own..." /></label>
      <label className="form-field"><span>Category</span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Dinner" /></label>
      <label className="form-field"><span>Time <small>minutes</small></span><input type="number" min="1" value={time} onChange={(event) => setTime(event.target.value)} /></label>
      <label className="form-field"><span>Servings</span><input type="number" min="1" value={servings} onChange={(event) => setServings(event.target.value)} /></label>
      {isAdmin && <label className="form-field wide"><span>Save to</span><select value={destination} onChange={(event) => setDestination(event.target.value as 'personal' | 'shared')}><option value="personal">My private recipes</option><option value="shared">Shared RecipeList catalog</option></select><small className="field-hint">Shared recipes are available to every RecipeList user.</small></label>}
      <label className="form-field wide"><span>Ingredients <small>One per line · ingredient | amount</small></span><textarea value={ingredientsText} onChange={(event) => setIngredientsText(event.target.value)} placeholder={'chickpeas | 1 can\nlemon | 1\nplain yogurt | ½ cup'} rows={5} required /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-dark" type="submit" disabled={savingShared}>{savingShared ? 'Saving…' : 'Save recipe'} {!savingShared && <Icon name="arrow" size={16} />}</button></div>
    </form>
  </Modal>
}

function RecipeDetails({ recipe, match, onClose, onAddMissing, onAddIngredients }: { recipe: Recipe; match?: RecipeMatch; onClose: () => void; onAddMissing: (match: RecipeMatch) => void; onAddIngredients: (recipe: Recipe) => void }) {
  return <Modal onClose={onClose} title={recipe.title} description={`${recipe.source} · ${recipe.time} minutes · ${recipe.servings} servings`} wide>
    <div className="detail-image" style={{ backgroundImage: `linear-gradient(180deg, transparent, rgba(24, 37, 29, .28)), url("${recipe.image}")` }}><span className="source-pill">{recipe.source}</span><span className="detail-category">{recipe.category}</span></div>
    <p className="detail-description">{recipe.description}</p>
    {match && <div className="detail-match"><span className="match-icon"><Icon name={match.missing.length ? 'leaf' : 'check'} size={14} /></span><strong>{match.percent}% of ingredients in your pantry</strong><span>{match.missing.length ? `${match.missing.length} missing` : 'Ready to cook'}</span></div>}
    <div className="detail-ingredients-heading"><div><span className="section-kicker">THE SHOPPING LIST</span><h3>Ingredients <small>{recipe.ingredients.length}</small></h3></div><button className="text-button" onClick={() => onAddIngredients(recipe)}>Add all to pantry <Icon name="plus" size={15} /></button></div>
    <ul className="detail-ingredients">{recipe.ingredients.map((ingredient) => {
      const isAvailable = Boolean(match?.available.some((item) => normalizeName(item.name) === normalizeName(ingredient.name)))
      return <li key={ingredient.name} className={isAvailable ? 'available' : ''}><span className="detail-ingredient-check">{isAvailable && <Icon name="check" size={13} />}</span><span>{ingredient.name}</span><span className="detail-amount">{ingredient.amount}</span></li>
    })}</ul>
    {match && <div className="modal-actions detail-actions"><span className="detail-hint">{match.missing.length ? `${match.missing.length} ingredients still to get` : 'You have everything you need'}</span><button className="button button-dark" onClick={() => onAddMissing(match)}>{match.missing.length ? 'Add missing to list' : 'Ready to cook'} <Icon name={match.missing.length ? 'plus' : 'check'} size={16} /></button></div>}
  </Modal>
}

function Modal({ onClose, title, description, children, wide = false }: { onClose: () => void; title: string; description: string; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const getFocusable = () => dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []
    const focusables = getFocusable()
    ;(dialog?.querySelector<HTMLElement>('[autofocus]') ?? focusables[0] ?? dialog)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const current = getFocusable()
      if (!current.length) {
        event.preventDefault()
      } else if (event.shiftKey && document.activeElement === current[0]) {
        event.preventDefault()
        current[current.length - 1].focus()
      } else if (!event.shiftKey && document.activeElement === current[current.length - 1]) {
        event.preventDefault()
        current[0].focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previouslyFocused?.focus()
    }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} className={`modal-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description">
      <div className="modal-header"><div><h2 id="modal-title">{title}</h2><p id="modal-description">{description}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={19} /></button></div>
      {children}
    </section>
  </div>
}

export default App
