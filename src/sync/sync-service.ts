import { type Table } from 'dexie'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { isRuntimeFlagEnabled } from '@/lib/runtime-flags'
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

/**
 * Prefer linked Kwenta account id when set; otherwise keep id.
 * Used for bill splits, settlements, and group_members so the server stores auth.profile ids.
 */
async function resolveSplitUserIdForPush(localUserId: string): Promise<string> {
  const p = await db.profiles.get(localUserId)
  if (!p || p.is_deleted) {
    return localUserId
  }
  if (p.linked_profile_id) {
    return p.linked_profile_id
  }
  return localUserId
}

/** Prefer linked Kwenta account id for settlement parties when available. */
async function resolveSettlementPartyIdForPush(localUserId: string): Promise<string> {
  const p = await db.profiles.get(localUserId)
  if (!p || p.is_deleted) {
    return localUserId
  }
  if (p.linked_profile_id) {
    return p.linked_profile_id
  }
  return localUserId
}

export const KWENTA_LAST_PULL_STORAGE_KEY = 'kwenta_last_pull'

/** Time since we last advanced `KWENTA_LAST_PULL_STORAGE_KEY` after a successful sync. */
export function getMillisecondsSinceLastPull(): number {
  const v = localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)
  if (!v) return Number.POSITIVE_INFINITY
  const t = Date.parse(v)
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, Date.now() - t)
}

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
type FullSyncResult = { pushed: number; pulled: number; errors: string[] }
const fullSyncInFlight = new Map<string, Promise<FullSyncResult>>()

function syncErrMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function isDatabaseClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.name === 'DatabaseClosedError' ||
    err.message.includes('DatabaseClosedError') ||
    err.message.includes('Database has been closed')
  )
}

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
    case 'profiles': {
      return unsynced.filter((r) => {
        const p = r as Profile
        if (p.id === userId) return true
        return Boolean(p.is_local && p.owner_id === userId)
      })
    }
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
  const startedAt = performance.now()
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

    let rowsToUpsert: SyncFields[] = unsynced

    if (tableName === 'item_splits') {
      rowsToUpsert = await Promise.all(
        unsynced.map(async (r) => {
          const split = r as ItemSplit
          const resolved = await resolveSplitUserIdForPush(split.user_id)
          return resolved === split.user_id ? split : { ...split, user_id: resolved }
        }),
      )
    } else if (tableName === 'settlements') {
      rowsToUpsert = await Promise.all(
        unsynced.map(async (r) => {
          const s = r as Settlement
          const [fromResolved, toResolved] = await Promise.all([
            resolveSettlementPartyIdForPush(s.from_user_id),
            resolveSettlementPartyIdForPush(s.to_user_id),
          ])
          if (fromResolved === s.from_user_id && toResolved === s.to_user_id) return s
          return { ...s, from_user_id: fromResolved, to_user_id: toResolved }
        }),
      )
    } else if (tableName === 'group_members') {
      rowsToUpsert = await Promise.all(
        unsynced.map(async (r) => {
          const gm = r as GroupMember
          const resolved = await resolveSplitUserIdForPush(gm.user_id)
          return resolved === gm.user_id ? gm : { ...gm, user_id: resolved }
        }),
      )
    }

    const { error } = await supabase.from(tableName).upsert(rowsToUpsert, {
      onConflict: 'id',
      ignoreDuplicates: false,
    })

    if (error) {
      errors.push(`Push ${tableName}: ${error.message}`)
      continue
    }

    const timestamp = now()
    if (tableName === 'item_splits') {
      for (let i = 0; i < unsynced.length; i++) {
        const original = unsynced[i] as ItemSplit
        const pushed = rowsToUpsert[i] as ItemSplit
        const patch: Partial<ItemSplit> & { synced_at: string } = { synced_at: timestamp }
        if (pushed.user_id !== original.user_id) {
          patch.user_id = pushed.user_id
        }
        await table.update(original.id, patch)
      }
    } else if (tableName === 'settlements') {
      for (let i = 0; i < unsynced.length; i++) {
        const original = unsynced[i] as Settlement
        const pushedRow = rowsToUpsert[i] as Settlement
        const patch: Partial<Settlement> & { synced_at: string } = { synced_at: timestamp }
        if (pushedRow.from_user_id !== original.from_user_id) patch.from_user_id = pushedRow.from_user_id
        if (pushedRow.to_user_id !== original.to_user_id) patch.to_user_id = pushedRow.to_user_id
        await table.update(original.id, patch)
      }
    } else if (tableName === 'group_members') {
      for (let i = 0; i < unsynced.length; i++) {
        const original = unsynced[i] as GroupMember
        const pushed = rowsToUpsert[i] as GroupMember
        const patch: Partial<GroupMember> & { synced_at: string } = { synced_at: timestamp }
        if (pushed.user_id !== original.user_id) {
          patch.user_id = pushed.user_id
        }
        await table.update(original.id, patch)
      }
    } else {
      for (const record of unsynced) {
        await table.update((record as SyncFields).id, { synced_at: timestamp })
      }
    }
    pushed += unsynced.length
  }

  captureMetric('sync.pushChanges', errors.length === 0, performance.now() - startedAt, { pushed, errors: errors.length })
  return { pushed, errors }
}

