import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import AuthGate from './AuthGate'
import { apiRequest, errorMessage } from './api'
import { authClient, type AuthUser } from './authClient'
import { createId, makeRecipe, matchRecipes, normalizeName } from './lib'
import MfaGate from './MfaGate'
import { loadProfile, saveProfile } from './profileStorage'
import { insertSharedRecipe, loadCurrentUserRole, loadSharedRecipes, updateSharedRecipeInstructions } from './recipeStorage'
import type { AppData, Ingredient, PantryItem, Recipe, RecipeMatch, UserRole } from './types'

type Section = 'discover' | 'recipes' | 'pantry' | 'shopping'
type RecipeSource = 'shared' | 'private'

/** Count instruction characters in code points so the limit matches PostgreSQL text length. */
function instructionCharacterCount(value: string): number {
  return Array.from(value).length
}

/** Return sorted ingredient names, deduplicated by normalized name using the first spelling encountered. */
function getRecipeIngredientCatalog(recipes: Recipe[]): string[] {
  const catalog = new Map<string, string>()
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const normalized = normalizeName(ingredient.name)
      if (!catalog.has(normalized)) catalog.set(normalized, ingredient.name)
    }
  }
  return Array.from(catalog.values()).sort((a, b) => a.localeCompare(b))
}

const sectionLabels: Record<Section, string> = {
  discover: 'Discover',
  recipes: 'Recipes',
  pantry: 'Pantry',
  shopping: 'Shopping list',
}

/** Render one of the application’s small inline SVG navigation and action icons. */
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
type SecurityStatus = 'checking' | 'setup' | 'verified' | 'error'
type CurrentUser = { user: AuthUser & { twoFactorEnabled: boolean }; role: UserRole; needsMfaReauthentication: boolean }

