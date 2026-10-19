import type { AppData } from './types'
import { parseAppData } from './lib'
import { supabase } from './supabase'

const PROFILE_TABLE = 'user_profiles'
let writeQueue: Promise<void> = Promise.resolve()

type ProfileRow = {
  app_data: unknown
  schema_version: number
}

function getClient() {
  if (!supabase) throw new Error('Supabase is not configured.')
  return supabase
}

async function readProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await getClient()
    .from(PROFILE_TABLE)
    .select('app_data, schema_version')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

function parsedProfile(row: ProfileRow): AppData {
  if (row.schema_version !== 1) throw new Error('Your saved kitchen data uses an unsupported format.')
  return parseAppData(row.app_data)
}

export async function loadProfile(userId: string, initialData: AppData): Promise<AppData> {
  // If a prior session has a pending save, wait before reading so it cannot be
  // followed by a stale snapshot from the same account.
  await writeQueue.catch(() => undefined)
  const existing = await readProfile(userId)
  if (!existing) throw new Error('Your kitchen profile could not be found. Please contact support.')
  if (existing.schema_version !== 0) return parsedProfile(existing)

  // Auth-user triggers create a placeholder row. Only one concurrent client
  // initializer can claim schema_version 0 and write sample app data.
  const { data: initialized, error } = await getClient()
    .from(PROFILE_TABLE)
    .update({ app_data: initialData, schema_version: 1 })
    .eq('user_id', userId)
    .eq('schema_version', 0)
    .select('app_data, schema_version')
    .maybeSingle()
  if (error) throw error
  if (initialized) return parsedProfile(initialized)

  // Another first-load request won the conditional update. Read its result;
  // a missing row or a still-uninitialized row is an error, never a client insert.
  const afterRace = await readProfile(userId)
  if (!afterRace || afterRace.schema_version === 0) {
    throw new Error('Could not initialize or load your kitchen profile.')
  }
  return parsedProfile(afterRace)
}

export function saveProfile(userId: string, appData: AppData): Promise<void> {
  const save = writeQueue.catch(() => undefined).then(async () => {
    const { data, error } = await getClient()
      .from(PROFILE_TABLE)
      .update({ app_data: appData, schema_version: 1 })
      .eq('user_id', userId)
      .select('user_id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Your kitchen profile could not be saved because it no longer exists.')
  })
  writeQueue = save
  return save
}
