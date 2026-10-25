import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { deleteBill, getBillWithDetails, linkProfileToRemote, updateBill } from '@/db/operations'
import * as billMirror from '@/sync/bill-mirror'
import { BillUnavailableError } from '@/sync/bill-mirror'
import { commitCloudFirstWrite } from '@/sync/cloud-write'
import { cancelScheduledDrainRetry, drainWriteQueue, retryQueuedWrite } from '@/sync/write-queue'
import { upsertRemoteRow } from '@/sync/mirror-upsert'
import { currentSessionEpoch } from '@/sync/session-epoch'
import { fullSync, selectServerRowsToApply } from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import type { Bill, BillItem, ItemSplit, Profile } from '@/types'
import { makeBill, makeItem, makeMember, makeProfile, makeSettlement, makeSplit, resetDb } from '../helpers/db'

/**
 * Edits are built from fresh cloud data, and a save built from a stale copy is refused by the
 * server instead of overwriting newer data (migration 081). The client half of the contract:
 *
 *  - every pushed row whose mirror copy is SYNCED (`synced_at !== null && updated_at <= synced_at`)
 *    carries `_base_updated_at` = that copy's `updated_at`; a staged row, a row edited past its
 *    sync, and a new row carry none — online and when queued offline alike;
 *  - neither `_base_updated_at` nor `_overwrite` is ever written into a Dexie row;
 *  - a retry of a refused entry ("apply mine") sends `_overwrite: true` and no base;
 *  - two queued edits of one row: the second inherits the version the server echoed for the first;
 *  - `loadBillIntoMirror(id, { fresh: true })` refreshes a bill already on the device;
 *  - `captureBillVersion` + `updateBill({ loadedVersion })` base the save on what the form loaded;
 *  - `linkProfileToRemote` sends only the link (045 rewrites the rest server-side), then syncs.
 *
 * Hand-made rows: every Dexie row comes from tests/helpers/db.ts factories (the app's SyncFields
 * shape). Server copies use microsecond timestamps with an explicit offset, the form PostgREST
 * serialises timestamptz in, because that is what the mirror holds after a sync.
 */

const T0 = '2026-10-20T08:00:00.123456+00:00'
const T1 = '2026-10-21T09:30:00.654321+00:00'
const T2 = '2026-10-22T10:00:00.111111+00:00'

const server = vi.hoisted(() => ({
  bundles: new Map<string, unknown>(),
  fetchCalls: [] as string[],
  fetchError: null as { message: string } | null,
  /** When set, kwenta_write refuses with 081's conflict error. */
  conflict: false,
  /** When set, kwenta_write echoes every row with these server-stamped versions, in call order. */
  stamps: [] as string[],
  /** 1-based kwenta_write call numbers that fail as a transport error AFTER storing. */
  lostCalls: new Set<number>(),
  writeCalls: 0,
  cloud: {
    mode: 'ok' as 'ok' | 'error' | 'drop' | 'reject' | 'transport' | 'lost' | 'inactive',
    calls: 0,
    pushes: [] as Record<string, Record<string, unknown>[]>[],
    rejectIds: new Set<string>(),
    seen: new Map<string, Record<string, string[]>>(),
    rpcNames: [] as string[],
    reconcileError: false,
    reconcilePayload: null as Record<string, unknown> | null,
    reconcileCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock, SYNC_TABLES } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(server.cloud as never)
  return {
    supabase: {
      ...base,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'kwenta_fetch_bill_bundle') {
          const id = String(args?.p_bill_id)
          server.fetchCalls.push(id)
          if (server.fetchError) return { data: null, error: server.fetchError }
          return { data: server.bundles.get(id) ?? null, error: null }
        }
        if (fn === 'kwenta_write') {
          server.writeCalls += 1
          const call = server.writeCalls
          if (server.conflict) {
            server.cloud.pushes.push((args?.p_push ?? {}) as Record<string, Record<string, unknown>[]>)
            return {
              data: null,
              error: {
                message: 'This was changed on another device. Refresh and try again.',
                details: 'bills:B',
                hint: 'Nothing from this write was stored.',
                code: 'P0001',
              },
              status: 400,
            }
          }
          const answer = (await base.rpc(fn, args)) as { data: Record<string, unknown> | null; error: unknown }
          if (answer.data) {
            // The real server never echoes the client-only keys (081 suite, C6), and stamps the
            // version of every row it applied against a base.
            const stamp = server.stamps[call - 1]
            for (const t of SYNC_TABLES) {
              const rows = answer.data[t] as Record<string, unknown>[] | undefined
              if (!Array.isArray(rows)) continue
              answer.data[t] = rows.map((r) => {
                const { _base_updated_at: _b, _overwrite: _o, ...rest } = r
                void _b
                void _o
                return stamp ? { ...rest, updated_at: stamp } : rest
              })
            }
          }
          if (server.lostCalls.has(call)) {
            return {
              data: null,
              error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
              status: 0,
            }
          }
          return answer
        }
        return base.rpc(fn, args)
      },
    },
  }
})
vi.mock('@/sync/sync-manager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestSyncNow: vi.fn(),
  triggerSync: vi.fn(),
}))
vi.mock('@/sync/sync-service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, changed: 0 })),
}))
vi.mock('@/lib/kwenta-notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyPaymentRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))

type LoadedVersion = { versions: Record<string, string>; itemIds: string[]; splitIds: string[] }
const loadFresh = (id: string) =>
  (billMirror.loadBillIntoMirror as unknown as (id: string, o?: { fresh?: boolean }) => Promise<void>)(id, {
    fresh: true,
  })
const captureBillVersion = (id: string) =>
  (billMirror as unknown as { captureBillVersion: (id: string) => Promise<LoadedVersion> }).captureBillVersion(id)

const PENDING = {
  operation: 'update_bill',
  entityType: 'bill' as const,
  entityId: 'B',
  payload: {},
  routeHint: null,
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.getState().setOnline(online)
}

/** A row as the mirror holds it after a sync: synced_at = updated_at = the server version. */
function synced<T extends { updated_at: string; synced_at: string | null }>(row: T, at: string): T {
  return { ...row, updated_at: at, synced_at: at }
}

/** The edit a builder sends for a row: the copy, changed, re-stamped by the device, unsynced. */
function edited<T extends object>(row: T, change: Partial<T>, at = '2026-10-25T00:00:00.000Z'): T {
  return { ...row, ...change, updated_at: at, synced_at: null }
}

function pushedRow(callIndex: number, table: string, id: string): Record<string, unknown> | undefined {
  return server.cloud.pushes[callIndex]?.[table]?.find((r) => r.id === id)
}

function lastPushedRow(table: string, id: string): Record<string, unknown> | undefined {
  for (let i = server.cloud.pushes.length - 1; i >= 0; i--) {
    const r = pushedRow(i, table, id)
    if (r) return r
  }
  return undefined
}

type QueuedEntry = {
  id: string
  seq: number
  status: string
  push: Record<string, Record<string, unknown>[]> | null
  restore_pending?: boolean
}
async function queued(): Promise<QueuedEntry[]> {
  const rows = (await db.pending_mutations.toArray()) as unknown as QueuedEntry[]
  return rows.sort((a, b) => a.seq - b.seq)
}

/** No Dexie row in any synced table carries a client-only key. */
async function expectNoClientKeysInDexie() {
  for (const t of [db.profiles, db.groups, db.group_members, db.bills, db.bill_items, db.item_splits, db.settlements, db.activity_log]) {
    const rows = (await t.toArray()) as unknown as Record<string, unknown>[]
    for (const r of rows) {
      expect(r, `${t.name}:${String(r.id)}`).not.toHaveProperty('_base_updated_at')
      expect(r, `${t.name}:${String(r.id)}`).not.toHaveProperty('_overwrite')
    }
  }
}

function serverBundle(bill: Bill, items: BillItem[], splits: ItemSplit[]) {
  return { bill, bill_items: items, item_splits: splits }
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  cancelScheduledDrainRetry()
  setOnline(true)
  server.bundles.clear()
  server.fetchCalls = []
  server.fetchError = null
  server.conflict = false
  server.stamps = []
  server.lostCalls = new Set()
  server.writeCalls = 0
  server.cloud.mode = 'ok'
  server.cloud.calls = 0
  server.cloud.pushes = []
  server.cloud.rejectIds = new Set()
  server.cloud.seen = new Map()
  server.cloud.rpcNames = []
  server.cloud.reconcileError = false
  server.cloud.reconcilePayload = null
  server.cloud.reconcileCalls = []
  vi.mocked(fullSync).mockClear()
  await db.profiles.bulkAdd([makeProfile({ id: 'ME', display_name: 'Me' })])
})

