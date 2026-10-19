import type { AppData } from './types'
import { parseAppData } from './lib'
import { apiRequest } from './api'

let writeQueue: Promise<void> = Promise.resolve()

export async function loadProfile(): Promise<AppData> {
  await writeQueue.catch(() => undefined)
  return parseAppData(await apiRequest<unknown>('/api/profile'))
}

export function saveProfile(appData: AppData): Promise<void> {
  const save = writeQueue.catch(() => undefined).then(async () => {
    await apiRequest<void>('/api/profile', { method: 'PUT', body: JSON.stringify(appData) })
  })
  writeQueue = save
  return save
}
