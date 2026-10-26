import { describe, expect, it, vi } from 'vitest'
import { createId, createRecipeMatcher, ingredientNamesEquivalent, makeRecipe, matchRecipes, normalizeName, parseAppData } from '../../src/lib'
import type { AppData, Ingredient, Recipe } from '../../src/types'

const recipe = (id: string, title: string, ingredients: Ingredient[], time = 30): Recipe => ({
  id, title, source: 'Tests', category: 'Dinner', time, servings: 2, image: '', description: '', instructions: '', ingredients,
})
const validData: AppData = { recipes: [recipe('r1', 'Meal', [{ name: 'Rice', amount: '1 cup' }])], pantry: [{ name: 'rice', amount: '' }], shopping: [{ id: 's1', name: 'Salt', checked: false }] }

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
  it('counts persisted recipe instruction limits in Unicode code points', () => {
    const twelveThousandEmoji = '😀'.repeat(12000)
    const withinLimit = { ...validData, recipes: [{ ...validData.recipes[0]!, instructions: twelveThousandEmoji }] }
    const beyondLimit = { ...validData, recipes: [{ ...validData.recipes[0]!, instructions: `${twelveThousandEmoji}😀` }] }
    expect(parseAppData(withinLimit).recipes[0]?.instructions).toBe(twelveThousandEmoji)
    expect(() => parseAppData(beyondLimit)).toThrow(/invalid|incomplete/i)
  })
  it('normalizes legacy pantry names and preserves tracked amounts', () => {
    const normalized = parseAppData({ ...validData, pantry: ['rice', { name: 'salt', amount: '2 tsp' }] })
    expect(normalized.pantry).toEqual([{ name: 'rice', amount: '' }, { name: 'salt', amount: '2 tsp' }])
  })
  it.each([null, [], 'data', {}, { ...validData, recipes: [{}] }, { ...validData, recipes: [{ ...validData.recipes[0], ingredients: [] }] }, { ...validData, pantry: [{ name: ' ', amount: '' }] }, { ...validData, shopping: [{ id: 'x', name: 'x', checked: 'no' }] }])('rejects invalid app data: %j', (input) => {
    expect(() => parseAppData(input)).toThrow(/invalid|incomplete/i)
  })
})

