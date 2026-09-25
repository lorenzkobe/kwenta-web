import { supabase } from '@/lib/supabase'
import { db } from '@/db/db'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { isRuntimeFlagEnabled } from '@/lib/runtime-flags'
import { readRealtimeCursor, realtimeCursorKey } from '@/lib/kwenta-storage-keys'
import { markRealtimeProcessingFailed } from '@/sync/realtime-health'
import type {
  SyncFields,
  Bill,
  BillItem,
  ItemSplit,
  Group,
  GroupMember,
  Settlement,
} from '@/types'
import {
  PULL_SINCE_EPOCH,
  compareTimestamps,
  fullSync,
  isFullSyncInFlight,
  newestUserEventSince,
  pullChanges,
  shouldApplyPulledRow,
  syncErrMessage,
  syncRoundTrip,
  type SyncRoundTripResult,
} from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import {
  ECHO_EVENT_TABLES,
  eventRowVersion,
  groupByEntity,
  planRealtimeBatch,
  sameInstant,
  type EntityEvents,
  type UserEventRow,
} from '@/sync/realtime-batch'
import { waitForInFlightCloudWrites } from '@/sync/in-flight-writes'
import { currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
type ReconcileBundle = Partial<
  Record<
    | 'profiles'
    | 'groups'
    | 'group_members'
    | 'bills'
    | 'bill_items'
    | 'item_splits'
    | 'settlements'
    | 'activity_log'
    | 'profile_peer_links',
    SyncFields[]
  >
>

const MAX_RECENT_EVENT_IDS = 1024
/** How long a realtime batch waits for this device's in-flight writes before deciding (072). */
const ECHO_WAIT_MS = 3_000

/**
 * Tell every mounted server-backed screen to re-fetch.
 *
 * Screens read from SQL endpoints, not Dexie, so upserting a bundle into the mirror changes
 * nothing they observe — `dataVersion` is their only invalidation signal. Without this the whole
 * realtime path was inert for reads: another device's payment landed in Dexie and the open Person
 * page kept showing the pre-payment hero until the 5-minute backup timer fired.
 *
 * Called once per applied unit of work (one event, or one batch however many entities it
 * reconciled), never per upserted row — each bump costs every mounted screen a round trip. And only
 * when that unit MOVED something: an event whose reconciled rows were new or carried a different
 * `updated_at`, a reconcile that came back empty, or a fallback (which cannot tell, so counts as
 * moved).
 * Every write this device makes echoes back as one event per row per member, reconciling rows the
 * write already mirrored; bumping for those refetched every mounted screen after every save for
 * payloads that could not have changed.
 *
 * The batch and catch-up paths call `fullSync(..., { invalidate: false })` and bump here instead,
 * so a batch that both reconciles and syncs still costs one re-read.
 */
function notifyServerDataChanged(): void {
  useAppStore.getState().bumpDataVersion()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object'
}

/**
 * Mirrors `row`; returns whether its content moved — `sync-service`'s `contentMoved` rule. A row
 * this device staged and has not pushed keeps its edit unless the server copy is strictly newer
 * (`shouldApplyPulledRow`, the pull's own rule): overwriting it lost the edit and marked it synced.
 */
async function upsertRemoteRow<T extends SyncFields>(tableName: keyof typeof db, row: T, epoch: number): Promise<boolean> {
  // Dexie tables are defined on db instance; index signature is fine here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any)[tableName] as { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<void>; update: (id: string, v: Partial<T>) => Promise<void> }
  const existing = await table.get(row.id)
  // The mirror was wiped (sign-out, account switch) after the request that fetched `row` began:
  // never write the ended session's rows into the next one's mirror.
  if (!isSessionEpochCurrent(epoch)) return false
  if (existing) {
    if (!shouldApplyPulledRow(existing, row.updated_at)) return false
    await table.update(row.id, { ...(row as unknown as Partial<T>), synced_at: row.updated_at } as Partial<T>)
    return compareTimestamps(existing.updated_at, row.updated_at) !== 0
  }
  await table.add({ ...(row as T), synced_at: row.updated_at })
  return true
}

/** Each apply* returns how many rows MOVED (see `upsertRemoteRow`), not how many it wrote. */
async function applyBillBundle(bundle: unknown, epoch: number): Promise<number> {
  if (!isRecord(bundle)) return 0
  const bill = bundle.bill as Bill | undefined
  const items = (bundle.bill_items as BillItem[] | undefined) ?? []
  const splits = (bundle.item_splits as ItemSplit[] | undefined) ?? []
  let moved = 0
  if (bill && (await upsertRemoteRow('bills', bill, epoch))) moved++
  for (const it of items) if (await upsertRemoteRow('bill_items', it, epoch)) moved++
  for (const sp of splits) if (await upsertRemoteRow('item_splits', sp, epoch)) moved++
  return moved
}

async function applyGroupBundle(bundle: unknown, epoch: number): Promise<number> {
  if (!isRecord(bundle)) return 0
  const group = bundle.group as Group | undefined
  const members = (bundle.group_members as GroupMember[] | undefined) ?? []
  let moved = 0
  if (group && (await upsertRemoteRow('groups', group, epoch))) moved++
  for (const m of members) if (await upsertRemoteRow('group_members', m, epoch)) moved++
  return moved
}

async function applySettlementBundle(bundle: unknown, epoch: number): Promise<number> {
  if (!isRecord(bundle)) return 0
  const settlement = bundle.settlement as Settlement | undefined
  if (settlement && (await upsertRemoteRow('settlements', settlement, epoch))) return 1
  return 0
}

function bundleRows<T extends SyncFields>(bundle: ReconcileBundle, key: keyof ReconcileBundle): T[] {
  const rows = bundle[key]
  return (Array.isArray(rows) ? rows : []) as T[]
}

function shouldFallbackPullAfterNoopReconcile(ev: UserEventRow): boolean {
  if (ev.op === 'DELETE') return false
  return ev.entity_type === 'groups' || ev.entity_type === 'group_members'
}

/**
 * `applied` counts rows the server returned (0 = a no-op reconcile, which may need a fallback
 * pull); `moved` counts the ones whose content actually changed here.
 */
async function applyReconcileBundle(bundle: ReconcileBundle, epoch: number): Promise<{ applied: number; moved: number }> {
  let applied = 0
  let moved = 0
  const tables: Array<keyof ReconcileBundle> = [
    'profiles',
    'groups',
    'group_members',
    'bills',
    'bill_items',
    'item_splits',
    'settlements',
    'activity_log',
    'profile_peer_links',
  ]
  for (const tableName of tables) {
    for (const row of bundleRows<SyncFields>(bundle, tableName)) {
      if (await upsertRemoteRow(tableName, row, epoch)) moved++
      applied++
    }
  }
  return { applied, moved }
}

/**
 * Whether the row that fired `ev` is already mirrored at exactly the version the event carries
 * (migration 072) — the echo of this device's own write, or a change a sync already brought. Such
 * an event has no news, so it needs no reconcile, no round trip and no re-read. Anything less than
 * certain answers false and takes the normal path: a staged row (`synced_at` null) whose server
 * state this device has not confirmed, a missing row, a different version, an old payload.
 */
async function isEventAlreadyMirrored(ev: UserEventRow): Promise<boolean> {
  const version = eventRowVersion(ev, ECHO_EVENT_TABLES)
  if (!version) return false
  try {
    const row = (await db[version.table].get(version.id)) as SyncFields | undefined
    return Boolean(row && row.synced_at !== null && sameInstant(row.updated_at, version.updatedAt))
  } catch {
    return false
  }
}

/**
 * `processEvent`'s fallback pull, remembering when it fails. The cursor moves past the event either
 * way, so a failure here is otherwise forgotten; the tab-focus gate reads this to sync instead.
 */
async function pullOrMarkFailed(userId: string): Promise<void> {
  const epoch = currentSessionEpoch()
  const result = await pullChanges(userId)
  if (result.errors.length > 0 && isSessionEpochCurrent(epoch)) markRealtimeProcessingFailed()
}

function rememberEventId(recentOrder: string[], recentSet: Set<string>, eventId: string): void {
  if (recentSet.has(eventId)) return
  recentSet.add(eventId)
  recentOrder.push(eventId)
  if (recentOrder.length <= MAX_RECENT_EVENT_IDS) return
  const evicted = recentOrder.shift()
  if (evicted) recentSet.delete(evicted)
}

/**
 * Applies one event to the mirror. Resolves whether it moved anything a screen could observe: a
 * row that was new or changed, or a pull / round trip (which reports no per-row answer, so it
 * counts as moved).
 */
export async function processEvent(userId: string, ev: UserEventRow): Promise<boolean> {
  const startedAt = performance.now()
  const epoch = currentSessionEpoch()

  // A profile link event means this user now has access to historical bills and groups that
  // were previously owned by a local contact. Those rows carry old updated_at values, which the
  // former incremental pull skipped; every round trip now fetches the complete bundle, so the
  // link case needs nothing special beyond a sync.
  if (ev.entity_type === 'profiles' && isRecord(ev.payload) && ev.payload.linked_profile_id) {
    // A round trip that changed rows has already bumped (sync-service); report only the push.
    const result = await syncRoundTrip(userId)
    if (result.errors.length > 0) markRealtimeProcessingFailed()
    captureMetric('realtime.event.process', true, performance.now() - startedAt, {
      entity: ev.entity_type,
      op: ev.op,
      fullPull: true,
    })
    return result.pushed > 0 && result.changed === 0
  }

  if (isRuntimeFlagEnabled('targetedRealtimeReconcile')) {
    const { data, error } = await withMetric(
      'realtime.fetch.reconcileEvent',
      () =>
        supabase.rpc('kwenta_reconcile_user_event', {
          p_entity_type: ev.entity_type,
          p_entity_id: ev.entity_id,
          p_payload: ev.payload,
        }),
      { entity: ev.entity_type, op: ev.op },
    )
    if (!error && data && isRecord(data)) {
      const { applied, moved } = await applyReconcileBundle(data as ReconcileBundle, epoch)
      if (applied > 0) {
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, applied })
        return moved > 0
      }
      if (shouldFallbackPullAfterNoopReconcile(ev)) {
        await pullOrMarkFailed(userId)
        captureMetric('realtime.event.process', true, performance.now() - startedAt, {
          entity: ev.entity_type,
          op: ev.op,
          applied,
          fallbackPull: true,
          noopReconcile: true,
        })
        return true
      }
      if (ev.op !== 'DELETE') {
        // The server no longer returns a row this event named — e.g. the viewer was taken off a
        // personal bill and lost access. That IS a change a list or balance must re-read for. An
        // echo of this device's own write always returns its rows, so this costs the echo path
        // nothing.
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, applied })
        return true
      }
    }
  }

  // Deletes are tricky to represent without updated_at; safest is to pull changes.
  if (ev.op === 'DELETE') {
    await pullOrMarkFailed(userId)
    captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
    return true
  }

  const payload = (isRecord(ev.payload) ? ev.payload : null) as Record<string, unknown> | null

  switch (ev.entity_type) {
    case 'bills': {
      const { data, error } = await withMetric(
        'realtime.fetch.billBundle',
        () => supabase.rpc('kwenta_fetch_bill_bundle', { p_bill_id: ev.entity_id }),
        { op: ev.op },
      )
      if (error) {
        console.warn('[realtime] bill bundle fetch failed', error.message)
        captureMetric('realtime.event.process', false, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
        throw new Error(`bill bundle fetch failed: ${error.message}`)
      }
      const moved = await applyBillBundle(data, epoch)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    case 'groups': {
      const gid = (payload?.group_id as string | undefined) ?? ev.entity_id
      const { data, error } = await withMetric(
        'realtime.fetch.groupBundle',
        () => supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: gid }),
        { op: ev.op },
      )
      if (error) {
        console.warn('[realtime] group bundle fetch failed', error.message)
        captureMetric('realtime.event.process', false, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
        throw new Error(`group bundle fetch failed: ${error.message}`)
      }
      const moved = await applyGroupBundle(data, epoch)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    case 'group_members': {
      const gid = payload?.group_id as string | undefined
      if (!gid) {
        // Fall back: pull changes, since we can't locate the group reliably.
        await pullOrMarkFailed(userId)
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
        return true
      }
      const { data, error } = await withMetric(
        'realtime.fetch.groupBundle',
        () => supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: gid }),
        { op: ev.op },
      )
      if (error) {
        console.warn('[realtime] group bundle fetch failed', error.message)
        captureMetric('realtime.event.process', false, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
        throw new Error(`group bundle fetch failed: ${error.message}`)
      }
      const moved = await applyGroupBundle(data, epoch)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    case 'settlements': {
      const { data, error } = await withMetric(
        'realtime.fetch.settlement',
        () => supabase.rpc('kwenta_fetch_settlement', { p_settlement_id: ev.entity_id }),
        { op: ev.op },
      )
      if (error) {
        console.warn('[realtime] settlement fetch failed', error.message)
        captureMetric('realtime.event.process', false, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
        throw new Error(`settlement fetch failed: ${error.message}`)
      }
      const moved = await applySettlementBundle(data, epoch)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    default: {
      // Unknown entity type; reconcile via pull.
      await pullOrMarkFailed(userId)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
      return true
    }
  }
}

/** Trailing debounce for a burst, and the most a steady stream may defer its flush. */
const FLUSH_DEBOUNCE_MS = 150
const FLUSH_MAX_DELAY_MS = 1_000
/** Above this many entities in one batch, one complete bundle is cheaper than a reconcile each. */
const MAX_RECONCILED_ENTITIES = 10
const RECONCILE_CONCURRENCY = 3
/** Catch-up replays at most this many missed events through the batch path; more costs one full sync. */
const CATCH_UP_MAX_EVENTS = 50

type EntityOutcome = 'moved' | 'unchanged' | 'needsFullSync'

/** One targeted reconcile for every event filed under `entity`. Throws when the fetch fails. */
async function reconcileEntity(userId: string, entity: EntityEvents): Promise<EntityOutcome> {
  const last = entity.events[entity.events.length - 1]
  if (!isRuntimeFlagEnabled('targetedRealtimeReconcile')) {
    // The per-type bundle fetches cover bills, groups and settlements only.
    if (entity.entityType === 'profiles' || entity.entityType === 'profile_peer_links') return 'needsFullSync'
    return (await processEvent(userId, last)) ? 'moved' : 'unchanged'
  }
  const epoch = currentSessionEpoch()
  const { data, error } = await withMetric(
    'realtime.fetch.reconcileEntity',
    () =>
      supabase.rpc('kwenta_reconcile_user_event', {
        p_entity_type: entity.entityType,
        p_entity_id: entity.entityId,
        p_payload: entity.entityType === 'groups' ? { group_id: entity.entityId } : last.payload,
      }),
    { entity: entity.entityType, events: entity.events.length },
  )
  // The session ended while this was in flight: nothing to apply, and no fallback to ask for.
  if (!isSessionEpochCurrent(epoch)) return 'unchanged'
  if (error) throw new Error(`reconcile failed: ${error.message}`)
  if (!isRecord(data)) throw new Error('reconcile returned no bundle')
  const { applied, moved } = await applyReconcileBundle(data as ReconcileBundle, epoch)
  if (applied > 0) return moved > 0 ? 'moved' : 'unchanged'
  // A group the reconcile no longer returns: only the complete bundle carries what a removed
  // member is still sent (024).
  if (entity.entityType === 'groups') return 'needsFullSync'
  // The server no longer returns a row the events named (e.g. access lost): a change to re-read for.
  return 'moved'
}

/**
 * The complete bundle as realtime's fallback, remembering a failure: the cursor moves past the
 * batch either way, and the tab-focus gate reads the mark to sync instead. `invalidate: false`
 * because the batch owns its one bump.
 */
async function fullSyncOrMarkFailed(userId: string): Promise<SyncRoundTripResult> {
  const epoch = currentSessionEpoch()
  try {
    const result = await fullSync(userId, { invalidate: false })
    // A sync abandoned because the session ended says nothing about the next session's mirror.
    if (result.errors.length > 0 && isSessionEpochCurrent(epoch)) markRealtimeProcessingFailed()
    return result
  } catch (error) {
    if (isSessionEpochCurrent(epoch)) markRealtimeProcessingFailed()
    return { pushed: 0, pulled: 0, changed: 0, errors: [syncErrMessage(error)] }
  }
}

/**
 * Callback registered by the running realtime session: the sync manager's probe found events newer
 * than the cursor and hands them here rather than downloading the complete bundle. With no session
 * running this does nothing — starting one catches up from the cursor anyway.
 */
let catchUpHandler: (() => void) | null = null

export function requestRealtimeCatchUp(): void {
  catchUpHandler?.()
}

export function startRealtimeForUser(userId: string): () => void {
  let disposed = false
  // A wipe (sign-out, account switch) can land before React disposes this session; from then on
  // nothing it receives may touch the mirror, the cursor or the screens.
  const sessionEpoch = currentSessionEpoch()
  const ended = () => disposed || !isSessionEpochCurrent(sessionEpoch)
  const queue: UserEventRow[] = []
  let flushing: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let firstQueuedAt: number | null = null
  let catchUpInFlight: Promise<void> | null = null
  let lastCatchUpSince: string | null = null
  const recentEventOrder: string[] = []
  const recentEventSet = new Set<string>()

  /** Moves the cursor forward to a SERVER timestamp; never backwards, never after sign-out. */
  function advanceCursor(serverCreatedAt: string | null): void {
    if (!serverCreatedAt || ended()) return
    const current = readRealtimeCursor(userId)
    if (current && Date.parse(serverCreatedAt) <= Date.parse(current)) return
    localStorage.setItem(realtimeCursorKey(userId), serverCreatedAt)
  }

  /** The one-event-at-a-time path, used only with `coalesceRealtimeBatch` off. */
  async function processEventSafely(ev: UserEventRow): Promise<void> {
    if (recentEventSet.has(ev.id)) {
      advanceCursor(ev.created_at)
      return
    }

    rememberEventId(recentEventOrder, recentEventSet, ev.id)

    if (await isEventAlreadyMirrored(ev)) {
      advanceCursor(ev.created_at)
      captureMetric('realtime.event.echoSkipped', true, 0, { entity: ev.entity_type })
      return
    }

    let moved = false
    try {
      moved = await processEvent(userId, ev)
    } catch (error) {
      moved = true
      console.warn('[realtime] event processing failed; falling back to a full sync', {
        eventId: ev.id,
        entity: ev.entity_type,
        op: ev.op,
        error,
      })
      await fullSyncOrMarkFailed(userId)
      captureMetric('realtime.event.process', false, 0, {
        entity: ev.entity_type,
        op: ev.op,
        fallbackSync: true,
        unhandledError: true,
      })
    } finally {
      advanceCursor(ev.created_at)
      if (moved && !ended()) notifyServerDataChanged()
    }
  }

  /** Reconciles each entity (at most RECONCILE_CONCURRENCY at once); stops at the first that needs the full bundle. */
  async function reconcileEntities(entities: EntityEvents[]): Promise<{ moved: boolean; needsFullSync: boolean }> {
    let moved = false
    let needsFullSync = false
    let next = 0
    async function worker(): Promise<void> {
      while (!ended() && !needsFullSync && next < entities.length) {
        const entity = entities[next++]
        try {
          const outcome = await reconcileEntity(userId, entity)
          if (outcome === 'moved') moved = true
          else if (outcome === 'needsFullSync') needsFullSync = true
        } catch (error) {
          console.warn('[realtime] reconcile failed; falling back to a full sync', {
            entity: entity.entityType,
            error,
          })
          needsFullSync = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, entities.length) }, worker))
    return { moved, needsFullSync }
  }

  /** Applies a batch's fresh events; resolves whether anything a screen could observe moved. */
  async function applyFreshEvents(fresh: UserEventRow[]): Promise<boolean> {
    const startedAt = performance.now()
    const grouping = groupByEntity(fresh)
    if (!grouping.fullSync && grouping.groups.length <= MAX_RECONCILED_ENTITIES) {
      const result = await reconcileEntities(grouping.groups)
      captureMetric('realtime.batch.reconciled', !result.needsFullSync, performance.now() - startedAt, {
        events: fresh.length,
        entities: grouping.groups.length,
      })
      if (!result.needsFullSync || ended()) return result.moved
      // A reconcile failed or could not answer: the complete bundle covers every entity at once. It
      // cannot say what it moved for those events, so it counts as moved.
      await fullSyncOrMarkFailed(userId)
      return true
    }
    const result = await fullSyncOrMarkFailed(userId)
    captureMetric('realtime.batch.fullSync', result.errors.length === 0, performance.now() - startedAt, {
      events: fresh.length,
      entities: grouping.groups.length,
    })
    // A link, a hard delete or an unknown event changed something the bundle's row count cannot
    // show (a delete removes no mirrored row), so those count as moved. A merely LARGE burst trusts
    // the sync's own answer.
    return grouping.fullSync || result.changed > 0 || result.pushed > 0
  }

  async function processBatch(batch: UserEventRow[]) {
    const plan = planRealtimeBatch(batch, (id) => recentEventSet.has(id))

    // Drop events whose rows are already mirrored at their version BEFORE grouping: one save echoes
    // back as a burst (bill, item, every split). Waiting for this device's in-flight writes first
    // lets an echo that beat its own response still be recognised. Waiting is only an optimisation
    // — the mirror check is what decides — so a timeout or failure just skips less.
    let fresh = plan.fresh
    if (fresh.length > 0) {
      try {
        await waitForInFlightCloudWrites(ECHO_WAIT_MS)
      } catch {
        // Never lose the batch over the wait; the check below still holds on its own.
      }
      // Signed out (or switched account) while waiting: this batch belongs to a session that is gone.
      if (ended()) return
      const unmirrored: UserEventRow[] = []
      for (const ev of fresh) {
        if (await isEventAlreadyMirrored(ev)) rememberEventId(recentEventOrder, recentEventSet, ev.id)
        else unmirrored.push(ev)
      }
      if (unmirrored.length < fresh.length) {
        captureMetric('realtime.event.echoSkipped', true, 0, { skipped: fresh.length - unmirrored.length })
      }
      fresh = unmirrored
    }

    // Remember every id up front so a redelivery of any of them is skipped.
    for (const ev of fresh) rememberEventId(recentEventOrder, recentEventSet, ev.id)
    let moved = false
    try {
      if (fresh.length > 0) moved = await applyFreshEvents(fresh)
    } finally {
      advanceCursor(plan.latestCreatedAt)
      // Exactly one bump for the whole batch, however many entities it reconciled.
      if (moved && !ended()) notifyServerDataChanged()
    }
  }

  function flush(): Promise<void> {
    if (flushing) return flushing
    flushing = (async () => {
      try {
        while (!ended() && queue.length > 0) {
          if (!isRuntimeFlagEnabled('coalesceRealtimeBatch')) {
            const ev = queue.shift()
            if (!ev) break
            await processEventSafely(ev)
            continue
          }
          // Drain everything queued so far (including what arrived while the last batch ran).
          await processBatch(queue.splice(0, queue.length))
        }
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  /**
   * Trailing debounce: one remote save arrives as several events a few milliseconds apart, and
   * flushing on the first split them across batches. Capped so a steady stream still flushes.
   */
  function scheduleFlush(): void {
    if (!isRuntimeFlagEnabled('coalesceRealtimeBatch')) {
      void flush()
      return
    }
    const nowMs = performance.now()
    if (firstQueuedAt === null) firstQueuedAt = nowMs
    if (flushTimer) clearTimeout(flushTimer)
    const delay = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, firstQueuedAt + FLUSH_MAX_DELAY_MS - nowMs))
    flushTimer = setTimeout(() => {
      flushTimer = null
      firstQueuedAt = null
      void flush()
    }, delay)
  }

  /**
   * More missed events than the batch path should replay. The newest server timestamp is read
   * BEFORE the sync: an event created while it runs then stays ahead of the cursor. (The rows the
   * catch-up fetched are the OLDEST ones, so their max would leave the cursor creeping behind.)
   */
  async function catchUpWithFullSync(sinceIso: string): Promise<void> {
    const probe = await newestUserEventSince(userId, sinceIso)
    // A joined sync may have read the server before these events existed.
    const joined = isFullSyncInFlight(userId)
    const result = await fullSyncOrMarkFailed(userId)
    if (ended()) return
    if (result.errors.length === 0 && !joined) advanceCursor(probe.newest)
    if (result.changed > 0 || result.pushed > 0) notifyServerDataChanged()
  }

  async function catchUpSince(sinceIso: string): Promise<void> {
    const { data, error } = await supabase
      .from('kwenta_user_events')
      .select('*')
      .eq('user_id', userId)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(CATCH_UP_MAX_EVENTS + 1)

    if (error) {
      console.warn('[realtime] catch-up query failed', error.message)
      return
    }

    const events = (data ?? []) as UserEventRow[]
    if (events.length === 0 || ended()) return
    if (events.length > CATCH_UP_MAX_EVENTS) {
      await catchUpWithFullSync(sinceIso)
      return
    }
    queue.push(...events)
    await flush()
  }

  function scheduleCatchUp(sinceIso: string) {
    const dedupe = isRuntimeFlagEnabled('realtimeCatchupSingleRun')
    if (dedupe && catchUpInFlight && lastCatchUpSince === sinceIso) return
    lastCatchUpSince = sinceIso
    // The tracked promise is the one compared on settle: comparing the inner `run` never matched,
    // so a finished catch-up stayed "in flight" and every later one from the same cursor was dropped.
    const tracked: Promise<void> = withMetric('realtime.catchUp', () => catchUpSince(sinceIso), { sinceIso }).finally(
      () => {
        if (catchUpInFlight === tracked) catchUpInFlight = null
      },
    )
    catchUpInFlight = tracked
  }

  function catchUpFromCursor(): void {
    if (ended()) return
    const sinceIso = readRealtimeCursor(userId)
    if (sinceIso) scheduleCatchUp(sinceIso)
  }
  catchUpHandler = catchUpFromCursor

  // No cursor yet: there is nothing to catch up FROM, and the device clock must never stand in for
  // one (rule 7) — start from the newest event the server has instead, without replaying it.
  const lastSeen = readRealtimeCursor(userId)
  if (lastSeen) scheduleCatchUp(lastSeen)
  else void initialiseCursorFromServer()

  async function initialiseCursorFromServer(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('kwenta_user_events')
        .select('created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
      if (error || !Array.isArray(data)) return
      const newest = (data[0] as { created_at?: unknown } | undefined)?.created_at
      // No events at all: the epoch is a floor the server stamped nothing before, so "no cursor"
      // (which the focus gate answers with a full sync) never recurs for a quiet account.
      const cursor = data.length === 0 ? PULL_SINCE_EPOCH : typeof newest === 'string' ? newest : null
      // An event drained meanwhile has already set a cursor; never move it backwards.
      if (!ended() && cursor && !readRealtimeCursor(userId)) {
        localStorage.setItem(realtimeCursorKey(userId), cursor)
      }
    } catch {
      // No cursor stays no cursor: the next tab focus runs a full sync, as it always did.
    }
  }

  const channel = supabase
    .channel(`kwenta_user_events:${userId}`)
    .on(
      'postgres_changes',
      {
        // Events are append-only; a DELETE is the prune job (073). Supabase delivers DELETEs
        // unfiltered and without RLS, with `new` = {}, so they must never reach the queue.
        event: 'INSERT',
        schema: 'public',
        table: 'kwenta_user_events',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const row = (payload.new ?? null) as UserEventRow | null
        if (!row || typeof row.id !== 'string' || typeof row.created_at !== 'string' || ended()) return
        queue.push(row)
        scheduleFlush()
      },
    )
    .subscribe((status) => {
      // On reconnect, do a quick catch-up query based on last seen timestamp.
      if (status === 'SUBSCRIBED') catchUpFromCursor()
    })

  return () => {
    disposed = true
    queue.length = 0
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    if (catchUpHandler === catchUpFromCursor) catchUpHandler = null
    void supabase.removeChannel(channel)
  }
}
