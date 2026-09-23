import { supabase } from '@/lib/supabase'
import { db } from '@/db/db'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { isRuntimeFlagEnabled } from '@/lib/runtime-flags'
import { now } from '@/lib/utils'
import type {
  SyncFields,
  Bill,
  BillItem,
  ItemSplit,
  Group,
  GroupMember,
  Settlement,
} from '@/types'
import { compareTimestamps, pullChanges, syncRoundTrip } from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import { latestEventCreatedAt, planRealtimeBatch, type UserEventRow } from '@/sync/realtime-batch'
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

const LAST_SEEN_EVENT_KEY = (userId: string) => `kwenta_last_seen_user_event:${userId}`
const MAX_RECENT_EVENT_IDS = 1024

/**
 * Tell every mounted server-backed screen to re-fetch.
 *
 * Screens read from SQL endpoints, not Dexie, so upserting a bundle into the mirror changes
 * nothing they observe — `dataVersion` is their only invalidation signal. Without this the whole
 * realtime path was inert for reads: another device's payment landed in Dexie and the open Person
 * page kept showing the pre-payment hero until the 5-minute backup timer fired.
 *
 * Called once per applied unit of work (one event, or one coalesced batch), never per upserted
 * row — each bump costs every mounted screen a round trip. And only when that unit MOVED
 * something: an event whose reconciled rows were new or carried a different `updated_at`, a
 * reconcile that came back empty, or a fallback pull (which cannot tell, so counts as moved).
 * Every write this device makes echoes back as one event per row per member, reconciling rows the
 * write already mirrored; bumping for those refetched every mounted screen after every save for
 * payloads that could not have changed.
 *
 * A `syncRoundTrip` that CHANGED rows bumps inside sync-service for every caller, so the paths
 * here that run one bump only for a push that changed nothing — otherwise one sync would cost
 * two re-reads.
 */
function notifyServerDataChanged(): void {
  useAppStore.getState().bumpDataVersion()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object'
}

/** Mirrors `row`; returns whether its content moved — `sync-service`'s `contentMoved` rule. */
async function upsertRemoteRow<T extends SyncFields>(tableName: keyof typeof db, row: T): Promise<boolean> {
  // Dexie tables are defined on db instance; index signature is fine here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any)[tableName] as { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<void>; update: (id: string, v: Partial<T>) => Promise<void> }
  const existing = await table.get(row.id)
  if (existing) {
    await table.update(row.id, { ...(row as unknown as Partial<T>), synced_at: row.updated_at } as Partial<T>)
    return compareTimestamps(existing.updated_at, row.updated_at) !== 0
  }
  await table.add({ ...(row as T), synced_at: row.updated_at })
  return true
}

/** Each apply* returns how many rows MOVED (see `upsertRemoteRow`), not how many it wrote. */
async function applyBillBundle(bundle: unknown): Promise<number> {
  if (!isRecord(bundle)) return 0
  const bill = bundle.bill as Bill | undefined
  const items = (bundle.bill_items as BillItem[] | undefined) ?? []
  const splits = (bundle.item_splits as ItemSplit[] | undefined) ?? []
  let moved = 0
  if (bill && (await upsertRemoteRow('bills', bill))) moved++
  for (const it of items) if (await upsertRemoteRow('bill_items', it)) moved++
  for (const sp of splits) if (await upsertRemoteRow('item_splits', sp)) moved++
  return moved
}

async function applyGroupBundle(bundle: unknown): Promise<number> {
  if (!isRecord(bundle)) return 0
  const group = bundle.group as Group | undefined
  const members = (bundle.group_members as GroupMember[] | undefined) ?? []
  let moved = 0
  if (group && (await upsertRemoteRow('groups', group))) moved++
  for (const m of members) if (await upsertRemoteRow('group_members', m)) moved++
  return moved
}

