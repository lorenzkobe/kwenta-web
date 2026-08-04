import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  computeCombinedNetRollup,
  computePairwiseNetAllContexts,
  computePairwiseNetPersonalOnly,
  loadBalanceSnapshot,
} from '@/lib/people'
import {
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSettlement,
  makeSplit,
  resetDb,
} from '../helpers/db'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

/**
 * The balance helpers take an optional shared snapshot so a page computes the working set once
 * instead of re-scanning every bill per contact. These tests pin the two things that could go
 * wrong with that: the numbers must not change, and the snapshot must actually be reused.
 */

async function seedTwoContacts() {
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME' }),
    makeProfile({ id: 'A', is_local: true, owner_id: 'ME', display_name: 'Ana' }),
    makeProfile({ id: 'B', is_local: true, owner_id: 'ME', display_name: 'Ben' }),
  ])

  // Personal bill: I paid 100, Ana owes 50.
  await db.bills.add(
    makeBill({ id: 'PB', group_id: null, created_by: 'ME', paid_by: 'ME', total_amount: 100 }),
  )
  await db.bill_items.add(makeItem({ id: 'PI', bill_id: 'PB', amount: 100 }))
  await db.item_splits.bulkAdd([
    makeSplit({ id: 'PS1', item_id: 'PI', user_id: 'ME', computed_amount: 50 }),
    makeSplit({ id: 'PS2', item_id: 'PI', user_id: 'A', computed_amount: 50 }),
  ])

  // Personal bill Ben paid: I owe Ben 30.
  await db.bills.add(
    makeBill({ id: 'PB2', group_id: null, created_by: 'ME', paid_by: 'B', total_amount: 60 }),
  )
  await db.bill_items.add(makeItem({ id: 'PI2', bill_id: 'PB2', amount: 60 }))
  await db.item_splits.bulkAdd([
    makeSplit({ id: 'PS3', item_id: 'PI2', user_id: 'ME', computed_amount: 30 }),
    makeSplit({ id: 'PS4', item_id: 'PI2', user_id: 'B', computed_amount: 30 }),
  ])

  // A group where Ana owes me another 20.
  await db.groups.add(makeGroup({ id: 'G', created_by: 'ME', currency: 'PHP' }))
  await db.group_members.bulkAdd([
    makeMember({ group_id: 'G', user_id: 'ME' }),
    makeMember({ group_id: 'G', user_id: 'A' }),
  ])
  await db.bills.add(
    makeBill({ id: 'GB', group_id: 'G', created_by: 'ME', paid_by: 'ME', total_amount: 20 }),
  )
  await db.bill_items.add(makeItem({ id: 'GI', bill_id: 'GB', amount: 20 }))
  await db.item_splits.add(
    makeSplit({ id: 'GS', item_id: 'GI', user_id: 'A', computed_amount: 20 }),
  )
}

beforeEach(async () => {
  await resetDb()
})

describe('shared balance snapshot', () => {
  it('produces identical numbers with and without a snapshot', async () => {
    await seedTwoContacts()

    const snapshot = await loadBalanceSnapshot()
    for (const other of ['A', 'B']) {
      const withSnap = await computePairwiseNetAllContexts('ME', other, snapshot)
      const without = await computePairwiseNetAllContexts('ME', other)
      expect([...withSnap.entries()].sort()).toEqual([...without.entries()].sort())
    }
  })

  it('keeps the expected signed totals across personal and group contexts', async () => {
    await seedTwoContacts()
    const snapshot = await loadBalanceSnapshot()

    // Ana: 50 from the personal bill + 20 from the group bill.
    expect((await computePairwiseNetAllContexts('ME', 'A', snapshot)).get('PHP')).toBe(70)
    // Ben paid for me, so the tab is negative.
    expect((await computePairwiseNetAllContexts('ME', 'B', snapshot)).get('PHP')).toBe(-30)
  })

  it('reflects a payment that clears the tab', async () => {
    await seedTwoContacts()
    await db.settlements.add(
      makeSettlement({
        id: 'ST',
        group_id: null,
        from_user_id: 'A',
        to_user_id: 'ME',
        amount: 50,
        currency: 'PHP',
      }),
    )

    const snapshot = await loadBalanceSnapshot()
    // Only the personal leg is cleared; the group leg still stands.
    expect((await computePairwiseNetPersonalOnly('ME', 'A', snapshot)).get('PHP')).toBe(0)
    expect((await computePairwiseNetAllContexts('ME', 'A', snapshot)).get('PHP')).toBe(20)
  })

  it('reads each table a bounded number of times regardless of contact count', async () => {
    await seedTwoContacts()
    // Add more contacts, each on their own personal bill, so a per-contact rescan would show up.
    for (let i = 0; i < 8; i++) {
      const id = `C${i}`
      await db.profiles.add(makeProfile({ id, is_local: true, owner_id: 'ME' }))
      await db.bills.add(
        makeBill({ id: `CB${i}`, group_id: null, created_by: 'ME', paid_by: 'ME', total_amount: 10 }),
      )
      await db.bill_items.add(makeItem({ id: `CI${i}`, bill_id: `CB${i}`, amount: 10 }))
      await db.item_splits.add(
        makeSplit({ id: `CS${i}`, item_id: `CI${i}`, user_id: id, computed_amount: 10 }),
      )
    }

    const splitsSpy = vi.spyOn(db.item_splits, 'where')
    const billsSpy = vi.spyOn(db.bills, 'toArray')

    await computeCombinedNetRollup('ME')

    // Before batching this scanned every bill and re-queried its splits once PER CONTACT.
    // With ten contacts that was ~10x the work; the exact counts below matter less than the
    // fact that they do not grow with the number of people.
    expect(billsSpy.mock.calls.length).toBeLessThanOrEqual(3)
    expect(splitsSpy.mock.calls.length).toBeLessThanOrEqual(6)

    splitsSpy.mockRestore()
    billsSpy.mockRestore()
  })
})
