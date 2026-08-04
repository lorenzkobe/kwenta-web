import { type Table } from 'dexie'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { isRuntimeFlagEnabled } from '@/lib/runtime-flags'
import { KWENTA_LAST_REFRESH_STORAGE_KEY, readLastRefreshAt } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { describeError, now } from '@/lib/utils'
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
export async function resolveSplitUserIdForPush(localUserId: string): Promise<string> {
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
export async function resolveSettlementPartyIdForPush(localUserId: string): Promise<string> {
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

export { KWENTA_LAST_REFRESH_STORAGE_KEY } from '@/lib/kwenta-storage-keys'

/**
 * Every pull asks for the COMPLETE bundle, never a delta.
 *
 * Cloud-first: the server is the truth and the client holds a mirror, so each refresh replaces
 * that mirror wholesale. The old incremental cursor was stamped from the device clock after the
 * query ran, so clock skew (or a row written mid-round-trip) permanently skipped rows, and a
 * server-side change that did not bump the client-written `updated_at` could never reach any
 * device — the cache could only be repaired by wiping it. A complete bundle is a true snapshot
 * because nothing is ever hard-deleted: soft-deleted rows are still sent, so absence from the
 * bundle carries no meaning and no local pruning is required.
 */
export const PULL_SINCE_EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * PostgREST truncates every response at its configured max-rows (1000 on Supabase by default) and
 * reports no error when it does. With the cursor gone every fallback query asks for the caller's
 * whole history, so any table past that cap came back silently short while the pull still reported
 * success and stamped the refresh marker. Page through explicitly instead.
 */
export const PULL_PAGE_SIZE = 1000

type RangeableQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
}

/**
 * Run a PostgREST query to exhaustion. `build` must apply a deterministic order (`id`), otherwise
 * successive ranges may overlap or skip rows.
 *
 * Exported for direct unit testing: proving the loop through a full `pullChanges` requires writing
 * thousands of rows into IndexedDB, which is slow enough to make the test timing-dependent.
 */
export async function fetchAllPages<T>(build: () => RangeableQuery<T>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PULL_PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PULL_PAGE_SIZE - 1)
    if (error) throw error
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PULL_PAGE_SIZE) return out
  }
}

/** Record that a full refresh completed (display/scheduling only — never a query filter). */
export function markRefreshed(): void {
  localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, now())
  useAppStore.getState().setInitialCloudHydration('ready')
}

/**
 * Confirm whether a row was successfully applied by the server in this sync.
 * Used to stamp synced_at only for rows the server actually stored (per the applied map from migration 044).
 * BACKWARD-COMPAT: if applied is undefined (older server pre-044), returns false so rows stay unsynced.
 */
export function isRowApplied(applied: Record<string, string[]> | undefined, table: string, id: string): boolean {
  return Array.isArray(applied?.[table]) && applied![table].includes(id)
}

/**
 * Compare two ISO timestamps as instants, never as text.
 *
 * Postgres renders timestamptz through `to_jsonb` as `2026-08-03T15:04:05.123+00:00`; the client
 * writes `Date.toISOString()`, i.e. `2026-08-03T15:04:05.123Z`. Those are the same instant and
 * different strings, and `'+' (0x2B) < 'Z' (0x5A)` — so a lexicographic compare ranks EVERY
 * server echo below the local copy it echoes. Anything gated on `serverTs > localTs` then silently
 * never fires. Returns 0 for unparseable input so a malformed value is treated as "same age"
 * rather than as older/newer by accident.
 */
export function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
  return ta === tb ? 0 : ta < tb ? -1 : 1
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
  const localUnsynced = local.synced_at === null || compareTimestamps(local.updated_at, local.synced_at) > 0
  if (!localUnsynced) return true
  // local has an unsynced edit; only let the server row win if it is strictly newer.
  return compareTimestamps(pulledUpdatedAt, local.updated_at) > 0
}

/**
 * Time since the last successful full refresh. Used only to schedule the backup sync and to show
 * staleness — never to filter a query, so device-clock error can delay a refresh but can never
 * hide a row.
 */
export function getMillisecondsSinceLastRefresh(): number {
  const v = readLastRefreshAt()
  if (!v) return Number.POSITIVE_INFINITY
  const t = Date.parse(v)
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, Date.now() - t)
}

