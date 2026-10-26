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
const quantityPattern = /^((?:\d+\/\d+|\d+(?:\.\d+)?))(?:\s+((?:\d+\/\d+|\d+(?:\.\d+)?)))?\s*([\p{L}\s-]+)?$/u
const quantityUnits: Readonly<Record<string, readonly [string, number]>> = {
  tsp: ['volume', 4.92892], teaspoon: ['volume', 4.92892], tbsp: ['volume', 14.7868], tablespoon: ['volume', 14.7868],
  cup: ['volume', 236.588], ml: ['volume', 1], mls: ['volume', 1], milliliter: ['volume', 1], l: ['volume', 1000], liter: ['volume', 1000],
  g: ['weight', 1], gram: ['weight', 1], kg: ['weight', 1000], kgs: ['weight', 1000], kilogram: ['weight', 1000], oz: ['weight', 28.3495], ounce: ['weight', 28.3495], lb: ['weight', 453.592], lbs: ['weight', 453.592], pound: ['weight', 453.592],
  each: ['count:each', 1], can: ['count:can', 1], tin: ['count:can', 1], jar: ['count:jar', 1], stick: ['count:stick', 1], packet: ['count:packet', 1], clove: ['count:clove', 1], piece: ['count:piece', 1], package: ['count:package', 1],
  fillet: ['count:fillet', 1], breast: ['count:breast', 1], thigh: ['count:thigh', 1], wing: ['count:wing', 1], drumstick: ['count:drumstick', 1],
  slice: ['count:slice', 1], strip: ['count:strip', 1], stalk: ['count:stalk', 1], sprig: ['count:sprig', 1], head: ['count:head', 1],
  bunch: ['count:bunch', 1], ear: ['count:ear', 1], bulb: ['count:bulb', 1], sheet: ['count:sheet', 1], leaf: ['count:leaf', 1],
}

const amountDescriptorWords = new Set([
  'boneless', 'bone', 'bone-in', 'bone-out', 'skinless', 'skin-on', 'skin-off',
  'large', 'medium', 'small', 'extra', 'jumbo', 'fresh', 'frozen', 'raw', 'cooked',
  'chopped', 'diced', 'sliced', 'minced', 'whole', 'ripe', 'organic', 'red', 'green',
  'yellow', 'white', 'brown', 'black', 'cherry', 'roma',
])

/** Match an amount phrase to an ingredient name, allowing only known leading descriptors. */
function isIngredientAmountPhrase(phrase: string, ingredientName: string): boolean {
  const words = normalizeName(phrase).split(' ').filter(Boolean)
  const ingredientWords = normalizeName(ingredientName).split(' ').filter(Boolean)
  if (!words.length || !ingredientWords.length || words.length < ingredientWords.length) return false
  const offset = words.length - ingredientWords.length
  return words.slice(offset).join(' ') === ingredientWords.join(' ')
    && words.slice(0, offset).every((word) => amountDescriptorWords.has(word))
}

/** Return true when a singular count unit names the end of the ingredient name. */
function isIngredientCountSuffix(unit: string, ingredientName: string): boolean {
  const unitWords = normalizeName(unit).split(' ').filter(Boolean)
  const ingredientWords = normalizeName(ingredientName).split(' ').filter(Boolean)
  return unitWords.length > 0
    && unitWords.length <= ingredientWords.length
    && ingredientWords.slice(-unitWords.length).join(' ') === unitWords.join(' ')
}

/** Remove a validated trailing ingredient phrase, including the common connector "of". */
function ingredientTailMatches(tail: string, ingredientName: string): boolean {
  if (!tail) return true
  const phrase = tail.replace(/^of\s+/u, '').trim()
  return Boolean(phrase) && isIngredientAmountPhrase(phrase, ingredientName)
}