/** Load account security and kitchen data, coordinate saves, and render the active application view. */
function App() {
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const user = session?.user ? session.user as AuthUser : null
  const [me, setMe] = useState<CurrentUser | null>(null)
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus>('checking')
  const [securityError, setSecurityError] = useState('')
  const [securityAttempt, setSecurityAttempt] = useState(0)
  const [reauthMessage, setReauthMessage] = useState('')
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
  const securityRequest = useRef(0)
  const editRevision = useRef(0)
  const savedRevision = useRef(0)
  const activeUserId = useRef<string | null>(null)
  const saveTimer = useRef<number | null>(null)
  const activeFlush = useRef<Promise<boolean> | null>(null)
  const signingOutRef = useRef(false)
  const handledReauthUser = useRef<string | null>(null)
  const profileSnapshot = useRef<{ userId: string | null; data: AppData | null; loadedUserId: string | null; status: ProfileStatus; securityStatus: SecurityStatus; generation: number }>({ userId: null, data: null, loadedUserId: null, status: 'loading', securityStatus: 'checking', generation: 0 })
  profileSnapshot.current = { userId: user?.id ?? null, data, loadedUserId, status: profileStatus, securityStatus, generation: generation.current }

  useEffect(() => {
    const nextUserId = user?.id ?? null
    if (activeUserId.current === nextUserId) return
    activeUserId.current = nextUserId
    handledReauthUser.current = null
    generation.current += 1
    securityRequest.current += 1
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    activeFlush.current = null
    savedRevision.current = editRevision.current
    setMe(null)
    setData(null)
    setLoadedUserId(null)
    setProfileStatus('loading')
    setProfileError('')
    setSaveStatus('saved')
    setAccountError('')
    setSecurityError('')
    setSecurityStatus(nextUserId ? 'checking' : 'setup')
    profileSnapshot.current = { userId: nextUserId, data: null, loadedUserId: null, status: 'loading', securityStatus: nextUserId ? 'checking' : 'setup', generation: generation.current }
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    let active = true
    const request = ++securityRequest.current
    setSecurityStatus('checking')
    void apiRequest<CurrentUser>('/api/me').then(async (current) => {
      if (!active || request !== securityRequest.current || activeUserId.current !== user.id) return
      if (!current || current.user?.id !== user.id || (current.role !== 'member' && current.role !== 'admin')) {
        throw new Error('Your account or role could not be verified.')
      }
      setMe(current)
      if (current.needsMfaReauthentication) {
        setReauthMessage('Authenticator setup is complete. Sign in again and verify your authenticator before opening your kitchen.')
        if (handledReauthUser.current !== user.id) {
          handledReauthUser.current = user.id
          const result = await authClient.signOut()
          if (result.error) throw result.error
        }
        return
      }
      setReauthMessage('')
      setSecurityStatus(current.user.twoFactorEnabled ? 'verified' : 'setup')
      setSecurityError('')
    }).catch((error: unknown) => {
      if (!active || request !== securityRequest.current) return
      setSecurityError(errorMessage(error, 'Could not verify your account and security setup.'))
      setSecurityStatus('error')
    })
    return () => { active = false }
  }, [user?.id, securityAttempt])

  useEffect(() => {
    if (!user || securityStatus !== 'verified') return
    if (profileSnapshot.current.userId === user.id && profileSnapshot.current.loadedUserId === user.id && profileSnapshot.current.status === 'ready' && profileSnapshot.current.data) return
    const requestGeneration = ++generation.current
    savedRevision.current = editRevision.current
    setData(null)
    setLoadedUserId(null)
    setProfileStatus('loading')
    setProfileError('')
    void loadProfile().then((profile) => {
      if (generation.current !== requestGeneration || activeUserId.current !== user.id) return
      savedRevision.current = editRevision.current
      setData(profile)
      setLoadedUserId(user.id)
      setProfileStatus('ready')
      setSaveStatus('saved')
    }).catch((error: unknown) => {
      if (generation.current !== requestGeneration) return
      setProfileError(errorMessage(error, 'Could not load your kitchen profile.'))
      setProfileStatus('error')
    })
    return () => { generation.current += 1 }
  }, [securityStatus, user?.id, profileAttempt])

  useEffect(() => {
    if (securityStatus !== 'verified' || !user || !data || loadedUserId !== user.id || profileStatus !== 'ready' || savedRevision.current === editRevision.current) return
    const timeout = window.setTimeout(() => {
      saveTimer.current = null
      void flushSaveRef.current()
    }, 500)
    saveTimer.current = timeout
    return () => {
      window.clearTimeout(timeout)
      if (saveTimer.current === timeout) saveTimer.current = null
    }
  }, [securityStatus, data, loadedUserId, profileStatus, saveAttempt, user?.id])

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
        if (snapshot.securityStatus !== 'verified' || !snapshot.userId || snapshot.loadedUserId !== snapshot.userId || snapshot.status !== 'ready' || !snapshot.data) return false
        const revision = editRevision.current
        try {
          setSaveStatus('saving')
          await saveProfile(snapshot.data)
          const latest = profileSnapshot.current
          if (latest.userId !== snapshot.userId || latest.generation !== snapshot.generation) return false
          savedRevision.current = Math.max(savedRevision.current, revision)
        } catch (error) {
          const latest = profileSnapshot.current
          if (latest.userId === snapshot.userId && latest.generation === snapshot.generation) {
            setSaveStatus('error')
            setProfileError(errorMessage(error, 'Could not save your changes. They are still available here; try again.'))
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

  /** Apply a profile edit and queue a debounced save for the active account. */
  function updateProfileData(update: (current: AppData) => AppData) {
    const current = profileSnapshot.current.data
    if (!current || profileSnapshot.current.securityStatus !== 'verified' || signingOutRef.current) return
    const next = update(current)
    editRevision.current += 1
    profileSnapshot.current = { ...profileSnapshot.current, data: next }
    setData(next)
    setSaveStatus('saving')
    setProfileError('')
  }

  /** Sign out after attempting to preserve verified pending kitchen edits. */
  async function signOut() {
    if (signingOutRef.current) return
    signingOutRef.current = true
    setSigningOut(true)
    setAccountError('')
    try {
      const snapshot = profileSnapshot.current
      const hasPendingData = savedRevision.current < editRevision.current
        && snapshot.userId === activeUserId.current
        && snapshot.loadedUserId === snapshot.userId
        && snapshot.data !== null
      if (hasPendingData && snapshot.securityStatus !== 'verified') {
        setAccountError('Please wait for the session security check to finish, then try signing out again so your pending changes can be saved.')
        return
      }
      const saved = snapshot.securityStatus === 'verified' ? await flushSaveRef.current() : true
      if (!saved) return
      const result = await authClient.signOut()
      if (result.error) throw result.error
    } catch (error) {
      setAccountError(`Could not sign out: ${errorMessage(error, 'Please try again.')}`)
    } finally {
      signingOutRef.current = false
      setSigningOut(false)
    }
  }

  /** Retry loading the current account security state. */
  function retrySecurity() {
    securityRequest.current += 1
    handledReauthUser.current = null
    setSecurityError('')
    setSecurityStatus('checking')
    setSecurityAttempt((attempt) => attempt + 1)
  }

  if (sessionPending) return <StatusScreen title="Checking your account…" />
  if (!user) return <AuthGate notice={reauthMessage} />
  if (!me && securityStatus === 'checking') return <StatusScreen title="Checking your account…" />
  if (securityStatus === 'error') return <StatusScreen title="We couldn’t confirm your account." message={securityError} onRetry={retrySecurity} />
  if (securityStatus === 'setup') return <MfaGate key={user.id} userId={user.id} email={user.email} onSetupComplete={() => window.location.reload()} onSignOut={() => { void signOut() }} signingOut={signingOut} accountError={accountError} />
  if (profileStatus === 'error') return <StatusScreen title="We couldn’t load your kitchen" message={profileError} onRetry={() => { setProfileStatus('loading'); setProfileError(''); setLoadedUserId(null); setProfileAttempt((attempt) => attempt + 1) }} />
  if (profileStatus === 'loading' || loadedUserId !== user.id || !data) return <StatusScreen title="Loading your kitchen…" />
  return <KitchenApp key={user.id} user={user} data={data} onDataChange={updateProfileData} saveStatus={saveStatus} saveError={profileError} accountError={accountError} signingOut={signingOut} onRetrySave={() => setSaveAttempt((attempt) => attempt + 1)} onSignOut={() => { void signOut() }} />
}

/** Render a loading or error state with an optional retry action. */
function StatusScreen({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return <main className="auth-screen"><section className="auth-card status-card"><div className="auth-brand"><span className="brand-mark">✦</span><span>recipe<span className="brand-light">list</span></span></div><h1>{title}</h1>{message && <p className="auth-intro" role={onRetry ? 'alert' : undefined}>{message}</p>}{onRetry && <button className="button button-dark auth-submit" onClick={onRetry}>Try again</button>}</section></main>
}

/** Render the kitchen navigation and active discovery, recipe, pantry, or shopping view. */
function KitchenApp({ user, data, onDataChange, saveStatus, saveError, accountError, signingOut, onRetrySave, onSignOut }: { user: AuthUser; data: AppData; onDataChange: (update: (current: AppData) => AppData) => void; saveStatus: SaveStatus; saveError: string; accountError: string; signingOut: boolean; onRetrySave: () => void; onSignOut: () => void }) {
  const [section, setSection] = useState<Section>('discover')
  const [query, setQuery] = useState('')
  const [pantryEntry, setPantryEntry] = useState('')
  const [pantryAmount, setPantryAmount] = useState('')
  const [shoppingEntry, setShoppingEntry] = useState('')
  const [onlyCookable, setOnlyCookable] = useState(false)
  const [showRecipeForm, setShowRecipeForm] = useState(false)
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null)
  const [selectedRecipeSource, setSelectedRecipeSource] = useState<RecipeSource | null>(null)
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
    void loadCurrentUserRole().then((nextRole) => {
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
  const closeSelectedRecipe = useCallback(() => { setSelectedRecipe(null); setSelectedRecipeSource(null) }, [])
  /** Capture whether a recipe came from the shared catalog or this user's profile. */
  function openRecipe(recipe: Recipe) {
    setSelectedRecipe(recipe)
    setSelectedRecipeSource(sharedRecipes.some((item) => item.id === recipe.id) ? 'shared' : 'private')
  }

  useEffect(() => { closeSelectedRecipe() }, [user.id, closeSelectedRecipe])

  const initials = user.email?.trim().slice(0, 1).toLocaleUpperCase() || 'U'
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timeout)
  }, [toast])
  useEffect(() => {
    /** Focus the search field when the user presses the supported keyboard shortcut. */
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
  const recipeIngredientCatalog = useMemo(() => getRecipeIngredientCatalog(recipes), [recipes])
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

  /** Apply one kitchen-data update through the parent change handler. */
  function updateData(update: (current: AppData) => AppData) {
    onDataChange(update)
  }

  /** Validate and append a new pantry entry unless an equivalent item already exists. */
  function addPantryItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = pantryEntry.trim()
    if (!value) return
    if (data.pantry.some((item) => normalizeName(item.name) === normalizeName(value))) {
      setToast(`${value} is already in your pantry. Update its amount in the list below.`)
      return
    }
    updateData((current) => ({ ...current, pantry: [...current.pantry, { name: value, amount: pantryAmount.trim() }].sort((a, b) => a.name.localeCompare(b.name)) }))
    setToast(`${value} added to your pantry`)
    setPantryEntry('')
    setPantryAmount('')
  }

  /** Remove one pantry row, preserving any legacy rows with the same name. */
  function removePantryItem(index: number) {
    updateData((current) => ({ ...current, pantry: current.pantry.filter((_, rowIndex) => rowIndex !== index) }))
  }

  /** Update the amount for one pantry row, including legacy duplicate names. */
  function updatePantryAmount(index: number, amount: string) {
    updateData((current) => ({ ...current, pantry: current.pantry.map((item, rowIndex) => rowIndex === index ? { ...item, amount } : item) }))
  }

  /** Add a recipe ingredient unless an equivalent name is already tracked. */
  function addCatalogIngredient(name: string) {
    if (data.pantry.some((item) => normalizeName(item.name) === normalizeName(name))) return
    updateData((current) => ({ ...current, pantry: [...current.pantry, { name, amount: '' }].sort((a, b) => a.name.localeCompare(b.name)) }))
    setToast(`${name} added to your pantry`)
  }

  /** Add unique normalized ingredient names to the shopping list. */
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

  /** Submit the shopping-list text field as a new entry. */
  function addShoppingEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!shoppingEntry.trim()) return
    setToast(addShoppingItems([shoppingEntry]) ? 'Added to your shopping list' : 'That item is already on your list')
    setShoppingEntry('')
  }

  /** Add a recipe match’s missing ingredients to the shopping list. */
  function addMissing(match: RecipeMatch) {
    if (match.missing.length === 0) {
      setToast('Everything for this recipe is in your pantry')
      return
    }
    const added = addShoppingItems(match.missing.map(({ name }) => name))
    setToast(added ? `${added} ${added === 1 ? 'item' : 'items'} added to your shopping list` : 'Those ingredients are already on your list')
  }

  /** Toggle the checked state of one shopping-list entry. */
  function toggleShoppingItem(id: string) {
    updateData((current) => ({ ...current, shopping: current.shopping.map((item) => item.id === id ? { ...item, checked: !item.checked } : item) }))
  }

  /** Remove checked entries from the shopping list. */
  function clearChecked() {
    updateData((current) => ({ ...current, shopping: current.shopping.filter((item) => !item.checked) }))
  }

  /** Add a recipe to the personal recipe collection. */
  function saveRecipe(recipe: Recipe) {
    updateData((current) => ({ ...current, recipes: [recipe, ...current.recipes] }))
    setShowRecipeForm(false)
    setToast('Recipe added to your library')
  }

  /** Submit an admin-approved recipe to the shared catalog and refresh the list. */
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

  /**
   * Add instructions to a blank recipe, requiring verified admin access for shared recipes.
   * Queue private profile edits or await the shared API update, then refresh the
   * selected recipe and show a save notice.
   *
   * @throws {Error} For blank instructions, more than 12,000 Unicode code points,
   * unverified shared admin access, or propagated shared update failures.
   */
  async function addInstructionsToRecipe(recipe: Recipe, source: RecipeSource, instructions: string) {
    if (!instructions.trim() || instructionCharacterCount(instructions) > 12000) throw new Error('Enter instructions of 12,000 characters or fewer.')
    if (source === 'shared') {
      if (role !== 'admin' || roleUserId !== user.id || roleError) throw new Error('Admin access could not be verified.')
      let updated: { id: string; instructions: string }
      try {
        updated = await updateSharedRecipeInstructions(recipe.id, instructions)
      } catch (error) {
        try {
          const refreshed = await loadSharedRecipes()
          setSharedRecipes(refreshed)
          const latest = refreshed.find((item) => item.id === recipe.id)
          if (latest) setSelectedRecipe((current) => current?.id === latest.id ? latest : current)
        } catch {
          // Preserve the original save error when refreshing the catalog also fails.
        }
        throw error
      }
      setSharedRecipes((current) => current.map((item) => item.id === updated.id ? { ...item, instructions: updated.instructions } : item))
      setSelectedRecipe((current) => current?.id === updated.id ? { ...current, instructions: updated.instructions } : current)
    } else {
      updateData((current) => ({
        ...current,
        recipes: current.recipes.map((item) => item.id === recipe.id && !(item.instructions ?? '').trim()
          ? { ...item, instructions }
          : item),
      }))
      setSelectedRecipe((current) => current?.id === recipe.id ? { ...current, instructions } : current)
    }
    setToast('Instructions saved')
  }

  /** Add ingredients from the selected recipe that are not already in the pantry. */
  function addRecipeIngredientsToPantry(recipe: Recipe) {
    const known = new Set(data.pantry.map((item) => normalizeName(item.name)))
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
    updateData((current) => ({ ...current, pantry: [...current.pantry, ...newItems.map((name) => ({ name, amount: '' }))].sort((a, b) => a.name.localeCompare(b.name)) }))
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
            onOpen={openRecipe}
            onAddMissing={addMissing}
            onShowRecipes={() => setSection('recipes')}
            onShowPantry={() => setSection('pantry')}
          />}
          {section === 'recipes' && <RecipesView matches={filteredMatches} total={recipes.length} query={query} onlyCookable={onlyCookable} onToggleCookable={() => setOnlyCookable((value) => !value)} onOpen={openRecipe} onAddMissing={addMissing} onAddRecipe={() => setShowRecipeForm(true)} />}
          {section === 'pantry' && <PantryView pantry={data.pantry} catalog={recipeIngredientCatalog} entry={pantryEntry} amount={pantryAmount} onEntryChange={setPantryEntry} onAmountChange={setPantryAmount} onSubmit={addPantryItem} onRemove={removePantryItem} onAmountUpdate={updatePantryAmount} onAddCatalog={addCatalogIngredient} matches={matches} onOpen={openRecipe} onAddMissing={addMissing} />}
          {section === 'shopping' && <ShoppingView items={data.shopping} entry={shoppingEntry} onEntryChange={setShoppingEntry} onSubmit={addShoppingEntry} onToggle={toggleShoppingItem} onRemove={(id) => updateData((current) => ({ ...current, shopping: current.shopping.filter((item) => item.id !== id) }))} onClearChecked={clearChecked} />}

          <footer className="app-footer"><span>Made for slower evenings & better dinners.</span><span><span className="footer-heart">♥</span> {saveStatus === 'saved' ? `Saved to ${user.email ?? 'your profile'}` : saveStatus === 'saving' ? 'Saving to your profile…' : 'Could not save to your profile'}</span></footer>
          {saveStatus === 'error' && <div className="save-error" role="alert">{saveError || 'Your changes could not be saved.'} <button onClick={onRetrySave}>Try saving again</button></div>}
          {accountError && <div className="save-error" role="alert">{accountError}</div>}
          {catalogError && <div className="save-error catalog-error" role="alert">Shared catalog unavailable: {catalogError} <button onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>Retry catalog</button></div>}
          {roleError && <div className="save-error catalog-error" role="status">Account role could not be verified. Shared recipe publishing is disabled.</div>}
        </div>
      </main>

      {showRecipeForm && <RecipeForm onClose={closeRecipeForm} onSave={saveRecipe} onSaveShared={saveSharedRecipe} isAdmin={role === 'admin' && roleUserId === user.id && !roleError} savingShared={catalogSaving} />}
      {selectedRecipe && selectedRecipeSource && <RecipeDetails key={selectedRecipe.id} recipe={selectedRecipe} source={selectedRecipeSource} match={matches.find((item) => item.recipe.id === selectedRecipe.id)} canAddInstructions={selectedRecipeSource === 'private' || (role === 'admin' && roleUserId === user.id && !roleError)} onSaveInstructions={addInstructionsToRecipe} onClose={closeSelectedRecipe} onAddMissing={addMissing} onAddIngredients={addRecipeIngredientsToPantry} />}
      {toast && <div className="toast" role="status"><span className="toast-check"><Icon name="check" size={16} /></span>{toast}</div>}
      <span className="sr-only" aria-live="polite">{`${shoppingCount} items on shopping list`}</span>
    </div>
    {signingOut && <div className="signout-overlay" role="status"><span>Saving your kitchen and signing out…</span></div>}
    </>
  )
}

