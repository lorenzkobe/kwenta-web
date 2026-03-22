import { type Table } from 'dexie'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { now } from '@/lib/utils'
import type {
  ActivityLog,
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  Profile,
  Settlement,
  SyncFields,
} from '@/types'

export const KWENTA_LAST_PULL_STORAGE_KEY = 'kwenta_last_pull'

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

type PushFilterContext = {
  groupsICreated: Set<string>
  memberGroupIds: Set<string>
  allowedBillIds: Set<string>
  allowedItemIds: Set<string>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLocalTable(name: TableName): Table<any, string> {
  return db[name]
}

/** Rows the current user is allowed to upsert per Supabase RLS (not every local row). */
async function buildPushFilterContext(userId: string): Promise<PushFilterContext> {
  const allGroups = await db.groups.toArray()
  const groupsICreated = new Set(
    allGroups.filter((g) => !g.is_deleted && g.created_by === userId).map((g) => g.id),
  )

  const allMemberships = await db.group_members.where('user_id').equals(userId).toArray()
  const memberGroupIds = new Set(
    allMemberships.filter((m) => !m.is_deleted).map((m) => m.group_id),
  )

  const allBills = await db.bills.toArray()
  const allowedBillIds = new Set<string>()
  for (const b of allBills) {
    if (b.created_by === userId) {
      allowedBillIds.add(b.id)
      continue
    }
    if (b.group_id && memberGroupIds.has(b.group_id)) {
      allowedBillIds.add(b.id)
    }
  }

  const allBillItems = await db.bill_items.toArray()
  const allowedItemIds = new Set<string>()
  for (const bi of allBillItems) {
    if (allowedBillIds.has(bi.bill_id)) {
      allowedItemIds.add(bi.id)
    }
  }

  return { groupsICreated, memberGroupIds, allowedBillIds, allowedItemIds }
}

function filterUnsyncedForPush(
  tableName: TableName,
  unsynced: SyncFields[],
  userId: string,
  ctx: PushFilterContext,
): SyncFields[] {
  switch (tableName) {
    case 'profiles':
      return unsynced.filter((r) => (r as Profile).id === userId)
    case 'groups':
      return unsynced.filter((r) => (r as Group).created_by === userId)
    case 'group_members': {
      return unsynced.filter((r) => {
        const gm = r as GroupMember
        return ctx.groupsICreated.has(gm.group_id) || gm.user_id === userId
      })
    }
    case 'bills':
      return unsynced.filter((r) => ctx.allowedBillIds.has((r as Bill).id))
    case 'bill_items':
      return unsynced.filter((r) => ctx.allowedBillIds.has((r as BillItem).bill_id))
    case 'item_splits':
      return unsynced.filter((r) => ctx.allowedItemIds.has((r as ItemSplit).item_id))
    case 'settlements':
      return unsynced.filter((r) => {
        const s = r as Settlement
        if (s.group_id) {
          return ctx.memberGroupIds.has(s.group_id)
        }
        return s.from_user_id === userId || s.to_user_id === userId
      })
    case 'activity_log':
      return unsynced.filter((r) => {
        const a = r as ActivityLog
        if (a.user_id === userId) return true
        if (a.group_id && ctx.memberGroupIds.has(a.group_id)) return true
        return false
      })
    default:
      return unsynced
  }
}

/** True if this user has local rows that still need a successful cloud push. */
export async function hasUnsyncedLocalDataForUser(userId: string): Promise<boolean> {
  const ctx = await buildPushFilterContext(userId)
  for (const tableName of TABLE_NAMES) {
    const table = getLocalTable(tableName)
    const allRecords = await table.toArray()
    const unsyncedRaw = allRecords.filter((r: SyncFields) => {
      if (r.synced_at === null) return true
      return r.updated_at > r.synced_at
    })
    const unsynced = filterUnsyncedForPush(tableName, unsyncedRaw, userId, ctx)
    if (unsynced.length > 0) return true
  }
  return false
}

/**
 * Push locally unsynced records the current user may write under RLS.
 * A record is unsynced if synced_at is null OR updated_at > synced_at.
 */
export async function pushChanges(): Promise<{ pushed: number; errors: string[] }> {
  let pushed = 0
  const errors: string[] = []

  const {
    data: { session },
  } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) {
    return { pushed: 0, errors: ['Push skipped: not signed in'] }
  }

  const ctx = await buildPushFilterContext(userId)

  for (const tableName of TABLE_NAMES) {
    const table = getLocalTable(tableName)
    const allRecords = await table.toArray()

    const unsyncedRaw = allRecords.filter((r: SyncFields) => {
      if (r.synced_at === null) return true
      return r.updated_at > r.synced_at
    })

    const unsynced = filterUnsyncedForPush(tableName, unsyncedRaw, userId, ctx)

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
  const lastPull = localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY) ?? '1970-01-01T00:00:00.000Z'

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

  localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, now())
  return { pulled, errors }
}

async function fetchSettlementRows(
  since: string,
  userId: string,
  groupIds: string[],
): Promise<SyncFields[]> {
  const rows: SyncFields[] = []
  if (groupIds.length > 0) {
    const { data: g, error: e1 } = await supabase
      .from('settlements')
      .select('*')
      .gt('updated_at', since)
      .in('group_id', groupIds)
    if (e1) throw e1
    if (g) rows.push(...(g as SyncFields[]))
  }
  const { data: p, error: e2 } = await supabase
    .from('settlements')
    .select('*')
    .gt('updated_at', since)
    .is('group_id', null)
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
  if (e2) throw e2
  if (p) rows.push(...(p as SyncFields[]))
  const dedup = new Map<string, SyncFields>()
  for (const r of rows) {
    const id = (r as SyncFields).id
    const prev = dedup.get(id)
    if (!prev || (r as SyncFields).updated_at > prev.updated_at) {
      dedup.set(id, r as SyncFields)
    }
  }
  return [...dedup.values()]
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
      return await fetchSettlementRows(since, userId, groupIds)
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
