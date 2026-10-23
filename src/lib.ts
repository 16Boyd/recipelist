import type { AppData, Ingredient, Recipe, RecipeMatch, ShoppingItem } from './types'

/** Normalize ingredient text for case-insensitive matching, including common plural forms. */
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

const proteinFamilies: Record<string, readonly string[]> = {
  poultry: ['poultry', 'chicken', 'turkey', 'duck', 'goose', 'quail', 'pheasant'],
  beef: ['beef', 'veal', 'bison'],
  pork: ['pork'],
  lamb: ['lamb', 'mutton'],
  finfish: [
    'fish', 'salmon', 'tuna', 'cod', 'haddock', 'halibut', 'tilapia', 'trout', 'catfish',
    'sardine', 'anchovy', 'mackerel', 'snapper', 'bass', 'pollock', 'mahi', 'sole', 'swordfish',
  ],
  shellfish: [
    'shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'crawfish', 'scallop', 'oyster',
    'mussel', 'clam', 'squid', 'octopus',
  ],
}

// These terms signal a stock, condiment, seasoning, or processed product rather than
// a plainly identified protein ingredient. Such items still match by exact name above.
const nonProteinProductTerms = new Set([
  'stock', 'broth', 'bouillon', 'sauce', 'seasoning', 'flavor', 'flavoured', 'flavored',
  'extract', 'base', 'powder', 'paste', 'sausage', 'bacon', 'ham', 'jerky', 'deli',
  'nugget', 'nuggets', 'patty', 'patties', 'meatball', 'meatballs', 'burger', 'hamburger',
  'hotdog', 'frankfurter', 'breaded', 'battered', 'smoked', 'cured',
  'oil', 'egg', 'eggs', 'plant', 'vegan', 'vegetarian', 'meatless', 'imitation', 'substitute',
  'salad', 'soup', 'casserole', 'pie', 'sandwich', 'wrap', 'taco', 'burrito', 'stew',
])

// Only permit common cut and preparation descriptors after a protein name. This
// avoids treating a compound dish (for example, "chicken and rice") as poultry.
const proteinFormTerms = new Set([
  'ground', 'mince', 'minced', 'chopped', 'diced', 'sliced', 'cubed', 'strip', 'chunk',
  'cutlet', 'fillet', 'breast', 'thigh', 'wing', 'drumstick', 'tender', 'tenderloin',
  'loin', 'chop', 'steak', 'roast', 'rack', 'rib', 'leg', 'whole', 'meat', 'skinless',
  'boneless', 'bone', 'in', 'out', 'bone-in', 'bone-out', 'skin-on', 'skin-off',
  'fresh', 'frozen', 'raw', 'cooked',
])

/** Return an animal-protein family only when the ingredient names one unambiguous protein and no product terms. */
function proteinFamily(value: string): string | undefined {
  const words = normalizeName(value).split(' ')
  if (words.some((word) => nonProteinProductTerms.has(word))) return undefined

  const matched = Object.entries(proteinFamilies)
    .flatMap(([family, names]) => names.filter((name) => words.includes(name)).map((name) => ({ family, name })))
  const matchedFamilies = new Set(matched.map(({ family }) => family))
  const matchedNames = new Set(matched.map(({ name }) => name))
  if (matchedFamilies.size !== 1 || matchedNames.size !== 1) return undefined

  const family = matched[0]?.family
  return family && words.every((word) => matchedNames.has(word) || proteinFormTerms.has(word)) ? family : undefined
}

/** Returns whether two ingredient names are the same ingredient or clear substitutions within one animal-protein family. */
export function ingredientNamesEquivalent(first: string, second: string): boolean {
  const normalizedFirst = normalizeName(first)
  const normalizedSecond = normalizeName(second)
  if (!normalizedFirst || !normalizedSecond) return false
  if (normalizedFirst === normalizedSecond) return true
  const firstFamily = proteinFamily(normalizedFirst)
  return Boolean(firstFamily && firstFamily === proteinFamily(normalizedSecond))
}

/** Check that an unknown value contains the required recipe fields and non-empty ingredients. */
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

/** Validate persisted kitchen data and return its typed form, rejecting incomplete or malformed records. */
export function parseAppData(value: unknown): AppData {
  if (!value || typeof value !== 'object') throw new Error('Your saved kitchen data has an invalid format.')
  const candidate = value as Partial<AppData>
  /** Check the fields required for one persisted shopping-list item. */
  const validShoppingItem = (item: unknown): item is ShoppingItem => Boolean(item)
    && typeof item === 'object'
    && typeof (item as ShoppingItem).id === 'string'
    && typeof (item as ShoppingItem).name === 'string'
    && typeof (item as ShoppingItem).checked === 'boolean'
  if (!Array.isArray(candidate.recipes) || !candidate.recipes.every(validRecipe)
    || !Array.isArray(candidate.pantry) || !candidate.pantry.every((item) => typeof item === 'string' && Boolean(item.trim()))
    || !Array.isArray(candidate.shopping) || !candidate.shopping.every(validShoppingItem)) {
    throw new Error('Your saved kitchen data is incomplete or invalid.')
  }
  return { recipes: candidate.recipes, pantry: candidate.pantry, shopping: candidate.shopping }
}

/** Rank recipes by the proportion of ingredients available in the pantry, then by missing items and cook time. */
export function matchRecipes(recipes: Recipe[], pantry: string[]): RecipeMatch[] {
  return recipes.map((recipe) => {
    const available: Ingredient[] = []
    const missing: Ingredient[] = []
    recipe.ingredients.forEach((ingredient) => {
      if (pantry.some((pantryName) => ingredientNamesEquivalent(ingredient.name, pantryName))) available.push(ingredient)
      else missing.push(ingredient)
    })
    const percent = recipe.ingredients.length ? Math.round((available.length / recipe.ingredients.length) * 100) : 0
    return { recipe, available, missing, percent }
  }).sort((a, b) => b.percent - a.percent || a.missing.length - b.missing.length || a.recipe.time - b.recipe.time)
}

/** Create a personal recipe with normalized defaults and a newly generated ID. */
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

/** Generate a UUID-backed identifier with the requested record prefix. */
export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
