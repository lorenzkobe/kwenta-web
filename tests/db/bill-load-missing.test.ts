import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { deleteBill, updateBill } from '@/db/operations'
import { BillUnavailableError, loadBillIntoMirror } from '@/sync/bill-mirror'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import type { Bill, BillItem, ItemSplit } from '@/types'
import { makeBill, makeItem, makeSplit, resetDb } from '../helpers/db'

/**
 * Dexie is a mirror, not the source of truth (rule 7). `updateBill`/`deleteBill` used to RETURN
 * when the bill was not on this device — a bill added from another device that had not synced
 * yet — and the page then navigated as if the change had been saved.
 *
 * Now: the edit screens load a missing bill with `loadBillIntoMirror` before filling the form, so
 * `updateBill` refuses a bill it cannot see (the form never loaded — saving it would overwrite the
 * real items with a blank form). `deleteBill` carries no form content, so it loads the bill itself.
 */

type Bundle = { bill: Bill; bill_items: BillItem[]; item_splits: ItemSplit[] }

const server = vi.hoisted(() => ({
  bundles: new Map<string, unknown>(),
  fetchCalls: [] as string[],
  fetchError: null as { message: string } | null,
  /** Runs while the fetch is in flight (e.g. a wipe landing mid-request). */
  onFetch: null as null | (() => void),
  cloud: { mode: 'ok' as const, calls: 0, pushes: [] as Record<string, { id: string }[]>[] },
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(server.cloud)
  return {
    supabase: {
      ...base,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'kwenta_fetch_bill_bundle') {
          const id = String(args?.p_bill_id)
          server.fetchCalls.push(id)
          server.onFetch?.()
          if (server.fetchError) return { data: null, error: server.fetchError }
          return { data: server.bundles.get(id) ?? null, error: null }
        }
        return base.rpc(fn, args)
      },
    },
  }
})
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/cloud-first-mutations', () => ({ enqueuePendingMutation: vi.fn(async () => 'p1') }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))

function serverBill(id: string, over: Partial<Bill> = {}): Bundle {
  const bill = makeBill({ id, created_by: 'ME', paid_by: 'ME', group_id: null, title: 'Dinner', ...over })
  const item = makeItem({ bill_id: id, amount: 100 })
  const split = makeSplit({ item_id: item.id, user_id: 'ME', computed_amount: 100 })
  return { bill, bill_items: [item], item_splits: [split] }
}

async function storeLocally(b: Bundle) {
  await db.bills.add(b.bill)
  await db.bill_items.bulkAdd(b.bill_items)
  await db.item_splits.bulkAdd(b.item_splits)
}

const EDIT = {
  title: 'Dinner (edited)',
  note: '',
  currency: 'PHP',
  items: [{ name: 'Food', amount: 120, splits: [{ userId: 'ME', splitType: 'equal' as const, splitValue: 1 }] }],
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

beforeEach(async () => {
  await resetDb()
  setOnline(true)
  server.bundles.clear()
  server.fetchCalls.length = 0
  server.fetchError = null
  server.onFetch = null
  server.cloud.calls = 0
  server.cloud.pushes.length = 0
})

describe('loadBillIntoMirror', () => {
  it('C27: a bundle that lands after a wipe (sign-out, account switch) writes nothing', async () => {
    server.bundles.set('B1', serverBill('B1'))
    server.onFetch = () => bumpSessionEpoch()

    await loadBillIntoMirror('B1')

    expect(server.fetchCalls).toEqual(['B1'])
    expect(await db.bills.get('B1')).toBeUndefined()
    expect(await db.bill_items.count()).toBe(0)
  })

  it('fetches a bill missing from this device and mirrors the bill, items and splits', async () => {
    const b = serverBill('B1')
    server.bundles.set('B1', b)

    await loadBillIntoMirror('B1')

    expect(server.fetchCalls).toEqual(['B1'])
    expect((await db.bills.get('B1'))?.title).toBe('Dinner')
    expect(await db.bill_items.where('bill_id').equals('B1').count()).toBe(1)
    expect((await db.item_splits.get(b.item_splits[0].id))?.computed_amount).toBe(100)
  })

  it('makes no request when the bill is already on this device', async () => {
    await storeLocally(serverBill('B2'))
    await loadBillIntoMirror('B2')
    expect(server.fetchCalls).toEqual([])
  })

  it('never overwrites a row already on this device (an unsynced edit stays)', async () => {
    const b = serverBill('B3')
    server.bundles.set('B3', { ...b, bill_items: [{ ...b.bill_items[0], name: 'server name' }] })
    await db.bill_items.add({ ...b.bill_items[0], name: 'my unsynced name', synced_at: null })

    await loadBillIntoMirror('B3')

    expect((await db.bill_items.get(b.bill_items[0].id))?.name).toBe('my unsynced name')
    expect(await db.bills.get('B3')).toBeDefined()
  })

  it('says "not found" when the server has no such bill', async () => {
    const err = await loadBillIntoMirror('GONE').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BillUnavailableError)
    expect((err as BillUnavailableError).kind).toBe('not_found')
  })

  it('says "unreachable" — not "not found" — on an RPC error', async () => {
    server.fetchError = { message: 'timeout' }
    const err = await loadBillIntoMirror('B4').catch((e: unknown) => e)
    expect((err as BillUnavailableError).kind).toBe('unreachable')
    expect((err as Error).message).not.toMatch(/not found|no longer exists/i)
  })

  it('says "unreachable" offline, without a request', async () => {
    setOnline(false)
    const err = await loadBillIntoMirror('B5').catch((e: unknown) => e)
    expect((err as BillUnavailableError).kind).toBe('unreachable')
    expect(server.fetchCalls).toEqual([])
  })
})

