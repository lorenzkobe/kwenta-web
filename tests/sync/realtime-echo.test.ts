import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { makeBill, makeItem, makeSplit, resetDb } from '../helpers/db'

/**
 * perf-pass-1, C7-C10: a realtime event must only invalidate the screens when it actually moved
 * something.
 *
 * Every write this device makes comes back as N `kwenta_user_events` (one per row, per member).
 * The rows those events reconcile are the rows the write already mirrored, so bumping
 * `dataVersion` for each of them made every mounted screen refetch after every save: a storm of
 * requests for payloads that could not have changed. The rule reused here is the one
 * `sync-service` already applies to a pulled bundle (`contentMoved`): a row moved when it is new
 * or its `updated_at` differs from the stored copy. A fallback pull is always treated as moved
 * (it cannot tell), and the last-seen cursor advances regardless.
 *
 * Real Dexie (fake-indexeddb) holds the mirror; only the network and sync-service are mocked.
 */

type Ev = {
  id: string
  user_id: string
  entity_type: string
  entity_id: string
  op: string
  payload: Record<string, unknown>
  created_at: string
  event_type: string
}

const h = vi.hoisted(() => {
  const state = {
    flags: {
      targetedRealtimeReconcile: true,
      coalesceRealtimeBatch: true,
      realtimeCatchupSingleRun: true,
    } as Record<string, boolean>,
    /** What `kwenta_user_events` returns to the catch-up query. */
    catchUpEvents: [] as unknown[],
    /** The postgres_changes handler startRealtimeForUser registers. */
    onChange: null as null | ((payload: { new: unknown }) => void),
    /** Per-RPC answer; a function lets a test hold a call open. */
    rpcAnswer: {} as Record<string, () => Promise<{ data: unknown; error: { message: string } | null }>>,
    syncResult: { pushed: 0, pulled: 0, changed: 0, errors: [] as string[] },
  }
  const rpc = vi.fn(async (fn: string) => {
    const answer = state.rpcAnswer[fn]
    return answer ? answer() : { data: null, error: null }
  })
  const pullChanges = vi.fn(async () => ({ pulled: 0, errors: [] as string[] }))
  const syncRoundTrip = vi.fn(async () => ({ ...state.syncResult }))
  return { state, rpc, pullChanges, syncRoundTrip }
})

vi.mock('@/lib/supabase', () => {
  function query(): Record<string, unknown> {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      gt: () => q,
      order: () => q,
      limit: async () => ({ data: h.state.catchUpEvents, error: null }),
    }
    return q
  }
  return {
    supabase: {
      rpc: h.rpc,
      from: () => query(),
      channel: () => {
        const ch = {
          on: (_type: string, _filter: unknown, cb: (payload: { new: unknown }) => void) => {
            h.state.onChange = cb
            return ch
          },
          subscribe: () => ch,
        }
        return ch
      },
      removeChannel: vi.fn(async () => {}),
    },
  }
})

// `compareTimestamps` is the real one: it IS the moved rule under test (realtime-events reuses
// sync-service's comparison rather than keeping a second copy).
vi.mock('@/sync/sync-service', async (importOriginal) => ({
  compareTimestamps: (await importOriginal<typeof import('@/sync/sync-service')>()).compareTimestamps,
  pullChanges: h.pullChanges,
  // The real syncRoundTrip bumps `dataVersion` itself when it changed rows, so the stand-in does
  // too; the batch/catch-up paths add a bump only for a push.
  syncRoundTrip: async (userId: string) => {
    const result = await h.syncRoundTrip(userId)
    if (result.changed > 0) {
      const { useAppStore } = await import('@/store/app-store')
      useAppStore.getState().bumpDataVersion()
    }
    return result
  },
  KWENTA_LAST_PULL_STORAGE_KEY: 'kwenta_last_pull',
}))

vi.mock('@/lib/runtime-flags', () => ({
  isRuntimeFlagEnabled: (key: string) => Boolean(h.state.flags[key]),
}))

vi.mock('@/lib/client-metrics', () => ({
  captureMetric: vi.fn(),
  withMetric: (_n: string, fn: () => unknown) => fn(),
}))

import { processEvent, startRealtimeForUser } from '@/sync/realtime-events'

const USER = 'ME'
/** The cursor key realtime-events reads on start and writes after each event. */
const CURSOR_KEY = `kwenta_last_seen_user_event:${USER}`
const STORED_AT = '2026-09-20T10:00:00.000Z'
const NEWER_AT = '2026-09-23T10:00:00.000Z'

function ev(over: Partial<Ev> = {}): Ev {
  return {
    id: 'e1',
    user_id: USER,
    entity_type: 'bills',
    entity_id: 'B1',
    op: 'UPDATE',
    payload: {},
    created_at: '2026-09-23T10:00:01.000Z',
    event_type: 'entity_changed',
    ...over,
  }
}