afterEach(() => {
  setOnline(true)
})

// ---------------------------------------------------------------------------------------------
// C8 / C25: which pushed rows carry a base
// ---------------------------------------------------------------------------------------------
describe('C8: a pushed row carries the version its mirror copy was synced at', () => {
  it('C8: synced copy → base = its updated_at; staged copy, edited-past-sync copy and new row → none', async () => {
    const syncedBill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner' }), T0)
    const stagedBill = { ...makeBill({ id: 'S', created_by: 'ME', title: 'Staged' }), updated_at: T1, synced_at: null }
    // C25: synced once at T0, then edited locally at T1 without a sync.
    const movedBill = { ...makeBill({ id: 'M', created_by: 'ME', title: 'Moved' }), updated_at: T1, synced_at: T0 }
    await db.bills.bulkAdd([syncedBill, stagedBill, movedBill])
    const newBill = edited(makeBill({ id: 'N', created_by: 'ME', title: 'New' }), {})

    const { mode } = await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: {
        bills: [
          edited(syncedBill, { title: 'Dinner (edited)' }),
          edited(stagedBill, { title: 'Staged (edited)' }),
          edited(movedBill, { title: 'Moved (edited)' }),
          newBill,
        ],
      },
      pending: PENDING,
    })

    expect(mode).toBe('cloud')
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'bills', 'S')).not.toHaveProperty('_base_updated_at')
    expect(pushedRow(0, 'bills', 'M')).not.toHaveProperty('_base_updated_at')
    expect(pushedRow(0, 'bills', 'N')).not.toHaveProperty('_base_updated_at')
    // A save never asks the server to overwrite.
    expect(pushedRow(0, 'bills', 'B')).not.toHaveProperty('_overwrite')
  })

  it('C8: the base is the MIRROR copy\'s version, not the updated_at the builder stamped on the row', async () => {
    const item = synced(makeItem({ id: 'I', bill_id: 'B', amount: 100 }), T1)
    await db.bill_items.add(item)
    await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bill_items: [edited(item, { amount: 120 }, '2030-01-01T00:00:00.000Z')] },
      pending: PENDING,
    })
    expect(pushedRow(0, 'bill_items', 'I')?._base_updated_at).toBe(T1)
    expect(pushedRow(0, 'bill_items', 'I')?.updated_at).toBe('2030-01-01T00:00:00.000Z')
  })

  it('C8/C9: after an online save no Dexie row carries _base_updated_at', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME' }), T0)
    const item = synced(makeItem({ id: 'I', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'SP', item_id: 'I', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)

    await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: {
        bills: [edited(bill, { title: 'X' })],
        bill_items: [edited(item, { amount: 90 })],
        item_splits: [edited(split, { computed_amount: 90 })],
      },
      pending: PENDING,
    })

    expect(pushedRow(0, 'item_splits', 'SP')?._base_updated_at).toBe(T0)
    expect((await db.bills.get('B'))?.title).toBe('X')
    await expectNoClientKeysInDexie()
  })
})

