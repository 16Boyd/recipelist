export type RecipeInput = {
  id: string
  title: string
  source: string
  category: string
  time: number
  servings: number
  image: string
  description: string
  ingredients: { name: string; amount: string }[]
}

export type AppDataInput = {
  recipes: RecipeInput[]
  pantry: string[]
  shopping: { id: string; name: string; checked: boolean }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length <= max
}

export function validateRecipe(value: unknown): value is RecipeInput {
  if (!isRecord(value)) return false
  return isText(value.id, 120) && value.id.length > 0
    && isText(value.title, 160) && value.title.trim().length > 0
    && isText(value.source, 100) && value.source.trim().length > 0
    && isText(value.category, 80) && value.category.trim().length > 0
    && Number.isInteger(value.time) && Number(value.time) >= 1 && Number(value.time) <= 1440
    && Number.isInteger(value.servings) && Number(value.servings) >= 1 && Number(value.servings) <= 100
    && isText(value.image, 2048)
    && isText(value.description, 4000)
    && Array.isArray(value.ingredients) && value.ingredients.length <= 200
    && value.ingredients.every((ingredient) => isRecord(ingredient)
      && isText(ingredient.name, 160) && ingredient.name.trim().length > 0
      && isText(ingredient.amount, 120))
}

export function validateAppData(value: unknown): value is AppDataInput {
  if (!isRecord(value) || !Array.isArray(value.recipes) || !Array.isArray(value.pantry) || !Array.isArray(value.shopping)) return false
  return value.recipes.length <= 1000 && value.recipes.every(validateRecipe)
    && value.pantry.length <= 2000 && value.pantry.every((item) => isText(item, 160) && item.trim().length > 0)
    && value.shopping.length <= 2000 && value.shopping.every((item) => isRecord(item)
      && isText(item.id, 120) && item.id.length > 0
      && isText(item.name, 160) && item.name.trim().length > 0
      && typeof item.checked === 'boolean')
}
