import { apiRequest } from './api'
import type { Recipe, UserRole } from './types'

type CurrentUser = { user: { id: string; email: string; twoFactorEnabled: boolean }; role: UserRole; needsMfaReauthentication: boolean }

/** Validate the required fields of a recipe received from the server. */
function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<Recipe>
  return typeof recipe.id === 'string' && typeof recipe.title === 'string'
    && typeof recipe.source === 'string' && typeof recipe.category === 'string'
    && typeof recipe.time === 'number' && typeof recipe.servings === 'number'
    && typeof recipe.image === 'string' && typeof recipe.description === 'string'
    && typeof recipe.instructions === 'string'
    && Array.isArray(recipe.ingredients) && recipe.ingredients.every((item) => item
      && typeof item.name === 'string' && typeof item.amount === 'string')
}

/** Fetch the signed-in account role and reject values outside the supported roles. */
export async function loadCurrentUserRole(): Promise<UserRole> {
  const current = await apiRequest<CurrentUser>('/api/me')
  if (current.role !== 'member' && current.role !== 'admin') throw new Error('Your account role could not be verified.')
  return current.role
}

/** Fetch and validate the shared recipe catalog before returning it to the UI. */
export async function loadSharedRecipes(): Promise<Recipe[]> {
  const recipes = await apiRequest<unknown>('/api/recipes')
  if (!Array.isArray(recipes) || !recipes.every(isRecipe)) throw new Error('The shared recipe catalog contains an invalid recipe.')
  return recipes
}

/** Submit a recipe to the shared catalog API. */
export async function insertSharedRecipe(recipe: Recipe): Promise<void> {
  await apiRequest<void>('/api/recipes', { method: 'POST', body: JSON.stringify(recipe) })
}

/** Add instructions to a blank shared recipe and validate the response. */
export async function updateSharedRecipeInstructions(id: string, instructions: string): Promise<{ id: string; instructions: string }> {
  const result = await apiRequest<unknown>(`/api/recipes/${encodeURIComponent(id)}/instructions`, {
    method: 'PUT', body: JSON.stringify({ instructions }),
  })
  if (!result || typeof result !== 'object'
    || typeof (result as { id?: unknown }).id !== 'string'
    || typeof (result as { instructions?: unknown }).instructions !== 'string') {
    throw new Error('The server returned an invalid recipe update.')
  }
  return { id: (result as { id: string }).id, instructions: (result as { instructions: string }).instructions }
}