describe('recipe matching and construction', () => {
  it('reuses prepared recipe metadata and matches the compatibility wrapper as pantry stock changes', () => {
    const recipes = [recipe('prepared-rice', 'Rice', [{ name: 'rice', amount: '2 cups' }, { name: 'rice', amount: '1 cup' }])]
    const matcher = createRecipeMatcher(recipes)
    const enoughPantry = [{ name: 'rice', amount: '2 cups' }, { name: 'rice', amount: '1 cup' }]
    const shortPantry = [{ name: 'rice', amount: '2 cups' }]

    expect(matcher(enoughPantry)).toEqual(matchRecipes(recipes, enoughPantry))
    expect(matcher(enoughPantry)[0]?.available).toEqual(recipes[0]?.ingredients)
    expect(matcher(shortPantry)).toEqual(matchRecipes(recipes, shortPantry))
    expect(matcher(shortPantry)[0]?.available).toEqual([recipes[0]?.ingredients[0]])
  })

  it('reports exact availability, missing ingredients, and rounded percentages for protein alternatives', () => {
    const recipes = [
      recipe('poultry', 'Poultry dinner', [{ name: 'Ground chicken', amount: '1 lb' }, { name: 'beef strips', amount: '8 oz' }, { name: 'chicken stock', amount: '1 cup' }]),
      recipe('fish', 'Fish dinner', [{ name: 'cod fillet', amount: '2 fillets' }, { name: 'shrimp', amount: '6 oz' }]),
      recipe('plant', 'Plant dinner', [{ name: 'tofu', amount: '1 block' }, { name: 'olive oil', amount: '1 tbsp' }]),
    ]
    const results = matchRecipes(recipes, [{ name: 'chicken tenders', amount: '' }, { name: 'ground bison', amount: '' }, { name: 'salmon', amount: '' }, { name: 'olive oil', amount: '' }])
    const byId = new Map(results.map((result) => [result.recipe.id, result]))
    expect(byId.get('poultry')).toMatchObject({ percent: 67, available: [recipes[0]!.ingredients[0], recipes[0]!.ingredients[1]], missing: [recipes[0]!.ingredients[2]] })
    expect(byId.get('fish')).toMatchObject({ percent: 50, available: [recipes[1]!.ingredients[0]], missing: [recipes[1]!.ingredients[1]] })
    expect(byId.get('plant')).toMatchObject({ percent: 50, available: [recipes[2]!.ingredients[1]], missing: [recipes[2]!.ingredients[0]] })
  })
  it('preserves recipe ingredient labels and amounts for equivalent pantry matches', () => {
    const original = recipe('poultry-only', 'Chicken dinner', [{ name: 'Ground chicken', amount: '1 lb' }])
    expect(matchRecipes([original], [{ name: 'Chicken tenders', amount: '' }])[0]).toMatchObject({ available: original.ingredients, missing: [], percent: 100 })
  })
  it('uses comparable pantry quantities and preserves name matching for blank legacy amounts', () => {
    const row = recipe('qty', 'Quantity', [
      { name: 'rice', amount: '2 cups' }, { name: 'oil', amount: '3 tbsp' },
      { name: 'salt', amount: '1/2 tsp' }, { name: 'cans', amount: '2 cans' },
    ])
    const result = matchRecipes([row], [
      { name: 'rice', amount: '1 cup' }, { name: 'oil', amount: '45 ml' },
      { name: 'salt', amount: '½ tsp' }, { name: 'cans', amount: '1 can' },
    ])[0]!
    expect(result.available.map((item) => item.name)).toEqual(['oil', 'salt'])
    expect(result.missing.map((item) => item.name)).toEqual(['rice', 'cans'])
    expect(matchRecipes([row], [{ name: 'rice', amount: '' }])[0]?.available).toContain(row.ingredients[0])
    expect(matchRecipes([recipe('unknown-unit', 'Unknown unit', [{ name: 'rice', amount: '2 scoops' }])], [{ name: 'rice', amount: '1 cup' }])[0]?.missing).toHaveLength(1)
  })
  it('compares unknown units by normalized unit name and quantity', () => {
    const row = recipe('unknown-unit-quantity', 'Unknown unit quantity', [{ name: 'tofu', amount: '2 blocks' }])
    expect(matchRecipes([row], [{ name: 'tofu', amount: '2 block' }])[0]?.available).toEqual(row.ingredients)
    expect(matchRecipes([row], [{ name: 'tofu', amount: '1 block' }])[0]?.missing).toEqual(row.ingredients)
  })
  it('normalizes common plural unit abbreviations for volume and weight comparisons', () => {
    const pounds = recipe('plural-pounds', 'Pounds', [{ name: 'rice', amount: '2 lb' }])
    expect(matchRecipes([pounds], [{ name: 'rice', amount: '2 lbs' }])[0]?.available).toEqual(pounds.ingredients)

    const kilograms = recipe('plural-kilograms', 'Kilograms', [{ name: 'rice', amount: '1 kg' }])
    expect(matchRecipes([kilograms], [{ name: 'rice', amount: '1 kgs' }])[0]?.available).toEqual(kilograms.ingredients)

    const milliliters = recipe('plural-milliliters', 'Milliliters', [{ name: 'water', amount: '250 ml' }])
    expect(matchRecipes([milliliters], [{ name: 'water', amount: '250 mls' }])[0]?.available).toEqual(milliliters.ingredients)
  })
  it('pools equivalent pantry entries and consumes pooled stock across repeated requirements', () => {
    const pooledSubstitutions = recipe('pooled-substitutions', 'Poultry', [{ name: 'chicken', amount: '2 lb' }])
    expect(matchRecipes([pooledSubstitutions], [
      { name: 'chicken', amount: '1 lb' }, { name: 'turkey', amount: '1 lb' },
    ])[0]?.available).toEqual(pooledSubstitutions.ingredients)

    const repeated = recipe('pooled-repeated', 'Rice', [{ name: 'rice', amount: '2 cups' }, { name: 'rice', amount: '2 cups' }])
    expect(matchRecipes([repeated], [{ name: 'rice', amount: '3 cups' }, { name: 'rice', amount: '1 cup' }])[0]?.available).toEqual(repeated.ingredients)
    expect(matchRecipes([repeated], [{ name: 'rice', amount: '3 cups' }])[0]?.missing).toEqual([repeated.ingredients[1]])

    const dimensionMismatch = recipe('dimension-mismatch', 'Rice', [{ name: 'rice', amount: '2 cups' }])
    expect(matchRecipes([dimensionMismatch], [{ name: 'rice', amount: '2 oz' }])[0]?.missing).toEqual(dimensionMismatch.ingredients)
  })
  it('tolerates conversion rounding without treating short comparable stock as enough', () => {
    const tablespoon = recipe('rounding-tbsp', 'Oil', [{ name: 'oil', amount: '1 tbsp' }])
    expect(matchRecipes([tablespoon], [{ name: 'oil', amount: '3 tsp' }])[0]?.available).toEqual(tablespoon.ingredients)

    const cup = recipe('rounding-cup', 'Rice', [{ name: 'rice', amount: '1 cup' }])
    expect(matchRecipes([cup], [
      { name: 'rice', amount: '1/3 cup' }, { name: 'rice', amount: '1/3 cup' }, { name: 'rice', amount: '1/3 cup' },
    ])[0]?.available).toEqual(cup.ingredients)
    expect(matchRecipes([cup], [{ name: 'rice', amount: '0.99 cup' }])[0]?.missing).toEqual(cup.ingredients)
  })
  it('uses name-presence fallback only when there are no comparable pantry quantities', () => {
    const tofu = recipe('tofu-mixed-units', 'Tofu', [{ name: 'tofu', amount: '2 blocks' }])
    expect(matchRecipes([tofu], [
      { name: 'tofu', amount: '1 block' }, { name: 'tofu', amount: '1 cup' },
    ])[0]?.missing).toEqual(tofu.ingredients)
  })
  it('pools quantities only across names equivalent to the current ingredient', () => {
    const row = recipe('separate-ingredients', 'Rice and oil', [
      { name: 'rice', amount: '2 cups' }, { name: 'oil', amount: '2 cups' },
    ])
    expect(matchRecipes([row], [
      { name: 'rice', amount: '2 cups' }, { name: 'oil', amount: '2 cups' },
    ])[0]?.available).toEqual(row.ingredients)
  })
  it('does not reuse the same pantry quantity for repeated recipe ingredients', () => {
    const row = recipe('repeat-qty', 'Repeated rice', [{ name: 'rice', amount: '1 cup' }, { name: 'rice', amount: '1 cup' }])
    const result = matchRecipes([row], [{ name: 'rice', amount: '1 cup' }])[0]!
    expect(result.available).toEqual([row.ingredients[0]])
    expect(result.missing).toEqual([row.ingredients[1]])
  })
  it('compares count units with singular and plural forms while keeping count dimensions distinct', () => {
    const filletRecipe = recipe('fillets', 'Fish', [{ name: 'salmon', amount: '2 fillets' }])
    expect(matchRecipes([filletRecipe], [{ name: 'salmon', amount: '1 fillet' }])[0]?.missing).toEqual(filletRecipe.ingredients)
    expect(matchRecipes([filletRecipe], [{ name: 'salmon', amount: '2 fillet' }])[0]?.available).toEqual(filletRecipe.ingredients)
    expect(matchRecipes([filletRecipe], [{ name: 'salmon', amount: '2 fillets' }])[0]?.available).toEqual(filletRecipe.ingredients)

    const sliceRecipe = recipe('slices', 'Sandwich', [{ name: 'bread', amount: '2 slices' }])
    expect(matchRecipes([sliceRecipe], [{ name: 'bread', amount: '1 slice' }])[0]?.missing).toEqual(sliceRecipe.ingredients)
    expect(matchRecipes([sliceRecipe], [{ name: 'bread', amount: '2 slice' }])[0]?.available).toEqual(sliceRecipe.ingredients)
    expect(matchRecipes([filletRecipe], [{ name: 'salmon', amount: '2 pieces' }])[0]?.missing).toEqual(filletRecipe.ingredients)

    const bunchRecipe = recipe('bunches', 'Herbs', [{ name: 'parsley', amount: '2 bunches' }])
    expect(matchRecipes([bunchRecipe], [{ name: 'parsley', amount: '1 bunch' }])[0]?.missing).toEqual(bunchRecipe.ingredients)
    const leavesRecipe = recipe('leaves', 'Salad', [{ name: 'lettuce', amount: '2 leaves' }])
    expect(matchRecipes([leavesRecipe], [{ name: 'lettuce', amount: '1 leaf' }])[0]?.missing).toEqual(leavesRecipe.ingredients)
  })
  it('compares ingredient count nouns with unitless and container counts without accepting short stock', () => {
    const lemon = recipe('lemon-count', 'Lemons', [{ name: 'lemon', amount: '1' }])
    expect(matchRecipes([lemon], [{ name: 'lemons', amount: '2 lemons' }])[0]?.available).toEqual(lemon.ingredients)

    const peppers = recipe('pepper-count', 'Peppers', [{ name: 'bell pepper', amount: '2' }])
    expect(matchRecipes([peppers], [{ name: 'bell peppers', amount: '1 bell pepper' }])[0]?.missing).toEqual(peppers.ingredients)
    expect(matchRecipes([peppers], [{ name: 'bell peppers', amount: '2 bell peppers' }])[0]?.available).toEqual(peppers.ingredients)

    const redPeppers = recipe('red-pepper-count', 'Red Peppers', [{ name: 'red bell pepper', amount: '2' }])
    expect(matchRecipes([redPeppers], [{ name: 'red bell pepper', amount: '2 bell peppers' }])[0]?.available).toEqual(redPeppers.ingredients)

    const garlic = recipe('garlic-cloves', 'Garlic', [{ name: 'garlic', amount: '2 cloves' }])
    expect(matchRecipes([garlic], [{ name: 'garlic', amount: '1 clove' }])[0]?.missing).toEqual(garlic.ingredients)
    expect(matchRecipes([garlic], [{ name: 'garlic', amount: '2 cloves' }])[0]?.available).toEqual(garlic.ingredients)

    const canned = recipe('canned-tomatoes', 'Tomatoes', [{ name: 'tomatoes', amount: '1 can' }])
    expect(matchRecipes([canned], [{ name: 'tomatoes', amount: '1 tin' }])[0]?.available).toEqual(canned.ingredients)
    expect(matchRecipes([canned], [{ name: 'tomatoes', amount: '1 package' }])[0]?.missing).toEqual(canned.ingredients)

    const unitless = recipe('unitless-rice', 'Rice', [{ name: 'rice', amount: '2' }])
    expect(matchRecipes([unitless], [{ name: 'rice', amount: '2 scoops' }])[0]?.missing).toEqual(unitless.ingredients)
  })
  it('keeps distinct count units from satisfying each other', () => {
    const garlicHeads = recipe('garlic-heads', 'Roasted garlic', [{ name: 'garlic', amount: '1 head' }])
    const garlicCloves = recipe('garlic-cloves-count', 'Garlic cloves', [{ name: 'garlic', amount: '1 clove' }])
    expect(matchRecipes([garlicHeads], [{ name: 'garlic', amount: '1 clove' }])[0]?.missing).toEqual(garlicHeads.ingredients)
    expect(matchRecipes([garlicCloves], [{ name: 'garlic', amount: '1 head' }])[0]?.missing).toEqual(garlicCloves.ingredients)

    const canned = recipe('canned-jars', 'Canned tomatoes', [{ name: 'tomatoes', amount: '2 cans' }])
    expect(matchRecipes([canned], [{ name: 'tomatoes', amount: '2 jars' }])[0]?.missing).toEqual(canned.ingredients)
    expect(matchRecipes([canned], [{ name: 'tomatoes', amount: '1 can' }, { name: 'tomatoes', amount: '1 jar' }])[0]?.missing).toEqual(canned.ingredients)
  })
  it('matches recognized count units to ingredient-name suffixes without changing volume units', () => {
    const chicken = recipe('chicken-breast-count', 'Chicken', [{ name: 'chicken breast', amount: '2' }])
    expect(matchRecipes([chicken], [{ name: 'chicken breast', amount: '2 breasts' }])[0]?.available).toEqual(chicken.ingredients)
    expect(matchRecipes([chicken], [{ name: 'chicken breast', amount: '1 breast' }])[0]?.missing).toEqual(chicken.ingredients)

    const stock = recipe('chicken-stock-volume', 'Chicken stock', [{ name: 'chicken stock', amount: '2 cups' }])
    expect(matchRecipes([stock], [{ name: 'chicken stock', amount: '473.176 ml' }])[0]?.available).toEqual(stock.ingredients)
  })
  it('parses common amount phrases without accepting unrelated or short amounts', () => {
    const chicken = recipe('qualified-chicken', 'Chicken', [{ name: 'chicken breast', amount: '2' }])
    expect(matchRecipes([chicken], [{ name: 'chicken breast', amount: '2 boneless chicken breasts' }])[0]?.available).toEqual(chicken.ingredients)
    expect(matchRecipes([chicken], [{ name: 'chicken breast', amount: '1 boneless chicken breast' }])[0]?.missing).toEqual(chicken.ingredients)

    const salmon = recipe('salmon-fillets', 'Salmon', [{ name: 'salmon', amount: '2 fillets' }])
    expect(matchRecipes([salmon], [{ name: 'salmon', amount: '2 salmon fillets' }])[0]?.available).toEqual(salmon.ingredients)
    expect(matchRecipes([salmon], [{ name: 'salmon', amount: '1 salmon fillet' }])[0]?.missing).toEqual(salmon.ingredients)

    const rice = recipe('rice-cups', 'Rice', [{ name: 'rice', amount: '1 cup' }])
    expect(matchRecipes([rice], [{ name: 'rice', amount: '1 cup of rice' }])[0]?.available).toEqual(rice.ingredients)
    expect(matchRecipes([rice], [{ name: 'rice', amount: '1 cup of salt' }])[0]?.missing).toEqual(rice.ingredients)

    const eggs = recipe('large-eggs', 'Eggs', [{ name: 'eggs', amount: '2' }])
    expect(matchRecipes([eggs], [{ name: 'eggs', amount: '2 large eggs' }])[0]?.available).toEqual(eggs.ingredients)
    expect(matchRecipes([eggs], [{ name: 'eggs', amount: '1 large egg' }])[0]?.missing).toEqual(eggs.ingredients)

    const garlic = recipe('cloves-garlic', 'Garlic', [{ name: 'garlic', amount: '2 cloves' }])
    expect(matchRecipes([garlic], [{ name: 'garlic', amount: '2 cloves garlic' }])[0]?.available).toEqual(garlic.ingredients)
    expect(matchRecipes([garlic], [{ name: 'garlic', amount: '1 clove garlic' }])[0]?.missing).toEqual(garlic.ingredients)
    expect(matchRecipes([eggs], [{ name: 'eggs', amount: '2 scoops eggs' }])[0]?.missing).toEqual(eggs.ingredients)
  })
  it('keeps zero-quantity requirements available when a matching pantry ingredient exists', () => {
    const zero = recipe('zero-rice', 'Rice', [{ name: 'rice', amount: '0 cup' }])
    expect(matchRecipes([zero], [{ name: 'rice', amount: '2 oz' }])[0]?.available).toEqual(zero.ingredients)
  })
  it('parses mixed Unicode fractions and rejects invalid quantities for measurable requirements', () => {
    const row = recipe('fractions', 'Fractions', [
      { name: 'rice', amount: '1½ cups' },
      { name: 'flour', amount: '2/3 cup' },
      { name: 'beans', amount: '1 can' },
    ])
    const result = matchRecipes([row], [
      { name: 'rice', amount: '1 1/2 cups' },
      { name: 'flour', amount: '1/0 cup' },
      { name: 'beans', amount: '1 package' },
    ])[0]!
    expect(result.available.map((item) => item.name)).toEqual(['rice'])
    expect(result.missing.map((item) => item.name)).toEqual(['flour', 'beans'])
    expect(matchRecipes([row], [{ name: 'rice', amount: '1 cup' }])[0]?.missing).toContain(row.ingredients[0])
    expect(matchRecipes([recipe('eighths', 'Rice', [{ name: 'rice', amount: '2 cups' }])], [{ name: 'rice', amount: '⅛ cup' }])[0]?.missing).toHaveLength(1)
    expect(matchRecipes([recipe('mixed-eighths', 'Rice', [{ name: 'rice', amount: '1 1/8 cups' }])], [{ name: 'rice', amount: '1⅛ cup' }])[0]?.available).toHaveLength(1)
    expect(matchRecipes([recipe('sixths', 'Rice', [{ name: 'rice', amount: '5/6 cup' }])], [{ name: 'rice', amount: '⅚ cup' }])[0]?.available).toHaveLength(1)
  })
  it.each([
    ['½', '1/2'], ['⅓', '1/3'], ['⅔', '2/3'], ['¼', '1/4'], ['¾', '3/4'],
    ['⅕', '1/5'], ['⅖', '2/5'], ['⅗', '3/5'], ['⅘', '4/5'],
    ['⅙', '1/6'], ['⅚', '5/6'], ['⅛', '1/8'], ['⅜', '3/8'], ['⅝', '5/8'], ['⅞', '7/8'],
    ['⅐', '1/7'], ['⅑', '1/9'], ['⅒', '1/10'],
  ])('parses the Unicode fraction %s as %s', (glyph, fraction) => {
    const row = recipe('unicode-fraction', 'Fraction', [{ name: 'rice', amount: `${fraction} cup` }])
    expect(matchRecipes([row], [{ name: 'rice', amount: `${glyph} cup` }])[0]?.available).toEqual(row.ingredients)
  })
  it('does not treat malformed nonblank stock as enough for measurable requirements', () => {
    const row = recipe('malformed-stock', 'Rice', [{ name: 'rice', amount: '2 cups' }])
    for (const amount of [
      '⅛ cup', 'one cup', '2-3 cups', '1/0 cup',
      `${'9'.repeat(400)} cups`,
    ]) {
      expect(matchRecipes([row], [{ name: 'rice', amount }])[0]?.missing, amount).toEqual(row.ingredients)
    }
    expect(matchRecipes([recipe('unmeasurable', 'Rice', [{ name: 'rice', amount: 'to taste' }])], [{ name: 'rice', amount: 'one cup' }])[0]?.available).toHaveLength(1)
    expect(matchRecipes([row], [{ name: 'rice', amount: '' }])[0]?.available).toEqual(row.ingredients)
  })
  it('sorts by match percentage, then missing count, then cooking time', () => {
    const rows = [recipe('slow', 'Slow', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 60), recipe('fast', 'Fast', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 10), recipe('more-missing', 'More missing', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }, { name: 'salt', amount: '' }], 1)]
    expect(matchRecipes(rows, [{ name: 'rice', amount: '' }]).map(({ recipe: row }) => row.id)).toEqual(['fast', 'slow', 'more-missing'])
    expect(matchRecipes([recipe('tieA', 'A', [{ name: 'rice', amount: '' }, { name: 'salt', amount: '' }], 10), recipe('tieB', 'B', [{ name: 'rice', amount: '' }, { name: 'oil', amount: '' }], 20)], [{ name: 'rice', amount: '' }]).map(({ recipe: row }) => row.id)).toEqual(['tieA', 'tieB'])
  })
  it('updates matches when pantry groups change while preserving unrelated results', () => {
    const rice = recipe('cached-rice', 'Rice', [{ name: 'rice', amount: '2 cups' }])
    const beans = recipe('cached-beans', 'Beans', [{ name: 'beans', amount: '2 cans' }])
    const matcher = createRecipeMatcher([rice, beans])
    const initial = matcher([{ name: 'rice', amount: '1 cup' }, { name: 'beans', amount: '2 cans' }])
    const initialRice = initial.find(({ recipe: row }) => row.id === 'cached-rice')!
    const initialBeans = initial.find(({ recipe: row }) => row.id === 'cached-beans')!

    const updated = matcher([{ name: 'rice', amount: '2 cups' }, { name: 'beans', amount: '2 cans' }])
    const updatedRice = updated.find(({ recipe: row }) => row.id === 'cached-rice')!
    const updatedBeans = updated.find(({ recipe: row }) => row.id === 'cached-beans')!
    expect(initialRice.missingCount).toBe(1)
    expect(updatedRice.missingCount).toBe(0)
    expect(updatedRice.available).toEqual(rice.ingredients)
    const availableGetter = Object.getOwnPropertyDescriptor(updatedBeans, 'available')?.get
    expect(availableGetter).toBeTypeOf('function')
    expect(Object.isFrozen(updatedBeans)).toBe(true)
    const available = availableGetter!.call(updatedBeans) as readonly Ingredient[]
    expect(availableGetter!.call(updatedBeans)).toBe(available)
    expect(Object.isFrozen(available)).toBe(true)
    const firstBean = available[0]
    expect(Reflect.set(available, 0, undefined)).toBe(false)
    expect(available[0]).toBe(firstBean)
    expect(updatedBeans).toEqual(initialBeans)

    const removed = matcher([{ name: 'beans', amount: '2 cans' }])
    const removedRice = removed.find(({ recipe: row }) => row.id === 'cached-rice')!
    expect(removedRice.missingCount).toBe(1)
    expect(removedRice.missing).toEqual(rice.ingredients)
    expect(removed.find(({ recipe: row }) => row.id === 'cached-beans')).toEqual(initialBeans)
    expect(initialRice.missing).toEqual(rice.ingredients)
    expect(initialBeans.available).toEqual(beans.ingredients)
  })
  it('exposes an immutable lazy preview of the first two missing ingredients', () => {
    const row = recipe('missing-preview', 'Missing preview', [
      { name: 'rice', amount: '1 cup' }, { name: 'beans', amount: '1 can' }, { name: 'salt', amount: '1 tsp' },
    ])
    const match = createRecipeMatcher([row])([])[0]!
    const previewGetter = Object.getOwnPropertyDescriptor(match, 'missingPreview')?.get

    expect(previewGetter).toBeTypeOf('function')
    const preview = previewGetter!.call(match) as readonly Ingredient[]
    expect(preview).toEqual(row.ingredients.slice(0, 2))
    expect(previewGetter!.call(match)).toBe(preview)
    expect(Object.isFrozen(preview)).toBe(true)
    expect(match.missingCount).toBe(3)
  })
  it('updates only a changed ingredient group while consuming repeated requirements and handling blank stock', () => {
    const repeatedRice = recipe('delta-rice', 'Rice', [
      { name: 'rice', amount: '1 cup' }, { name: 'rice', amount: '1 cup' }, { name: 'beans', amount: '1 can' },
    ])
    const matcher = createRecipeMatcher([repeatedRice])
    const first = matcher([{ name: 'rice', amount: '1 cup' }])[0]!
    expect(first.missingCount).toBe(2)
    expect(first.available.map(({ name }) => name)).toEqual(['rice'])

    const enoughRice = matcher([{ name: 'rice', amount: '2 cups' }])[0]!
    expect(enoughRice.missingCount).toBe(1)
    expect(enoughRice.available.map(({ name }) => name)).toEqual(['rice', 'rice'])

    const addedBeans = matcher([{ name: 'rice', amount: '2 cups' }, { name: 'beans', amount: '' }])[0]!
    expect(addedBeans.missingCount).toBe(0)
    expect(addedBeans.available).toEqual(repeatedRice.ingredients)

    const removedRice = matcher([{ name: 'beans', amount: '' }])[0]!
    expect(removedRice.missingCount).toBe(2)
    expect(removedRice.available).toEqual([repeatedRice.ingredients[2]])
  })
  it('keeps empty-ingredient recipes at zero coverage with the cached matcher', () => {
    expect(createRecipeMatcher([recipe('empty-cache', 'Empty', [])])([])[0]).toMatchObject({ percent: 0, available: [], missing: [] })
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

  it('normalizes legacy recipes without instructions and preserves multiline instructions', () => {
    const legacy: Omit<Recipe, 'instructions'> = (({ instructions: _instructions, ...rest }) => rest)(recipe('legacy', 'Legacy', [{ name: 'rice', amount: '1 cup' }]))
    const normalized = parseAppData({ ...validData, recipes: [legacy] })
    expect(normalized.recipes[0]?.instructions).toBe('')
    const steps = 'Toast rice.\nAdd water and simmer.'
    expect(parseAppData({ ...validData, recipes: [{ ...legacy, instructions: steps }] }).recipes[0]?.instructions).toBe(steps)
  })
})
