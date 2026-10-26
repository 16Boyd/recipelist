import { describe, expect, it } from 'vitest'
import { validateAppData, validateRecipe, validateRecipeInstructions, type RecipeInput } from '../../server/validation.js'

const recipe: RecipeInput = {
  id: 'recipe-1', title: 'Chicken soup', source: 'Kitchen', category: 'Dinner', time: 30, servings: 4,
  image: '', description: '', instructions: 'Cook the rice.', ingredients: [{ name: 'Chicken breast', amount: '1 lb' }],
}

describe('server data validation', () => {
  it('validates nonblank recipe instruction text and its length limit', () => {
    const twelveThousandEmoji = '😀'.repeat(12000)
    expect(validateRecipeInstructions('Cook the rice.')).toBe(true)
    expect(validateRecipeInstructions(' '.repeat(4))).toBe(false)
    expect(validateRecipeInstructions('x'.repeat(12000))).toBe(true)
    expect(validateRecipeInstructions('x'.repeat(12001))).toBe(false)
    expect(validateRecipeInstructions(twelveThousandEmoji)).toBe(true)
    expect(validateRecipeInstructions(`${twelveThousandEmoji}😀`)).toBe(false)
    expect(validateRecipeInstructions(null)).toBe(false)
  })

  it('accepts a valid recipe and validates the nested ingredient shape', () => {
    expect(validateRecipe(recipe)).toBe(true)
    expect(validateRecipe({ ...recipe, ingredients: [{ name: 'Chicken', amount: '' }] })).toBe(true)
    expect(validateRecipe({ ...recipe, ingredients: [{ name: ' ', amount: '1 lb' }] })).toBe(false)
    expect(validateRecipe({ ...recipe, ingredients: [null] })).toBe(false)
  })

  it('enforces recipe boundary values and text limits', () => {
    expect(validateRecipe({ ...recipe, time: 1, servings: 1, ingredients: [] })).toBe(true)
    expect(validateRecipe({ ...recipe, time: 1440, servings: 100 })).toBe(true)
    expect(validateRecipe({ ...recipe, time: 0 })).toBe(false)
    expect(validateRecipe({ ...recipe, time: 1441 })).toBe(false)
    expect(validateRecipe({ ...recipe, servings: 0 })).toBe(false)
    expect(validateRecipe({ ...recipe, servings: 101 })).toBe(false)
    expect(validateRecipe({ ...recipe, id: '' })).toBe(false)
    expect(validateRecipe({ ...recipe, title: ' '.repeat(2) })).toBe(false)
    expect(validateRecipe({ ...recipe, title: 'x'.repeat(161) })).toBe(false)
    expect(validateRecipe({ ...recipe, instructions: '' })).toBe(false)
    expect(validateRecipe({ ...recipe, instructions: '  ' })).toBe(false)
    expect(validateRecipe({ ...recipe, instructions: 'x'.repeat(12001) })).toBe(false)
    expect(validateRecipe({ ...recipe, instructions: 'x'.repeat(12000) })).toBe(true)
    const twelveThousandEmoji = '😀'.repeat(12000)
    expect(validateRecipe({ ...recipe, instructions: twelveThousandEmoji })).toBe(true)
    expect(validateRecipe({ ...recipe, instructions: `${twelveThousandEmoji}😀` })).toBe(false)
    expect(validateRecipe({ ...recipe, ingredients: Array.from({ length: 201 }, () => ({ name: 'x', amount: '1' })) })).toBe(false)
    expect(validateRecipe({ ...recipe, ingredients: Array.from({ length: 200 }, () => ({ name: 'x', amount: '1' })) })).toBe(true)
  })

  it('accepts valid app data and rejects malformed collections and nested values', () => {
    const appData = { recipes: [recipe], pantry: ['salt'], shopping: [{ id: 's1', name: 'pepper', checked: false }] }
    expect(validateAppData(appData)).toBe(true)
    expect(validateAppData({ ...appData, recipes: [{ ...recipe, instructions: '' }] })).toBe(true)
    const { instructions: _legacyInstructions, ...legacyRecipe } = recipe
    expect(validateAppData({ ...appData, recipes: [legacyRecipe] })).toBe(true)
    expect(validateAppData({ ...appData, recipes: [{ ...recipe, instructions: 123 }] })).toBe(false)
    expect(validateAppData({ ...appData, recipes: [{ ...recipe, instructions: 'x'.repeat(12001) }] })).toBe(false)
    const twelveThousandEmoji = '😀'.repeat(12000)
    expect(validateAppData({ ...appData, recipes: [{ ...recipe, instructions: twelveThousandEmoji }] })).toBe(true)
    expect(validateAppData({ ...appData, recipes: [{ ...recipe, instructions: `${twelveThousandEmoji}😀` }] })).toBe(false)
    expect(validateAppData({ ...appData, recipes: [null] })).toBe(false)
    expect(validateAppData({ ...appData, pantry: ['  '] })).toBe(false)
    expect(validateAppData({ ...appData, pantry: [{ name: 'salt', amount: '2 tsp' }] })).toBe(true)
    expect(validateAppData({ ...appData, pantry: [{ name: ' ', amount: '2 tsp' }] })).toBe(false)
    expect(validateAppData({ ...appData, shopping: [{ id: 's1', name: 'pepper', checked: 'false' }] })).toBe(false)
    expect(validateAppData({ recipes: [], pantry: [], shopping: [] })).toBe(true)
    expect(validateAppData(null)).toBe(false)
  })

  it('enforces collection size and item text boundaries', () => {
    expect(validateAppData({ recipes: [], pantry: ['x'.repeat(160)], shopping: [] })).toBe(true)
    expect(validateAppData({ recipes: [], pantry: ['x'.repeat(161)], shopping: [] })).toBe(false)
    expect(validateAppData({ recipes: [], pantry: Array(2001).fill('x'), shopping: [] })).toBe(false)
    expect(validateAppData({ recipes: [], pantry: [], shopping: Array.from({ length: 2000 }, (_, i) => ({ id: String(i), name: 'x', checked: true })) })).toBe(true)
    expect(validateAppData({ recipes: [], pantry: [], shopping: Array(2001).fill({ id: 'x', name: 'x', checked: true }) })).toBe(false)
  })
})