// ---------------------------------------------------------------------------------------------
// C9: queued offline
// ---------------------------------------------------------------------------------------------
describe('C9: the base is attached before enqueue', () => {
  it('C9: the queued entry carries the base; the staged Dexie row does not; the replay sends it', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner' }), T0)
    await db.bills.add(bill)
    const fresh = edited(makeBill({ id: 'N', created_by: 'ME', title: 'New' }), {})

    setOnline(false)
    const { mode } = await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [edited(bill, { title: 'Dinner (offline)' }), fresh] },
      pending: PENDING,
    })
    expect(mode).toBe('queued')
    expect(server.cloud.pushes).toHaveLength(0)

    const [entry] = await queued()
    const queuedB = entry.push?.bills?.find((r) => r.id === 'B')
    const queuedN = entry.push?.bills?.find((r) => r.id === 'N')
    expect(queuedB?._base_updated_at).toBe(T0)
    expect(queuedN).not.toHaveProperty('_base_updated_at')

    // The staged mirror row shows the edit and holds no client-only key.
    expect((await db.bills.get('B'))?.title).toBe('Dinner (offline)')
    await expectNoClientKeysInDexie()

    setOnline(true)
    await drainWriteQueue('ME')
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'bills', 'N')).not.toHaveProperty('_base_updated_at')
    expect(await db.pending_mutations.count()).toBe(0)
    await expectNoClientKeysInDexie()
  })
})

// ---------------------------------------------------------------------------------------------
// C10: an online conflict refusal
// ---------------------------------------------------------------------------------------------
describe('C10: a conflict refusal online', () => {
  it('C10: throws the "changed on another device" message and leaves Dexie untouched', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I', bill_id: 'B', amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    const newItem = edited(makeItem({ id: 'I2', bill_id: 'B', amount: 50 }), {})
    server.conflict = true

    await expect(
      commitCloudFirstWrite({
        actorUserId: 'ME',
        payload: {
          bills: [edited(bill, { title: 'Dinner (stale edit)', total_amount: 150 })],
          bill_items: [edited(item, { amount: 100 }), newItem],
        },
        pending: PENDING,
      }),
    ).rejects.toThrow(/changed on another device/i)

    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
    expect(await db.bills.get('B')).toEqual(bill)
    expect(await db.bill_items.get('I')).toEqual(item)
    expect(await db.bill_items.get('I2')).toBeUndefined()
    // A refusal is not a transport failure: nothing is queued to be replayed.
    expect(await db.pending_mutations.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// C11 / C23: Retry sends an overwrite, no bases
// ---------------------------------------------------------------------------------------------
describe('C11: retrying a refused queued write', () => {
  it('C11: retryQueuedWrite sends `_overwrite: true` and no `_base_updated_at`; Dexie holds neither', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner' }), T0)
    await db.bills.add(bill)
    setOnline(false)
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(bill, { title: 'Mine' })] }, pending: PENDING })
    setOnline(true)

    server.cloud.rejectIds = new Set(['B'])
    await drainWriteQueue('ME')
    const [entry] = await queued()
    expect(entry.status).toBe('conflict')
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)

    server.cloud.rejectIds = new Set()
    const landed = await retryQueuedWrite(entry.id)

    expect(landed).toBe(true)
    const retried = lastPushedRow('bills', 'B')
    expect(retried?.title).toBe('Mine')
    expect(retried).not.toHaveProperty('_base_updated_at')
    expect(retried?._overwrite).toBe(true)
    expect(await db.pending_mutations.count()).toBe(0)
    await expectNoClientKeysInDexie()
  })
})

// ---------------------------------------------------------------------------------------------
// C22: two queued edits of the same row
// ---------------------------------------------------------------------------------------------
describe('C22: a second queued edit inherits the version the server gave the first', () => {
  it('C22: entry 1 carries the base, entry 2 none; once entry 1 applies, entry 2 is sent with the echoed version', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner' }), T0)
    await db.bills.add(bill)
    setOnline(false)
    await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [edited(bill, { title: 'One' }, '2026-10-25T00:00:01.000Z')] },
      pending: PENDING,
    })
    const staged = (await db.bills.get('B'))!
    await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [edited(staged, { title: 'Two' }, '2026-10-25T00:00:02.000Z')] },
      pending: PENDING,
    })
    const [e1, e2] = await queued()
    expect(e1.push?.bills?.[0]?._base_updated_at).toBe(T0)
    expect(e2.push?.bills?.[0]).not.toHaveProperty('_base_updated_at')

    // Entry 1 is stored and stamped T1 by the server; entry 2's response is lost.
    setOnline(true)
    server.stamps = [T1, T2]
    server.lostCalls = new Set([2])
    await drainWriteQueue('ME', { ignoreBackoff: true } as never)

    const left = await queued()
    expect(left.map((e) => e.id)).toEqual([e2.id])
    // Persisted in the queue, so a later drain (or another tab) sends it too.
    expect(left[0].push?.bills?.[0]?._base_updated_at).toBe(T1)
    expect(pushedRow(1, 'bills', 'B')?._base_updated_at).toBe(T1)

    server.lostCalls = new Set()
    await drainWriteQueue('ME', { ignoreBackoff: true } as never)
    expect(lastPushedRow('bills', 'B')?.title).toBe('Two')
    expect(lastPushedRow('bills', 'B')?._base_updated_at).toBe(T1)
    expect(await db.pending_mutations.count()).toBe(0)
    await expectNoClientKeysInDexie()
  })
})