export type PullPrefetchContext = {
  groupIds: string[]
  billIds: string[]
  itemIds: string[]
}

/** Fetch group ids + bill/item ids once per pull (avoids duplicate RPCs). */
export async function prefetchPullContext(userId: string): Promise<PullPrefetchContext> {
  const groupIds = await getGroupIdsForUser(userId)
  const billIds = await getRelevantBillIds(userId)
  let itemIds: string[] = []
  if (billIds.length > 0) {
    const { data, error } = await supabase.from('bill_items').select('id').in('bill_id', billIds)
    if (error) throw error
    itemIds = (data ?? []).map((r) => r.id)
  }
  return { groupIds, billIds, itemIds }
}

/**
 * Pull all remote records updated since our last pull timestamp.
 * Insert or update them into local Dexie.
 * Does not advance last-pull time unless every table pull succeeds.
 */
export async function pullChanges(userId: string): Promise<{ pulled: number; errors: string[] }> {
  const startedAt = performance.now()
  let pulled = 0
  const errors: string[] = []
  const lastPull = localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY) ?? '1970-01-01T00:00:00.000Z'

  const prefetch = await prefetchPullContext(userId)

  for (const tableName of TABLE_NAMES) {
    try {
      const rows = await fetchRemoteRows(tableName, lastPull, userId, prefetch)
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
      if (isDatabaseClosedError(err)) {
        // Sign-out/local clear can close Dexie while a pull is in-flight. Treat as cancelled.
        return { pulled, errors }
      }
      errors.push(`Pull ${tableName}: ${syncErrMessage(err)}`)
    }
  }

  if (errors.length === 0) {
    localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, now())
  }

  captureMetric('sync.pullChanges', errors.length === 0, performance.now() - startedAt, { pulled, errors: errors.length })
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
  prefetch: PullPrefetchContext,
): Promise<SyncFields[]> {
  const { groupIds, billIds, itemIds } = prefetch
  let query = supabase.from(tableName).select('*').gt('updated_at', since)

  switch (tableName) {
    case 'profiles': {
      const { data: ownRow, error: e1 } = await supabase
        .from('profiles')
        .select('*')
        .gt('updated_at', since)
        .eq('id', userId)
      if (e1) throw e1
      const { data: ownedLocals, error: e2 } = await supabase
        .from('profiles')
        .select('*')
        .gt('updated_at', since)
        .eq('owner_id', userId)
        .eq('is_local', true)
      if (e2) throw e2
      const merged = [...(ownRow ?? []), ...(ownedLocals ?? [])]
      const dedup = new Map<string, SyncFields>()
      for (const r of merged) {
        const id = (r as Profile).id
        const prev = dedup.get(id)
        if (!prev || (r as SyncFields).updated_at > prev.updated_at) {
          dedup.set(id, r as SyncFields)
        }
      }
      return [...dedup.values()]
    }
    case 'groups': {
      if (groupIds.length === 0) return []
      const { data: incGroups, error: eGroupsInc } = await supabase
        .from('groups')
        .select('*')
        .in('id', groupIds)
        .gt('updated_at', since)
      if (eGroupsInc) throw eGroupsInc
      const { data: recentMemberships, error: eRecentGm } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('user_id', userId)
        .eq('is_deleted', false)
        .gt('updated_at', since)
      if (eRecentGm) throw eRecentGm
      const recentGroupIds = [
        ...new Set((recentMemberships ?? []).map((r) => r.group_id).filter((gid) => groupIds.includes(gid))),
      ]
      let extraGroups: SyncFields[] = []
      if (recentGroupIds.length > 0) {
        const { data: fullGroups, error: eGroupsFull } = await supabase
          .from('groups')
          .select('*')
          .in('id', recentGroupIds)
        if (eGroupsFull) throw eGroupsFull
        extraGroups = (fullGroups ?? []) as SyncFields[]
      }
      const dedup = new Map<string, SyncFields>()
      for (const r of [...(incGroups ?? []), ...extraGroups]) {
        const row = r as SyncFields
        const prev = dedup.get(row.id)
        if (!prev || row.updated_at > prev.updated_at) dedup.set(row.id, row)
      }
      return [...dedup.values()]
    }
    case 'group_members': {
      const { data: myMembershipRows, error: eMine } = await supabase
        .from('group_members')
        .select('*')
        .eq('user_id', userId)
        .gt('updated_at', since)
      if (eMine) throw eMine
      let inActiveGroups: SyncFields[] = []
      if (groupIds.length > 0) {
        const { data: gRows, error: eG } = await supabase
          .from('group_members')
          .select('*')
          .in('group_id', groupIds)
          .gt('updated_at', since)
        if (eG) throw eG
        inActiveGroups = (gRows ?? []) as SyncFields[]
      }
      const dedupGm = new Map<string, SyncFields>()
      for (const r of [...(myMembershipRows ?? []), ...inActiveGroups]) {
        const row = r as SyncFields
        const prev = dedupGm.get(row.id)
        if (!prev || row.updated_at > prev.updated_at) dedupGm.set(row.id, row)
      }
      return [...dedupGm.values()]
    }
    case 'bills': {
      const { data: rpcRows, error: rpcError } = await supabase.rpc('bills_for_sync', {
        p_since: since,
      })
      if (rpcError) throw rpcError
      return (rpcRows ?? []) as SyncFields[]
    }
    case 'bill_items': {
      if (billIds.length === 0) return []
      query = query.in('bill_id', billIds)
      break
    }
    case 'item_splits': {
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

async function getRelevantBillIds(userId: string): Promise<string[]> {
  void userId
  const { data, error } = await supabase.rpc('relevant_bill_ids_for_user')
  if (error) throw error
  return (data ?? []).map((r: { id: string }) => r.id)
}

export async function fullSync(userId: string): Promise<FullSyncResult> {
  if (isRuntimeFlagEnabled('dedupeSyncEnabled')) {
    const running = fullSyncInFlight.get(userId)
    if (running) return running
  }

  const job = withMetric('sync.fullSync', async () => {
    const roundTrip = await syncRoundTrip(userId)
    return {
      pushed: roundTrip.pushed,
      pulled: roundTrip.pulled,
      errors: roundTrip.errors,
    }
  })

  if (!isRuntimeFlagEnabled('dedupeSyncEnabled')) {
    return job
  }

  fullSyncInFlight.set(userId, job)
  try {
    return await job
  } finally {
    fullSyncInFlight.delete(userId)
  }
}

type KwentaSyncPullBundle = Record<(typeof TABLE_NAMES)[number], unknown[]>

function isPullBundle(x: unknown): x is KwentaSyncPullBundle {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return TABLE_NAMES.every((t) => Array.isArray(o[t]))
}

/**
 * One RPC: apply push payload on the server, return all visible rows changed since `since`.
 * Falls back to pushChanges + pullChanges if the RPC is missing (older DB).
 */
export async function syncRoundTrip(userId: string): Promise<{
  pushed: number
  pulled: number
  errors: string[]
}> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.user?.id) {
    return { pushed: 0, pulled: 0, errors: ['Sync skipped: not signed in'] }
  }

  const lastPull = localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY) ?? '1970-01-01T00:00:00.000Z'

  let ctx: PushFilterContext
  try {
    ctx = await buildPushFilterContext(userId)
  } catch (err) {
    if (isDatabaseClosedError(err)) return { pushed: 0, pulled: 0, errors: [] }
    return { pushed: 0, pulled: 0, errors: [syncErrMessage(err)] }
  }
  const pPush: Record<string, SyncFields[]> = {}

  for (const tableName of TABLE_NAMES) {
    const table = getLocalTable(tableName)
    let allRecords: SyncFields[]
    try {
      allRecords = await table.toArray()
    } catch (err) {
      if (isDatabaseClosedError(err)) return { pushed: 0, pulled: 0, errors: [] }
      return { pushed: 0, pulled: 0, errors: [syncErrMessage(err)] }
    }
    const unsyncedRaw = allRecords.filter((r: SyncFields) => {
      if (r.synced_at === null) return true
      return r.updated_at > r.synced_at
    })
    let unsynced = filterUnsyncedForPush(tableName, unsyncedRaw, userId, ctx)
    if (tableName === 'item_splits') {
      unsynced = await Promise.all(
        unsynced.map(async (r) => {
          const split = r as ItemSplit
          const resolved = await resolveSplitUserIdForPush(split.user_id)
          return resolved === split.user_id ? split : { ...split, user_id: resolved }
        }),
      )
    } else if (tableName === 'settlements') {
      unsynced = await Promise.all(
        unsynced.map(async (r) => {
          const s = r as Settlement
          const [fromResolved, toResolved] = await Promise.all([
            resolveSettlementPartyIdForPush(s.from_user_id),
            resolveSettlementPartyIdForPush(s.to_user_id),
          ])
          if (fromResolved === s.from_user_id && toResolved === s.to_user_id) return s
          return { ...s, from_user_id: fromResolved, to_user_id: toResolved }
        }),
      )
    } else if (tableName === 'group_members') {
      unsynced = await Promise.all(
        unsynced.map(async (r) => {
          const gm = r as GroupMember
          const resolved = await resolveSplitUserIdForPush(gm.user_id)
          return resolved === gm.user_id ? gm : { ...gm, user_id: resolved }
        }),
      )
    }
    if (unsynced.length > 0) {
      pPush[tableName] = unsynced
    }
  }

  const { data: bundle, error: rpcError } = await withMetric(
    'sync.kwentaSyncRpc',
    () =>
      supabase.rpc('kwenta_sync', {
        p_since: lastPull,
        p_push: pPush,
      }),
    { hasPushPayload: Object.keys(pPush).length > 0 },
  )

  if (rpcError) {
    const code = 'code' in rpcError ? String((rpcError as { code?: string }).code) : ''
    const msg = rpcError.message ?? ''
    if (code === 'PGRST202' || /does not exist/i.test(msg)) {
      const pushResult = await pushChanges()
      const pullResult = await pullChanges(userId)
      return {
        pushed: pushResult.pushed,
        pulled: pullResult.pulled,
        errors: [...pushResult.errors, ...pullResult.errors],
      }
    }
    return { pushed: 0, pulled: 0, errors: [`kwenta_sync: ${syncErrMessage(rpcError)}`] }
  }

  if (!isPullBundle(bundle)) {
    return { pushed: 0, pulled: 0, errors: ['kwenta_sync: invalid response shape'] }
  }

  let pulled = 0
  for (const tableName of TABLE_NAMES) {
    const rows = bundle[tableName] as SyncFields[]
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
  }

  const timestamp = now()
  for (const tableName of TABLE_NAMES) {
    const pushedRows = pPush[tableName]
    if (!pushedRows?.length) continue
    const table = getLocalTable(tableName)
    for (const r of pushedRows) {
      if (tableName === 'item_splits') {
        const s = r as ItemSplit
        await table.update(s.id, { synced_at: timestamp, user_id: s.user_id })
      } else if (tableName === 'settlements') {
        const s = r as Settlement
        await table.update(s.id, {
          synced_at: timestamp,
          from_user_id: s.from_user_id,
          to_user_id: s.to_user_id,
        })
      } else if (tableName === 'group_members') {
        const gm = r as GroupMember
        await table.update(gm.id, { synced_at: timestamp, user_id: gm.user_id })
      } else {
        await table.update((r as SyncFields).id, { synced_at: timestamp })
      }
    }
  }

  localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, now())

  let pushedCount = 0
  for (const rows of Object.values(pPush)) {
    pushedCount += rows.length
  }

  return { pushed: pushedCount, pulled, errors: [] }
}
