import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { dropQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { now } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { enqueuePendingMutation, recordNotAppliedChange } from '@/sync/cloud-first-mutations'
import { submitCloudWrite, type CloudWritePayload } from '@/sync/cloud-write'
import { trackCloudWrite } from '@/sync/in-flight-writes'
import { SessionEndedError, assertSessionEpoch, currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
import {
  TABLE_NAMES,
  type TableName,
  fullSync,
  getLocalTable,
  hasUnsyncedLocalDataForUser,
  rowKey,
  syncErrMessage,
} from '@/sync/sync-service'
import { WriteSessionMismatchError, classifyWriteFailure } from '@/sync/write-errors'
import type { MutationEntityType, PendingMutation, SyncFields, WriteFailureKind } from '@/types'

/**
 * The ordered write queue (Dexie v15 `pending_mutations`).
 *
 * A write that could not reach the server — offline, a transport failure, or older writes still
 * waiting — is staged in the mirror and queued with the exact rows it submits and its submission
 * id. Draining replays the entries oldest first through the same `submitCloudWrite` as an online
 * save, reusing the submission id, so a replay after a lost response returns the original outcome
 * instead of applying twice. Only a real server refusal marks an entry `conflict`; a transport
 * failure backs off and holds everything behind it, because a later edit to the same rows must
 * never land before the earlier one.
 */

/** What the Settings "not applied" list shows if the write is later refused. */
export type QueuedWriteMeta = {
  operation: string
  entityType: MutationEntityType
  entityId: string | null
  payload: unknown
  routeHint: string | null
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60_000

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine
}

function tablesIn(payload: CloudWritePayload): TableName[] {
  return TABLE_NAMES.filter((t) => (payload[t]?.length ?? 0) > 0)
}

function rowKeysOf(payload: CloudWritePayload): string[] {
  const keys = new Set<string>()
  for (const t of tablesIn(payload)) {
    for (const row of payload[t] as SyncFields[]) keys.add(rowKey(t, row.id))
  }
  return [...keys]
}

function sharesRows(a: Set<string>, entry: PendingMutation): boolean {
  return entry.row_keys.some((k) => a.has(k))
}

/** Stage a write's rows in the mirror and queue it, in one transaction: never one without the other. */
export async function enqueueWrite(input: {
  actorUserId: string
  payload: CloudWritePayload
  pending: QueuedWriteMeta
  submissionId: string
  failure?: { kind: WriteFailureKind; message: string }
}): Promise<string> {
  const tables = tablesIn(input.payload)
  const id = await db.transaction('rw', [...tables.map(getLocalTable), db.pending_mutations], async () => {
    for (const t of tables) await getLocalTable(t).bulkPut(input.payload[t] as SyncFields[])
    return enqueuePendingMutation({
      actorUserId: input.actorUserId,
      operation: input.pending.operation,
      entityType: input.pending.entityType,
      entityId: input.pending.entityId,
      payload: input.pending.payload,
      routeHint: input.pending.routeHint,
      push: input.payload as PendingMutation['push'],
      rowKeys: rowKeysOf(input.payload),
      submissionId: input.submissionId,
      failure: input.failure,
    })
  })
  // A save that failed in transit is retried on its own; waiting for a focus or the backup tick
  // would queue every later save behind it.
  if (input.failure?.kind === 'transport') scheduleDrainRetry(input.actorUserId, Date.now() + BACKOFF_BASE_MS)
  return id
}

/** This actor's entries, oldest first. The queue is small by nature (unsent writes of one device). */
async function entriesFor(actorUserId: string): Promise<PendingMutation[]> {
  const rows = await db.pending_mutations.where('actor_user_id').equals(actorUserId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

/**
 * Whether this device holds a queued write in ANY live status — waiting, refused or blocked. This is
 * what a sign-out (or account switch) would destroy, so it is what a sign-out warning must count;
 * the row-scan checks deliberately ignore queue-owned rows.
 */
export async function hasQueuedWrites(): Promise<boolean> {
  const live = await db.pending_mutations
    .where('status')
    .anyOf(['pending', 'conflict', 'blocked_by_earlier'])
    .count()
  return live > 0
}

/** Everything a sign-out would destroy: a queued write in any status, or a row only a full sync sends. */
export async function hasUnsentWrites(userId: string): Promise<boolean> {
  return (await hasQueuedWrites()) || (await hasUnsyncedLocalDataForUser(userId))
}

/**
 * The last send before a wipe (sign-out, Reset local data): the write queue first (a full sync never
 * pushes queue-owned rows), then the row scan. Reports what is still unsent afterwards, so the
 * caller wipes only when nothing would be lost.
 */
export async function sendUnsentWritesBeforeWipe(
  userId: string,
): Promise<{ errors: string[]; stillUnsent: boolean }> {
  // A call that joins a running background drain inherits its backoff (and a drain another tab
  // holds sends nothing here), so once that settles, one run of our own sends what is left.
  const joined = drainsInFlight.get(userId)?.epoch === currentSessionEpoch()
  const first = await drainWriteQueue(userId, { ignoreBackoff: true })
  if ((joined || first?.lockHeld) && (await hasPendingQueuedWrites(userId))) {
    await drainWriteQueue(userId, { ignoreBackoff: true })
  }
  const { errors } = await fullSync(userId)
  return { errors, stillUnsent: await hasUnsentWrites(userId) }
}

/** Whether a queued write is still waiting to be sent. A refused or blocked one does not count. */
export async function hasPendingQueuedWrites(actorUserId: string): Promise<boolean> {
  const pending = await db.pending_mutations
    .where('[actor_user_id+status+seq]')
    .between([actorUserId, 'pending', -Infinity], [actorUserId, 'pending', Infinity])
    .toArray()
  return pending.some((m) => m.push != null)
}

function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/**
 * The entry was refused: mark it `conflict`, and every later pending entry that touches one of its
 * rows (transitively) `blocked_by_earlier` — those edits build on a change the server never stored.
 * Their notifications are dropped: they describe writes that did not happen.
 */
async function markRefused(head: PendingMutation, message: string, entries: PendingMutation[]): Promise<void> {
  const keys = new Set(head.row_keys)
  const blocked: PendingMutation[] = []
  for (const e of entries) {
    if (e.seq <= head.seq || e.status !== 'pending' || e.push == null || !sharesRows(keys, e)) continue
    blocked.push(e)
    for (const k of e.row_keys) keys.add(k)
  }
  const timestamp = now()
  await db.transaction('rw', db.pending_mutations, db.not_applied_changes, async () => {
    await db.pending_mutations.update(head.id, {
      status: 'conflict',
      retry_count: head.retry_count + 1,
      last_error: message,
      last_error_kind: 'rejected',
      next_attempt_at: null,
      updated_at: timestamp,
    })
    for (const b of blocked) {
      await db.pending_mutations.update(b.id, { status: 'blocked_by_earlier', updated_at: timestamp })
    }
    await recordNotAppliedChange({
      actorUserId: head.actor_user_id,
      pendingMutationId: head.id,
      operation: head.operation,
      entityType: head.entity_type,
      entityId: head.entity_id,
      reasonCode: 'rejected',
      reasonMessage: message,
      payload: parsePayload(head.payload_json),
      routeHint: head.route_hint ?? null,
    })
  })
  dropQueuedKwentaNotifications([head.submission_id, ...blocked.map((b) => b.submission_id)])
}

/** `lockHeld`: another tab was draining, so this call sent nothing. */
type DrainResult = { applied: number; refused: number; lockHeld?: boolean }

async function runDrain(actorUserId: string, ignoreBackoff: boolean): Promise<DrainResult> {
  const result: DrainResult = { applied: 0, refused: 0 }
  const attempted = new Set<string>()
  // A wipe mid-drain ends it: the entries (and the mirror) it was draining are gone, and nothing it
  // learns afterwards may be written into the next session's database.
  const epoch = currentSessionEpoch()
  // A drain sends only the signed-in account's own writes. A timer armed for A can fire after A's
  // session ended without a wipe (expiry, the switch prompt) and B signed in: then nothing is sent
  // and the entries stay exactly as they are, for A's next session.
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (session?.user?.id !== actorUserId) return result
  try {
    while (isOnline() && isSessionEpochCurrent(epoch)) {
      const entries = await entriesFor(actorUserId)
      const head = entries.find((e) => e.status === 'pending' && e.push != null)
      if (!head) break
      // Never skip past the earliest pending entry. Seeing it again in this run means it was put back
      // (Retry) after this run refused it; its dependents must not overtake it, so this run ends and
      // the caller starts a fresh one.
      if (attempted.has(head.id)) break
      // Head-of-line: a head in backoff holds every later entry, so order is never broken.
      if (!ignoreBackoff && head.next_attempt_at !== null && head.next_attempt_at > Date.now()) {
        scheduleDrainRetry(actorUserId, head.next_attempt_at)
        break
      }
      attempted.add(head.id)

      const refusedEarlier = new Set(
        entries
          .filter((e) => e.seq < head.seq && (e.status === 'conflict' || e.status === 'blocked_by_earlier'))
          .flatMap((e) => e.row_keys),
      )
      if (sharesRows(refusedEarlier, head)) {
        await db.pending_mutations.update(head.id, { status: 'blocked_by_earlier', updated_at: now() })
        dropQueuedKwentaNotifications([head.submission_id])
        result.refused++
        continue
      }

      const laterKeys = new Set(entries.filter((e) => e.id !== head.id).flatMap((e) => e.row_keys))
      try {
        await trackCloudWrite(
          submitCloudWrite({
            actorUserId,
            payload: head.push as CloudWritePayload,
            submissionId: head.submission_id,
            preserveLocalKeys: laterKeys,
          }),
        )
        assertSessionEpoch(epoch)
        await db.pending_mutations.delete(head.id)
        result.applied++
      } catch (err) {
        if (err instanceof SessionEndedError || err instanceof WriteSessionMismatchError || !isSessionEpochCurrent(epoch)) {
          break
        }
        const kind = classifyWriteFailure(err)
        const message = err instanceof Error ? err.message : syncErrMessage(err)
        if (kind === 'rejected') {
          await markRefused(head, message, entries)
          result.refused++
          continue
        }
        // Transport: back off and keep order. Inactive: stop; the auth layer signs the user out
        // and the entry is still here for the same user's next session.
        const nextAttemptAt =
          kind === 'transport' ? Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** head.retry_count, BACKOFF_MAX_MS) : null
        await db.pending_mutations.update(head.id, {
          retry_count: head.retry_count + 1,
          last_error: message,
          last_error_kind: kind,
          next_attempt_at: nextAttemptAt,
          updated_at: now(),
        })
        if (nextAttemptAt !== null) scheduleDrainRetry(actorUserId, nextAttemptAt)
        break
      }
    }
  } finally {
    // One invalidation for the whole drain, however many entries it moved.
    if (result.applied + result.refused > 0) useAppStore.getState().bumpDataVersion()
  }
  return result
}

/**
 * One timer for the next backed-off attempt. Without it a queued write waited for a tab focus or the
 * backup tick while every later save queued behind it. It belongs to the session that set it: after
 * a wipe (epoch change) it fires into nothing.
 */
let drainRetry: { timer: ReturnType<typeof setTimeout>; at: number; actorUserId: string; epoch: number } | null =
  null

/**
 * Keeps the earliest pending attempt for this actor and session. A timer that fires before the head's
 * backoff ends finds it still backed off, and that drain schedules the next one.
 */
function scheduleDrainRetry(actorUserId: string, at: number): void {
  const epoch = currentSessionEpoch()
  if (drainRetry && drainRetry.actorUserId === actorUserId && drainRetry.epoch === epoch && drainRetry.at <= at) return
  cancelScheduledDrainRetry()
  const timer = setTimeout(() => {
    if (drainRetry?.timer === timer) drainRetry = null
    if (isSessionEpochCurrent(epoch)) void drainWriteQueue(actorUserId)
  }, Math.max(0, at - Date.now()))
  drainRetry = { timer, at, actorUserId, epoch }
}

/** Drop the scheduled retry (a wipe or sign-out; the timer is already inert after an epoch change). */
export function cancelScheduledDrainRetry(): void {
  if (drainRetry) clearTimeout(drainRetry.timer)
  drainRetry = null
}

/** Keyed by actor; a drain started in an earlier session (before a wipe) is never joined. */
const drainsInFlight = new Map<string, { epoch: number; drain: Promise<DrainResult> }>()

/**
 * Replay this actor's queued writes, oldest first, one `kwenta_write` each. Single-flight: a call
 * while a drain runs joins it (the running loop re-reads the queue, so it also sends entries added
 * meanwhile). Across tabs, `navigator.locks` keeps two tabs from sending the same entry at once.
 *
 * `budgetMs` bounds how long the CALLER waits (a save must not hang behind a slow queue); the
 * drain itself keeps running. `ignoreBackoff` sends a backed-off head now — for a user who asked
 * (Refresh, Retry); background callers leave it off so a flaky network is not hammered. A call that
 * joins a running drain inherits that drain's setting.
 */
export async function drainWriteQueue(
  actorUserId: string,
  options?: { budgetMs?: number; ignoreBackoff?: boolean },
): Promise<DrainResult | null> {
  const ignoreBackoff = options?.ignoreBackoff === true
  const epoch = currentSessionEpoch()
  const running = drainsInFlight.get(actorUserId)
  let drain = running?.epoch === epoch ? running.drain : undefined
  if (!drain) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    const run = locks
      ? locks.request(`kwenta-write-queue:${actorUserId}`, { ifAvailable: true }, (lock) =>
          lock ? runDrain(actorUserId, ignoreBackoff) : { applied: 0, refused: 0, lockHeld: true },
        )
      : runDrain(actorUserId, ignoreBackoff)
    const started: Promise<DrainResult> = Promise.resolve(run).finally(() => {
      if (drainsInFlight.get(actorUserId)?.drain === started) drainsInFlight.delete(actorUserId)
    })
    drain = started
    drainsInFlight.set(actorUserId, { epoch, drain })
  }
  if (options?.budgetMs === undefined) return drain
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.budgetMs)
  })
  try {
    return await Promise.race([drain, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** A refused entry plus the blocked entries that depend on it (transitively, by shared rows). */
async function refusedGroup(entry: PendingMutation): Promise<PendingMutation[]> {
  const entries = await entriesFor(entry.actor_user_id)
  const keys = new Set(entry.row_keys)
  const group = [entry]
  for (const e of entries) {
    if (e.seq <= entry.seq || e.status !== 'blocked_by_earlier' || !sharesRows(keys, e)) continue
    group.push(e)
    for (const k of e.row_keys) keys.add(k)
  }
  return group
}

async function refusedEntry(entryId: string): Promise<PendingMutation> {
  const entry = await db.pending_mutations.get(entryId)
  if (!entry || entry.push == null || entry.status !== 'conflict') {
    throw new Error('Only a change the server refused can be dismissed or retried.')
  }
  return entry
}

/** The `kwenta_reconcile_user_event` entity (028's names) that returns this row. */
function reconcileEntityFor(
  table: TableName,
  row: SyncFields & Record<string, unknown>,
  itemBillIds: Map<string, string>,
): [string, string] | null {
  switch (table) {
    case 'bills':
    case 'groups':
    case 'settlements':
    case 'profiles':
    case 'profile_peer_links':
      return [table, row.id]
    case 'bill_items':
      return ['bills', String(row.bill_id)]
    case 'item_splits': {
      const billId = itemBillIds.get(String(row.item_id))
      return billId ? ['bills', billId] : null
    }
    case 'group_members':
      return ['groups', String(row.group_id)]
    case 'activity_log':
      return null
  }
}

/**
 * Discard a refused change (and the blocked changes built on it): every row it touched goes back
 * to what the server holds — re-read per entity — and a row the server does not return is removed
 * from this device's mirror (a local cache eviction, never a server delete; a later full sync
 * brings it back if it exists). Online only, and only for `conflict` entries: a pending entry may
 * still land, and discarding it offline could not restore anything.
 */
export async function dismissQueuedWrite(entryId: string): Promise<void> {
  const epoch = currentSessionEpoch()
  const entry = await refusedEntry(entryId)
  if (!isOnline()) throw new Error('Connect to the internet to discard this change.')
  const group = await refusedGroup(entry)
  // A later change to the same rows that is still waiting to be sent would be reverted on screen
  // and then land anyway. Let it settle first (it is sent, or refused and joins this group).
  const groupKeys = new Set(group.flatMap((e) => e.row_keys))
  const waiting = (await entriesFor(entry.actor_user_id)).some(
    (e) => e.status === 'pending' && e.push != null && sharesRows(groupKeys, e),
  )
  if (waiting) {
    throw new Error('A later change to the same item is still waiting to be sent. Try again once it has synced.')
  }

  const touched = new Map<string, { table: TableName; row: SyncFields & Record<string, unknown> }>()
  for (const e of group) {
    for (const t of tablesIn(e.push as CloudWritePayload)) {
      for (const row of (e.push as CloudWritePayload)[t] as unknown as (SyncFields & Record<string, unknown>)[]) {
        touched.set(rowKey(t, row.id), { table: t, row })
      }
    }
  }

  const itemBillIds = new Map<string, string>()
  const splitItemIds = [...touched.values()].filter((r) => r.table === 'item_splits').map((r) => String(r.row.item_id))
  for (const { table, row } of touched.values()) {
    if (table === 'bill_items') itemBillIds.set(row.id, String(row.bill_id))
  }
  const missingItemIds = splitItemIds.filter((id) => !itemBillIds.has(id))
  if (missingItemIds.length > 0) {
    const items = await db.bill_items.bulkGet(missingItemIds)
    for (const item of items) if (item) itemBillIds.set(item.id, item.bill_id)
  }

  const entities = new Map<string, [string, string]>()
  for (const { table, row } of touched.values()) {
    const entity = reconcileEntityFor(table, row, itemBillIds)
    if (entity) entities.set(entity.join(':'), entity)
  }

  // Read everything before changing anything: a failed read leaves the change (and its entry)
  // exactly as it was.
  const serverRows = new Map<string, SyncFields>()
  for (const [entityType, entityId] of entities.values()) {
    const { data, error } = await supabase.rpc('kwenta_reconcile_user_event', {
      p_entity_type: entityType,
      p_entity_id: entityId,
    })
    if (error) throw new Error(`Could not read the saved version: ${syncErrMessage(error)}`)
    if (!data || typeof data !== 'object') continue
    for (const t of TABLE_NAMES) {
      const rows = (data as Record<string, unknown>)[t]
      if (!Array.isArray(rows)) continue
      for (const row of rows as SyncFields[]) serverRows.set(rowKey(t, row.id), row)
    }
  }

  assertSessionEpoch(epoch)
  const tables = [...new Set([...touched.values()].map((r) => r.table))]
  const groupIds = group.map((e) => e.id)
  const timestamp = now()
  await db.transaction(
    'rw',
    [...tables.map(getLocalTable), db.pending_mutations, db.not_applied_changes],
    async () => {
      for (const [key, { table, row }] of touched) {
        const server = serverRows.get(key)
        if (server) await getLocalTable(table).put({ ...server, synced_at: server.updated_at })
        else await getLocalTable(table).delete(row.id)
      }
      await db.pending_mutations.bulkDelete(groupIds)
      await db.not_applied_changes
        .where('pending_mutation_id')
        .anyOf(groupIds)
        .filter((c) => c.resolution === 'pending')
        .modify({ resolution: 'dismissed', resolved_at: timestamp })
    },
  )
  dropQueuedKwentaNotifications(group.map((e) => e.submission_id))
  useAppStore.getState().bumpDataVersion()
}

/**
 * Send a refused change again (with its blocked dependents behind it), same submission id: the
 * refusal rolled the submission back (078), so nothing of it is recorded. Resolves true when the
 * entry landed.
 */
export async function retryQueuedWrite(entryId: string): Promise<boolean> {
  const entry = await refusedEntry(entryId)
  const group = await refusedGroup(entry)
  const timestamp = now()
  await db.transaction('rw', db.pending_mutations, db.not_applied_changes, async () => {
    for (const e of group) {
      await db.pending_mutations.update(e.id, {
        status: 'pending',
        next_attempt_at: null,
        last_error_kind: null,
        updated_at: timestamp,
      })
    }
    await db.not_applied_changes
      .where('pending_mutation_id')
      .equals(entry.id)
      .filter((c) => c.resolution === 'pending')
      .modify({ resolution: 'reapplied', resolved_at: timestamp })
  })
  // The drain this joins may be the run that refused the entry; that run stops when it meets the
  // entry again rather than send its dependents first, so a fresh run picks it up.
  await drainWriteQueue(entry.actor_user_id, { ignoreBackoff: true })
  const after = await db.pending_mutations.get(entry.id)
  if (after?.status === 'pending' && after.last_error_kind === null) {
    await drainWriteQueue(entry.actor_user_id, { ignoreBackoff: true })
  }
  return (await db.pending_mutations.get(entry.id)) === undefined
}
