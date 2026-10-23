import type { AppData } from './types'
import { parseAppData } from './lib'
import { apiRequest } from './api'

let writeQueue: Promise<void> = Promise.resolve()

/** Wait for pending writes, fetch the signed-in profile, and validate its stored data. */
export async function loadProfile(): Promise<AppData> {
  await writeQueue.catch(() => undefined)
  return parseAppData(await apiRequest<unknown>('/api/profile'))
}

/** Queue a profile update after earlier writes so requests persist in order. */
export function saveProfile(appData: AppData): Promise<void> {
  const save = writeQueue.catch(() => undefined).then(async () => {
    await apiRequest<void>('/api/profile', { method: 'PUT', body: JSON.stringify(appData) })
  })
  writeQueue = save
  return save
}