/** Parse a nonnegative number or fraction, returning zero for absent input and undefined for invalid values. */
function parseQuantityNumber(raw?: string): number | undefined {
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

/**
 * Parse supported nonnegative numbers and fractions into comparable quantities.
 * Volumes use milliliters and weights use grams. Explicit count units remain
 * distinct, except can/tin aliases; a count noun matching the ingredient name
 * is treated as an each-count.
 *
 * @returns The quantity and comparison dimension, or undefined for unparseable
 * or nonfinite amounts.
 */
function parseQuantity(value: string, ingredientName = ''): { value: number; dimension: string } | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅐⅑⅒]/g, (fraction) => ` ${vulgarFractions[fraction]}`).trim()
  const match = normalized.match(quantityPattern)
  if (!match) return undefined
  const whole = parseQuantityNumber(match[1])
  const fraction = parseQuantityNumber(match[2])
  if (whole === undefined || fraction === undefined) return undefined
  const count = whole + fraction
  if (!Number.isFinite(count)) return undefined
  const rawUnit = match[3]?.trim() ?? 'each'
  const unitPhrase = normalizeName(rawUnit)
  const unitWords = unitPhrase.split(' ').filter(Boolean)
  const ingredientNameKey = normalizeName(ingredientName)
  const firstUnit = unitWords[0] ?? 'each'
  const firstConversion = quantityUnits[firstUnit]
  const firstUnitTail = unitWords.slice(1).join(' ')

  // A leading unit is unambiguous when the rest is empty or names this ingredient.
  // Keep arbitrary trailing words in the unknown dimension so malformed text cannot
  // accidentally satisfy a measurable requirement.
  if (firstConversion && (!firstUnitTail || ingredientTailMatches(firstUnitTail, ingredientNameKey))) {
    if (firstConversion[0] === 'volume' || firstConversion[0] === 'weight') {
      const converted = count * firstConversion[1]
      return Number.isFinite(converted) ? { value: converted, dimension: firstConversion[0] } : undefined
    }
    if (firstConversion[0].startsWith('count:')) {
      const dimension = isIngredientCountSuffix(firstUnit, ingredientNameKey) ? 'count:each' : firstConversion[0]
      return { value: count, dimension }
    }
  }

  // Natural item phrases such as “large eggs” and “boneless chicken breasts”
  // are each-counts only when the normalized phrase names the ingredient.
  if (isIngredientAmountPhrase(unitPhrase, ingredientNameKey)) return { value: count, dimension: 'count:each' }
  if (isIngredientCountSuffix(unitPhrase, ingredientNameKey)) return { value: count, dimension: 'count:each' }

  // Unit nouns may follow the ingredient (“salmon fillets”). Only accept that
  // order when the preceding phrase matches the ingredient name.
  const lastUnit = unitWords.at(-1) ?? ''
  const lastConversion = quantityUnits[lastUnit]
  const unitPrefix = unitWords.slice(0, -1).join(' ')
  if (lastConversion?.[0].startsWith('count:') && isIngredientAmountPhrase(unitPrefix, ingredientNameKey)) {
    return { value: count, dimension: lastConversion[0] }
  }

  return { value: count, dimension: `unknown:${unitPhrase || 'each'}` }
}

/**
 * Return pantry matches ranked by rounded coverage percentage, then fewer missing
 * ingredients, then shorter cooking time. Recipes without ingredients score zero.
 * Pool comparable quantities for equivalent names and consume covered requirements
 * in ingredient order, allowing a relative tolerance of 1e-5 for conversion rounding.
 * Use name presence for unparseable requirements or blank pantry amounts
 * when no comparable stock exists; malformed nonblank amounts do not satisfy a
 * measurable requirement.
 * Each recipe is evaluated independently without changing the pantry or recipes.
 */
type IngredientMetadata = { normalizedName: string; family?: string }
type PreparedIngredient = { ingredient: Ingredient; required?: { value: number; dimension: string }; groupKey: string; position: number }
type PreparedRecipeGroup = { ingredients: PreparedIngredient[]; groupIndex: number; startPosition: number; isContiguous: boolean; signature: string }
type RecipeMatchSnapshot = { statuses: Uint8Array; availableByGroup: Uint32Array; availableCount: number }
type PantryQuantityGroup = { hasBlankAmount: boolean; quantities: Map<string, number> }

/** Compare the quantities that can affect recipe matching for one pantry ingredient group. */
function samePantryQuantityGroup(first?: PantryQuantityGroup, second?: PantryQuantityGroup): boolean {
  if (!first || !second) return first === second
  if (first.hasBlankAmount !== second.hasBlankAmount || first.quantities.size !== second.quantities.size) return false
  for (const [dimension, amount] of first.quantities) {
    if (second.quantities.get(dimension) !== amount) return false
  }
  return true
}

/**
 * Prepare immutable recipe metadata once, then evaluate it against changing pantry stock.
 * Recreate the matcher whenever recipes or ingredient rows change; the app does this
 * through its immutable recipe state and memoizes the returned matcher by recipe list.
 * Cached recipe statuses are byte snapshots; each affected recipe gets a cloned
 * snapshot, while ingredient-result arrays are frozen and materialized on demand.
 */