async function applySettlementBundle(bundle: unknown): Promise<number> {
  if (!isRecord(bundle)) return 0
  const settlement = bundle.settlement as Settlement | undefined
  if (settlement && (await upsertRemoteRow('settlements', settlement))) return 1
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
async function applyReconcileBundle(bundle: ReconcileBundle): Promise<{ applied: number; moved: number }> {
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
      if (await upsertRemoteRow(tableName, row)) moved++
      applied++
    }
  }
  return { applied, moved }
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

  // A profile link event means this user now has access to historical bills and groups that
  // were previously owned by a local contact. Those rows carry old updated_at values, which the
  // former incremental pull skipped; every round trip now fetches the complete bundle, so the
  // link case needs nothing special beyond a sync.
  if (ev.entity_type === 'profiles' && isRecord(ev.payload) && ev.payload.linked_profile_id) {
    // A round trip that changed rows has already bumped (sync-service); report only the push.
    const result = await syncRoundTrip(userId)
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
      const { applied, moved } = await applyReconcileBundle(data as ReconcileBundle)
      if (applied > 0) {
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, applied })
        return moved > 0
      }
      if (shouldFallbackPullAfterNoopReconcile(ev)) {
        await pullChanges(userId)
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
    await pullChanges(userId)
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
      const moved = await applyBillBundle(data)
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
      const moved = await applyGroupBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    case 'group_members': {
      const gid = payload?.group_id as string | undefined
      if (!gid) {
        // Fall back: pull changes, since we can't locate the group reliably.
        await pullChanges(userId)
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
      const moved = await applyGroupBundle(data)
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
      const moved = await applySettlementBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return moved > 0
    }
    default: {
      // Unknown entity type; reconcile via pull.
      await pullChanges(userId)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
      return true
    }
  }
}

// Above this threshold, per-event RPCs are more expensive than a single syncRoundTrip.
const CATCH_UP_BULK_THRESHOLD = 5

async function catchUpSince(userId: string, sinceIso: string, onEvent: (ev: UserEventRow) => Promise<void>): Promise<void> {
  const { data, error } = await supabase
    .from('kwenta_user_events')
    .select('*')
    .eq('user_id', userId)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(CATCH_UP_BULK_THRESHOLD + 1)

  if (error) {
    console.warn('[realtime] catch-up query failed', error.message)
    return
  }

  const events = (data ?? []) as UserEventRow[]
  if (events.length === 0) return

  if (events.length > CATCH_UP_BULK_THRESHOLD) {
    // Many missed events — one syncRoundTrip is far cheaper than N individual RPCs. It pulls the
    // complete bundle, so a missed profile-link event needs no special handling (it used to
    // require probing kwenta_user_events and resetting the pull cursor).
    // A round trip that changed rows has already bumped (sync-service); only a push is left.
    const result = await syncRoundTrip(userId)
    // Advance from the SERVER clock, never this device's. `kwenta_user_events.created_at` is
    // stamped by Postgres; writing now() here means a device whose clock runs fast stores a cursor
    // in the future, and the next catch-up's `.gt('created_at', cursor)` filters out every event
    // the server creates until real time catches up — and the cursor only moves forward. It also
    // skipped anything created between the query above and this write. The sibling batch path
    // already advances from the event rows themselves.
    const latestCreatedAt = latestEventCreatedAt(events)
    if (latestCreatedAt) localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), latestCreatedAt)
    if (result.pushed > 0 && result.changed === 0) notifyServerDataChanged()
    return
  }

  for (const ev of events) {
    await onEvent(ev)
  }
}