// ---------------------------------------------------------------------------------------------
// C12 / C13 / C18: loadBillIntoMirror fresh
// ---------------------------------------------------------------------------------------------
describe('C12: a fresh load refreshes a bill already on the device', () => {
  it('C12/C18: one fetch; a newer server amount replaces the local one and a server-only item is added', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)

    const sBill = { ...bill, total_amount: 200, updated_at: T1, synced_at: T1 }
    const sItem = { ...item, amount: 150, updated_at: T1, synced_at: T1 }
    const sItem2 = makeItem({ id: 'I2', bill_id: 'B', amount: 50, created_at: T1, updated_at: T1, synced_at: T1 })
    const sSplit2 = makeSplit({ id: 'S2', item_id: 'I2', user_id: 'ME', computed_amount: 50, updated_at: T1, synced_at: T1 })
    server.bundles.set('B', serverBundle(sBill, [sItem, sItem2], [split, sSplit2]))

    await loadFresh('B')

    expect(server.fetchCalls).toEqual(['B'])
    expect((await db.bill_items.get('I1'))?.amount).toBe(150)
    expect((await db.bills.get('B'))?.total_amount).toBe(200)
    expect((await db.bill_items.get('I2'))?.amount).toBe(50)
    expect((await db.item_splits.get('S2'))?.computed_amount).toBe(50)
    // Refreshed rows are mirror copies of the server: synced at the server's version.
    expect((await db.bill_items.get('I1'))?.synced_at).not.toBeNull()
    expect((await db.bill_items.get('I2'))?.synced_at).not.toBeNull()
    await expectNoClientKeysInDexie()
  })

  it('C12: a staged local row newer than the server copy is kept; an older staged row loses to the server', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME' }), T0)
    const mine = { ...makeItem({ id: 'IM', bill_id: 'B', name: 'mine', amount: 10 }), updated_at: T2, synced_at: null }
    const old = { ...makeItem({ id: 'IO', bill_id: 'B', name: 'old local', amount: 10 }), updated_at: T0, synced_at: null }
    await db.bills.add(bill)
    await db.bill_items.bulkAdd([mine, old])
    server.bundles.set(
      'B',
      serverBundle(bill, [
        { ...mine, name: 'theirs', amount: 99, updated_at: T1, synced_at: T1 },
        { ...old, name: 'server', amount: 77, updated_at: T1, synced_at: T1 },
      ], []),
    )

    await loadFresh('B')

    expect(await db.bill_items.get('IM')).toEqual(mine)
    expect((await db.bill_items.get('IO'))?.name).toBe('server')
    expect((await db.bill_items.get('IO'))?.amount).toBe(77)
  })
})

describe('C13: a fresh load that cannot reach the server', () => {
  it('C13: offline, a present bill resolves from the local copy without fetching', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Local' }), T0)
    await db.bills.add(bill)
    setOnline(false)
    await expect(loadFresh('B')).resolves.toBeUndefined()
    expect(server.fetchCalls).toEqual([])
    expect(await db.bills.get('B')).toEqual(bill)
  })

  it('C13: a failed fetch of a present bill resolves using the local copy', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Local' }), T0)
    await db.bills.add(bill)
    server.fetchError = { message: 'TypeError: Failed to fetch' }
    await expect(loadFresh('B')).resolves.toBeUndefined()
    expect(server.fetchCalls).toEqual(['B'])
    expect(await db.bills.get('B')).toEqual(bill)
  })

  it('C13: a missing bill offline still throws unreachable', async () => {
    setOnline(false)
    await expect(loadFresh('B')).rejects.toMatchObject({ name: 'BillUnavailableError', kind: 'unreachable' })
  })

  it('C13: a missing bill whose fetch fails throws unreachable; one the server lacks throws not_found', async () => {
    server.fetchError = { message: 'TypeError: Failed to fetch' }
    const err = await loadFresh('B').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BillUnavailableError)
    expect((err as BillUnavailableError).kind).toBe('unreachable')

    server.fetchError = null
    const gone = await loadFresh('B').catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(BillUnavailableError)
    expect((gone as BillUnavailableError).kind).toBe('not_found')
    expect(await db.bills.get('B')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// C14: deleteBill refreshes first
// ---------------------------------------------------------------------------------------------
describe('C14: deleteBill online refreshes the bill first', () => {
  it('C14: an item (and its split) another device added are retired too', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner' }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)
    const theirItem = makeItem({ id: 'I2', bill_id: 'B', amount: 40, updated_at: T1, synced_at: T1 })
    const theirSplit = makeSplit({ id: 'S2', item_id: 'I2', user_id: 'ME', computed_amount: 40, updated_at: T1, synced_at: T1 })
    server.bundles.set('B', serverBundle({ ...bill, updated_at: T1, synced_at: T1 }, [item, theirItem], [split, theirSplit]))

    await deleteBill('B', 'ME')

    expect(server.fetchCalls).toEqual(['B'])
    const items = server.cloud.pushes[0]?.bill_items ?? []
    const splits = server.cloud.pushes[0]?.item_splits ?? []
    expect(items.find((r) => r.id === 'I1')?.is_deleted).toBe(true)
    expect(items.find((r) => r.id === 'I2')?.is_deleted).toBe(true)
    expect(splits.find((r) => r.id === 'S2')?.is_deleted).toBe(true)
    expect(pushedRow(0, 'bills', 'B')?.is_deleted).toBe(true)
    // The bill was refreshed to the server's version before the delete was built.
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T1)
  })
})

// ---------------------------------------------------------------------------------------------
// C21 (replaces C15): updateBill bases on the version the form loaded
// ---------------------------------------------------------------------------------------------
describe('C21: updateBill saves against the version the edit form loaded', () => {
  async function seed() {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)
    return { bill, item, split }
  }

  const EDIT = {
    title: 'Dinner (edited)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Food', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }

  it('C21: captureBillVersion records synced versions and the live item/split ids', async () => {
    await seed()
    const staged = { ...makeItem({ id: 'I9', bill_id: 'B', amount: 5 }), updated_at: T1, synced_at: null }
    const stagedSplit = { ...makeSplit({ id: 'S9', item_id: 'I9', user_id: 'ME', computed_amount: 5 }), updated_at: T1, synced_at: null }
    const gone = { ...synced(makeItem({ id: 'IX', bill_id: 'B', amount: 1 }), T0), is_deleted: true }
    await db.bill_items.bulkAdd([staged, gone])
    await db.item_splits.add(stagedSplit)

    const v = await captureBillVersion('B')

    expect(v.versions).toMatchObject({ 'bills:B': T0, 'bill_items:I1': T0, 'item_splits:S1': T0 })
    // Staged rows were not synced at load: no version for them.
    expect(v.versions).not.toHaveProperty('bill_items:I9')
    expect(v.versions).not.toHaveProperty('item_splits:S9')
    expect([...v.itemIds].sort()).toEqual(['I1', 'I9'])
    expect([...v.splitIds].sort()).toEqual(['S1', 'S9'])
  })

  it('C21: rows carry the LOADED versions even after a newer server copy overwrote the mirror; only loaded items are retired; no fetch', async () => {
    await seed()
    const loadedVersion = await captureBillVersion('B')

    // While the form is open, another device's edit arrives (realtime) and overwrites the mirror.
    await db.bills.update('B', { title: 'Theirs', updated_at: T1, synced_at: T1 })
    await db.bill_items.update('I1', { amount: 130, updated_at: T1, synced_at: T1 })
    await db.bill_items.add(makeItem({ id: 'I8', bill_id: 'B', amount: 30, updated_at: T1, synced_at: T1 }))
    server.fetchCalls = []

    await updateBill('B', 'ME', { ...EDIT, loadedVersion } as never)

    expect(server.fetchCalls).toEqual([])
    expect(server.cloud.rpcNames).not.toContain('kwenta_fetch_bill_bundle')
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'bill_items', 'I1')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'bill_items', 'I1')?.is_deleted).toBe(true)
    expect(pushedRow(0, 'item_splits', 'S1')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'item_splits', 'S1')?.is_deleted).toBe(true)
    // The item the form never saw is not retired by this save.
    expect(pushedRow(0, 'bill_items', 'I8')).toBeUndefined()
    // The form's new rows are new: no base.
    const fresh = (server.cloud.pushes[0]?.bill_items ?? []).filter((r) => r.id !== 'I1')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].amount).toBe(120)
    expect(fresh[0]).not.toHaveProperty('_base_updated_at')
    await expectNoClientKeysInDexie()
  })

  it('C15/C21: updateBill makes no kwenta_fetch_bill_bundle call (without a loaded version either)', async () => {
    await seed()
    await updateBill('B', 'ME', EDIT)
    expect(server.fetchCalls).toEqual([])
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
  })
})

