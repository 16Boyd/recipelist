import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import type { AppData, Recipe } from '../../src/types'

const mocks = vi.hoisted(() => ({
  session: { data: { user: { id: 'user-1', email: 'alex@example.com' } } as { user: { id: string; email: string } } | null, isPending: false },
  apiRequest: vi.fn(), loadProfile: vi.fn(), saveProfile: vi.fn(), loadCurrentUserRole: vi.fn(), loadSharedRecipes: vi.fn(), insertSharedRecipe: vi.fn(), signOut: vi.fn(),
}))
vi.mock('../../src/authClient', () => ({ authClient: { useSession: () => mocks.session, signOut: mocks.signOut } }))
vi.mock('../../src/api', () => ({ apiRequest: mocks.apiRequest, errorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback }))
vi.mock('../../src/profileStorage', () => ({ loadProfile: mocks.loadProfile, saveProfile: mocks.saveProfile }))
vi.mock('../../src/recipeStorage', () => ({ loadCurrentUserRole: mocks.loadCurrentUserRole, loadSharedRecipes: mocks.loadSharedRecipes, insertSharedRecipe: mocks.insertSharedRecipe }))

const shared: Recipe[] = [
  { id: 'chicken-meal', title: 'Chicken and Rice', source: 'Test Kitchen', category: 'Dinner', time: 25, servings: 2, image: '', description: 'A simple dinner.', ingredients: [{ name: 'ground chicken', amount: '1 lb' }, { name: 'rice', amount: '1 cup' }, { name: 'lemon', amount: '1' }] },
  { id: 'soup', title: 'Tomato Soup', source: 'Test Kitchen', category: 'Lunch', time: 20, servings: 2, image: '', description: 'Tomato soup.', ingredients: [{ name: 'tomatoes', amount: '4' }, { name: 'cream', amount: '1 cup' }] },
]
const userData = (): AppData => ({ recipes: [], pantry: ['chicken tenders', 'rice'], shopping: [{ id: 'salt', name: 'salt', checked: false }, { id: 'oats', name: 'oats', checked: true }] })

async function mountReady(initial = userData()) {
  mocks.apiRequest.mockResolvedValue({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
  mocks.loadProfile.mockResolvedValue(initial)
  mocks.loadCurrentUserRole.mockResolvedValue('member')
  mocks.loadSharedRecipes.mockResolvedValue(shared)
  mocks.saveProfile.mockResolvedValue(undefined)
  const result = render(<App />)
  await screen.findByRole('heading', { name: 'Your kitchen, sorted.' })
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.data = { user: { id: 'user-1', email: 'alex@example.com' } }
  mocks.session.isPending = false
  mocks.signOut.mockResolvedValue({})
})

describe('application session and profile flow', () => {
  it('shows sign-in while signed out and renders MFA setup for an unsecured session', async () => {
    mocks.session.data = null
    const { rerender } = render(<App />)
    expect(await screen.findByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
    mocks.session.data = { user: { id: 'user-1', email: 'alex@example.com' } }
    mocks.apiRequest.mockResolvedValueOnce({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: false }, role: 'member', needsMfaReauthentication: false })
    rerender(<App />)
    expect(await screen.findByRole('heading', { name: 'Secure your account.' })).toBeInTheDocument()
    expect(mocks.loadProfile).not.toHaveBeenCalled()
  })
  it('shows account errors and retries the security check', async () => {
    const user = userEvent.setup()
    mocks.apiRequest.mockRejectedValueOnce(new Error('Role service unavailable')).mockResolvedValueOnce({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
    mocks.loadProfile.mockResolvedValue(userData())
    mocks.loadCurrentUserRole.mockResolvedValue('member')
    mocks.loadSharedRecipes.mockResolvedValue([])
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'We couldn’t confirm your account.' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Your kitchen, sorted.' })).toBeInTheDocument()
  })
  it('shows profile load errors with a retry action', async () => {
    const user = userEvent.setup()
    mocks.apiRequest.mockResolvedValue({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
    mocks.loadProfile.mockRejectedValueOnce(new Error('Profile unavailable')).mockResolvedValueOnce(userData())
    mocks.loadCurrentUserRole.mockResolvedValue('member')
    mocks.loadSharedRecipes.mockResolvedValue([])
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'We couldn’t load your kitchen' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Your kitchen, sorted.' })).toBeInTheDocument()
  })
  it('saves pantry edits before sign-out and retries a failed save', async () => {
    const user = userEvent.setup()
    const firstApp = await mountReady()
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'parsley')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalled())
    const newest = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData
    expect(newest.pantry).toContain('parsley')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled())
    firstApp.unmount()

    vi.clearAllMocks()
    mocks.apiRequest.mockResolvedValue({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
    mocks.loadProfile.mockResolvedValue(userData())
    mocks.loadCurrentUserRole.mockResolvedValue('member')
    mocks.loadSharedRecipes.mockResolvedValue(shared)
    await mountReady()
    mocks.saveProfile.mockRejectedValueOnce(new Error('Write failed')).mockResolvedValue(undefined)
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'parsley')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Write failed')
    await user.click(screen.getByRole('button', { name: 'Try saving again' }))
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(2))
  })
})

describe('pantry, recipes, and shopping list flows', () => {
  it('adds and removes pantry items and prevents normalized duplicates', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'Rice')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Rice is already in your pantry')
    await user.clear(screen.getByLabelText('Add pantry ingredient'))
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'parsley')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByText('parsley')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove parsley from pantry' }))
    expect(screen.queryByText('parsley')).not.toBeInTheDocument()
  })
  it('adds, checks, and clears shopping items while preventing duplicates', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(screen.getAllByRole('button', { name: 'Shopping list' })[0]!)
    await user.type(screen.getByLabelText('Add shopping list item'), 'salt')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByRole('status')).toHaveTextContent('already on your list')
    await user.clear(screen.getByLabelText('Add shopping list item'))
    await user.type(screen.getByLabelText('Add shopping list item'), 'lemons')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByText('lemons')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark salt as picked up' }))
    expect(await screen.findByRole('button', { name: 'Mark salt as not picked up' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear checked' }))
    expect(screen.queryByText('oats')).not.toBeInTheDocument()
    expect(screen.queryByText('salt')).not.toBeInTheDocument()
  })
  it('searches and filters recipe catalog and adds missing ingredients to shopping', async () => {
    const user = userEvent.setup()
    await mountReady()
    expect(await screen.findByText('Chicken and Rice')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Search recipes or ingredients' }), 'tomato')
    expect(await screen.findByText('Tomato Soup')).toBeInTheDocument()
    expect(screen.queryByText('Chicken and Rice')).not.toBeInTheDocument()
    await user.clear(screen.getByRole('textbox', { name: 'Search recipes or ingredients' }))
    await user.click(screen.getAllByRole('button', { name: 'Recipes' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Ready to cook' }))
    expect(screen.getByText('0 recipes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ready to cook' }))
    await user.click(screen.getByRole('button', { name: 'Add missing ingredients for Chicken and Rice' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 item added to your shopping list')
    await user.click(screen.getAllByRole('button', { name: 'Shopping list' })[0]!)
    expect(await screen.findByText('lemon')).toBeInTheDocument()
  })
})
