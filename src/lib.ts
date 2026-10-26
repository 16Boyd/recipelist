import type { AppData, Ingredient, PantryItem, Recipe, RecipeMatch, ShoppingItem } from './types'

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

/** Return an animal-protein family only when normalized words name one unambiguous protein and no product terms. */
function proteinFamilyFromNormalizedName(normalizedName: string): string | undefined {
  const words = normalizedName.split(' ')
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
  const firstFamily = proteinFamilyFromNormalizedName(normalizedFirst)
  return Boolean(firstFamily && firstFamily === proteinFamilyFromNormalizedName(normalizedSecond))
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
    && (recipe.instructions === undefined || (typeof recipe.instructions === 'string' && Array.from(recipe.instructions).length <= 12000))
    && Array.isArray(recipe.ingredients)
    && recipe.ingredients.length > 0
    && recipe.ingredients.every((item) => item
      && typeof item.name === 'string'
      && Boolean(item.name.trim())
      && typeof item.amount === 'string')
}

/**
 * Validate persisted kitchen data, defaulting missing recipe instructions to an
 * empty string and converting legacy pantry names to entries with empty amounts.
 *
 * @throws {Error} If the saved data has an invalid shape or fails field validation.
 */
export function parseAppData(value: unknown): AppData {
  if (!value || typeof value !== 'object') throw new Error('Your saved kitchen data has an invalid format.')
  const candidate = value as Partial<AppData>
  const pantryValues: unknown = (value as { pantry?: unknown }).pantry
  /** Check the fields required for one persisted shopping-list item. */
  const validShoppingItem = (item: unknown): item is ShoppingItem => Boolean(item)
    && typeof item === 'object'
    && typeof (item as ShoppingItem).id === 'string'
    && typeof (item as ShoppingItem).name === 'string'
    && typeof (item as ShoppingItem).checked === 'boolean'
  if (!Array.isArray(candidate.recipes) || !candidate.recipes.every(validRecipe)
    || !Array.isArray(pantryValues) || !pantryValues.every((item: unknown) => typeof item === 'string' ? Boolean(item.trim()) : Boolean(item && typeof item === 'object' && typeof (item as PantryItem).name === 'string' && (item as PantryItem).name.trim() && typeof (item as PantryItem).amount === 'string'))
    || !Array.isArray(candidate.shopping) || !candidate.shopping.every(validShoppingItem)) {
    throw new Error('Your saved kitchen data is incomplete or invalid.')
  }
  return {
    recipes: candidate.recipes.map((recipe) => ({ ...recipe, instructions: recipe.instructions ?? '' })),
    pantry: pantryValues.map((item: string | PantryItem) => typeof item === 'string' ? { name: item, amount: '' } : item),
    shopping: candidate.shopping,
  }
}

const vulgarFractions: Readonly<Record<string, string>> = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
  '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
}
const quantityPattern = /^((?:\d+\/\d+|\d+(?:\.\d+)?))(?:\s+((?:\d+\/\d+|\d+(?:\.\d+)?)))?\s*([\p{L}]+)?$/u

/**
 * Parse supported nonnegative numbers and fractions into comparable quantities.
 * Volumes use milliliters, weights use grams, and count units remain distinct.
 * Unitless amounts use each; unknown units retain a normalized unit name.
 *
 * @returns The quantity and comparison dimension, or undefined for unparseable
 * or nonfinite amounts.
 */
function parseQuantity(value: string): { value: number; dimension: string } | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅐⅑⅒]/g, (fraction) => ` ${vulgarFractions[fraction]}`).trim()
  const match = normalized.match(quantityPattern)
  if (!match) return undefined
  /** Parse a nonnegative number or fraction, returning zero for absent input and undefined for invalid values. */
  const parseNumber = (raw?: string): number | undefined => {
    if (!raw) return 0
    if (!raw.includes('/')) {
      const parsed = Number(raw)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    const [numeratorText, denominatorText] = raw.split('/')
    const numerator = Number(numeratorText)
    const denominator = Number(denominatorText)
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0 || numerator < 0 || denominator < 0) return undefined
    const parsed = numerator / denominator
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const whole = parseNumber(match[1])
  const fraction = parseNumber(match[2])
  if (whole === undefined || fraction === undefined) return undefined
  const count = whole + fraction
  if (!Number.isFinite(count)) return undefined
  const rawUnit = match[3] ?? 'each'
  const unit = rawUnit === 'leaves'
    ? 'leaf'
    : rawUnit.replace(/(ches|shes|sses|xes|zes|oes)$/, (plural) => plural.slice(0, -2)).replace(/s$/, '')
  const units: Record<string, [string, number]> = {
    tsp: ['volume', 4.92892], teaspoon: ['volume', 4.92892], tbsp: ['volume', 14.7868], tablespoon: ['volume', 14.7868],
    cup: ['volume', 236.588], ml: ['volume', 1], milliliter: ['volume', 1], l: ['volume', 1000], liter: ['volume', 1000],
    g: ['weight', 1], gram: ['weight', 1], kg: ['weight', 1000], kilogram: ['weight', 1000], oz: ['weight', 28.3495], ounce: ['weight', 28.3495], lb: ['weight', 453.592], pound: ['weight', 453.592],
    each: ['count:each', 1], can: ['count:can', 1], clove: ['count:clove', 1], piece: ['count:piece', 1], package: ['count:package', 1],
    fillet: ['count:fillet', 1], breast: ['count:breast', 1], thigh: ['count:thigh', 1], wing: ['count:wing', 1], drumstick: ['count:drumstick', 1],
    slice: ['count:slice', 1], strip: ['count:strip', 1], stalk: ['count:stalk', 1], sprig: ['count:sprig', 1], head: ['count:head', 1],
    bunch: ['count:bunch', 1], ear: ['count:ear', 1], bulb: ['count:bulb', 1], sheet: ['count:sheet', 1], leaf: ['count:leaf', 1],
  }
  const conversion = units[unit]
  if (!conversion) return { value: count, dimension: `unknown:${unit}` }
  const converted = count * conversion[1]
  return Number.isFinite(converted) ? { value: converted, dimension: conversion[0] } : undefined
}