export function startRealtimeForUser(userId: string): () => void {
  let disposed = false
  const queue: UserEventRow[] = []
  let flushing = false
  let catchUpInFlight: Promise<void> | null = null
  let lastCatchUpSince: string | null = null
  const recentEventOrder: string[] = []
  const recentEventSet = new Set<string>()

  async function processEventSafely(ev: UserEventRow): Promise<void> {
    if (recentEventSet.has(ev.id)) {
      localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), ev.created_at)
      return
    }

    rememberEventId(recentEventOrder, recentEventSet, ev.id)

    let moved = false
    try {
      moved = await processEvent(userId, ev)
    } catch (error) {
      moved = true
      console.warn('[realtime] event processing failed; falling back to pull', {
        eventId: ev.id,
        entity: ev.entity_type,
        op: ev.op,
        error,
      })
      await pullChanges(userId)
      captureMetric('realtime.event.process', false, 0, {
        entity: ev.entity_type,
        op: ev.op,
        fallbackPull: true,
        unhandledError: true,
      })
    } finally {
      localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), ev.created_at)
      if (moved) notifyServerDataChanged()
    }
  }

  function scheduleCatchUp(sinceIso: string) {
    const dedupe = isRuntimeFlagEnabled('realtimeCatchupSingleRun')
    if (dedupe && catchUpInFlight && lastCatchUpSince === sinceIso) return
    lastCatchUpSince = sinceIso
    const run = withMetric('realtime.catchUp', () => catchUpSince(userId, sinceIso, processEventSafely), { sinceIso })
    catchUpInFlight = run.finally(() => {
      if (catchUpInFlight === run) catchUpInFlight = null
    })
  }

  const lastSeen = localStorage.getItem(LAST_SEEN_EVENT_KEY(userId)) ?? now()
  scheduleCatchUp(lastSeen)

  // Collapse a burst of events (e.g. a multi-leg settle-up fanned out into one
  // event per leg) into a single syncRoundTrip instead of one reconcile RPC per
  // event. A lone fresh event keeps the lighter targeted-reconcile path.
  async function processBatch(batch: UserEventRow[]) {
    const plan = planRealtimeBatch(batch, (id) => recentEventSet.has(id))

    if (plan.fresh.length <= 1) {
      for (const ev of plan.fresh) await processEventSafely(ev)
      if (plan.latestCreatedAt) {
        localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), plan.latestCreatedAt)
      }
      return
    }

    // Remember every id up front so a redelivery of any of them is skipped.
    for (const ev of plan.fresh) rememberEventId(recentEventOrder, recentEventSet, ev.id)
    const startedAt = performance.now()
    let moved = false
    try {
      const result = await syncRoundTrip(userId)
      // A round trip that changed rows has already bumped (sync-service); only a push is left.
      moved = result.pushed > 0 && result.changed === 0
      captureMetric('realtime.batch.coalesced', true, performance.now() - startedAt, {
        events: batch.length,
        fresh: plan.fresh.length,
      })
    } catch (error) {
      console.warn('[realtime] coalesced batch sync failed; falling back to pull', { error })
      moved = true
      await pullChanges(userId)
      captureMetric('realtime.batch.coalesced', false, performance.now() - startedAt, {
        events: batch.length,
        fresh: plan.fresh.length,
      })
    } finally {
      if (plan.latestCreatedAt) {
        localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), plan.latestCreatedAt)
      }
      // Only the coalesced branch: the `<= 1` branch above delegates to processEventSafely,
      // which bumps for itself. Bumping in both would cost every mounted screen two round trips
      // for one event.
      if (moved) notifyServerDataChanged()
    }
  }

  async function flush() {
    if (flushing) return
    flushing = true
    try {
      while (!disposed && queue.length > 0) {
        if (!isRuntimeFlagEnabled('coalesceRealtimeBatch')) {
          const ev = queue.shift()
          if (!ev) break
          await processEventSafely(ev)
          continue
        }
        // Drain everything queued so far and handle it as one batch.
        const batch = queue.splice(0, queue.length)
        await processBatch(batch)
      }
    } finally {
      flushing = false
    }
  }

  const channel = supabase
    .channel(`kwenta_user_events:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'kwenta_user_events',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const row = (payload.new ?? null) as UserEventRow | null
        if (!row || disposed) return
        queue.push(row)
        void flush()
      },
    )
    .subscribe((status) => {
      // On reconnect, do a quick catch-up query based on last seen timestamp.
      if (status === 'SUBSCRIBED') {
        const sinceIso = localStorage.getItem(LAST_SEEN_EVENT_KEY(userId)) ?? now()
        scheduleCatchUp(sinceIso)
      }
    })

  return () => {
    disposed = true
    queue.length = 0
    void supabase.removeChannel(channel)
    // Ensure any eventual consistency backstop still advances after a disconnect.
    localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), localStorage.getItem(LAST_SEEN_EVENT_KEY(userId)) ?? now())
  }
}

