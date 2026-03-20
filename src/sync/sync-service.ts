import { type Table } from 'dexie'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { now } from '@/lib/utils'
import type { SyncFields } from '@/types'

const LAST_PULL_KEY = 'kwenta_last_pull'

const TABLE_NAMES = [
  'profiles',
  'groups',
  'group_members',
  'bills',
  'bill_items',
  'item_splits',
  'settlements',
  'activity_log',
] as const

type TableName = (typeof TABLE_NAMES)[number]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLocalTable(name: TableName): Table<any, string> {
  return db[name]
}

/**
 * Push all locally unsynced records to Supabase.
 * A record is unsynced if synced_at is null OR updated_at > synced_at.
 */
export async function pushChanges(): Promise<{ pushed: number; errors: string[] }> {
  let pushed = 0
  const errors: string[] = []

  for (const tableName of TABLE_NAMES) {
    const table = getLocalTable(tableName)
    const allRecords = await table.toArray()

    const unsynced = allRecords.filter((r: SyncFields) => {
      if (r.synced_at === null) return true
      return r.updated_at > r.synced_at
    })

    if (unsynced.length === 0) continue

    const { error } = await supabase.from(tableName).upsert(unsynced, {
      onConflict: 'id',
      ignoreDuplicates: false,
    })

    if (error) {
      errors.push(`Push ${tableName}: ${error.message}`)
      continue
    }

    const timestamp = now()
    for (const record of unsynced) {
      await table.update((record as SyncFields).id, { synced_at: timestamp })
    }
    pushed += unsynced.length
  }

  return { pushed, errors }
}

/**
 * Pull all remote records updated since our last pull timestamp.
 * For each table, query Supabase for rows where updated_at > lastPull.
 * Insert or update them into local Dexie.
 */
export async function pullChanges(userId: string): Promise<{ pulled: number; errors: string[] }> {
  let pulled = 0
  const errors: string[] = []
  const lastPull = localStorage.getItem(LAST_PULL_KEY) ?? '1970-01-01T00:00:00.000Z'

  const groupIds = await getGroupIdsForUser(userId)

  for (const tableName of TABLE_NAMES) {
    try {
      const rows = await fetchRemoteRows(tableName, lastPull, userId, groupIds)
      if (rows.length === 0) continue

      const table = getLocalTable(tableName)

      for (const row of rows) {
        const existing = await table.get(row.id)
        if (existing) {
          const local = existing as SyncFields
          if (row.updated_at > local.updated_at) {
            await table.update(row.id, { ...row, synced_at: row.updated_at })
          }
        } else {
          await table.add({ ...row, synced_at: row.updated_at })
        }
      }

      pulled += rows.length
    } catch (err) {
      errors.push(`Pull ${tableName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  localStorage.setItem(LAST_PULL_KEY, now())
  return { pulled, errors }
}

async function getGroupIdsForUser(userId: string): Promise<string[]> {
  const { data } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('is_deleted', false)

  return (data ?? []).map((r) => r.group_id)
}

async function fetchRemoteRows(
  tableName: TableName,
  since: string,
  userId: string,
  groupIds: string[],
): Promise<SyncFields[]> {
  let query = supabase.from(tableName).select('*').gt('updated_at', since)

  switch (tableName) {
    case 'profiles':
      query = query.eq('id', userId)
      break
    case 'groups':
      if (groupIds.length === 0) return []
      query = query.in('id', groupIds)
      break
    case 'group_members':
      if (groupIds.length === 0) return []
      query = query.in('group_id', groupIds)
      break
    case 'bills':
      if (groupIds.length === 0) {
        query = query.eq('created_by', userId)
      } else {
        query = query.or(`created_by.eq.${userId},group_id.in.(${groupIds.join(',')})`)
      }
      break
    case 'bill_items': {
      const billIds = await getRelevantBillIds(userId, groupIds)
      if (billIds.length === 0) return []
      query = query.in('bill_id', billIds)
      break
    }
    case 'item_splits': {
      const itemIds = await getRelevantItemIds(userId, groupIds)
      if (itemIds.length === 0) return []
      query = query.in('item_id', itemIds)
      break
    }
    case 'settlements':
      if (groupIds.length === 0) return []
      query = query.in('group_id', groupIds)
      break
    case 'activity_log':
      if (groupIds.length === 0) {
        query = query.eq('user_id', userId)
      } else {
        query = query.or(`user_id.eq.${userId},group_id.in.(${groupIds.join(',')})`)
      }
      break
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as SyncFields[]
}

async function getRelevantBillIds(userId: string, groupIds: string[]): Promise<string[]> {
  let query = supabase.from('bills').select('id')
  if (groupIds.length === 0) {
    query = query.eq('created_by', userId)
  } else {
    query = query.or(`created_by.eq.${userId},group_id.in.(${groupIds.join(',')})`)
  }
  const { data } = await query
  return (data ?? []).map((r) => r.id)
}

async function getRelevantItemIds(userId: string, groupIds: string[]): Promise<string[]> {
  const billIds = await getRelevantBillIds(userId, groupIds)
  if (billIds.length === 0) return []
  const { data } = await supabase.from('bill_items').select('id').in('bill_id', billIds)
  return (data ?? []).map((r) => r.id)
}

export async function fullSync(userId: string): Promise<{
  pushed: number
  pulled: number
  errors: string[]
}> {
  const pushResult = await pushChanges()
  const pullResult = await pullChanges(userId)

  return {
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    errors: [...pushResult.errors, ...pullResult.errors],
  }
}