// ---------------------------------------------------------------------------------------------
// C16: linkProfileToRemote
// ---------------------------------------------------------------------------------------------
describe('C16: linkProfileToRemote sends only the link', () => {
  async function seedContact() {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'C', display_name: 'Bobby', email: '', is_local: true, owner_id: 'ME', updated_at: T0, synced_at: T0 }),
      makeProfile({ id: 'ACC', display_name: 'Bob', email: 'bob@example.com' }),
    ])
    await db.group_members.add(makeMember({ id: 'GM', group_id: 'G', user_id: 'C', display_name: 'Bobby' }))
    await db.bills.add(makeBill({ id: 'B', created_by: 'ME', paid_by: 'C' }))
    await db.item_splits.add(makeSplit({ id: 'SP', item_id: 'I', user_id: 'C' }))
    await db.settlements.add(makeSettlement({ id: 'ST', from_user_id: 'C', to_user_id: 'ME' }))
  }

  it('C16: online, the push holds only profiles (+ activity_log) and one background fullSync follows', async () => {
    await seedContact()
    const { mode } = await linkProfileToRemote('C', 'ACC', 'ME')

    expect(mode).toBe('cloud')
    expect(server.cloud.pushes).toHaveLength(1)
    const push = server.cloud.pushes[0]
    const nonEmpty = Object.entries(push).filter(([, rows]) => Array.isArray(rows) && rows.length > 0).map(([t]) => t)
    expect(nonEmpty.filter((t) => t !== 'activity_log')).toEqual(['profiles'])
    for (const t of ['item_splits', 'bills', 'settlements', 'group_members']) {
      expect(push[t] ?? [], t).toHaveLength(0)
    }
    expect(pushedRow(0, 'profiles', 'C')?.linked_profile_id).toBe('ACC')
    expect(pushedRow(0, 'profiles', 'C')?._base_updated_at).toBe(T0)

    await vi.waitFor(() => expect(vi.mocked(fullSync)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(fullSync).mock.calls[0][0]).toBe('ME')
    await new Promise((r) => setTimeout(r, 20))
    expect(vi.mocked(fullSync)).toHaveBeenCalledTimes(1)
  })

  it('C16: a link queued offline sends only profiles too and starts no fullSync', async () => {
    await seedContact()
    setOnline(false)
    const { mode } = await linkProfileToRemote('C', 'ACC', 'ME')

    expect(mode).toBe('queued')
    const [entry] = await queued()
    const tables = Object.entries(entry.push ?? {}).filter(([, rows]) => Array.isArray(rows) && rows.length > 0).map(([t]) => t)
    expect(tables.filter((t) => t !== 'activity_log')).toEqual(['profiles'])
    await new Promise((r) => setTimeout(r, 20))
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })

  it('C16: a refused link starts no fullSync', async () => {
    await seedContact()
    server.cloud.mode = 'reject'
    await expect(linkProfileToRemote('C', 'ACC', 'ME')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
    expect((await db.profiles.get('C'))?.linked_profile_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// C18: cost of the base lookup
// ---------------------------------------------------------------------------------------------
describe('C18: the base lookup costs one bulkGet per pushed table', () => {
  it('C18: a queued write of three tables reads each table once with bulkGet and never row by row', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME' }), T0)
    const items = [1, 2, 3].map((n) => synced(makeItem({ id: `I${n}`, bill_id: 'B', amount: n }), T0))
    const splits = items.map((it, n) => synced(makeSplit({ id: `S${n}`, item_id: it.id, user_id: 'ME' }), T0))
    await db.bills.add(bill)
    await db.bill_items.bulkAdd(items)
    await db.item_splits.bulkAdd(splits)

    const proto = Object.getPrototypeOf(db.bills) as { bulkGet: unknown; get: unknown }
    const bulkGet = vi.spyOn(proto as never, 'bulkGet' as never)
    const get = vi.spyOn(proto as never, 'get' as never)
    const bulkCtx: unknown[] = []
    const getCtx: unknown[] = []
    setOnline(false)
    try {
      await commitCloudFirstWrite({
        actorUserId: 'ME',
        payload: {
          bills: [edited(bill, { title: 'x' })],
          bill_items: items.map((i) => edited(i, { amount: 9 })),
          item_splits: splits.map((s) => edited(s, { computed_amount: 9 })),
        },
        pending: PENDING,
      })
    } finally {
      bulkCtx.push(...(bulkGet.mock.contexts as unknown[]))
      getCtx.push(...(get.mock.contexts as unknown[]))
      bulkGet.mockRestore()
      get.mockRestore()
    }

    const tableOf = (ctx: unknown) => (ctx as { name: string }).name
    const bulkByTable = bulkCtx.map(tableOf)
    expect(bulkByTable.filter((t) => t === 'bills')).toHaveLength(1)
    expect(bulkByTable.filter((t) => t === 'bill_items')).toHaveLength(1)
    expect(bulkByTable.filter((t) => t === 'item_splits')).toHaveLength(1)
    const getByTable = getCtx.map(tableOf)
    expect(getByTable.filter((t) => t === 'bill_items' || t === 'item_splits')).toHaveLength(0)
    const [entry] = await queued()
    expect(entry.push?.bill_items?.every((r) => r._base_updated_at === T0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------------------------
describe('H3.1: rows staged by a REFUSED write keep that write\'s base', () => {
  const EDIT = {
    title: 'Dinner (again)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Food', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }

  /** A queued edit built from the T0 copy that the server then refused (another device moved on). */
  async function seedRefusedEdit() {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    setOnline(false)
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(bill, { title: 'Mine' })] }, pending: PENDING })
    setOnline(true)
    // The refusal normally puts the staged rows back to the server's state (C27). Here that read
    // fails, so the rows stay staged: the window in which the carried base still matters.
    server.cloud.reconcileError = true
    server.cloud.rejectIds = new Set(['B'])
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()
    const [entry] = await queued()
    expect(entry.status).toBe('conflict')
    server.cloud.pushes = []
  }

  it('H3.1: the edit form\'s captured version and its save carry the refused write\'s base, so the server refuses again', async () => {
    await seedRefusedEdit()
    const loadedVersion = await captureBillVersion('B')
    expect(loadedVersion.versions['bills:B']).toBe(T0)

    server.conflict = true
    await expect(updateBill('B', 'ME', { ...EDIT, loadedVersion } as never)).rejects.toThrow(/changed on another device/i)
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
    expect(pushedRow(0, 'bill_items', 'I1')?._base_updated_at).toBe(T0)
  })

  it('H3.1: a plain operation re-saving the staged row carries the refused write\'s base too', async () => {
    await seedRefusedEdit()
    server.conflict = true
    await expect(updateBill('B', 'ME', EDIT)).rejects.toThrow(/changed on another device/i)
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T0)
  })

  it('H3.1: a row staged by a PENDING write still gets no base', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME' }), T0)
    await db.bills.add(bill)
    setOnline(false)
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(bill, { title: 'One' })] }, pending: PENDING })
    const staged = (await db.bills.get('B'))!
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(staged, { title: 'Two' })] }, pending: PENDING })
    const [, second] = await queued()
    expect(second.push?.bills?.[0]).not.toHaveProperty('_base_updated_at')
  })
})