export function createRecipeMatcher(recipes: Recipe[]): (pantry: PantryItem[]) => RecipeMatch[] {
  const ingredientNameCache = new Map<string, IngredientMetadata>()
  /** Cache normalized ingredient names and protein families for the matcher lifetime. */
  function getIngredientName(name: string): IngredientMetadata {
    let metadata = ingredientNameCache.get(name)
    if (!metadata) {
      const normalizedName = normalizeName(name)
      metadata = { normalizedName, family: proteinFamilyFromNormalizedName(normalizedName) }
      ingredientNameCache.set(name, metadata)
    }
    return metadata
  }

  const preparedRecipes = recipes.map((recipe) => {
    const ingredients = recipe.ingredients.map((ingredient, position): PreparedIngredient => {
      const { normalizedName, family } = getIngredientName(ingredient.name)
      return {
        ingredient,
        required: parseQuantity(ingredient.amount, ingredient.name),
        groupKey: family ? `family:${family}` : `name:${normalizedName}`,
        position,
      }
    })
    const groups = new Map<string, PreparedRecipeGroup>()
    ingredients.forEach((ingredient) => {
      let group = groups.get(ingredient.groupKey)
      if (!group) {
        group = { ingredients: [], groupIndex: groups.size, startPosition: ingredient.position, isContiguous: true, signature: '' }
        groups.set(ingredient.groupKey, group)
      }
      if (group.ingredients.length && ingredient.position !== group.ingredients[group.ingredients.length - 1]!.position + 1) group.isContiguous = false
      group.ingredients.push(ingredient)
    })
    for (const group of groups.values()) {
      group.signature = JSON.stringify(group.ingredients.map(({ required }) => required ? [required.dimension, required.value] : null))
    }
    return { recipe, ingredients, groups }
  })

  const recipesByGroup = new Map<string, Set<number>>()
  preparedRecipes.forEach(({ groups }, recipeIndex) => {
    for (const groupKey of groups.keys()) {
      const indexes = recipesByGroup.get(groupKey)
      if (indexes) indexes.add(recipeIndex)
      else recipesByGroup.set(groupKey, new Set([recipeIndex]))
    }
  })

  let previousPantryByGroup: Map<string, PantryQuantityGroup> | undefined
  const cachedRecipeMatches: Array<RecipeMatch | undefined> = Array(preparedRecipes.length).fill(undefined)
  const cachedSnapshots: Array<RecipeMatchSnapshot | undefined> = Array(preparedRecipes.length).fill(undefined)

  /** Evaluate one ingredient group in recipe order, consuming stock across repeated requirements. */
  function evaluateGroupStatuses(groupIngredients: PreparedIngredient[], pantryGroup: PantryQuantityGroup | undefined): { statuses: Uint8Array; availableCount: number } {
    const statuses = new Uint8Array(groupIngredients.length)
    let availableCount = 0
    const consumedByDimension = new Map<string, number>()
    for (const [index, { required }] of groupIngredients.entries()) {
      let isAvailable = false
      if (!pantryGroup) {
        // A removed pantry group makes every requirement in this group unavailable.
      } else if (!required || required.value === 0) {
        isAvailable = true
      } else {
        const total = pantryGroup.quantities.get(required.dimension)
        const consumed = consumedByDimension.get(required.dimension) ?? 0
        const remaining = total === undefined ? undefined : Math.max(0, total - consumed)
        if (remaining === undefined) {
          if (pantryGroup.hasBlankAmount) isAvailable = true
        } else {
          const tolerance = Math.max(remaining, required.value) * 1e-5
          if (remaining + tolerance >= required.value) {
            isAvailable = true
            consumedByDimension.set(required.dimension, consumed + Math.min(remaining, required.value))
          }
        }
      }
      if (isAvailable) {
        statuses[index] = 1
        availableCount += 1
      }
    }
    return { statuses, availableCount }
  }

  /** Expose one immutable result snapshot, materializing ingredient lists only on access. */
  function createMatchSnapshot(recipeIndex: number, snapshot: RecipeMatchSnapshot): RecipeMatch {
    const { recipe, ingredients } = preparedRecipes[recipeIndex]!
    let available: readonly Ingredient[] | undefined
    let missing: readonly Ingredient[] | undefined
    let missingPreview: readonly Ingredient[] | undefined
    const result = {
      recipe,
      get available() {
        if (!available) {
          available = Object.freeze(ingredients.flatMap(({ ingredient, position }) =>
            snapshot.statuses[position] ? [ingredient] : []))
        }
        return available
      },
      get missing() {
        if (!missing) {
          missing = Object.freeze(ingredients.flatMap(({ ingredient, position }) =>
            snapshot.statuses[position] ? [] : [ingredient]))
        }
        return missing
      },
      get missingPreview() {
        if (!missingPreview) {
          const preview: Ingredient[] = []
          for (const { ingredient, position } of ingredients) {
            if (!snapshot.statuses[position]) preview.push(ingredient)
            if (preview.length === 2) break
          }
          missingPreview = Object.freeze(preview)
        }
        return missingPreview
      },
      missingCount: ingredients.length - snapshot.availableCount,
      percent: ingredients.length ? Math.round((snapshot.availableCount / ingredients.length) * 100) : 0,
    }
    return Object.freeze(result)
  }

  return (pantry: PantryItem[]): RecipeMatch[] => {
    const pantryByGroup = new Map<string, PantryQuantityGroup>()
    for (const item of pantry) {
      const { normalizedName, family } = getIngredientName(item.name)
      const groupKey = family ? `family:${family}` : `name:${normalizedName}`
      let group = pantryByGroup.get(groupKey)
      if (!group) {
        group = { hasBlankAmount: false, quantities: new Map() }
        pantryByGroup.set(groupKey, group)
      }
      if (!item.amount.trim()) group.hasBlankAmount = true
      const quantity = parseQuantity(item.amount, item.name)
      if (quantity) group.quantities.set(quantity.dimension, (group.quantities.get(quantity.dimension) ?? 0) + quantity.value)
    }

    const changedGroups = new Set<string>()
    if (!previousPantryByGroup) {
      for (const groupKey of recipesByGroup.keys()) changedGroups.add(groupKey)
    } else {
      for (const groupKey of new Set([...previousPantryByGroup.keys(), ...pantryByGroup.keys()])) {
        if (!samePantryQuantityGroup(previousPantryByGroup.get(groupKey), pantryByGroup.get(groupKey))) changedGroups.add(groupKey)
      }
    }

    const recipesToRecalculate = new Set<number>()
    if (!previousPantryByGroup) {
      preparedRecipes.forEach((_, recipeIndex) => recipesToRecalculate.add(recipeIndex))
    } else {
      for (const groupKey of changedGroups) {
        for (const recipeIndex of recipesByGroup.get(groupKey) ?? []) recipesToRecalculate.add(recipeIndex)
      }
    }

    const evaluatedGroups = new Map<string, { statuses: Uint8Array; availableCount: number }>()
    for (const recipeIndex of recipesToRecalculate) {
      const prepared = preparedRecipes[recipeIndex]!
      const previous = cachedSnapshots[recipeIndex]
      const statuses = previous ? previous.statuses.slice() : new Uint8Array(prepared.ingredients.length)
      const availableByGroup = previous ? previous.availableByGroup.slice() : new Uint32Array(prepared.groups.size)
      let availableCount = previous?.availableCount ?? 0
      const groupsToUpdate = previous ? changedGroups : prepared.groups.keys()
      for (const groupKey of groupsToUpdate) {
        const recipeGroup = prepared.groups.get(groupKey)
        if (!recipeGroup) continue
        const cacheKey = `${groupKey}\u0000${recipeGroup.signature}`
        let evaluated = evaluatedGroups.get(cacheKey)
        if (!evaluated) {
          evaluated = evaluateGroupStatuses(recipeGroup.ingredients, pantryByGroup.get(groupKey))
          evaluatedGroups.set(cacheKey, evaluated)
        }
        availableCount += evaluated.availableCount - availableByGroup[recipeGroup.groupIndex]!
        availableByGroup[recipeGroup.groupIndex] = evaluated.availableCount
        if (recipeGroup.isContiguous) statuses.set(evaluated.statuses, recipeGroup.startPosition)
        else recipeGroup.ingredients.forEach(({ position }, groupOffset) => { statuses[position] = evaluated!.statuses[groupOffset]! })
      }
      const snapshot = { statuses, availableByGroup, availableCount }
      cachedSnapshots[recipeIndex] = snapshot
      cachedRecipeMatches[recipeIndex] = createMatchSnapshot(recipeIndex, snapshot)
    }

    previousPantryByGroup = pantryByGroup
    return [...cachedRecipeMatches]
      .sort((first, second) => second!.percent - first!.percent || first!.missingCount - second!.missingCount || first!.recipe.time - second!.recipe.time) as RecipeMatch[]
  }
}

/** Match recipes against pantry stock by preparing recipe metadata for one call. */
export function matchRecipes(recipes: Recipe[], pantry: PantryItem[]): RecipeMatch[] {
  return createRecipeMatcher(recipes)(pantry)
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
