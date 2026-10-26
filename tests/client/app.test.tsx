import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import type { AppData, Recipe } from '../../src/types'

const mocks = vi.hoisted(() => ({
  session: { data: { user: { id: 'user-1', email: 'alex@example.com' } } as { user: { id: string; email: string } } | null, isPending: false },
  apiRequest: vi.fn(), loadProfile: vi.fn(), saveProfile: vi.fn(), loadCurrentUserRole: vi.fn(), loadSharedRecipes: vi.fn(), insertSharedRecipe: vi.fn(), updateSharedRecipeInstructions: vi.fn(), signOut: vi.fn(),
}))
vi.mock('../../src/authClient', () => ({ authClient: { useSession: () => mocks.session, signOut: mocks.signOut } }))
vi.mock('../../src/api', () => ({ apiRequest: mocks.apiRequest, errorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback }))
vi.mock('../../src/profileStorage', () => ({ loadProfile: mocks.loadProfile, saveProfile: mocks.saveProfile }))
vi.mock('../../src/recipeStorage', () => ({ loadCurrentUserRole: mocks.loadCurrentUserRole, loadSharedRecipes: mocks.loadSharedRecipes, insertSharedRecipe: mocks.insertSharedRecipe, updateSharedRecipeInstructions: mocks.updateSharedRecipeInstructions }))

const shared: Recipe[] = [
  { id: 'chicken-meal', title: 'Chicken and Rice', source: 'Test Kitchen', category: 'Dinner', time: 25, servings: 2, image: '', description: 'A simple dinner.', instructions: 'Cook rice.\nBrown chicken.', ingredients: [{ name: 'ground chicken', amount: '1 lb' }, { name: 'rice', amount: '1 cup' }, { name: 'lemon', amount: '1' }] },
  { id: 'soup', title: 'Tomato Soup', source: 'Test Kitchen', category: 'Lunch', time: 20, servings: 2, image: '', description: 'Tomato soup.', instructions: '', ingredients: [{ name: 'tomatoes', amount: '4' }, { name: 'cream', amount: '1 cup' }, { name: 'RICE', amount: '1 cup' }] },
]
const userData = (): AppData => ({ recipes: [], pantry: [{ name: 'chicken tenders', amount: '' }, { name: 'rice', amount: '' }], shopping: [{ id: 'salt', name: 'salt', checked: false }, { id: 'oats', name: 'oats', checked: true }] })