describe('H3.2: a row a builder changes is staged, even when the device clock is behind the server', () => {
  it('H3.2: retired children carry synced_at null, so a later edit of them is not based on a client timestamp', async () => {
    // The server stamped these in the future of this device's clock (a slow phone).
    const S = '2099-01-01T00:00:00.000000+00:00'
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', total_amount: 100 }), S)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), S)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), S)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)

    setOnline(false)
    await updateBill('B', 'ME', {
      title: 'x',
      note: '',
      currency: 'PHP',
      items: [{ name: 'Food', amount: 5, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
    })
    const [first] = await queued()
    expect(first.push?.bill_items?.find((r) => r.id === 'I1')?._base_updated_at).toBe(S)

    const stagedItem = (await db.bill_items.get('I1'))!
    const stagedSplit = (await db.item_splits.get('S1'))!
    expect(stagedItem.is_deleted).toBe(true)
    expect(stagedItem.synced_at).toBeNull()
    expect(stagedSplit.synced_at).toBeNull()

    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bill_items: [edited(stagedItem, { name: 'again' })] }, pending: PENDING })
    const second = (await queued())[1]
    expect(second.push?.bill_items?.[0]).not.toHaveProperty('_base_updated_at')
  })

  it('H3.2: deleteBill stages the bill and the items it retires', async () => {
    const S = '2099-01-01T00:00:00.000000+00:00'
    await db.bills.add(synced(makeBill({ id: 'B', created_by: 'ME' }), S))
    await db.bill_items.add(synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), S))
    setOnline(false)
    await deleteBill('B', 'ME')
    expect((await db.bills.get('B'))?.synced_at).toBeNull()
    expect((await db.bill_items.get('I1'))?.synced_at).toBeNull()
  })
})

describe('H3.3: a fresh load writes each table in one bulk call', () => {
  it('H3.3: one bulkPut per table and no per-row put, add or update', async () => {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', total_amount: 100 }), T0)
    const items = [1, 2, 3].map((n) => synced(makeItem({ id: `I${n}`, bill_id: 'B', amount: n }), T0))
    const splits = items.map((it, n) => synced(makeSplit({ id: `S${n}`, item_id: it.id, user_id: 'ME' }), T0))
    await db.bills.add(bill)
    await db.bill_items.add(items[0])
    server.bundles.set(
      'B',
      serverBundle(
        { ...bill, total_amount: 200, updated_at: T1, synced_at: T1 },
        items.map((i) => ({ ...i, updated_at: T1, synced_at: T1 })),
        splits.map((s) => ({ ...s, updated_at: T1, synced_at: T1 })),
      ),
    )

    const proto = Object.getPrototypeOf(db.bills) as Record<string, unknown>
    const spies = (['bulkPut', 'put', 'add', 'update', 'bulkAdd'] as const).map((m) => ({
      m,
      spy: vi.spyOn(proto as never, m as never),
    }))
    let counts: unknown = []
    try {
      await loadFresh('B')
    } finally {
      counts = spies.map(({ m, spy }) => ({ m, tables: (spy.mock.contexts as unknown[]).map((c) => (c as { name: string }).name) }))
      for (const { spy } of spies) spy.mockRestore()
    }

    const by = Object.fromEntries((counts as unknown as { m: string; tables: string[] }[]).map((c) => [c.m, c.tables]))
    expect([...by.bulkPut].sort()).toEqual(['bill_items', 'bills', 'item_splits'])
    expect([...by.put, ...by.add, ...by.update, ...by.bulkAdd]).toEqual([])
    expect((await db.bills.get('B'))?.total_amount).toBe(200)
    expect(await db.bill_items.count()).toBe(3)
    expect(await db.item_splits.count()).toBe(3)
  })
})