/** The bill this device already mirrors, synced (synced_at === updated_at). */
function storedRows() {
  const bill = makeBill({ id: 'B1', created_by: USER, total_amount: 100 })
  const item = makeItem({ id: 'I1', bill_id: 'B1', amount: 100 })
  const split = makeSplit({ id: 'S1', item_id: 'I1', user_id: USER, computed_amount: 100 })
  for (const r of [bill, item, split]) {
    r.updated_at = STORED_AT
    r.synced_at = STORED_AT
  }
  return { bill, item, split }
}

function reconcileReturns(bundle: Record<string, unknown[]>) {
  h.state.rpcAnswer.kwenta_reconcile_user_event = async () => ({ data: bundle, error: null })
}

function version(): number {
  return useAppStore.getState().dataVersion
}

/** Let fake-indexeddb and the async flush loop run to completion. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10))
}

function deliver(row: Ev) {
  if (!h.state.onChange) throw new Error('realtime handler was never registered')
  h.state.onChange({ new: row })
}

let stop: (() => void) | null = null

beforeEach(async () => {
  stop?.()
  stop = null
  await resetDb()
  localStorage.clear()
  h.rpc.mockClear()
  h.pullChanges.mockClear()
  h.syncRoundTrip.mockClear()
  h.state.flags = {
    targetedRealtimeReconcile: true,
    coalesceRealtimeBatch: true,
    realtimeCatchupSingleRun: true,
  }
  h.state.catchUpEvents = []
  h.state.onChange = null
  h.state.rpcAnswer = {}
  h.state.syncResult = { pushed: 0, pulled: 0, changed: 0, errors: [] }
  const { bill, item, split } = storedRows()
  await db.bills.add(bill)
  await db.bill_items.add(item)
  await db.item_splits.add(split)
})

describe('processEvent reports whether it moved anything', () => {
  it('C7: resolves false when every reconciled row equals the stored row (same updated_at)', async () => {
    const { bill, item, split } = storedRows()
    reconcileReturns({ bills: [bill], bill_items: [item], item_splits: [split] })

    await expect(processEvent(USER, ev() as never)).resolves.toBe(false)
    expect(h.pullChanges).not.toHaveBeenCalled()
  })

  it('C8: resolves true when one reconciled row has a different updated_at, and mirrors it', async () => {
    const { bill, item, split } = storedRows()
    reconcileReturns({
      bills: [bill],
      bill_items: [item],
      item_splits: [{ ...split, computed_amount: 60, updated_at: NEWER_AT }],
    })

    await expect(processEvent(USER, ev() as never)).resolves.toBe(true)
    const stored = await db.item_splits.get('S1')
    expect(stored?.updated_at).toBe(NEWER_AT)
    expect(stored?.computed_amount).toBe(60)
  })

  it('C8: resolves true when the reconciled bundle carries a row this device does not have', async () => {
    const { bill } = storedRows()
    const fresh = makeSplit({ id: 'S2', item_id: 'I1', user_id: 'FR', computed_amount: 50 })
    reconcileReturns({ bills: [bill], item_splits: [fresh] })

    await expect(processEvent(USER, ev() as never)).resolves.toBe(true)
    expect(await db.item_splits.get('S2')).toBeTruthy()
  })

  it('H1.4: resolves true when the reconcile returns no rows for a non-DELETE event', async () => {
    // The server no longer shows a row the event named (e.g. access lost): a change to re-read for.
    reconcileReturns({})

    await expect(processEvent(USER, ev({ op: 'UPDATE' }) as never)).resolves.toBe(true)
    expect(h.pullChanges).not.toHaveBeenCalled()
  })

  it('C10: a DELETE event that falls back to a pull resolves true', async () => {
    reconcileReturns({})

    await expect(processEvent(USER, ev({ op: 'DELETE' }) as never)).resolves.toBe(true)
    expect(h.pullChanges).toHaveBeenCalledTimes(1)
  })

  it('C10: with targeted reconcile off, a DELETE still pulls and resolves true', async () => {
    h.state.flags.targetedRealtimeReconcile = false

    await expect(processEvent(USER, ev({ op: 'DELETE' }) as never)).resolves.toBe(true)
    expect(h.pullChanges).toHaveBeenCalledTimes(1)
  })
})

describe('startRealtimeForUser only bumps dataVersion when something moved', () => {
  it('C7: an echo of rows Dexie already holds does not bump, and the cursor still advances', async () => {
    const { bill, item, split } = storedRows()
    reconcileReturns({ bills: [bill], bill_items: [item], item_splits: [split] })
    stop = startRealtimeForUser(USER)
    await settle()
    const before = version()

    deliver(ev({ id: 'echo-1', created_at: '2026-09-23T10:00:05.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:05.000Z'))
    await settle()

    expect(version()).toBe(before)
    expect(h.pullChanges).not.toHaveBeenCalled()
  })

  it('C8: an event whose row changed bumps exactly once', async () => {
    const { bill } = storedRows()
    reconcileReturns({ bills: [{ ...bill, title: 'Dinner', updated_at: NEWER_AT }] })
    stop = startRealtimeForUser(USER)
    await settle()
    const before = version()

    deliver(ev({ id: 'real-1', created_at: '2026-09-23T10:00:06.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:06.000Z'))
    await settle()

    expect(version()).toBe(before + 1)
    expect((await db.bills.get('B1'))?.title).toBe('Dinner')
  })

  it('H1.4: an event whose reconcile comes back empty bumps exactly once', async () => {
    reconcileReturns({})
    stop = startRealtimeForUser(USER)
    await settle()
    const before = version()

    deliver(ev({ id: 'gone-1', created_at: '2026-09-23T10:00:08.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:08.000Z'))
    await settle()

    expect(version()).toBe(before + 1)
  })

  it('C10: an event whose fetch fails falls back to a pull and still bumps', async () => {
    h.state.flags.targetedRealtimeReconcile = false
    h.state.rpcAnswer.kwenta_fetch_bill_bundle = async () => ({ data: null, error: { message: 'boom' } })
    stop = startRealtimeForUser(USER)
    await settle()
    const before = version()

    deliver(ev({ id: 'fail-1', created_at: '2026-09-23T10:00:07.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:07.000Z'))
    await settle()

    expect(h.pullChanges).toHaveBeenCalledTimes(1)
    expect(version()).toBe(before + 1)
  })

  /**
   * A coalesced batch needs >= 2 fresh events drained together. The first delivery is processed
   * alone (its reconcile is held open), and the next two queue behind it and drain as one batch.
   */
  async function runCoalescedBatch() {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const { bill } = storedRows()
    h.state.rpcAnswer.kwenta_reconcile_user_event = async () => {
      await held
      return { data: { bills: [bill] }, error: null }
    }
    stop = startRealtimeForUser(USER)
    await settle()
    const before = version()

    deliver(ev({ id: 'b-1', created_at: '2026-09-23T10:01:00.000Z' }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledWith('kwenta_reconcile_user_event', expect.anything()))
    deliver(ev({ id: 'b-2', created_at: '2026-09-23T10:01:01.000Z' }))
    deliver(ev({ id: 'b-3', created_at: '2026-09-23T10:01:02.000Z' }))
    release()

    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:01:02.000Z'))
    await settle()
    return before
  }

  it('C9: a coalesced batch whose syncRoundTrip moved nothing does not bump', async () => {
    h.state.syncResult = { pushed: 0, pulled: 812, changed: 0, errors: [] }
    const before = await runCoalescedBatch()
    // `pulled` is the size of a complete bundle, never evidence of change.
    expect(version()).toBe(before)
  })

  it('C9: a coalesced batch whose syncRoundTrip changed rows bumps exactly once', async () => {
    h.state.syncResult = { pushed: 0, pulled: 812, changed: 2, errors: [] }
    const before = await runCoalescedBatch()
    expect(version()).toBe(before + 1)
  })

  function missedEvents(n: number): Ev[] {
    return Array.from({ length: n }, (_, i) =>
      ev({ id: `m-${i}`, created_at: `2026-09-23T11:00:0${i}.000Z` }),
    )
  }

  it('C9: a bulk catch-up whose syncRoundTrip moved nothing does not bump, cursor still advances', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-09-23T09:00:00.000Z')
    h.state.catchUpEvents = missedEvents(6)
    h.state.syncResult = { pushed: 0, pulled: 812, changed: 0, errors: [] }
    const before = version()

    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T11:00:05.000Z'))
    await settle()

    expect(version()).toBe(before)
  })

  it('C9: a bulk catch-up whose syncRoundTrip changed rows bumps exactly once', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-09-23T09:00:00.000Z')
    h.state.catchUpEvents = missedEvents(6)
    h.state.syncResult = { pushed: 0, pulled: 812, changed: 3, errors: [] }
    const before = version()

    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T11:00:05.000Z'))
    await settle()

    expect(version()).toBe(before + 1)
  })

  it('a coalesced batch whose syncRoundTrip pushed AND changed rows bumps exactly once', async () => {
    h.state.syncResult = { pushed: 1, pulled: 812, changed: 2, errors: [] }
    const before = await runCoalescedBatch()
    expect(version()).toBe(before + 1)
  })

  it('a bulk catch-up that pushed AND changed rows bumps exactly once', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-09-23T09:00:00.000Z')
    h.state.catchUpEvents = missedEvents(6)
    h.state.syncResult = { pushed: 1, pulled: 812, changed: 4, errors: [] }
    const before = version()

    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T11:00:05.000Z'))
    await settle()

    expect(version()).toBe(before + 1)
  })

  it('C9: a bulk catch-up that pushed rows bumps exactly once', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-09-23T09:00:00.000Z')
    h.state.catchUpEvents = missedEvents(6)
    h.state.syncResult = { pushed: 1, pulled: 812, changed: 0, errors: [] }
    const before = version()

    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await settle()

    expect(version()).toBe(before + 1)
  })
})
