import { apiRequest } from './api'
import type { Recipe, UserRole } from './types'

type CurrentUser = { user: { id: string; email: string; twoFactorEnabled: boolean }; role: UserRole; needsMfaReauthentication: boolean }

function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<Recipe>
  return typeof recipe.id === 'string' && typeof recipe.title === 'string'
    && typeof recipe.source === 'string' && typeof recipe.category === 'string'
    && typeof recipe.time === 'number' && typeof recipe.servings === 'number'
    && typeof recipe.image === 'string' && typeof recipe.description === 'string'
    && Array.isArray(recipe.ingredients) && recipe.ingredients.every((item) => item
      && typeof item.name === 'string' && typeof item.amount === 'string')
}

export async function loadCurrentUserRole(): Promise<UserRole> {
  const current = await apiRequest<CurrentUser>('/api/me')
  if (current.role !== 'member' && current.role !== 'admin') throw new Error('Your account role could not be verified.')
  return current.role
}

export async function loadSharedRecipes(): Promise<Recipe[]> {
  const recipes = await apiRequest<unknown>('/api/recipes')
  if (!Array.isArray(recipes) || !recipes.every(isRecipe)) throw new Error('The shared recipe catalog contains an invalid recipe.')
  return recipes
}

export async function insertSharedRecipe(recipe: Recipe): Promise<void> {
  await apiRequest<void>('/api/recipes', { method: 'POST', body: JSON.stringify(recipe) })
}