describe('C26: while the restore of a refused write is pending, its staged row takes the server copy', () => {
  const EDIT = {
    title: 'Dinner (again)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Food', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }
  const theirs = (bill: Bill) => ({ ...bill, title: 'Theirs', updated_at: T1, synced_at: T1 })

  async function seedRefused() {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    setOnline(false)
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(bill, { title: 'Mine' })] }, pending: PENDING })
    setOnline(true)
    // The restore read fails, so the refused rows stay staged: the window H4.1 covers.
    server.cloud.reconcileError = true
    server.cloud.rejectIds = new Set(['B'])
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()
    server.cloud.pushes = []
    const [entry] = await queued()
    expect(entry.status).toBe('conflict')
    return { bill, item, entry }
  }

  it('C26: a fresh load replaces the staged row; the next save is based on the server version and applies; Retry still overwrites', async () => {
    const { bill, item, entry } = await seedRefused()
    server.bundles.set('B', serverBundle(theirs(bill), [item], []))

    await loadFresh('B')

    const shown = await db.bills.get('B')
    expect(shown?.title).toBe('Theirs')
    expect(shown?.synced_at).toBe(T1)
    const loadedVersion = await captureBillVersion('B')
    expect(loadedVersion.versions['bills:B']).toBe(T1)

    await updateBill('B', 'ME', { ...EDIT, loadedVersion } as never)
    expect(pushedRow(0, 'bills', 'B')?._base_updated_at).toBe(T1)
    expect((await db.bills.get('B'))?.title).toBe('Dinner (again)')

    // The refused entry is untouched: Settings still lists it and Retry sends its own rows.
    const [still] = await queued()
    expect(still.id).toBe(entry.id)
    expect(still.status).toBe('conflict')
    expect(still.push?.bills?.[0]?._base_updated_at).toBe(T0)
    expect(await retryQueuedWrite(entry.id)).toBe(true)
    const retried = lastPushedRow('bills', 'B')
    expect(retried?.title).toBe('Mine')
    expect(retried?._overwrite).toBe(true)
  })

  it('C26: the realtime upsert replaces it too', async () => {
    const { bill } = await seedRefused()
    const moved = await upsertRemoteRow('bills', theirs(bill), currentSessionEpoch())
    expect(moved).toBe(true)
    expect((await db.bills.get('B'))?.title).toBe('Theirs')
    expect((await db.bills.get('B'))?.synced_at).toBe(T1)
  })

  it('C26: the pull/sync apply decision releases it (one rule shared by every server-apply path)', async () => {
    const { bill } = await seedRefused()
    const staged = (await db.bills.get('B'))!
    expect(await selectServerRowsToApply('bills', [theirs(bill)], [staged])).toEqual([true])
    // A staged row that no queue entry owns stays shielded.
    const other = { ...makeBill({ id: 'X', created_by: 'ME' }), updated_at: '2026-10-25T00:00:00.000Z', synced_at: null }
    expect(await selectServerRowsToApply('bills', [{ ...other, updated_at: T1 }], [other])).toEqual([false])
  })

  it('C26: a row ALSO owned by a pending write is still shielded', async () => {
    const { bill } = await seedRefused()
    setOnline(false)
    const staged = (await db.bills.get('B'))!
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(staged, { title: 'Two' }, '2026-10-26T00:00:00.000Z')] }, pending: PENDING })
    setOnline(true)
    server.bundles.set('B', serverBundle(theirs(bill), [], []))

    await loadFresh('B')

    expect((await db.bills.get('B'))?.title).toBe('Two')
    expect(await upsertRemoteRow('bills', theirs(bill), currentSessionEpoch())).toBe(false)
  })
})

describe('C27: a refused write is released as a unit, at refusal time', () => {
  const REPLACE = {
    title: 'Dinner (mine)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Mine', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }

  /** A queued updateBill that replaced the items (new ids), then refused: the server's items are I1/S1. */
  async function seedRefusedReplacement() {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)
    server.cloud.reconcilePayload = { bills: [bill], bill_items: [item], item_splits: [split] }

    setOnline(false)
    await updateBill('B', 'ME', REPLACE)
    setOnline(true)
    server.cloud.rejectIds = new Set(['B'])
    return { bill, item, split }
  }

  const liveItemIds = async () =>
    (await db.bill_items.where('bill_id').equals('B').toArray()).filter((i) => !i.is_deleted).map((i) => i.id)

  it('C27: after the refusal the mirror, the form and the capture show only the server\'s items; a save sends only those', async () => {
    await seedRefusedReplacement()
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()

    const [entry] = await queued()
    expect(entry.status).toBe('conflict')
    const refusedNewItems = (entry.push?.bill_items ?? []).filter((r) => !r.is_deleted).map((r) => r.id)
    expect(refusedNewItems).toHaveLength(1)

    expect(await liveItemIds()).toEqual(['I1'])
    expect((await db.bill_items.get('I1'))?.synced_at).toBe(T0)
    expect(await db.bill_items.get(refusedNewItems[0] as string)).toBeUndefined()
    expect((await getBillWithDetails('B'))?.items.map((i) => i.id)).toEqual(['I1'])
    const loadedVersion = await captureBillVersion('B')
    expect(loadedVersion.itemIds).toEqual(['I1'])
    expect(loadedVersion.versions['bill_items:I1']).toBe(T0)

    server.cloud.pushes = []
    await updateBill('B', 'ME', { ...REPLACE, loadedVersion } as never)
    const sent = (server.cloud.pushes[0]?.bill_items ?? []).map((r) => r.id as string)
    expect(sent).not.toContain(refusedNewItems[0])
    expect(sent).toContain('I1')
    expect(sent).toHaveLength(2)
    await expectNoClientKeysInDexie()
  })

  it('C27: the refused entry stays for Settings; Retry stages and sends its own rows with _overwrite', async () => {
    await seedRefusedReplacement()
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()
    const [entry] = await queued()
    const refusedNewItem = (entry.push?.bill_items ?? []).find((r) => !r.is_deleted)!.id as string

    server.cloud.pushes = []
    const landed = await retryQueuedWrite(entry.id)

    expect(landed).toBe(true)
    const sentNew = lastPushedRow('bill_items', refusedNewItem)
    expect(sentNew?._overwrite).toBe(true)
    expect(sentNew).not.toHaveProperty('_base_updated_at')
    expect((await db.bill_items.get(refusedNewItem))?.is_deleted).toBe(false)
    expect((await db.bill_items.get('I1'))?.is_deleted).toBe(true)
    await expectNoClientKeysInDexie()
  })

  it('C27: a restore that cannot read the server is flagged and completed by the next drain', async () => {
    await seedRefusedReplacement()
    server.cloud.reconcileError = true
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()

    const [flagged] = await queued()
    expect(flagged.restore_pending).toBe(true)
    expect(await liveItemIds()).not.toContain('I1')

    server.cloud.reconcileError = false
    await drainWriteQueue('ME')

    const [done] = await queued()
    expect(done.status).toBe('conflict')
    expect(done.restore_pending).toBe(false)
    expect(await liveItemIds()).toEqual(['I1'])
  })

  it('C27: a fresh bill load completes a pending restore too', async () => {
    const { bill, item, split } = await seedRefusedReplacement()
    server.cloud.reconcileError = true
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()
    server.cloud.reconcileError = false
    server.bundles.set('B', serverBundle(bill, [item], [split]))

    await loadFresh('B')

    expect(await liveItemIds()).toEqual(['I1'])
  })
})

