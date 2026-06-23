import { type Table } from 'dexie'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { isRuntimeFlagEnabled } from '@/lib/runtime-flags'
import { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { now } from '@/lib/utils'
import type {
  ActivityLog,
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  Profile,
  ProfilePeerLink,
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

/** Prefer linked Kwenta account id for bill payers when available. */
export async function resolvePaidByForPush(localUserId: string): Promise<string> {
  const p = await db.profiles.get(localUserId)
  if (!p || p.is_deleted) {
    return localUserId
  }
  if (p.linked_profile_id) {
    return p.linked_profile_id
  }
  return localUserId
}

export { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'

/**
 * Confirm whether a row was successfully applied by the server in this sync.
 * Used to stamp synced_at only for rows the server actually stored (per the applied map from migration 044).
 * BACKWARD-COMPAT: if applied is undefined (older server pre-044), returns false so rows stay unsynced.
 */
export function isRowApplied(applied: Record<string, string[]> | undefined, table: string, id: string): boolean {
  return Array.isArray(applied?.[table]) && applied![table].includes(id)
}

/**
 * Decide whether to apply a pulled row over the local row during pull-apply.
 * Prevents mid-round-trip local edits from being clobbered by the pulled snapshot.
 *
 * Returns true (apply) if:
 * - No local row exists (brand new server row)
 * - Local row is synced (synced_at is not null and updated_at <= synced_at)
 * - Local row is unsynced BUT the server row is strictly newer
 *
 * Returns false (skip apply) if:
 * - Local row is unsynced AND the server row is older or same age
 *   (preserves the in-flight local edit for retry)
 */
export function shouldApplyPulledRow(
  local: { updated_at: string; synced_at: string | null } | undefined,
  pulledUpdatedAt: string,
): boolean {
  if (!local) return true
  const localUnsynced = local.synced_at === null || local.updated_at > local.synced_at
  if (!localUnsynced) return true
  // local has an unsynced edit; only let the server row win if it is strictly newer.
  return pulledUpdatedAt > local.updated_at
}

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
  'profile_peer_links',
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
    case 'profile_peer_links':
      return unsynced.filter((r) => (r as ProfilePeerLink).owner_user_id === userId)
    default:
      return unsynced
  }
}

/** True if the specific entity's local rows are still unsynced. Scoped strictly to the rows this
 *  mutation could have touched — it must NOT conflate an unrelated offline edit elsewhere with this
 *  mutation, or a change that synced fine gets surfaced as a false "could not be saved" conflict. */
export async function isEntityUnsyncedForActor(
  entityType: string,
  entityId: string | null | undefined,
  actorUserId: string,
): Promise<boolean> {
  const isUnsynced = (r: { synced_at: string | null; updated_at: string } | undefined) =>
    !!r && (r.synced_at === null || r.updated_at > r.synced_at)
  // No entity to scope to: the sync already returned no transport error, and the actor-global
  // check would flag this mutation for any unrelated unsynced row. Treat as not-stuck rather than
  // raise a false conflict; genuinely dropped writes are still caught by the per-row push retry.
  if (!entityId) return false
  switch (entityType) {
    case 'bill': {
      if (isUnsynced(await db.bills.get(entityId))) return true
      const items = await db.bill_items.where('bill_id').equals(entityId).toArray()
      if (items.some(isUnsynced)) return true
      for (const it of items) {
        const splits = await db.item_splits.where('item_id').equals(it.id).toArray()
        if (splits.some(isUnsynced)) return true
      }
      return false
    }
    case 'settlement':
      return isUnsynced(await db.settlements.get(entityId))
    case 'group':
      return isUnsynced(await db.groups.get(entityId))
    case 'profile': {
      // The profile row itself...
      if (isUnsynced(await db.profiles.get(entityId))) return true
      // ...and the deletePerson cascade: a soft-deleted membership / settlement / split that the
      // server silently dropped would otherwise let the mutation report "applied" while the
      // person resurfaces with stale balances elsewhere. Scoped to rows referencing this person.
      const memberships = await db.group_members.where('user_id').equals(entityId).toArray()
      if (memberships.some(isUnsynced)) return true
      const settlements = await db.settlements
        .filter((s) => s.from_user_id === entityId || s.to_user_id === entityId)
        .toArray()
      if (settlements.some(isUnsynced)) return true
      const splits = await db.item_splits.where('user_id').equals(entityId).toArray()
      if (splits.some(isUnsynced)) return true
      return false
    }
    default:
      // group_member and others use entityId semantics we can't reliably map to a single row;
      // fall back to the actor-global check so a genuinely dropped write is still caught.
      return hasUnsyncedLocalDataForUser(actorUserId)
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
    } else if (tableName === 'bills') {
      rowsToUpsert = await Promise.all(
        unsynced.map(async (r) => {
          const b = r as Bill
          const resolved = await resolvePaidByForPush(b.paid_by)
          return resolved === b.paid_by ? b : { ...b, paid_by: resolved }
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
    } else if (tableName === 'bills') {
      for (let i = 0; i < unsynced.length; i++) {
        const original = unsynced[i] as Bill
        const pushedRow = rowsToUpsert[i] as Bill
        const patch: Partial<Bill> & { synced_at: string } = { synced_at: timestamp }
        if (pushedRow.paid_by !== original.paid_by) patch.paid_by = pushedRow.paid_by
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
          // Same guard as syncRoundTrip's pull-apply: never clobber a newer unsynced local edit
          // with an older server snapshot. pullChanges is the realtime / RPC-missing fallback
          // path, so without this an in-flight local edit could vanish depending on which sync
          // path happened to fire.
          if (shouldApplyPulledRow(existing as { updated_at: string; synced_at: string | null }, row.updated_at)) {
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
    useAppStore.getState().setInitialCloudHydration('ready')
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
    case 'profile_peer_links':
      query = query.eq('owner_user_id', userId)
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
    } else if (tableName === 'bills') {
      unsynced = await Promise.all(
        unsynced.map(async (r) => {
          const b = r as Bill
          const resolved = await resolvePaidByForPush(b.paid_by)
          return resolved === b.paid_by ? b : { ...b, paid_by: resolved }
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

  // Stamp pushed rows as synced ONLY if the server applied them (per the applied map from migration 044).
  // BACKWARD-COMPAT: if applied is undefined (older server pre-044), stamp all (current behavior).
  // Rows NOT in applied stay unsynced and will retry on the next sync.
  // Then apply the pull bundle. The pull carries server-authoritative updated_at.
  const applied = (bundle as { applied?: Record<string, string[]> }).applied
  for (const tableName of TABLE_NAMES) {
    const pushedRows = pPush[tableName]
    if (!pushedRows?.length) continue
    const table = getLocalTable(tableName)
    for (const r of pushedRows) {
      const rowId = (r as SyncFields).id
      // BACKWARD-COMPAT: if applied is undefined, stamp all rows (old server behavior).
      const shouldStamp = applied === undefined || isRowApplied(applied, tableName, rowId)
      if (!shouldStamp) {
        // Row not applied: leave synced_at unchanged so it stays unsynced and retries.
        // Still preserve canonicalization write-backs for applied rows only.
        continue
      }
      const syncedAt = (r as SyncFields).updated_at
      if (tableName === 'item_splits') {
        const s = r as ItemSplit
        await table.update(s.id, { synced_at: syncedAt, user_id: s.user_id })
      } else if (tableName === 'settlements') {
        const s = r as Settlement
        await table.update(s.id, {
          synced_at: syncedAt,
          from_user_id: s.from_user_id,
          to_user_id: s.to_user_id,
        })
      } else if (tableName === 'group_members') {
        const gm = r as GroupMember
        await table.update(gm.id, { synced_at: syncedAt, user_id: gm.user_id })
      } else if (tableName === 'bills') {
        const b = r as Bill
        await table.update(b.id, { synced_at: syncedAt, paid_by: b.paid_by })
      } else {
        await table.update((r as SyncFields).id, { synced_at: syncedAt })
      }
    }
  }

  let pulled = 0
  for (const tableName of TABLE_NAMES) {
    const rows = bundle[tableName] as SyncFields[]
    const table = getLocalTable(tableName)
    for (const row of rows) {
      const existing = await table.get(row.id)
      if (existing) {
        // Guard: do not clobber a newer unsynced local edit made during the round-trip.
        if (shouldApplyPulledRow(existing, row.updated_at)) {
          await table.update(row.id, { ...row, synced_at: row.updated_at })
        }
      } else {
        await table.add({ ...row, synced_at: row.updated_at })
      }
    }
    pulled += rows.length
  }

  localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, now())
  useAppStore.getState().setInitialCloudHydration('ready')

  let pushedCount = 0
  for (const rows of Object.values(pPush)) {
    pushedCount += rows.length
  }

  return { pushed: pushedCount, pulled, errors: [] }
}