/** Choose the page description for the active kitchen section and recipe count. */
function pageDescription(section: Section, recipeCount: number) {
  if (section === 'recipes') return `${recipeCount} recipes from your favorite meal kits and your own kitchen.`
  if (section === 'pantry') return 'Keep track of what’s on hand and find recipes that fit.'
  if (section === 'shopping') return 'Everything you need to bring your next meal together.'
  return ''
}

/** Render ranked recipe matches and discovery actions. */
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

/** Render one compact labeled statistic card. */
function StatCard({ icon, label, value, suffix, tone }: { icon: 'book' | 'basket' | 'chef'; label: string; value: string; suffix: string; tone: string }) {
  return <div className="stat-card"><span className={`stat-icon ${tone}`}><Icon name={icon} size={19} /></span><div className="stat-main"><span>{label}</span><div><strong>{value}</strong><small>{suffix}</small></div></div><span className="stat-spark">↗</span></div>
}

/** Render recipe search and filtering controls with the matching recipe grid. */
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

/** Render the collection of recipe cards for the current filtered results. */
function RecipeGrid({ matches, onOpen, onAddMissing }: { matches: RecipeMatch[]; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void }) {
  return <div className="recipe-grid">{matches.map((match) => <RecipeCard key={match.recipe.id} match={match} onOpen={onOpen} onAddMissing={onAddMissing} />)}</div>
}

