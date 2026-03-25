import { supabase } from '@/lib/supabase'
import { db } from '@/db/db'
import { now } from '@/lib/utils'
import type { SyncFields, Bill, BillItem, ItemSplit, Group, GroupMember, Settlement } from '@/types'
import { pullChanges } from '@/sync/sync-service'

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

const LAST_SEEN_EVENT_KEY = (userId: string) => `kwenta_last_seen_user_event:${userId}`

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object'
}

async function upsertRemoteRow<T extends SyncFields>(tableName: keyof typeof db, row: T): Promise<void> {
  // Dexie tables are defined on db instance; index signature is fine here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any)[tableName] as { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<void>; update: (id: string, v: Partial<T>) => Promise<void> }
  const existing = await table.get(row.id)
  if (existing) {
    if (row.updated_at > existing.updated_at) {
      await table.update(row.id, { ...(row as unknown as Partial<T>), synced_at: row.updated_at } as Partial<T>)
    }
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

async function processEvent(userId: string, ev: UserEventRow): Promise<void> {
  // Deletes are tricky to represent without updated_at; safest is to pull changes.
  if (ev.op === 'DELETE') {
    await pullChanges(userId)
    return
  }

  const payload = (isRecord(ev.payload) ? ev.payload : null) as Record<string, unknown> | null

  switch (ev.entity_type) {
    case 'bills': {
      const { data, error } = await supabase.rpc('kwenta_fetch_bill_bundle', { p_bill_id: ev.entity_id })
      if (error) {
        console.warn('[realtime] bill bundle fetch failed', error.message)
        return
      }
      await applyBillBundle(data)
      return
    }
    case 'groups': {
      const gid = (payload?.group_id as string | undefined) ?? ev.entity_id
      const { data, error } = await supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: gid })
      if (error) {
        console.warn('[realtime] group bundle fetch failed', error.message)
        return
      }
      await applyGroupBundle(data)
      return
    }
    case 'group_members': {
      const gid = payload?.group_id as string | undefined
      if (!gid) {
        // Fall back: pull changes, since we can't locate the group reliably.
        await pullChanges(userId)
        return
      }
      const { data, error } = await supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: gid })
      if (error) {
        console.warn('[realtime] group bundle fetch failed', error.message)
        return
      }
      await applyGroupBundle(data)
      return
    }
    case 'settlements': {
      const { data, error } = await supabase.rpc('kwenta_fetch_settlement', { p_settlement_id: ev.entity_id })
      if (error) {
        console.warn('[realtime] settlement fetch failed', error.message)
        return
      }
      await applySettlementBundle(data)
      return
    }
    default: {
      // Unknown entity type; reconcile via pull.
      await pullChanges(userId)
    }
  }
}

async function catchUpSince(userId: string, sinceIso: string): Promise<void> {
  const { data, error } = await supabase
    .from('kwenta_user_events')
    .select('*')
    .eq('user_id', userId)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(500)

  if (error) {
    console.warn('[realtime] catch-up query failed', error.message)
    return
  }

  const events = (data ?? []) as UserEventRow[]
  for (const ev of events) {
    await processEvent(userId, ev)
    localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), ev.created_at)
  }
}

export function startRealtimeForUser(userId: string): () => void {
  let disposed = false
  const queue: UserEventRow[] = []
  let flushing = false

  const lastSeen = localStorage.getItem(LAST_SEEN_EVENT_KEY(userId)) ?? '1970-01-01T00:00:00.000Z'
  void catchUpSince(userId, lastSeen)

  async function flush() {
    if (flushing) return
    flushing = true
    try {
      while (!disposed && queue.length > 0) {
        const ev = queue.shift()
        if (!ev) break
        await processEvent(userId, ev)
        localStorage.setItem(LAST_SEEN_EVENT_KEY(userId), ev.created_at)
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
        const sinceIso = localStorage.getItem(LAST_SEEN_EVENT_KEY(userId)) ?? '1970-01-01T00:00:00.000Z'
        void catchUpSince(userId, sinceIso)
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

