import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { makeBill, makeItem, makeMember, makeSplit, resetDb } from '../helpers/db'

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
    /** What waiting for this device's in-flight cloud writes does (072 echo skip). */
    waitWrites: async (): Promise<boolean> => true,
    /** Each `kwenta_user_events` query built, as its chained calls. */
    queries: [] as unknown[][][],
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
    const calls: unknown[][] = []
    h.state.queries.push(calls)
    const q: Record<string, unknown> = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), q),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), q),
      gt: (...a: unknown[]) => (calls.push(['gt', ...a]), q),
      order: (...a: unknown[]) => (calls.push(['order', ...a]), q),
      limit: async (...a: unknown[]) => {
        calls.push(['limit', ...a])
        return { data: h.state.catchUpEvents, error: null }
      },
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

vi.mock('@/sync/in-flight-writes', () => ({
  waitForInFlightCloudWrites: () => h.state.waitWrites(),
  trackCloudWrite: <T>(p: Promise<T>) => p,
}))

vi.mock('@/lib/runtime-flags', () => ({
  isRuntimeFlagEnabled: (key: string) => Boolean(h.state.flags[key]),
}))

vi.mock('@/lib/client-metrics', () => ({
  captureMetric: vi.fn(),
  withMetric: (_n: string, fn: () => unknown) => fn(),
}))

import { processEvent, startRealtimeForUser } from '@/sync/realtime-events'
import { clearRealtimeProcessingFailed, realtimeProcessingFailed } from '@/sync/realtime-health'

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
  h.state.waitWrites = async () => true
  h.state.queries = []
  clearRealtimeProcessingFailed()
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

/**
 * 072: every event names the row that fired it and its server version. An event whose row this
 * device already mirrors at EXACTLY that version (synced) carries no news — it is the echo of this
 * device's own write — so it costs no RPC, no round trip and no re-read. Anything less certain
 * falls back to today's path.
 */
