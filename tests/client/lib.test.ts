import { describe, expect, it, vi } from 'vitest'
import { createId, ingredientNamesEquivalent, makeRecipe, matchRecipes, normalizeName, parseAppData } from '../../src/lib'
import type { AppData, Ingredient, Recipe } from '../../src/types'

const recipe = (id: string, title: string, ingredients: Ingredient[], time = 30): Recipe => ({
  id, title, source: 'Tests', category: 'Dinner', time, servings: 2, image: '', description: '', ingredients,
})
const validData: AppData = { recipes: [recipe('r1', 'Meal', [{ name: 'Rice', amount: '1 cup' }])], pantry: ['rice'], shopping: [{ id: 's1', name: 'Salt', checked: false }] }

describe('ingredient normalization and substitutions', () => {
  it('retains common normalization and inflection behavior', () => {
    expect(normalizeName('  Red Onions ')).toBe('red onion')
    expect(normalizeName('Cilantro Leaves')).toBe('cilantro leaf')
    expect(normalizeName('CRÈME fraîche')).toBe('crème fraîche')
    expect(ingredientNamesEquivalent('Red Onions', 'red onion')).toBe(true)
    expect(ingredientNamesEquivalent('olive oil', 'extra virgin olive oil')).toBe(false)
  })

  it('matches common poultry forms and poultry species as interchangeable', () => {
    for (const pantryName of ['ground chicken', 'chicken tenders', 'chicken breast', 'turkey breast', 'duck']) expect(ingredientNamesEquivalent('chicken', pantryName), pantryName).toBe(true)
    expect(ingredientNamesEquivalent('poultry', 'ground chicken')).toBe(true)
    expect(ingredientNamesEquivalent('ground chicken', 'chicken tenders')).toBe(true)
  })

  it('matches cuts and species within other meat families and separates fish/shellfish', () => {
    expect(ingredientNamesEquivalent('beef', 'veal steak')).toBe(true)
    expect(ingredientNamesEquivalent('bison', 'ground beef')).toBe(true)
    expect(ingredientNamesEquivalent('pork', 'pork tenderloin')).toBe(true)
    expect(ingredientNamesEquivalent('lamb', 'mutton chops')).toBe(true)
    expect(ingredientNamesEquivalent('fish', 'salmon fillet')).toBe(true)
    expect(ingredientNamesEquivalent('cod', 'tuna')).toBe(true)
    expect(ingredientNamesEquivalent('shrimp', 'crab meat')).toBe(true)
    expect(ingredientNamesEquivalent('scallops', 'lobster')).toBe(true)
    expect(ingredientNamesEquivalent('salmon', 'shrimp')).toBe(false)
  })

  it('rejects cross-family, processed, compound, and unknown-descriptor substitutions', () => {
    for (const [first, second] of [
      ['chicken breast', 'beef strips'], ['ground turkey', 'ground pork'], ['chicken', 'tofu'], ['fish', 'tempeh'],
      ['chicken stock', 'chicken broth'], ['chicken', 'chicken stock'], ['fish', 'fish sauce'], ['beef', 'beef seasoning'],
      ['chicken sausage', 'turkey sausage'], ['chicken burger', 'turkey breast'], ['smoked salmon', 'cod'],
      ['chicken and rice', 'turkey'], ['chicken rice', 'turkey'], ['chicken delight', 'turkey'], ['chicken and turkey', 'ground chicken'], ['', ' '],
    ]) expect(ingredientNamesEquivalent(first, second), `${first} / ${second}`).toBe(false)
    expect(ingredientNamesEquivalent('chicken stock', 'chicken stock')).toBe(true)
  })
})

describe('app data validation', () => {
  it('accepts valid app data and returns a validated shape', () => expect(parseAppData(validData)).toEqual(validData))
  it.each([null, [], 'data', {}, { ...validData, recipes: [{}] }, { ...validData, recipes: [{ ...validData.recipes[0], ingredients: [] }] }, { ...validData, pantry: [' '] }, { ...validData, shopping: [{ id: 'x', name: 'x', checked: 'no' }] }])('rejects invalid app data: %j', (input) => {
    expect(() => parseAppData(input)).toThrow(/invalid|incomplete/i)
  })
})

describe('recipe matching and construction', () => {
  it('reports exact availability, missing ingredients, and rounded percentages for protein alternatives', () => {
    const recipes = [
      recipe('poultry', 'Poultry dinner', [{ name: 'Ground chicken', amount: '1 lb' }, { name: 'beef strips', amount: '8 oz' }, { name: 'chicken stock', amount: '1 cup' }]),
      recipe('fish', 'Fish dinner', [{ name: 'cod fillet', amount: '2 fillets' }, { name: 'shrimp', amount: '6 oz' }]),
      recipe('plant', 'Plant dinner', [{ name: 'tofu', amount: '1 block' }, { name: 'olive oil', amount: '1 tbsp' }]),
    ]
    const results = matchRecipes(recipes, ['chicken tenders', 'ground bison', 'salmon', 'olive oil'])
    const byId = new Map(results.map((result) => [result.recipe.id, result]))
    expect(byId.get('poultry')).toMatchObject({ percent: 67, available: [recipes[0]!.ingredients[0], recipes[0]!.ingredients[1]], missing: [recipes[0]!.ingredients[2]] })
    expect(byId.get('fish')).toMatchObject({ percent: 50, available: [recipes[1]!.ingredients[0]], missing: [recipes[1]!.ingredients[1]] })
    expect(byId.get('plant')).toMatchObject({ percent: 50, available: [recipes[2]!.ingredients[1]], missing: [recipes[2]!.ingredients[0]] })
  })
  it('preserves recipe ingredient labels and amounts for equivalent pantry matches', () => {
    const original = recipe('poultry-only', 'Chicken dinner', [{ name: 'Ground chicken', amount: '1 lb' }])
    expect(matchRecipes([original], ['Chicken tenders'])[0]).toMatchObject({ available: original.ingredients, missing: [], percent: 100 })
  })
  it('sorts by match percentage, then missing count, then cooking time', () => {
    const rows = [recipe('slow', 'Slow', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 60), recipe('fast', 'Fast', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 10), recipe('more-missing', 'More missing', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }, { name: 'salt', amount: '' }], 1)]
    expect(matchRecipes(rows, ['rice']).map(({ recipe: row }) => row.id)).toEqual(['fast', 'slow', 'more-missing'])
    expect(matchRecipes([recipe('tieA', 'A', [{ name: 'rice', amount: '' }, { name: 'salt', amount: '' }], 10), recipe('tieB', 'B', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 20)], ['rice']).map(({ recipe: row }) => row.id)).toEqual(['tieA', 'tieB'])
  })
  it('creates recipes with defaults, trimmed values, and unique prefixed IDs', () => {
    const uuid = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    const result = makeRecipe(' Dinner ', ' ', ' ', 20, 3, [{ name: 'rice', amount: '1 cup' }])
    expect(result).toMatchObject({ id: 'recipe-00000000-0000-4000-8000-000000000001', title: 'Dinner', source: 'My recipes', category: 'Dinner', time: 20, servings: 3, description: expect.any(String), ingredients: [{ name: 'rice', amount: '1 cup' }] })
    expect(result.image).toContain('images.unsplash.com')
    expect(createId('shop')).toBe('shop-00000000-0000-4000-8000-000000000002')
    uuid.mockRestore()
  })
})