async function mountReady(initial = userData(), recipes = shared, role: 'member' | 'admin' = 'member') {
  mocks.apiRequest.mockResolvedValue({ user: { id: 'user-1', email: 'alex@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
  mocks.loadProfile.mockResolvedValue(initial)
  mocks.loadCurrentUserRole.mockResolvedValue(role)
  mocks.loadSharedRecipes.mockResolvedValue(recipes)
  mocks.saveProfile.mockResolvedValue(undefined)
  mocks.updateSharedRecipeInstructions.mockImplementation(async (id: string, instructions: string) => ({ id, instructions }))
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
    expect(newest.pantry).toContainEqual({ name: 'parsley', amount: '' })
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
  it('updates only the selected duplicate pantry row amount', async () => {
    const user = userEvent.setup()
    await mountReady({ ...userData(), pantry: [{ name: 'rice', amount: '1 cup' }, { name: 'rice', amount: '3 cups' }] }, [])
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    const amounts = screen.getAllByLabelText(/rice amount on hand, entry \d/)
    expect(amounts).toHaveLength(2)
    expect(amounts.map((input) => input.getAttribute('aria-label'))).toEqual([null, null])
    await user.clear(amounts[1]!)
    await user.type(amounts[1]!, '4 cups')
    await waitFor(() => {
      const saved = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData | undefined
      expect(saved?.pantry).toEqual([{ name: 'rice', amount: '1 cup' }, { name: 'rice', amount: '4 cups' }])
    })
    expect(screen.getByRole('button', { name: 'Remove rice from pantry, entry 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove rice from pantry, entry 2' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove rice from pantry, entry 1' }))
    await waitFor(() => {
      const saved = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData | undefined
      expect(saved?.pantry).toEqual([{ name: 'rice', amount: '4 cups' }])
    })
  })

  it('shows every recorded amount for duplicate ingredients in the pantry catalog', async () => {
    const user = userEvent.setup()
    await mountReady({ ...userData(), pantry: [{ name: 'rice', amount: '1 cup' }, { name: 'RICE', amount: '4 cups' }] })
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    const riceRow = Array.from(document.querySelectorAll('.pantry-catalog li'))
      .find((row) => row.querySelector('span:first-child')?.textContent === 'rice')
    const trackedAmounts = riceRow?.querySelector('.pantry-tracked')
    expect(trackedAmounts).toHaveTextContent('Tracked (2 entries) · 1 cup; 4 cups')
    expect(trackedAmounts).not.toHaveClass('muted')
  })

  it('adds and removes pantry items and prevents normalized duplicates', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    expect(screen.getByText('ALL RECIPE INGREDIENTS')).toBeInTheDocument()
    const catalog = screen.getByRole('list', { name: 'ALL RECIPE INGREDIENTS' })
    expect(Array.from(catalog.querySelectorAll('li > span:first-child')).map((item) => item.textContent)).toContain('rice')
    expect(Array.from(catalog.querySelectorAll('li > span:first-child')).filter((item) => item.textContent?.toLowerCase() === 'rice')).toHaveLength(1)
    expect(screen.getByLabelText('Search recipe ingredients')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to pantry: cream' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to pantry: cream' }))
    expect(await screen.findAllByText(/Tracked/)).toHaveLength(2)
    expect(screen.getByLabelText('Amount on hand')).toHaveAttribute('maxLength', '120')
    const amountHint = screen.getByText(/Use numeric amounts such as 2 cups, 3 lemons, or 2 salmon fillets\. Supported units convert; unknown units compare only when their names match and aren’t converted\. Incompatible units or unparseable amounts won’t count; blank amounts match by name\./)
    expect(amountHint).toHaveAttribute('id', 'pantry-amount-hint')
    expect(screen.getByLabelText('Amount on hand')).toHaveAttribute('aria-describedby', 'pantry-amount-hint')
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'Rice')
    await user.type(screen.getByLabelText('Amount on hand'), '2 cups')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Rice is already in your pantry')
    expect(screen.getByLabelText('Add pantry ingredient')).toHaveValue('Rice')
    expect(screen.getByLabelText('Amount on hand')).toHaveValue('2 cups')
    await user.clear(screen.getByLabelText('Add pantry ingredient'))
    await user.clear(screen.getByLabelText('Amount on hand'))
    await user.type(screen.getByLabelText('Add pantry ingredient'), 'parsley')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(await screen.findByText('parsley')).toBeInTheDocument()
    const amount = screen.getByLabelText('parsley amount on hand')
    expect(amount).toHaveAttribute('maxLength', '120')
    await user.type(amount, '2 bunches')
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ pantry: expect.arrayContaining([{ name: 'parsley', amount: '2 bunches' }]) })))
    await user.click(screen.getByRole('button', { name: 'Remove parsley from pantry' }))
    expect(screen.queryByText('parsley')).not.toBeInTheDocument()
  })
  it('searches the full recipe-ingredient catalog without changing its stable order', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    const catalog = screen.getByRole('list', { name: 'ALL RECIPE INGREDIENTS' })
    const search = screen.getByLabelText('Search recipe ingredients')
    await user.type(search, 'R')
    expect(Array.from(catalog.querySelectorAll('li > span:first-child')).map((item) => item.textContent)).toEqual(['cream', 'ground chicken', 'rice'])
    expect(document.querySelector('.pantry-catalog-count')).toHaveTextContent('Showing 3 of 3 recipe ingredients matching “R”.')
  })
  it('renders large recipe-ingredient catalogs in pages and lets users reach later entries', async () => {
    const user = userEvent.setup()
    const ingredients = Array.from({ length: 105 }, (_, index) => ({ name: `ingredient ${String(index).padStart(3, '0')}`, amount: '' }))
    const manyIngredients: Recipe = { ...shared[0]!, id: 'large-catalog', title: 'Large catalog', ingredients }
    await mountReady(userData(), [manyIngredients])
    await user.click(screen.getAllByRole('button', { name: 'Pantry' })[0]!)
    const catalog = screen.getByRole('list', { name: 'ALL RECIPE INGREDIENTS' })
    expect(catalog.querySelectorAll('li')).toHaveLength(100)
    expect(document.querySelector('.pantry-catalog-count')).toHaveTextContent('Showing 100 of 105 recipe ingredients.')
    await user.click(screen.getByRole('button', { name: 'Show more ingredients' }))
    expect(catalog.querySelectorAll('li')).toHaveLength(105)
    expect(within(catalog).getByText('ingredient 104')).toBeInTheDocument()
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
    expect(screen.getByText('Missing: lemon')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Search recipes or ingredients' }), 'tomato')
    expect(await screen.findByText('Tomato Soup')).toBeInTheDocument()
    expect(screen.getByText('Missing: tomatoes, cream')).toBeInTheDocument()
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

  it('shows multiline recipe instructions in details and saves entered instructions', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(await screen.findByRole('button', { name: 'View Chicken and Rice' }))
    expect(screen.getByRole('heading', { name: 'Instructions' }).parentElement).toHaveTextContent('Cook rice. Brown chicken.')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /Add recipe/ }))
    await user.type(screen.getByRole('textbox', { name: 'Recipe name' }), 'Quick rice')
    await user.type(screen.getByRole('textbox', { name: /Ingredients/ }), 'rice | 1 cup')
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'Rinse rice.\nCook until tender.')
    await user.click(screen.getByRole('button', { name: 'Save recipe' }))
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalled())
    const saved = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData
    expect(saved.recipes[0]?.instructions).toBe('Rinse rice.\nCook until tender.')
  })

  it('allows 12,000 non-BMP code points in newly added recipe instructions', async () => {
    const user = userEvent.setup()
    await mountReady()
    await user.click(screen.getByRole('button', { name: /Add recipe/ }))
    await user.type(screen.getByRole('textbox', { name: 'Recipe name' }), 'Emoji recipe')
    await user.type(screen.getByRole('textbox', { name: /Ingredients/ }), 'rice | 1 cup')
    const instructions = '😀'.repeat(12000)
    const textarea = screen.getByRole('textbox', { name: 'Instructions' })
    expect(textarea).not.toHaveAttribute('maxLength')
    fireEvent.change(textarea, { target: { value: instructions } })
    await user.click(screen.getByRole('button', { name: 'Save recipe' }))
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalled())
    const saved = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData
    expect(saved.recipes[0]?.instructions).toBe(instructions)
  })

  it('lets a user add instructions to a legacy private recipe and preserves its other data', async () => {
    const user = userEvent.setup()
    const privateRecipe: Recipe = { ...shared[0]!, id: 'private-legacy', instructions: '' }
    await mountReady({ ...userData(), recipes: [privateRecipe] }, [])
    await user.click(await screen.findByRole('button', { name: 'View Chicken and Rice' }))
    expect(screen.getByText('No instructions have been added for this recipe yet.')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Add instructions' }))
    const instructions = ['Roast chicken.', 'Serve with rice.'].join('\n')
    await user.type(screen.getByRole('textbox', { name: 'Recipe instructions' }), instructions)
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))
    await waitFor(() => {
      const saved = mocks.saveProfile.mock.calls.at(-1)?.[0] as AppData | undefined
      expect(saved?.recipes[0]).toEqual({ ...privateRecipe, instructions })
    })
    expect(screen.getByRole('heading', { name: 'Instructions' }).parentElement).toHaveTextContent('Roast chicken. Serve with rice.')
    expect(screen.queryByText('Instructions saved')).not.toBeInTheDocument()
  })

  it('allows 12,000 non-BMP code points when completing legacy shared instructions', async () => {
    const user = userEvent.setup()
    const legacyShared = { ...shared[1]!, instructions: '' }
    await mountReady(userData(), [legacyShared], 'admin')
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    await user.click(await screen.findByRole('button', { name: 'Add instructions' }))
    const instructions = '😀'.repeat(12000)
    const textarea = screen.getByRole('textbox', { name: 'Recipe instructions' })
    expect(textarea).not.toHaveAttribute('maxLength')
    fireEvent.change(textarea, { target: { value: instructions } })
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))
    await waitFor(() => expect(mocks.updateSharedRecipeInstructions).toHaveBeenCalledWith('soup', instructions))
  })

  it('lets an admin complete a blank shared recipe and hides the control from members', async () => {
    const user = userEvent.setup()
    const legacyShared = { ...shared[1]!, instructions: '' }
    const firstApp = await mountReady(userData(), [legacyShared], 'admin')
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    await user.click(await screen.findByRole('button', { name: 'Add instructions' }))
    const instructions = ['Simmer tomatoes.', 'Stir in cream.'].join('\n')
    await user.type(screen.getByRole('textbox', { name: 'Recipe instructions' }), instructions)
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))
    await waitFor(() => expect(mocks.updateSharedRecipeInstructions).toHaveBeenCalledWith('soup', instructions))
    expect(screen.getByRole('heading', { name: 'Instructions' }).parentElement).toHaveTextContent('Simmer tomatoes. Stir in cream.')

    firstApp.unmount()
    vi.clearAllMocks()
    await mountReady(userData(), [legacyShared], 'member')
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    expect(screen.queryByRole('button', { name: 'Add instructions' })).not.toBeInTheDocument()
  })

  it('keeps an instruction draft and reports shared-save errors', async () => {
    const user = userEvent.setup()
    await mountReady(userData(), [{ ...shared[1]!, instructions: '' }], 'admin')
    mocks.updateSharedRecipeInstructions.mockRejectedValueOnce(new Error('Recipe instructions have already been added'))
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    await user.click(await screen.findByRole('button', { name: 'Add instructions' }))
    const draft = 'Cook the tomatoes.'
    await user.type(screen.getByRole('textbox', { name: 'Recipe instructions' }), draft)
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Recipe instructions have already been added')
    expect(screen.getByRole('textbox', { name: 'Recipe instructions' })).toHaveValue(draft)
  })

  it('refreshes a shared recipe after a conflicting instruction save', async () => {
    const user = userEvent.setup()
    const blankRecipe = { ...shared[1]!, instructions: '' }
    const completedRecipe = { ...blankRecipe, instructions: 'Another admin added these steps.' }
    await mountReady(userData(), [blankRecipe], 'admin')
    mocks.loadSharedRecipes.mockResolvedValueOnce([completedRecipe])
    mocks.updateSharedRecipeInstructions.mockRejectedValueOnce(new Error('Recipe instructions have already been added'))
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    await user.click(await screen.findByRole('button', { name: 'Add instructions' }))
    await user.type(screen.getByRole('textbox', { name: 'Recipe instructions' }), 'My draft steps.')
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Recipe instructions have already been added')
    expect(screen.getByText('Another admin added these steps.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add instructions' })).not.toBeInTheDocument()
  })

  it('closes recipe details when the signed-in account changes', async () => {
    const user = userEvent.setup()
    const app = await mountReady(userData(), shared, 'admin')
    await user.click(await screen.findByRole('button', { name: 'View Tomato Soup' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    mocks.session.data = { user: { id: 'user-2', email: 'sam@example.com' } }
    mocks.apiRequest.mockResolvedValue({ user: { id: 'user-2', email: 'sam@example.com', twoFactorEnabled: true }, role: 'member', needsMfaReauthentication: false })
    mocks.loadProfile.mockResolvedValue(userData())
    mocks.loadCurrentUserRole.mockResolvedValue('member')
    mocks.loadSharedRecipes.mockResolvedValue([])
    app.rerender(<App />)
    await waitFor(() => expect(mocks.loadProfile).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('marks each repeated recipe ingredient according to its own required quantity', async () => {
    const user = userEvent.setup()
    const recipe: Recipe = {
      ...shared[0]!,
      ingredients: [{ name: 'rice', amount: '1 cup' }, { name: 'rice', amount: '3 cups' }],
    }
    await mountReady({ ...userData(), pantry: [{ name: 'rice', amount: '2 cups' }] }, [recipe])
    await user.click(await screen.findByRole('button', { name: 'View Chicken and Rice' }))
    const ingredients = screen.getAllByRole('listitem').filter((item) => item.closest('.detail-ingredients'))
    expect(ingredients).toHaveLength(2)
    expect(ingredients[0]).toHaveClass('available')
    expect(ingredients[1]).not.toHaveClass('available')
  })
})