/** Render one recipe summary and its available cooking actions. */
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

/** Render pantry editing and recipe discovery actions. */
function PantryView({ pantry, catalog, entry, amount, onEntryChange, onAmountChange, onSubmit, onRemove, onAmountUpdate, onAddCatalog, matches, onOpen, onAddMissing }: {
  pantry: PantryItem[]; catalog: string[]; entry: string; amount: string; onEntryChange: (value: string) => void; onAmountChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onRemove: (index: number) => void; onAmountUpdate: (index: number, amount: string) => void; onAddCatalog: (name: string) => void; matches: RecipeMatch[]; onOpen: (recipe: Recipe) => void; onAddMissing: (match: RecipeMatch) => void;
}) {
  const cookable = matches.filter((match) => match.missing.length === 0)
  const pantryByNormalizedName = useMemo(() => {
    const index = new Map<string, PantryItem[]>()
    for (const item of pantry) {
      const key = normalizeName(item.name)
      const rows = index.get(key)
      if (rows) rows.push(item)
      else index.set(key, [item])
    }
    return index
  }, [pantry])
  return <div className="pantry-layout">
    <section className="surface-card pantry-card">
      <div className="surface-heading"><div><div className="section-kicker">WHAT’S ON HAND</div><h2>Your ingredients <span className="pill-count">{pantry.length}</span></h2><p>Add the ingredients you have. We’ll match them to your recipes.</p></div><span className="surface-illustration"><Icon name="basket" size={23} /></span></div>
      <form className="inline-add" onSubmit={onSubmit}><label className="sr-only" htmlFor="pantry-item">Add pantry ingredient</label><input id="pantry-item" value={entry} onChange={(event) => onEntryChange(event.target.value)} placeholder="e.g. cherry tomatoes, brown rice..." /><label className="sr-only" htmlFor="pantry-amount">Amount on hand</label><input id="pantry-amount" value={amount} maxLength={120} onChange={(event) => onAmountChange(event.target.value)} placeholder="Amount (e.g. 2 cups)" /><button className="button button-dark" type="submit"><Icon name="plus" size={16} />Add item</button></form>
      {pantry.length ? <ul className="pantry-items">{pantry.map((item, index) => { const inputId = `pantry-qty-${index}-${normalizeName(item.name).replace(/\s/g, '-')}`; return <li key={`${item.name}-${index}`}><span className="ingredient-bullet" />{item.name}<label className="sr-only" htmlFor={inputId}>{item.name} amount on hand</label><input id={inputId} aria-label={`${item.name} amount on hand`} value={item.amount} maxLength={120} placeholder="Amount on hand" onChange={(event) => onAmountUpdate(index, event.target.value)} /><button onClick={() => onRemove(index)} aria-label={`Remove ${item.name} from pantry`}><Icon name="close" size={13} /></button></li> })}</ul> : <div className="empty-inline"><Icon name="basket" size={20} /><span>Your pantry is empty. Add a few things you already have.</span></div>}
      <div className="section-kicker pantry-catalog-heading">ALL RECIPE INGREDIENTS</div><ul className="pantry-catalog">{catalog.map((name) => {
        const tracked = pantryByNormalizedName.get(normalizeName(name)) ?? []
        const amounts = tracked.map((item) => item.amount.trim()).filter(Boolean)
        const trackedLabel = tracked.length > 1
          ? `Tracked (${tracked.length} entries)${amounts.length ? ` · ${amounts.join('; ')}` : ''}`
          : `Tracked${amounts[0] ? ` · ${amounts[0]}` : ''}`
        return <li key={name}><span>{name}</span>{tracked.length ? <span className="pantry-tracked">{trackedLabel}</span> : <button className="text-button" onClick={() => onAddCatalog(name)}>Add to pantry <Icon name="plus" size={14} /></button>}</li>
      })}</ul>
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

/** Render the shopping list and its completion controls. */
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

/** Render one shopping-list item with toggle and remove actions. */
function ShoppingRow({ item, onToggle, onRemove }: { item: AppData['shopping'][number]; onToggle: (id: string) => void; onRemove: (id: string) => void }) {
  return <li className={`shopping-row ${item.checked ? 'checked' : ''}`}><button className="check-button" onClick={() => onToggle(item.id)} aria-label={item.checked ? `Mark ${item.name} as not picked up` : `Mark ${item.name} as picked up`}><Icon name="check" size={14} /></button><span className="shopping-name">{item.name}</span><button className="remove-shopping" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name} from list`}><Icon name="trash" size={16} /></button></li>
}

/** Render the form for saving a personal or shared recipe. */
function RecipeForm({ onClose, onSave, onSaveShared, isAdmin, savingShared }: { onClose: () => void; onSave: (recipe: Recipe) => void; onSaveShared: (recipe: Recipe) => Promise<void>; isAdmin: boolean; savingShared: boolean }) {
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [category, setCategory] = useState('Dinner')
  const [time, setTime] = useState('30')
  const [servings, setServings] = useState('2')
  const [ingredientsText, setIngredientsText] = useState('')
  const [instructions, setInstructions] = useState('')
  const [destination, setDestination] = useState<'personal' | 'shared'>('personal')
  const [error, setError] = useState('')

  /** Validate recipe form fields and save the recipe to the selected destination. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const ingredients: Ingredient[] = ingredientsText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, ...amountParts] = line.split('|')
      return { name: name.trim(), amount: amountParts.join('|').trim() || 'as needed' }
    }).filter((item) => item.name)
    if (!title.trim()) { setError('Give your recipe a name to continue.'); return }
    if (!ingredients.length) { setError('Add at least one ingredient, one per line.'); return }
    if (!instructions.trim()) { setError('Add instructions for your recipe to continue.'); return }
    if (instructionCharacterCount(instructions) > 12000) { setError('Instructions must be 12,000 characters or fewer.'); return }
    const recipe = makeRecipe(title, source, category, Math.max(1, Number(time) || 30), Math.max(1, Number(servings) || 2), ingredients, instructions)
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
      <label className="form-field wide"><span>Instructions</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder={'Add each cooking step on a new line.'} rows={6} required /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-dark" type="submit" disabled={savingShared}>{savingShared ? 'Saving…' : 'Save recipe'} {!savingShared && <Icon name="arrow" size={16} />}</button></div>
    </form>
  </Modal>
}

/** Render recipe instructions and ingredients, with permitted completion of blank instructions and shopping or pantry actions. */
function RecipeDetails({ recipe, source, match, canAddInstructions, onSaveInstructions, onClose, onAddMissing, onAddIngredients }: { recipe: Recipe; source: RecipeSource; match?: RecipeMatch; canAddInstructions: boolean; onSaveInstructions: (recipe: Recipe, source: RecipeSource, instructions: string) => Promise<void>; onClose: () => void; onAddMissing: (match: RecipeMatch) => void; onAddIngredients: (recipe: Recipe) => void }) {
  const [editingInstructions, setEditingInstructions] = useState(false)
  const [instructionsDraft, setInstructionsDraft] = useState(recipe.instructions ?? '')
  const [instructionError, setInstructionError] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  /**
   * Validate and submit instructions, closing the editor on success.
   * Validation and save failures appear in the form and retain the draft;
   * save errors are caught rather than propagated.
   */
  async function submitInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!instructionsDraft.trim()) { setInstructionError('Add instructions to continue.'); return }
    if (instructionCharacterCount(instructionsDraft) > 12000) { setInstructionError('Instructions must be 12,000 characters or fewer.'); return }
    setSavingInstructions(true)
    setInstructionError('')
    try {
      await onSaveInstructions(recipe, source, instructionsDraft)
      setEditingInstructions(false)
    } catch (error) {
      setInstructionError(error instanceof Error ? error.message : 'Could not save the instructions. Please try again.')
    } finally {
      setSavingInstructions(false)
    }
  }

  return <Modal onClose={onClose} title={recipe.title} description={`${recipe.source} · ${recipe.time} minutes · ${recipe.servings} servings`} wide>
    <div className="detail-image" style={{ backgroundImage: `linear-gradient(180deg, transparent, rgba(24, 37, 29, .28)), url("${recipe.image}")` }}><span className="source-pill">{recipe.source}</span><span className="detail-category">{recipe.category}</span></div>
    <p className="detail-description">{recipe.description}</p>
    <section className="detail-instructions" aria-labelledby="recipe-instructions-heading"><span className="section-kicker">HOW TO MAKE IT</span><h3 id="recipe-instructions-heading">Instructions</h3>{recipe.instructions?.trim()
      ? <p>{recipe.instructions}</p>
      : <>
        <p className="detail-instructions-empty">No instructions have been added for this recipe yet.</p>
        {canAddInstructions && !editingInstructions && <button type="button" className="button button-outline" onClick={() => { setInstructionsDraft(recipe.instructions ?? ''); setInstructionError(''); setEditingInstructions(true) }}>Add instructions</button>}
        {editingInstructions && <form className="recipe-form instruction-editor" onSubmit={submitInstructions}>
          <label className="form-field wide"><span>Instructions</span><textarea aria-label="Recipe instructions" autoFocus value={instructionsDraft} onChange={(event) => setInstructionsDraft(event.target.value)} placeholder="Add each cooking step on a new line." rows={6} required /></label>
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => { setInstructionsDraft(recipe.instructions ?? ''); setInstructionError(''); setEditingInstructions(false) }}>Cancel</button><button className="button button-dark" type="submit" disabled={savingInstructions}>{savingInstructions ? 'Saving…' : 'Save instructions'}</button></div>
        </form>}
      </>}
      {instructionError && <div className="form-error" role="alert">{instructionError}</div>}
    </section>
    {match && <div className="detail-match"><span className="match-icon"><Icon name={match.missing.length ? 'leaf' : 'check'} size={14} /></span><strong>{match.percent}% of ingredients in your pantry</strong><span>{match.missing.length ? `${match.missing.length} missing` : 'Ready to cook'}</span></div>}
    <div className="detail-ingredients-heading"><div><span className="section-kicker">THE SHOPPING LIST</span><h3>Ingredients <small>{recipe.ingredients.length}</small></h3></div><button className="text-button" onClick={() => onAddIngredients(recipe)}>Add all to pantry <Icon name="plus" size={15} /></button></div>
    <ul className="detail-ingredients">{recipe.ingredients.map((ingredient, index) => {
      const isAvailable = Boolean(match?.available.includes(ingredient))
      return <li key={`${ingredient.name}-${index}`} className={isAvailable ? 'available' : ''}><span className="detail-ingredient-check">{isAvailable && <Icon name="check" size={13} />}</span><span>{ingredient.name}</span><span className="detail-amount">{ingredient.amount}</span></li>
    })}</ul>
    {match && <div className="modal-actions detail-actions"><span className="detail-hint">{match.missing.length ? `${match.missing.length} ingredients still to get` : 'You have everything you need'}</span><button className="button button-dark" onClick={() => onAddMissing(match)}>{match.missing.length ? 'Add missing to list' : 'Ready to cook'} <Icon name={match.missing.length ? 'plus' : 'check'} size={16} /></button></div>}
  </Modal>
}

/** Render an accessible dialog with Escape handling and focus containment. */
function Modal({ onClose, title, description, children, wide = false }: { onClose: () => void; title: string; description: string; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    /** Select dialog controls eligible for keyboard focus. */
    const getFocusable = () => dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []
    const focusables = getFocusable()
    ;(dialog?.querySelector<HTMLElement>('[autofocus]') ?? focusables[0] ?? dialog)?.focus()
    /** Handle Escape dismissal and cycle Tab focus within the dialog. */
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
