import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  loadStagedBillDetail,
  loadStagedContactRows,
  loadStagedPersonalBillRows,
} from '@/lib/staged-rows'
import {
  makeBill,
  makeItem,
  makeProfile,
  makeSplit,
  resetDb,
} from '../helpers/db'

// `fetchRemoteProfileIntoDexie` (reached through getBillWithDetails) would otherwise try the
// network for a profile the mirror does not hold.
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: null, error: null })) },
}))

/**
 * These rows are what makes an offline write visible. The read migration made a screen the server
 * response, and `withPending` can only decorate rows the server already returned — so a bill or
 * contact created offline appeared NOWHERE, which reads as "the save failed" and leads straight
 * back to the duplicate-entry path cloud-first writes exist to close.
 */

const ME = 'me'

beforeEach(async () => {
  await resetDb()
  await db.profiles.add(makeProfile({ id: ME, display_name: 'Me' }))
})

/** An unsent row is one this device wrote and has not pushed: `synced_at === null`. */
function unsent<T extends { synced_at: string | null }>(row: T): T {
  return { ...row, synced_at: null }
}

describe('loadStagedPersonalBillRows', () => {
  it('returns a bill this device has not pushed yet', async () => {
    await db.bills.add(
      unsent(makeBill({ id: 'B1', title: 'Offline lunch', created_by: ME, paid_by: ME, group_id: null, total_amount: 120 })),
    )
    await db.bill_items.add(makeItem({ id: 'I1', bill_id: 'B1', amount: 120 }))
    await db.item_splits.add(makeSplit({ item_id: 'I1', user_id: ME, computed_amount: 120 }))

    const rows = await loadStagedPersonalBillRows(ME)

    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Offline lunch')
    expect(rows[0].itemCount).toBe(1)
    expect(rows[0].participants.map((p) => p.id)).toEqual([ME])
  })

  /** Rule 8: a bill the server has never seen cannot have been settled against. */
  it('never claims a staged bill is settled', async () => {
    await db.bills.add(unsent(makeBill({ id: 'B1', created_by: ME, paid_by: ME, group_id: null })))
    const rows = await loadStagedPersonalBillRows(ME)
    expect(rows[0].settled).toBe(false)
  })

  it('ignores bills the server has already confirmed', async () => {
    await db.bills.add(makeBill({ id: 'B1', title: 'Synced', created_by: ME, paid_by: ME, group_id: null }))
    expect(await loadStagedPersonalBillRows(ME)).toEqual([])
  })

  it('ignores group bills, deleted bills, and other people’s bills', async () => {
    await db.bills.bulkAdd([
      unsent(makeBill({ id: 'G1', created_by: ME, paid_by: ME, group_id: 'group-1' })),
      unsent(makeBill({ id: 'D1', created_by: ME, paid_by: ME, group_id: null, is_deleted: true })),
      unsent(makeBill({ id: 'O1', created_by: 'someone', paid_by: 'someone', group_id: null })),
    ])
    expect(await loadStagedPersonalBillRows(ME)).toEqual([])
  })

  it('orders newest first, like the list it joins', async () => {
    await db.bills.bulkAdd([
      unsent(makeBill({ id: 'OLD', title: 'Old', created_by: ME, paid_by: ME, group_id: null, created_at: '2026-01-01T00:00:00.000Z' })),
      unsent(makeBill({ id: 'NEW', title: 'New', created_by: ME, paid_by: ME, group_id: null, created_at: '2026-05-01T00:00:00.000Z' })),
    ])
    const rows = await loadStagedPersonalBillRows(ME)
    expect(rows.map((r) => r.title)).toEqual(['New', 'Old'])
  })
})

describe('loadStagedBillDetail', () => {
  it('builds the detail payload for an unsent bill', async () => {
    await db.bills.add(
      unsent(makeBill({ id: 'B1', title: 'Offline dinner', created_by: ME, paid_by: ME, group_id: null, total_amount: 100 })),
    )
    await db.bill_items.add(makeItem({ id: 'I1', bill_id: 'B1', name: 'Mains', amount: 100 }))
    await db.item_splits.add(makeSplit({ id: 'S1', item_id: 'I1', user_id: ME, computed_amount: 40 }))

    const detail = await loadStagedBillDetail('B1', ME)

    expect(detail?.bill.title).toBe('Offline dinner')
    expect(detail?.items[0].name).toBe('Mains')
    expect(detail?.mySplitTotal).toBe(40)
  })

  /**
   * Pairwise nets and `squareOverall` are server aggregates over data the server has never seen
   * for this bill. Emitting a computed one here would be a second implementation of a money rule.
   */
  it('returns no pairwise rows, because no device can compute them', async () => {
    await db.bills.add(unsent(makeBill({ id: 'B1', created_by: ME, paid_by: ME, group_id: null })))
    const detail = await loadStagedBillDetail('B1', ME)
    expect(detail?.pairs).toEqual([])
  })

  /** Same rule migration 065 restores server-side: absent from every split is null, not zero. */
  it('reports a null share when the viewer is not on the bill', async () => {
    await db.bills.add(unsent(makeBill({ id: 'B1', created_by: ME, paid_by: ME, group_id: null })))
    await db.bill_items.add(makeItem({ id: 'I1', bill_id: 'B1', amount: 100 }))
    await db.item_splits.add(makeSplit({ item_id: 'I1', user_id: 'other', computed_amount: 100 }))

    const detail = await loadStagedBillDetail('B1', ME)
    expect(detail?.mySplitTotal).toBeNull()
  })

  it('refuses a bill the server has already confirmed, so the endpoint stays authoritative', async () => {
    await db.bills.add(makeBill({ id: 'B1', created_by: ME, paid_by: ME, group_id: null }))
    expect(await loadStagedBillDetail('B1', ME)).toBeNull()
  })
})

describe('loadStagedContactRows', () => {
  it('returns an unsent local contact with no balance attached', async () => {
    await db.profiles.add(
      unsent(makeProfile({ id: 'C1', display_name: 'Maya', is_local: true, owner_id: ME, email: '' })),
    )

    const rows = await loadStagedContactRows(ME)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ peerId: 'C1', displayName: 'Maya', subtitle: 'Local contact' })
    expect(rows[0].net).toEqual({})
  })

  it('ignores confirmed contacts, deleted ones, and contacts owned by someone else', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'C1', is_local: true, owner_id: ME, email: '' }),
      unsent(makeProfile({ id: 'C2', is_local: true, owner_id: ME, email: '', is_deleted: true })),
      unsent(makeProfile({ id: 'C3', is_local: true, owner_id: 'someone-else', email: '' })),
    ])
    expect(await loadStagedContactRows(ME)).toEqual([])
  })
})
