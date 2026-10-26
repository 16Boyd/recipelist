export type RecipeInput = {
  id: string
  title: string
  source: string
  category: string
  time: number
  servings: number
  image: string
  description: string
  instructions: string
  ingredients: { name: string; amount: string }[]
}

export type AppDataInput = {
  recipes: (RecipeInput | (Omit<RecipeInput, 'instructions'> & { instructions?: string }))[]
  pantry: (string | { name: string; amount: string })[]
  shopping: { id: string; name: string; checked: boolean }[]
}

/** Narrow an unknown JSON value to a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Check that a value is a string within the configured length limit. */
function isText(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length <= max
}

/** Match PostgreSQL text length by counting Unicode code points instead of UTF-16 units. */
function withinCodePointLimit(value: string, max: number): boolean {
  return Array.from(value).length <= max
}

/** Accept nonblank instructions of at most 12,000 Unicode code points, including surrounding whitespace. */
export function validateRecipeInstructions(value: unknown): value is string {
  return typeof value === 'string' && withinCodePointLimit(value, 12000) && value.trim().length > 0
}

/**
 * Validate untrusted recipe JSON against field, length, range, and ingredient limits.
 * Instructions must be nonblank by default; passing false for requireInstructions
 * allows missing or blank legacy instructions, retaining the 12,000 code point limit.
 */
export function validateRecipe(value: unknown): value is RecipeInput
export function validateRecipe(value: unknown, requireInstructions: false): value is Omit<RecipeInput, 'instructions'> & { instructions?: string }
/** Validate recipe fields with required or legacy-optional instructions. */
export function validateRecipe(value: unknown, requireInstructions = true): value is RecipeInput {
  if (!isRecord(value)) return false
  return isText(value.id, 120) && value.id.length > 0
    && isText(value.title, 160) && value.title.trim().length > 0
    && isText(value.source, 100) && value.source.trim().length > 0
    && isText(value.category, 80) && value.category.trim().length > 0
    && Number.isInteger(value.time) && Number(value.time) >= 1 && Number(value.time) <= 1440
    && Number.isInteger(value.servings) && Number(value.servings) >= 1 && Number(value.servings) <= 100
    && isText(value.image, 2048)
    && isText(value.description, 4000)
    && (requireInstructions
      ? validateRecipeInstructions(value.instructions)
      : value.instructions === undefined || (typeof value.instructions === 'string' && withinCodePointLimit(value.instructions, 12000)))
    && Array.isArray(value.ingredients) && value.ingredients.length <= 200
    && value.ingredients.every((ingredient) => isRecord(ingredient)
      && isText(ingredient.name, 160) && ingredient.name.trim().length > 0
      && isText(ingredient.amount, 120))
}

/**
 * Validate untrusted profile JSON and enforce limits on recipes, pantry, and shopping entries.
 * Accept legacy recipes with missing or blank instructions and pantry entries as
 * either names or objects with amounts; validation does not normalize these values.
 */
export function validateAppData(value: unknown): value is AppDataInput {
  if (!isRecord(value) || !Array.isArray(value.recipes) || !Array.isArray(value.pantry) || !Array.isArray(value.shopping)) return false
  return value.recipes.length <= 1000 && value.recipes.every((recipe) => validateRecipe(recipe, false))
    && value.pantry.length <= 2000 && value.pantry.every((item) => isText(item, 160) ? item.trim().length > 0 : isRecord(item) && isText(item.name, 160) && item.name.trim().length > 0 && isText(item.amount, 120))
    && value.shopping.length <= 2000 && value.shopping.every((item) => isRecord(item)
      && isText(item.id, 120) && item.id.length > 0
      && isText(item.name, 160) && item.name.trim().length > 0
      && typeof item.checked === 'boolean')
}
