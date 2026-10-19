import { initialAppData } from './data'
import type { AppData, Ingredient, Recipe, RecipeMatch, ShoppingItem } from './types'

const STORAGE_KEY = 'recipelist.app-data.v1'

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => {
      if (word === 'leaves') return 'leaf'
      if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
      if (word.length > 4 && /(ches|shes|sses|xes|zes|oes)$/.test(word)) return word.slice(0, -2)
      if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1)
      return word
    })
    .join(' ')
}

function validRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false
  const recipe = value as Partial<Recipe>
  return typeof recipe.id === 'string'
    && typeof recipe.title === 'string'
    && typeof recipe.source === 'string'
    && typeof recipe.category === 'string'
    && typeof recipe.time === 'number'
    && typeof recipe.servings === 'number'
    && typeof recipe.image === 'string'
    && typeof recipe.description === 'string'
    && Array.isArray(recipe.ingredients)
    && recipe.ingredients.length > 0
    && recipe.ingredients.every((item) => item
      && typeof item.name === 'string'
      && Boolean(item.name.trim())
      && typeof item.amount === 'string')
}

export function loadAppData(): AppData {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return initialAppData
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object') return initialAppData
    const candidate = parsed as Partial<AppData>
    return {
      recipes: Array.isArray(candidate.recipes) ? candidate.recipes.filter(validRecipe) : initialAppData.recipes,
      pantry: Array.isArray(candidate.pantry)
        ? candidate.pantry.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        : initialAppData.pantry,
      shopping: Array.isArray(candidate.shopping)
        ? candidate.shopping.filter((item): item is ShoppingItem => Boolean(item)
          && typeof item === 'object'
          && typeof item.id === 'string'
          && typeof item.name === 'string'
          && typeof item.checked === 'boolean')
        : initialAppData.shopping,
    }
  } catch {
    return initialAppData
  }
}

export function saveAppData(data: AppData): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // The app remains usable in private browsing or when storage is unavailable.
  }
}

export function matchRecipes(recipes: Recipe[], pantry: string[]): RecipeMatch[] {
  const pantryNames = new Set(pantry.map(normalizeName))
  return recipes.map((recipe) => {
    const available: Ingredient[] = []
    const missing: Ingredient[] = []
    recipe.ingredients.forEach((ingredient) => {
      if (pantryNames.has(normalizeName(ingredient.name))) available.push(ingredient)
      else missing.push(ingredient)
    })
    const percent = recipe.ingredients.length ? Math.round((available.length / recipe.ingredients.length) * 100) : 0
    return { recipe, available, missing, percent }
  }).sort((a, b) => b.percent - a.percent || a.missing.length - b.missing.length || a.recipe.time - b.recipe.time)
}

export function makeRecipe(title: string, source: string, category: string, time: number, servings: number, ingredients: Ingredient[]): Recipe {
  return {
    id: `recipe-${crypto.randomUUID()}`,
    title: title.trim(),
    source: source.trim() || 'My recipes',
    category: category.trim() || 'Dinner',
    time,
    servings,
    image: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=1100&q=85',
    description: 'A recipe saved to your personal library.',
    ingredients,
  }
}

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