export const TABLE_NAMES = [
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

export type TableName = (typeof TABLE_NAMES)[number]
type FullSyncResult = { pushed: number; pulled: number; errors: string[] }
const fullSyncInFlight = new Map<string, Promise<FullSyncResult>>()

export function syncErrMessage(err: unknown): string {
  // Shared with the UI error paths: Supabase hands back PostgrestError as a plain object, so an
  // `instanceof Error` test alone loses the server's message.
  return describeError(err, (() => {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  })())
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
export function getLocalTable(name: TableName): Table<any, string> {
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
    const rows = await fetchAllPages<{ id: string }>(() =>
      supabase.from('bill_items').select('id').in('bill_id', billIds).order('id'),
    )
    itemIds = rows.map((r) => r.id)
  }
  return { groupIds, billIds, itemIds }
}

/**
 * Pull the caller's COMPLETE remote record set (see {@link PULL_SINCE_EPOCH}) and mirror it into
 * Dexie. Fallback path used when the `kwenta_sync` RPC is unavailable and by realtime recovery.
 * Does not mark the refresh complete unless every table pull succeeds.
 */
export async function pullChanges(userId: string): Promise<{ pulled: number; errors: string[] }> {
  const startedAt = performance.now()
  let pulled = 0
  const errors: string[] = []

  // Report a prefetch failure through the result instead of throwing out of the function: callers
  // (realtime recovery) invoke this from their own catch blocks, and `getGroupIdsForUser` used to
  // swallow query errors and return an empty group list — which reads as "you are in no groups"
  // and quietly pulls none of that data. Failing loudly is right; failing past the contract is not.
  let prefetch: PullPrefetchContext
  try {
    prefetch = await prefetchPullContext(userId)
  } catch (err) {
    if (isDatabaseClosedError(err)) return { pulled, errors }
    errors.push(`Pull context: ${syncErrMessage(err)}`)
    captureMetric('sync.pullChanges', false, performance.now() - startedAt, { pulled, errors: errors.length })
    return { pulled, errors }
  }

  for (const tableName of TABLE_NAMES) {
    try {
      const rows = await fetchRemoteRows(tableName, userId, prefetch)
      if (rows.length === 0) continue

      const table = getLocalTable(tableName)

      // Same guard as syncRoundTrip's pull-apply: never clobber a newer unsynced local edit with
      // an older server snapshot. pullChanges is the realtime / RPC-missing fallback path, so
      // without this an in-flight local edit could vanish depending on which sync path fired.
      // Batched for the same reason as there — this now carries the caller's whole history.
      const existingRows = await table.bulkGet(rows.map((r) => r.id))
      const toPut: SyncFields[] = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const existing = existingRows[i] as { updated_at: string; synced_at: string | null } | undefined
        if (!shouldApplyPulledRow(existing, row.updated_at)) continue
        toPut.push({ ...(existing ?? {}), ...row, synced_at: row.updated_at })
      }
      if (toPut.length > 0) await table.bulkPut(toPut)

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
    markRefreshed()
  }

  captureMetric('sync.pullChanges', errors.length === 0, performance.now() - startedAt, { pulled, errors: errors.length })
  return { pulled, errors }
}

async function fetchSettlementRows(
  userId: string,
  groupIds: string[],
): Promise<SyncFields[]> {
  const rows: SyncFields[] = []
  if (groupIds.length > 0) {
    rows.push(
      ...(await fetchAllPages<SyncFields>(() =>
        supabase
          .from('settlements')
          .select('*')
          .in('group_id', groupIds)
          .order('id'),
      )),
    )
  }
  // Literal id match only. The `kwenta_sync` RPC — the primary path — routes personal rows by
  // identity (account + local contacts linked to it, migration 049); this PostgREST fallback
  // cannot, because a device never holds another user's local contacts (the pull-bundle privacy
  // boundary), so it cannot compute its own identity set. A row still filed under a
  // not-yet-canonicalized contact id is therefore delivered by the next round trip rather than by
  // this recovery path.
  rows.push(
    ...(await fetchAllPages<SyncFields>(() =>
      supabase
        .from('settlements')
        .select('*')
        .is('group_id', null)
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
        .order('id'),
    )),
  )
  // The two queries are disjoint (group_id null vs not null); dedup only guards against a row
  // being re-classified between them.
  const dedup = new Map<string, SyncFields>()
  for (const r of rows) {
    const prev = dedup.get(r.id)
    if (!prev || compareTimestamps(r.updated_at, prev.updated_at) > 0) {
      dedup.set(r.id, r)
    }
  }
  return [...dedup.values()]
}

async function getGroupIdsForUser(userId: string): Promise<string[]> {
  const rows = await fetchAllPages<{ group_id: string }>(() =>
    supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .order('group_id'),
  )
  return rows.map((r) => r.group_id)
}

/**
 * Fetch a table's COMPLETE remote row set for this user.
 *
 * There is deliberately no `since` parameter and no `updated_at` filter. This used to take one, and
 * every caller passed the epoch — which made the filter always true and left the shape of a delta
 * cursor sitting in the code for someone to "optimise" back into a real one. That cursor was
 * stamped from the device clock, so skew silently and permanently skipped rows (see
 * {@link PULL_SINCE_EPOCH}). Removing the parameter makes "reads are always complete" structural
 * rather than a convention every future caller has to know about.
 */
async function fetchRemoteRows(
  tableName: TableName,
  userId: string,
  prefetch: PullPrefetchContext,
): Promise<SyncFields[]> {
  const { groupIds, billIds, itemIds } = prefetch
  // A factory, not a builder: paging calls `.range()` once per page, and a PostgREST builder is a
  // one-shot thenable — reusing the same instance across pages would re-await a settled request.
  const baseQuery = () => supabase.from(tableName).select('*').order('id')
  type TableQuery = ReturnType<typeof baseQuery>
  let applyFilter: ((q: TableQuery) => TableQuery) | null = null

  switch (tableName) {
    case 'profiles': {
      const ownRow = await fetchAllPages<SyncFields>(() =>
        supabase.from('profiles').select('*').eq('id', userId).order('id'),
      )
      const ownedLocals = await fetchAllPages<SyncFields>(() =>
        supabase
          .from('profiles')
          .select('*')
          .eq('owner_id', userId)
          .eq('is_local', true)
          .order('id'),
      )
      return dedupeById([...ownRow, ...ownedLocals])
    }
    case 'groups': {
      if (groupIds.length === 0) return []
      // One query. The second pass this used to make — re-fetching every group whose membership
      // row had changed since the cursor — existed only to defeat the delta cursor: a group row
      // that had not itself changed would not come back on its own. Pulls are unconditional now,
      // so the first query already returns every one of the user's groups and that pass re-fetched
      // an identical set, leaving the dedup map to collapse only duplicates the code itself made.
      return await fetchAllPages<SyncFields>(() =>
        supabase.from('groups').select('*').in('id', groupIds).order('id'),
      )
    }
    case 'group_members': {
      const myMembershipRows = await fetchAllPages<SyncFields>(() =>
        supabase.from('group_members').select('*').eq('user_id', userId).order('id'),
      )
      let inActiveGroups: SyncFields[] = []
      if (groupIds.length > 0) {
        inActiveGroups = await fetchAllPages<SyncFields>(() =>
          supabase
            .from('group_members')
            .select('*')
            .in('group_id', groupIds)
            .order('id'),
        )
      }
      // Genuinely overlapping: my own row inside one of my active groups matches both queries.
      return dedupeById([...myMembershipRows, ...inActiveGroups])
    }
    case 'bills': {
      return await fetchAllPages<SyncFields>(() =>
        supabase.rpc('bills_for_sync', { p_since: PULL_SINCE_EPOCH }).order('id'),
      )
    }
    case 'bill_items': {
      if (billIds.length === 0) return []
      applyFilter = (q) => q.in('bill_id', billIds)
      break
    }
    case 'item_splits': {
      if (itemIds.length === 0) return []
      applyFilter = (q) => q.in('item_id', itemIds)
      break
    }
    case 'settlements':
      return await fetchSettlementRows(userId, groupIds)
    case 'activity_log':
      applyFilter =
        groupIds.length === 0
          ? (q) => q.eq('user_id', userId)
          : (q) => q.or(`user_id.eq.${userId},group_id.in.(${groupIds.join(',')})`)
      break
    case 'profile_peer_links':
      applyFilter = (q) => q.eq('owner_user_id', userId)
      break
  }

  return await fetchAllPages<SyncFields>(() => {
    const q = baseQuery()
    return applyFilter ? applyFilter(q) : q
  })
}

/** Keep the newest copy of each id across overlapping queries. */
function dedupeById(rows: SyncFields[]): SyncFields[] {
  const dedup = new Map<string, SyncFields>()
  for (const row of rows) {
    const prev = dedup.get(row.id)
    if (!prev || compareTimestamps(row.updated_at, prev.updated_at) > 0) dedup.set(row.id, row)
  }
  return [...dedup.values()]
}

async function getRelevantBillIds(userId: string): Promise<string[]> {
  void userId
  const rows = await fetchAllPages<{ id: string }>(() =>
    supabase.rpc('relevant_bill_ids_for_user').order('id'),
  )
  return rows.map((r) => r.id)
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

export function isPullBundle(x: unknown): x is KwentaSyncPullBundle {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return TABLE_NAMES.every((t) => Array.isArray(o[t]))
}

/**
 * One RPC: apply the push payload on the server, then return the caller's COMPLETE visible row
 * set (see {@link PULL_SINCE_EPOCH}) and mirror it into Dexie.
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
        p_since: PULL_SINCE_EPOCH,
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

  // Index the bundle by id per table once. Used twice below: to decide whether a pushed row was
  // really stored, and to apply the pull.
  const bundleRowsById = new Map<TableName, Map<string, SyncFields>>()
  for (const tableName of TABLE_NAMES) {
    const byId = new Map<string, SyncFields>()
    for (const row of (bundle[tableName] as SyncFields[]) ?? []) byId.set(row.id, row)
    bundleRowsById.set(tableName, byId)
  }

  // Stamp pushed rows as synced ONLY on evidence that the server stored them.
  //
  // With migration 044 the server says so outright via the `applied` map. Against an older server
  // (`applied === undefined`) the honest evidence is the echo in this same bundle: the bundle is
  // the caller's COMPLETE row set, so anything the server accepted comes back at least as new as
  // what we sent. Stamping unconditionally there — the previous behaviour — marks a SILENTLY
  // DROPPED push (validator or RLS rejection) as synced. The row then stops being re-pushed, so on
  // the next round trip nothing guards it, and the complete bundle overwrites the local row with
  // the server's older copy: the user's edit disappears one sync later. Under the old incremental
  // cursor that stale copy was never sent, which is why this only surfaces now.
  const applied = (bundle as { applied?: Record<string, string[]> }).applied
  for (const tableName of TABLE_NAMES) {
    const pushedRows = pPush[tableName]
    if (!pushedRows?.length) continue
    const table = getLocalTable(tableName)
    const echoedRows = bundleRowsById.get(tableName)
    for (const r of pushedRows) {
      const rowId = (r as SyncFields).id
      const syncedAt = (r as SyncFields).updated_at
      const echo = echoedRows?.get(rowId)
      const shouldStamp =
        applied !== undefined
          ? isRowApplied(applied, tableName, rowId)
          : echo !== undefined && compareTimestamps(echo.updated_at, syncedAt) >= 0
      if (!shouldStamp) {
        // Not stored (or not provably stored): leave synced_at alone so the row stays unsynced
        // and retries on the next round trip.
        continue
      }
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
    const rows = (bundle[tableName] as SyncFields[]) ?? []
    pulled += rows.length
    if (rows.length === 0) continue
    const table = getLocalTable(tableName)
    // What we sent for each row this round trip. The bundle carries the caller's COMPLETE row set
    // (not just rows newer than a cursor), so the server's copy of everything we just pushed comes
    // back on every sync — including a copy that predates our push if the server silently dropped
    // it. Refusing to apply an echo older than what we sent keeps that write queued.
    const pushedUpdatedAt = new Map<string, string>()
    for (const r of pPush[tableName] ?? []) {
      pushedUpdatedAt.set((r as SyncFields).id, (r as SyncFields).updated_at)
    }
    // One bulkGet + one bulkPut per table. Every sync now applies the whole dataset, so the old
    // per-row `await get` + `await update` pair meant thousands of serial IndexedDB round trips on
    // the main thread on each of the many triggers (mutation, route change, focus, backup timer,
    // realtime burst) — the UI stalled after saving a bill and while tabbing between screens.
    const existingRows = await table.bulkGet(rows.map((r) => r.id))
    const toPut: SyncFields[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const sentUpdatedAt = pushedUpdatedAt.get(row.id)
      if (sentUpdatedAt !== undefined && compareTimestamps(row.updated_at, sentUpdatedAt) < 0) continue
      const existing = existingRows[i] as { updated_at: string; synced_at: string | null } | undefined
      // Guard: do not clobber a newer unsynced local edit made during the round-trip.
      if (!shouldApplyPulledRow(existing, row.updated_at)) continue
      toPut.push({ ...(existing ?? {}), ...row, synced_at: row.updated_at })
    }
    if (toPut.length > 0) await table.bulkPut(toPut)
  }

  markRefreshed()

  let pushedCount = 0
  for (const rows of Object.values(pPush)) {
    pushedCount += rows.length
  }

  return { pushed: pushedCount, pulled, errors: [] }
}
