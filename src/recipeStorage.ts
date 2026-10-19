import type { Recipe, UserRole } from './types'
import { supabase } from './supabase'

type RecipeRow = Recipe

function client() {
  if (!supabase) throw new Error('Supabase is not configured.')
  return supabase
}

export async function loadCurrentUserRole(userId: string): Promise<UserRole> {
  const { data, error } = await client().from('user_roles').select('role').eq('user_id', userId).maybeSingle()
  if (error) throw error
  if (!data || (data.role !== 'member' && data.role !== 'admin')) throw new Error('Your account role could not be verified.')
  return data.role
}

export async function loadSharedRecipes(): Promise<Recipe[]> {
  const { data, error } = await client().from('recipes')
    .select('id,title,source,category,time,servings,image,description,ingredients')
    .order('title')
  if (error) throw error
  return (data ?? []).map((row) => {
    if (!row || typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.source !== 'string'
      || typeof row.category !== 'string' || typeof row.time !== 'number' || typeof row.servings !== 'number'
      || typeof row.image !== 'string' || typeof row.description !== 'string' || !Array.isArray(row.ingredients)
      || !row.ingredients.every((item: unknown) => item && typeof item === 'object'
        && typeof (item as { name?: unknown }).name === 'string' && typeof (item as { amount?: unknown }).amount === 'string')) {
      throw new Error('The shared recipe catalog contains an invalid recipe.')
    }
    return row as RecipeRow
  })
}

export async function insertSharedRecipe(recipe: Recipe): Promise<void> {
  const { error } = await client().from('recipes').insert(recipe)
  if (error) throw error
}
