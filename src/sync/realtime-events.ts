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
  Profile,
  ActivityLog,
  ProfilePeerLink,
} from '@/types'
import { pullChanges, syncRoundTrip } from '@/sync/sync-service'

type UserEventRow = {
  id: string
  user_id: string
  event_type: string
  entity_type: string
  entity_id: string
  op: string
  payload: unknown | null
  created_at: string
}
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object'
}

async function upsertRemoteRow<T extends SyncFields>(tableName: keyof typeof db, row: T): Promise<void> {
  // Dexie tables are defined on db instance; index signature is fine here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any)[tableName] as { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<void>; update: (id: string, v: Partial<T>) => Promise<void> }
  const existing = await table.get(row.id)
  if (existing) {
    await table.update(row.id, { ...(row as unknown as Partial<T>), synced_at: row.updated_at } as Partial<T>)
    return
  }
  await table.add({ ...(row as T), synced_at: row.updated_at })
}

async function applyBillBundle(bundle: unknown): Promise<void> {
  if (!isRecord(bundle)) return
  const bill = bundle.bill as Bill | undefined
  const items = (bundle.bill_items as BillItem[] | undefined) ?? []
  const splits = (bundle.item_splits as ItemSplit[] | undefined) ?? []
  if (bill) await upsertRemoteRow('bills', bill)
  for (const it of items) await upsertRemoteRow('bill_items', it)
  for (const sp of splits) await upsertRemoteRow('item_splits', sp)
}

async function applyGroupBundle(bundle: unknown): Promise<void> {
  if (!isRecord(bundle)) return
  const group = bundle.group as Group | undefined
  const members = (bundle.group_members as GroupMember[] | undefined) ?? []
  if (group) await upsertRemoteRow('groups', group)
  for (const m of members) await upsertRemoteRow('group_members', m)
}

async function applySettlementBundle(bundle: unknown): Promise<void> {
  if (!isRecord(bundle)) return
  const settlement = bundle.settlement as Settlement | undefined
  if (settlement) await upsertRemoteRow('settlements', settlement)
}

function bundleRows<T extends SyncFields>(bundle: ReconcileBundle, key: keyof ReconcileBundle): T[] {
  const rows = bundle[key]
  return (Array.isArray(rows) ? rows : []) as T[]
}

function shouldFallbackPullAfterNoopReconcile(ev: UserEventRow): boolean {
  if (ev.op === 'DELETE') return false
  return ev.entity_type === 'groups' || ev.entity_type === 'group_members'
}

async function applyReconcileBundle(bundle: ReconcileBundle): Promise<number> {
  let applied = 0
  for (const row of bundleRows<Profile>(bundle, 'profiles')) {
    await upsertRemoteRow('profiles', row)
    applied++
  }
  for (const row of bundleRows<Group>(bundle, 'groups')) {
    await upsertRemoteRow('groups', row)
    applied++
  }
  for (const row of bundleRows<GroupMember>(bundle, 'group_members')) {
    await upsertRemoteRow('group_members', row)
    applied++
  }
  for (const row of bundleRows<Bill>(bundle, 'bills')) {
    await upsertRemoteRow('bills', row)
    applied++
  }
  for (const row of bundleRows<BillItem>(bundle, 'bill_items')) {
    await upsertRemoteRow('bill_items', row)
    applied++
  }
  for (const row of bundleRows<ItemSplit>(bundle, 'item_splits')) {
    await upsertRemoteRow('item_splits', row)
    applied++
  }
  for (const row of bundleRows<Settlement>(bundle, 'settlements')) {
    await upsertRemoteRow('settlements', row)
    applied++
  }
  for (const row of bundleRows<ActivityLog>(bundle, 'activity_log')) {
    await upsertRemoteRow('activity_log', row)
    applied++
  }
  for (const row of bundleRows<ProfilePeerLink>(bundle, 'profile_peer_links')) {
    await upsertRemoteRow('profile_peer_links', row)
    applied++
  }
  return applied
}

function rememberEventId(recentOrder: string[], recentSet: Set<string>, eventId: string): void {
  if (recentSet.has(eventId)) return
  recentSet.add(eventId)
  recentOrder.push(eventId)
  if (recentOrder.length <= MAX_RECENT_EVENT_IDS) return
  const evicted = recentOrder.shift()
  if (evicted) recentSet.delete(evicted)
}

async function processEvent(userId: string, ev: UserEventRow): Promise<void> {
  const startedAt = performance.now()
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
      const applied = await applyReconcileBundle(data as ReconcileBundle)
      if (applied > 0) {
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, applied })
        return
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
        return
      }
      if (ev.op !== 'DELETE') {
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, applied })
        return
      }
    }
  }

  // Deletes are tricky to represent without updated_at; safest is to pull changes.
  if (ev.op === 'DELETE') {
    await pullChanges(userId)
    captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
    return
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
        return
      }
      await applyBillBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return
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
        return
      }
      await applyGroupBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return
    }
    case 'group_members': {
      const gid = payload?.group_id as string | undefined
      if (!gid) {
        // Fall back: pull changes, since we can't locate the group reliably.
        await pullChanges(userId)
        captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
        return
      }
      const { data, error } = await withMetric(
        'realtime.fetch.groupBundle',
        () => supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: gid }),
        { op: ev.op },
      )
      if (error) {
        console.warn('[realtime] group bundle fetch failed', error.message)
        captureMetric('realtime.event.process', false, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
        return
      }
      await applyGroupBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return
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
        return
      }
      await applySettlementBundle(data)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op })
      return
    }
    default: {
      // Unknown entity type; reconcile via pull.
      await pullChanges(userId)
      captureMetric('realtime.event.process', true, performance.now() - startedAt, { entity: ev.entity_type, op: ev.op, fallbackPull: true })
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
    // Many missed events — one syncRoundTrip is far cheaper than N individual RPCs.
    await syncRoundTrip(userId)
    localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), now())
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

    try {
      await processEvent(userId, ev)
    } catch (error) {
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

  async function flush() {
    if (flushing) return
    flushing = true
    try {
      while (!disposed && queue.length > 0) {
        const ev = queue.shift()
        if (!ev) break
        await processEventSafely(ev)
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

