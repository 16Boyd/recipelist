import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, errorMessage } from '../../src/api'
import { insertSharedRecipe, loadCurrentUserRole, loadSharedRecipes, updateSharedRecipeInstructions } from '../../src/recipeStorage'
import { loadProfile, saveProfile } from '../../src/profileStorage'
import type { AppData, Recipe } from '../../src/types'

const recipe: Recipe = { id: 'r1', title: 'Rice', source: 'Test', category: 'Dinner', time: 20, servings: 2, image: '', description: '', instructions: 'Cook the rice.', ingredients: [{ name: 'rice', amount: '1 cup' }] }
const profile: AppData = { recipes: [recipe], pantry: [{ name: 'rice', amount: '' }], shopping: [{ id: 's1', name: 'salt', checked: false }] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('same-origin API wrapper', () => {
  it('sets same-origin credentials, preserves caller headers, and adds JSON content type for bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('/api/sample', { method: 'POST', headers: { Authorization: 'token' }, body: '{}' })
    expect(fetchMock).toHaveBeenCalledWith('/api/sample', expect.objectContaining({ credentials: 'same-origin', method: 'POST', headers: expect.any(Headers), body: '{}' }))
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('token')
    expect(headers.get('Content-Type')).toBe('application/json')
  })
  it('returns JSON or undefined for a successful 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ value: 2 })).mockResolvedValueOnce(new Response(null, { status: 204 })))
    await expect(apiRequest('/ok')).resolves.toEqual({ value: 2 })
    await expect(apiRequest('/empty')).resolves.toBeUndefined()
  })
  it('uses server message/error fields and falls back for malformed error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ message: 'Specific failure' }, 403)).mockResolvedValueOnce(new Response('oops', { status: 503 })))
    await expect(apiRequest('/forbidden')).rejects.toThrow('Specific failure')
    await expect(apiRequest('/unavailable')).rejects.toThrow('Request failed (503).')
    expect(errorMessage({ message: 'Plain object error' }, 'fallback')).toBe('Plain object error')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
  })
})

describe('shared recipe API validation', () => {
  it('validates member/admin roles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ role: 'member' })).mockResolvedValueOnce(json({ role: 'admin' })).mockResolvedValueOnce(json({ role: 'owner' })))
    await expect(loadCurrentUserRole()).resolves.toBe('member')
    await expect(loadCurrentUserRole()).resolves.toBe('admin')
    await expect(loadCurrentUserRole()).rejects.toThrow('role could not be verified')
  })
  it('validates catalog recipe shape and sends recipe inserts as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json([recipe])).mockResolvedValueOnce(json([{}])).mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadSharedRecipes()).resolves.toEqual([recipe])
    await expect(loadSharedRecipes()).rejects.toThrow('invalid recipe')
    await expect(insertSharedRecipe(recipe)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(recipe) })
  })

  it('rejects shared recipes that omit instructions', async () => {
    const { instructions: _instructions, ...legacy } = recipe
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json([legacy])))
    await expect(loadSharedRecipes()).rejects.toThrow('invalid recipe')
  })

  it('completes shared recipe instructions with a validated response', async () => {
    const instructions = 'Simmer the rice.\\nServe warm.'
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'legacy/recipe', instructions }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(updateSharedRecipeInstructions('legacy/recipe', instructions)).resolves.toEqual({ id: 'legacy/recipe', instructions })
    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/legacy%2Frecipe/instructions', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ instructions }) }))
  })

  it('rejects malformed shared instruction update responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ id: 5, instructions: 'Cook the rice.' })))
    await expect(updateSharedRecipeInstructions('r1', 'Cook the rice.')).rejects.toThrow('invalid recipe update')
  })
})

describe('profile storage validation and write serialization', () => {
  it('parses profile responses and rejects invalid shapes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json({ ...profile, pantry: [{ name: 2, amount: '' }] })))
    await expect(loadProfile()).resolves.toEqual(profile)
    await expect(loadProfile()).rejects.toThrow('incomplete or invalid')
  })
  it('serializes concurrent saves and recovers the queue after a failed write', async () => {
    let resolveFirst!: (response: Response) => void
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve })
    const requests: string[] = []
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      requests.push(String(init?.body))
      if (requests.length === 1) return first
      if (requests.length === 2) return Promise.resolve(json({ error: 'write failed' }, 500))
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const saveOne = saveProfile(profile)
    const saveTwo = saveProfile({ ...profile, pantry: [{ name: 'beans', amount: '' }] })
    const saveThree = saveProfile({ ...profile, pantry: [{ name: 'lentils', amount: '' }] })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests).toHaveLength(1)
    resolveFirst(new Response(null, { status: 204 }))
    await expect(saveOne).resolves.toBeUndefined()
    await expect(saveTwo).rejects.toThrow('write failed')
    await expect(saveThree).resolves.toBeUndefined()
    expect(requests).toEqual([JSON.stringify(profile), JSON.stringify({ ...profile, pantry: [{ name: 'beans', amount: '' }] }), JSON.stringify({ ...profile, pantry: [{ name: 'lentils', amount: '' }] })])
  })
})