/**
 * Return pantry matches ranked by rounded coverage percentage, then fewer missing
 * ingredients, then shorter cooking time. Recipes without ingredients score zero.
 * Pool comparable quantities for equivalent names and consume covered requirements
 * in ingredient order, allowing a relative tolerance of 1e-5 for conversion rounding.
 * Use name presence for unparseable requirements or blank legacy pantry amounts
 * when no comparable stock exists; malformed nonblank amounts do not satisfy a
 * measurable requirement.
 * Each recipe is evaluated independently without changing the pantry or recipes.
 */
export function matchRecipes(recipes: Recipe[], pantry: PantryItem[]): RecipeMatch[] {
  const pantryRows = pantry.map((item, index) => {
    const normalizedName = normalizeName(item.name)
    return {
      index,
      normalizedName,
      family: proteinFamilyFromNormalizedName(normalizedName),
      quantity: parseQuantity(item.amount),
      hasBlankAmount: !item.amount.trim(),
    }
  })
  const pantryByName = new Map<string, typeof pantryRows[number][]>()
  const pantryByFamily = new Map<string, typeof pantryRows[number][]>()
  for (const row of pantryRows) {
    const namedRows = pantryByName.get(row.normalizedName) ?? []
    namedRows.push(row)
    pantryByName.set(row.normalizedName, namedRows)
    if (row.family) {
      const familyRows = pantryByFamily.get(row.family) ?? []
      familyRows.push(row)
      pantryByFamily.set(row.family, familyRows)
    }
  }

  return recipes.map((recipe) => {
    const available: Ingredient[] = []
    const missing: Ingredient[] = []
    const remainingAmounts = new Map<number, number>()
    recipe.ingredients.forEach((ingredient) => {
      const required = parseQuantity(ingredient.amount)
      const normalizedName = normalizeName(ingredient.name)
      const family = proteinFamilyFromNormalizedName(normalizedName)
      const equivalent = family
        ? pantryByFamily.get(family) ?? []
        : pantryByName.get(normalizedName) ?? []
      if (!equivalent.length) {
        missing.push(ingredient)
        return
      }
      if (!required) {
        available.push(ingredient)
        return
      }

      const comparable = equivalent.filter(({ quantity }) => quantity?.dimension === required.dimension)
      const total = comparable.reduce((sum, { index, quantity }) => sum + (remainingAmounts.get(index) ?? quantity?.value ?? 0), 0)
      const tolerance = Math.max(total, required.value) * 1e-5
      if (total + tolerance >= required.value) {
        let needed = required.value
        for (const { index, quantity } of comparable) {
          const remaining = remainingAmounts.get(index) ?? quantity?.value ?? 0
          const consumed = Math.min(remaining, needed)
          remainingAmounts.set(index, Math.max(0, remaining - consumed))
          needed -= consumed
          if (needed <= 0) break
        }
        available.push(ingredient)
      } else if (!comparable.length && equivalent.some(({ hasBlankAmount }) => hasBlankAmount)) {
        // Preserve name-presence matching for legacy pantry entries without tracked amounts.
        available.push(ingredient)
      } else {
        missing.push(ingredient)
      }
    })
    const percent = recipe.ingredients.length ? Math.round((available.length / recipe.ingredients.length) * 100) : 0
    return { recipe, available, missing, percent }
  }).sort((a, b) => b.percent - a.percent || a.missing.length - b.missing.length || a.recipe.time - b.recipe.time)
}

/** Create a personal recipe with normalized defaults and a newly generated ID. */
export function makeRecipe(title: string, source: string, category: string, time: number, servings: number, ingredients: Ingredient[], instructions = ''): Recipe {
  return {
    id: `recipe-${crypto.randomUUID()}`,
    title: title.trim(),
    source: source.trim() || 'My recipes',
    category: category.trim() || 'Dinner',
    time,
    servings,
    image: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=1100&q=85',
    description: 'A recipe saved to your personal library.',
    instructions,
    ingredients,
  }
}

/** Generate a UUID-backed identifier with the requested record prefix. */
export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
