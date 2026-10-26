import { describe, expect, it } from 'vitest'
import { demoRecipes, initialAppData } from '../../src/data'

describe('built-in data fixtures', () => {
  it('provides complete demo recipes with nonempty ingredient details and unique IDs', () => {
    expect(demoRecipes.length).toBeGreaterThan(0)
    expect(new Set(demoRecipes.map(({ id }) => id)).size).toBe(demoRecipes.length)
    for (const recipe of demoRecipes) {
      expect(recipe.id).toBeTruthy()
      expect(recipe.title).toBeTruthy()
      expect(recipe.ingredients.length).toBeGreaterThan(0)
      expect(recipe.ingredients.every((ingredient) => ingredient.name.trim() && ingredient.amount.length > 0)).toBe(true)
      expect(recipe.instructions.trim()).toBeTruthy()
    }
  })

  it('starts new profiles with an empty private recipe list and valid pantry/shopping defaults', () => {
    expect(initialAppData.recipes).toEqual([])
    expect(initialAppData.pantry.length).toBeGreaterThan(0)
    expect(initialAppData.shopping.length).toBeGreaterThan(0)
    expect(initialAppData.shopping.every((item) => item.id && item.name && typeof item.checked === 'boolean')).toBe(true)
  })
})
