export type Ingredient = {
  name: string
  amount: string
}

export type Recipe = {
  id: string
  title: string
  source: string
  category: string
  time: number
  servings: number
  image: string
  description: string
  ingredients: Ingredient[]
}

export type UserRole = 'member' | 'admin'

export type ShoppingItem = {
  id: string
  name: string
  checked: boolean
}

export type AppData = {
  recipes: Recipe[]
  pantry: string[]
  shopping: ShoppingItem[]
}

export type RecipeMatch = {
  recipe: Recipe
  available: Ingredient[]
  missing: Ingredient[]
  percent: number
}