describe('updateBill / deleteBill on a bill this device has not loaded', () => {
  it('updateBill refuses a bill missing from this device and submits nothing (the form never loaded)', async () => {
    server.bundles.set('B1', serverBill('B1'))
    await expect(updateBill('B1', 'ME', EDIT)).rejects.toThrow(/bill/i)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('deleteBill fetches a missing bill from the server and submits the delete', async () => {
    server.bundles.set('B2', serverBill('B2'))

    await deleteBill('B2', 'ME')

    expect(server.fetchCalls).toEqual(['B2'])
    expect(server.cloud.pushes).toHaveLength(1)
    expect((await db.bills.get('B2'))?.is_deleted).toBe(true)
    const items = await db.bill_items.where('bill_id').equals('B2').toArray()
    expect(items.every((i) => i.is_deleted)).toBe(true)
  })

  it('deleteBill throws a clear error and submits nothing when the server has no such bill', async () => {
    await expect(deleteBill('GONE', 'ME')).rejects.toBeInstanceOf(BillUnavailableError)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('deleteBill of a bill already deleted on the server is a silent no-op', async () => {
    server.bundles.set('B3', serverBill('B3', { is_deleted: true }))
    await expect(deleteBill('B3', 'ME')).resolves.toBeUndefined()
    expect(server.cloud.pushes).toHaveLength(0)
  })

  // deleteBill loads fresh (081 work): it asks the server even for a bill already on the device, so
  // it retires items another device added. updateBill still never fetches.
  it('updateBill makes no fetch for a bill already on this device; deleteBill refreshes it once', async () => {
    const b = serverBill('B4')
    await storeLocally(b)
    server.bundles.set('B4', b)

    await updateBill('B4', 'ME', EDIT)
    expect(server.fetchCalls).toEqual([])
    await deleteBill('B4', 'ME')

    expect(server.fetchCalls).toEqual(['B4'])
    expect(server.cloud.pushes).toHaveLength(2)
  })

  it('deleting an already-deleted local bill stays a silent no-op', async () => {
    const b = serverBill('B5', { is_deleted: true })
    await storeLocally(b)
    server.bundles.set('B5', b)
    await expect(deleteBill('B5', 'ME')).resolves.toBeUndefined()
    expect(server.fetchCalls).toEqual(['B5'])
    expect(server.cloud.pushes).toHaveLength(0)
  })

  // C28: a fetch that SUCCEEDS and returns no bill means the server has none for this account, even
  // when the device still holds a copy; only a failed fetch falls back to the local copy.
  it('C28: a successful fetch that returns no bill throws not_found for a synced local copy', async () => {
    await storeLocally(serverBill('B8'))
    await expect(loadBillIntoMirror('B8', { fresh: true })).rejects.toMatchObject({ name: 'BillUnavailableError', kind: 'not_found' })
    await expect(deleteBill('B8', 'ME')).rejects.toBeInstanceOf(BillUnavailableError)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('C28: a bill this device created and has not sent yet is used as it is', async () => {
    const b = serverBill('B9')
    await storeLocally({ ...b, bill: { ...b.bill, synced_at: null } })
    await expect(loadBillIntoMirror('B9', { fresh: true })).resolves.toBeUndefined()
  })

  it('in collect mode (a cascade) never fetches and never throws for a missing bill', async () => {
    const collect = { profiles: [], groups: [], group_members: [], bills: [], bill_items: [], item_splits: [], settlements: [], activity_log: [], profile_peer_links: [] }
    await expect(deleteBill('GONE', 'ME', { collect: collect as never })).resolves.toBeUndefined()
    expect(server.fetchCalls).toEqual([])
  })
})

describe('update/delete by someone who did not add the bill', () => {
  it('updateBill throws instead of silently doing nothing', async () => {
    await storeLocally(serverBill('B6', { created_by: 'OTHER' }))
    await expect(updateBill('B6', 'ME', EDIT)).rejects.toThrow(/added this bill/i)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('deleteBill throws instead of silently doing nothing', async () => {
    const b = serverBill('B7', { created_by: 'OTHER' })
    await storeLocally(b)
    server.bundles.set('B7', b)
    await expect(deleteBill('B7', 'ME')).rejects.toThrow(/added this bill/i)
    expect(server.cloud.pushes).toHaveLength(0)
  })
})