describe('C29: a row staged at load that has been synced by Save is not saved over', () => {
  const EDIT = {
    title: 'Dinner (form)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Food', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }

  async function seedStagedBill() {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    setOnline(false)
    await commitCloudFirstWrite({ actorUserId: 'ME', payload: { bills: [edited(bill, { title: 'One' })] }, pending: PENDING })
    return { bill, item }
  }

  it('C29: queued edit → capture (staged) → drain applies → another device\'s version lands → the save is refused and sends nothing', async () => {
    const { bill } = await seedStagedBill()
    const loadedVersion = await captureBillVersion('B')
    expect(loadedVersion.stagedKeys).toEqual(['bills:B'])
    expect(loadedVersion.versions).not.toHaveProperty('bills:B')

    setOnline(true)
    await drainWriteQueue('ME')
    expect(await db.pending_mutations.count()).toBe(0)
    const theirItem = makeItem({ id: 'IT', bill_id: 'B', amount: 30, updated_at: T2, synced_at: T2 })
    await upsertRemoteRow('bills', { ...bill, title: 'Theirs', updated_at: T2, synced_at: T2 }, currentSessionEpoch())
    await upsertRemoteRow('bill_items', theirItem, currentSessionEpoch())
    server.cloud.pushes = []

    await expect(updateBill('B', 'ME', { ...EDIT, loadedVersion })).rejects.toThrow(/just synced from another change/i)

    expect(server.cloud.pushes).toHaveLength(0)
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.bills.get('B'))?.title).toBe('Theirs')
    expect(await db.bill_items.get('IT')).toEqual(theirItem)
  })

  it('C29: a row still staged at Save keeps today\'s behaviour (no base; the drain rebases it)', async () => {
    await seedStagedBill()
    const loadedVersion = await captureBillVersion('B')

    await updateBill('B', 'ME', { ...EDIT, loadedVersion })

    const entries = await queued()
    expect(entries).toHaveLength(2)
    expect(entries[1].push?.bills?.[0]).not.toHaveProperty('_base_updated_at')
  })
})

describe('C30: a fresh load completes a pending restore for its own bill', () => {
  const REPLACE = {
    title: 'Dinner (mine)',
    note: '',
    currency: 'PHP',
    items: [{ name: 'Mine', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
  }

  async function refusedWithFailedRestore(extra?: { profiles: Profile[] }) {
    const bill = synced(makeBill({ id: 'B', created_by: 'ME', title: 'Dinner', total_amount: 100 }), T0)
    const item = synced(makeItem({ id: 'I1', bill_id: 'B', amount: 100 }), T0)
    const split = synced(makeSplit({ id: 'S1', item_id: 'I1', user_id: 'ME', computed_amount: 100 }), T0)
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.add(split)
    setOnline(false)
    await updateBill('B', 'ME', REPLACE)
    if (extra) {
      const [entry] = await queued()
      await db.pending_mutations.update(entry.id, { push: { ...entry.push, profiles: extra.profiles } as never })
    }
    setOnline(true)
    server.cloud.reconcileError = true
    server.cloud.rejectIds = new Set(['B'])
    await drainWriteQueue('ME')
    server.cloud.rejectIds = new Set()
    return { bill, item, split }
  }

  const liveItemIds = async () =>
    (await db.bill_items.where('bill_id').equals('B').toArray()).filter((i) => !i.is_deleted).map((i) => i.id)

  it('C30: the restore read fails at refusal and again at the load, yet a successful bundle leaves only the server\'s items and clears the flag', async () => {
    const { bill, item, split } = await refusedWithFailedRestore()
    expect((await queued())[0].restore_pending).toBe(true)
    expect(await liveItemIds()).not.toContain('I1')
    server.bundles.set('B', serverBundle(bill, [item], [split]))

    await loadFresh('B')

    expect(await liveItemIds()).toEqual(['I1'])
    expect((await getBillWithDetails('B'))?.items.map((i) => i.id)).toEqual(['I1'])
    const [entry] = await queued()
    expect(entry.status).toBe('conflict')
    expect(entry.restore_pending).toBe(false)
  })

  it('C30: an entry that also staged rows outside this bill keeps its flag', async () => {
    const outside = { ...makeProfile({ id: 'ME', display_name: 'Me again' }), updated_at: '2026-10-25T00:00:00.000Z', synced_at: null }
    const { bill, item, split } = await refusedWithFailedRestore({ profiles: [outside] })
    server.bundles.set('B', serverBundle(bill, [item], [split]))

    await loadFresh('B')

    expect(await liveItemIds()).toEqual(['I1'])
    expect((await queued())[0].restore_pending).toBe(true)
  })
})
