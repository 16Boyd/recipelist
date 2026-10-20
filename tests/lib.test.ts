import assert from 'node:assert/strict'
import test from 'node:test'
import { ingredientNamesEquivalent, matchRecipes, normalizeName } from '../src/lib'
import type { Recipe } from '../src/types'

const recipe = (name: string): Recipe => ({
  id: 'recipe-1',
  title: 'Test recipe',
  source: 'Tests',
  category: 'Dinner',
  time: 30,
  servings: 2,
  image: '',
  description: '',
  ingredients: [{ name, amount: '1 lb' }],
})

test('matches common poultry forms and poultry species as interchangeable', () => {
  for (const pantryName of ['ground chicken', 'chicken tenders', 'chicken breast', 'turkey breast', 'duck']) {
    assert.equal(ingredientNamesEquivalent('chicken', pantryName), true, pantryName)
  }
  assert.equal(ingredientNamesEquivalent('poultry', 'ground chicken'), true)
  assert.equal(ingredientNamesEquivalent('ground chicken', 'chicken tenders'), true)
})

test('matches cuts and species within other meat families', () => {
  assert.equal(ingredientNamesEquivalent('beef', 'veal steak'), true)
  assert.equal(ingredientNamesEquivalent('bison', 'ground beef'), true)
  assert.equal(ingredientNamesEquivalent('pork', 'pork tenderloin'), true)
  assert.equal(ingredientNamesEquivalent('lamb', 'mutton chops'), true)
})

test('groups finfish together and shellfish together while keeping those groups separate', () => {
  assert.equal(ingredientNamesEquivalent('fish', 'salmon fillet'), true)
  assert.equal(ingredientNamesEquivalent('cod', 'tuna'), true)
  assert.equal(ingredientNamesEquivalent('shrimp', 'crab meat'), true)
  assert.equal(ingredientNamesEquivalent('scallops', 'lobster'), true)
  assert.equal(ingredientNamesEquivalent('salmon', 'shrimp'), false)
})

test('does not substitute across protein families or between animal and plant proteins', () => {
  assert.equal(ingredientNamesEquivalent('chicken breast', 'beef strips'), false)
  assert.equal(ingredientNamesEquivalent('ground turkey', 'ground pork'), false)
  assert.equal(ingredientNamesEquivalent('chicken', 'tofu'), false)
  assert.equal(ingredientNamesEquivalent('fish', 'tempeh'), false)
})

test('keeps stocks, broths, sauces, seasonings, and processed names exact-only', () => {
  assert.equal(ingredientNamesEquivalent('chicken stock', 'chicken broth'), false)
  assert.equal(ingredientNamesEquivalent('chicken', 'chicken stock'), false)
  assert.equal(ingredientNamesEquivalent('fish', 'fish sauce'), false)
  assert.equal(ingredientNamesEquivalent('beef', 'beef seasoning'), false)
  assert.equal(ingredientNamesEquivalent('chicken sausage', 'turkey sausage'), false)
  assert.equal(ingredientNamesEquivalent('chicken burger', 'turkey breast'), false)
  assert.equal(ingredientNamesEquivalent('smoked salmon', 'cod'), false)
  assert.equal(ingredientNamesEquivalent('chicken stock', 'chicken stock'), true)
})

test('does not treat compound dishes or unknown descriptors as interchangeable proteins', () => {
  assert.equal(ingredientNamesEquivalent('chicken and rice', 'turkey'), false)
  assert.equal(ingredientNamesEquivalent('chicken rice', 'turkey'), false)
  assert.equal(ingredientNamesEquivalent('chicken delight', 'turkey'), false)
  assert.equal(ingredientNamesEquivalent('chicken and turkey', 'ground chicken'), false)
  assert.equal(ingredientNamesEquivalent('', ' '), false)
})

test('retains normalized exact matching for ordinary ingredients', () => {
  assert.equal(normalizeName('  Red Onions '), 'red onion')
  assert.equal(ingredientNamesEquivalent('Red Onions', 'red onion'), true)
  assert.equal(ingredientNamesEquivalent('olive oil', 'extra virgin olive oil'), false)
})

test('matchRecipes reports substituted proteins as available without rewriting ingredient labels', () => {
  const original = recipe('Ground chicken')
  const result = matchRecipes([original], ['Chicken tenders'])[0]
  assert.deepEqual(result.available, original.ingredients)
  assert.deepEqual(result.missing, [])
  assert.equal(result.percent, 100)
  assert.equal(result.available[0].name, 'Ground chicken')
  assert.equal(result.available[0].amount, '1 lb')
})