describe('echo skip: events for a row version this device already mirrors', () => {
  /** Postgres renders the stored STORED_AT like this (to_jsonb of a timestamptz). */
  const STORED_PG = '2026-09-20T10:00:00+00:00'
  const NEWER_PG = '2026-09-23T10:00:00+00:00'

  function rowEv(id: string, created_at: string, row: Record<string, unknown> | null, over: Partial<Ev> = {}): Ev {
    return ev({ id, created_at, payload: { bill_id: 'B1', group_id: null, row }, ...over })
  }

  async function started() {
    stop = startRealtimeForUser(USER)
    await settle()
    h.rpc.mockClear()
    return version()
  }

  it('C3: a lone echo makes no RPC and no re-read, and the cursor advances', async () => {
    const before = await started()

    deliver(rowEv('x-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:01.000Z'))
    await settle()

    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
    expect(h.pullChanges).not.toHaveBeenCalled()
    expect(version()).toBe(before)
  })

  it('C4: the burst of echoes one save produces (bill, item, splits) costs no RPC and no round trip', async () => {
    const before = await started()

    deliver(rowEv('y-1', '2026-09-23T12:00:01.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }))
    deliver(rowEv('y-2', '2026-09-23T12:00:02.000Z', { table: 'bill_items', id: 'I1', updated_at: STORED_PG }))
    deliver(rowEv('y-3', '2026-09-23T12:00:03.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    deliver(rowEv('y-4', '2026-09-23T12:00:04.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }))
    deliver(rowEv('y-5', '2026-09-23T12:00:05.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:05.000Z'))
    await settle()

    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
    expect(version()).toBe(before)
  })

  it('C5: echoes drained with one foreign event: only the foreign one is reconciled, no round trip', async () => {
    const { split } = storedRows()
    reconcileReturns({ item_splits: [{ ...split, computed_amount: 70, updated_at: NEWER_AT }] })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    h.state.waitWrites = async () => {
      await held
      return true
    }
    const before = await started()

    // The first delivery is drained alone and parks on the wait; the rest queue behind it and
    // drain together as one batch of four.
    deliver(rowEv('z-1', '2026-09-23T12:00:01.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }))
    deliver(rowEv('z-2', '2026-09-23T12:00:02.000Z', { table: 'bill_items', id: 'I1', updated_at: STORED_PG }))
    deliver(rowEv('z-3', '2026-09-23T12:00:03.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }))
    deliver(rowEv('z-4', '2026-09-23T12:00:04.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    deliver(rowEv('z-5', '2026-09-23T12:00:05.000Z', { table: 'bill_items', id: 'I1', updated_at: STORED_PG }))
    release()
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:05.000Z'))
    await settle()

    expect(h.syncRoundTrip).not.toHaveBeenCalled()
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith('kwenta_reconcile_user_event', expect.anything())
    expect((await db.item_splits.get('S1'))?.computed_amount).toBe(70)
    expect(version()).toBe(before + 1)
  })

  it('C6: a different version (another member edited the row) is reconciled as before', async () => {
    const { split } = storedRows()
    reconcileReturns({ item_splits: [{ ...split, computed_amount: 55, updated_at: NEWER_AT }] })
    const before = await started()
    deliver(rowEv('d-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    await settle()
    expect((await db.item_splits.get('S1'))?.computed_amount).toBe(55)
    expect(version()).toBe(before + 1)
  })

  it('C6: a version one microsecond newer is not mistaken for the stored one', async () => {
    await db.item_splits.update('S1', {
      updated_at: '2026-09-20T10:00:00.123456+00:00',
      synced_at: '2026-09-20T10:00:00.123456+00:00',
    })
    const before = await started()
    reconcileReturns({})
    deliver(rowEv('u-1', '2026-09-23T12:00:01.000Z', {
      table: 'item_splits', id: 'S1', updated_at: '2026-09-20T10:00:00.123457+00:00',
    }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    await settle()
    expect(version()).toBe(before + 1)
  })

  it('C7: a payload without a row (pre-072 server) is reconciled as before', async () => {
    const before = await started()
    reconcileReturns({})
    deliver(rowEv('o-1', '2026-09-23T12:00:01.000Z', null, { payload: { bill_id: 'B1', group_id: null } }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    await settle()
    expect(version()).toBe(before + 1)
  })

  it('C8: a row this device has staged but not pushed (synced_at null) is not skipped', async () => {
    await db.item_splits.update('S1', { synced_at: null })
    const before = await started()
    reconcileReturns({})
    deliver(rowEv('s-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    await settle()
    expect(version()).toBe(before + 1)
  })

  it('C8: a row this device does not hold is not skipped', async () => {
    await started()
    reconcileReturns({})
    deliver(rowEv('m-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S9', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
  })

  it('C9: a DELETE event is never skipped, even carrying a mirrored row', async () => {
    await started()
    reconcileReturns({})
    deliver(rowEv('del-1', '2026-09-23T12:00:01.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }, { op: 'DELETE' }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    expect(h.rpc).toHaveBeenCalledWith('kwenta_reconcile_user_event', expect.anything())
  })

  it('the skip also holds on the one-event-at-a-time path (coalescing off, catch-up)', async () => {
    h.state.flags.coalesceRealtimeBatch = false
    const before = await started()
    deliver(rowEv('one-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:01.000Z'))
    await settle()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(version()).toBe(before)
  })

  it('a catch-up of a few missed echoes skips them one by one', async () => {
    localStorage.setItem(CURSOR_KEY, '2026-09-23T09:00:00.000Z')
    h.state.catchUpEvents = [
      rowEv('c-1', '2026-09-23T11:00:01.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }),
      rowEv('c-2', '2026-09-23T11:00:02.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }),
    ]
    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T11:00:02.000Z'))
    await settle()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
  })

  it('C10: an echo that arrives before its write response is mirrored waits for the write, then skips', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    h.state.waitWrites = async () => {
      await held
      return true
    }
    const before = await started()

    deliver(rowEv('w-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    deliver(rowEv('w-2', '2026-09-23T12:00:02.000Z', { table: 'bills', id: 'B1', updated_at: NEWER_PG }))
    await settle()
    // The write's response lands: submitCloudWrite mirrors the server's rows, then settles.
    await db.item_splits.update('S1', { updated_at: NEWER_PG, synced_at: NEWER_PG })
    await db.bills.update('B1', { updated_at: NEWER_PG, synced_at: NEWER_PG })
    release()
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:02.000Z'))
    await settle()

    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
    expect(version()).toBe(before)
  })

  it('C14: when the wait times out, unmirrored events are processed normally and the cursor advances', async () => {
    h.state.waitWrites = async () => false
    await started()
    reconcileReturns({})
    deliver(rowEv('t-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    deliver(rowEv('t-2', '2026-09-23T12:00:02.000Z', { table: 'bills', id: 'B1', updated_at: NEWER_PG }))
    deliver(rowEv('t-3', '2026-09-23T12:00:03.000Z', { table: 'bills', id: 'B1', updated_at: NEWER_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:03.000Z'))
    await settle()
    // t-1 drains alone and is reconciled; t-2 and t-3 drain together and take the round trip.
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.syncRoundTrip).toHaveBeenCalledTimes(1)
  })

  it('C14: a timed-out wait still skips events that ARE mirrored', async () => {
    h.state.waitWrites = async () => false
    await started()
    deliver(rowEv('tm-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: STORED_PG }))
    deliver(rowEv('tm-2', '2026-09-23T12:00:02.000Z', { table: 'bills', id: 'B1', updated_at: STORED_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:02.000Z'))
    await settle()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
  })

  it('a batch whose wait outlives sign-out does nothing for the old session', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    h.state.waitWrites = async () => {
      await held
      return true
    }
    await started()
    deliver(rowEv('so-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    await settle()
    stop?.()
    stop = null
    const cursorBefore = localStorage.getItem(CURSOR_KEY)
    release()
    await settle()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
    expect(localStorage.getItem(CURSOR_KEY)).toBe(cursorBefore)
  })

  it('C14: a wait that throws does not lose the batch', async () => {
    h.state.waitWrites = async () => {
      throw new Error('boom')
    }
    await started()
    reconcileReturns({})
    deliver(rowEv('th-1', '2026-09-23T12:00:01.000Z', { table: 'item_splits', id: 'S1', updated_at: NEWER_PG }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:01.000Z'))
    await settle()
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('C15: the groups refresh event of a membership change is skipped by its group_members row', async () => {
    const member = makeMember({ id: 'GM1', group_id: 'G1', user_id: USER })
    member.updated_at = STORED_AT
    member.synced_at = STORED_AT
    await db.group_members.add(member)
    const before = await started()

    deliver(ev({
      id: 'g-1', created_at: '2026-09-23T12:00:01.000Z', entity_type: 'groups', entity_id: 'G1',
      payload: { group_id: 'G1', row: { table: 'group_members', id: 'GM1', updated_at: STORED_PG } },
    }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T12:00:01.000Z'))
    await settle()

    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.pullChanges).not.toHaveBeenCalled()
    expect(version()).toBe(before)
  })
})

/**
 * The tab-focus probe trusts the cursor, so two things the full focus sync used to paper over now
 * have to hold on their own: a failed apply is remembered (the cursor moves past it regardless),
 * and the cursor only ever holds a SERVER timestamp.
 */
describe('what the focus probe relies on', () => {
  it('C13: an event whose fetch AND fallback pull fail marks realtime as failed', async () => {
    h.state.flags.targetedRealtimeReconcile = false
    h.state.rpcAnswer.kwenta_fetch_bill_bundle = async () => ({ data: null, error: { message: 'boom' } })
    h.pullChanges.mockResolvedValueOnce({ pulled: 0, errors: ['pull failed'] })
    stop = startRealtimeForUser(USER)
    await settle()
    deliver(ev({ id: 'f-1', created_at: '2026-09-23T10:00:07.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:07.000Z'))
    await settle()
    expect(realtimeProcessingFailed()).toBe(true)
  })

  it('C13: a fetch failure healed by the fallback pull does not mark it', async () => {
    h.state.flags.targetedRealtimeReconcile = false
    h.state.rpcAnswer.kwenta_fetch_bill_bundle = async () => ({ data: null, error: { message: 'boom' } })
    stop = startRealtimeForUser(USER)
    await settle()
    deliver(ev({ id: 'f-2', created_at: '2026-09-23T10:00:08.000Z' }))
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-23T10:00:08.000Z'))
    await settle()
    expect(h.pullChanges).toHaveBeenCalledTimes(1)
    expect(realtimeProcessingFailed()).toBe(false)
  })

  it('C13: a coalesced batch whose round trip reports errors marks realtime as failed', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { bill } = storedRows()
    h.state.rpcAnswer.kwenta_reconcile_user_event = async () => {
      await held
      return { data: { bills: [bill] }, error: null }
    }
    h.state.syncResult = { pushed: 0, pulled: 0, changed: 0, errors: ['round trip failed'] }
    stop = startRealtimeForUser(USER)
    await settle()
    deliver(ev({ id: 'rt-1', created_at: '2026-09-23T10:01:00.000Z' }))
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledWith('kwenta_reconcile_user_event', expect.anything()))
    deliver(ev({ id: 'rt-2', created_at: '2026-09-23T10:01:01.000Z' }))
    deliver(ev({ id: 'rt-3', created_at: '2026-09-23T10:01:02.000Z' }))
    release()
    await vi.waitFor(() => expect(h.syncRoundTrip).toHaveBeenCalledTimes(1))
    await settle()
    expect(realtimeProcessingFailed()).toBe(true)
  })

  it('C15: with no cursor and no events, stopping never stamps one from the device clock', async () => {
    stop = startRealtimeForUser(USER)
    await settle()
    stop()
    stop = null
    expect(localStorage.getItem(CURSOR_KEY)).toBeNull()
  })

  it('C15: with no cursor, it starts from the newest SERVER event without replaying it', async () => {
    h.state.catchUpEvents = [ev({ id: 'old-1', created_at: '2026-09-22T08:00:00.000Z' })]
    stop = startRealtimeForUser(USER)
    await vi.waitFor(() => expect(localStorage.getItem(CURSOR_KEY)).toBe('2026-09-22T08:00:00.000Z'))
    await settle()
    // The NEWEST event: descending, one row. Ascending would start from the oldest and replay
    // the whole history (the mock returns rows regardless of order, so pin the query itself).
    expect(h.state.queries).toContainEqual([
      ['select', 'created_at'],
      ['eq', 'user_id', USER],
      ['order', 'created_at', { ascending: false }],
      ['limit', 1],
    ])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.syncRoundTrip).not.toHaveBeenCalled()
  })
})
