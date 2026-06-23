import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import {
  computePairwiseNet,
  computePairwiseNetForBill,
  expandProfileIdsForSplitMatching,
  participantUnionForBill,
} from '@/lib/people'
import { makeBill, makeItem, makeProfile, makeSettlement, makeSplit, resetDb, seedSimpleBill } from '../helpers/db'

const ISO = '2026-06-18T00:00:00.000Z'
function syncFieldsForTest(id: string) {
  return { id, created_at: ISO, updated_at: ISO, synced_at: ISO, is_deleted: false, device_id: 'test-device' }
}

beforeEach(async () => {
  await resetDb()
})

describe('expandProfileIdsForSplitMatching', () => {
  it('returns just the id for a plain profile', async () => {
    await db.profiles.add(makeProfile({ id: 'P' }))
    const ids = await expandProfileIdsForSplitMatching('P')
    expect([...ids].sort()).toEqual(['P'])
  })

  it('includes the linked remote id and siblings linking to the same remote', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'local1', is_local: true, owner_id: 'me', linked_profile_id: 'R' }),
      makeProfile({ id: 'local2', is_local: true, owner_id: 'x', linked_profile_id: 'R' }),
      makeProfile({ id: 'R' }),
    ])
    const ids = await expandProfileIdsForSplitMatching('local1')
    expect(ids.has('local1')).toBe(true)
    expect(ids.has('R')).toBe(true)
    expect(ids.has('local2')).toBe(true)
  })

  it('includes local contacts that link to the queried id', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'R' }),
      makeProfile({ id: 'local', is_local: true, owner_id: 'me', linked_profile_id: 'R' }),
    ])
    const ids = await expandProfileIdsForSplitMatching('R')
    expect(ids.has('R')).toBe(true)
    expect(ids.has('local')).toBe(true)
  })

  it('still returns the id when the profile is missing', async () => {
    const ids = await expandProfileIdsForSplitMatching('ghost')
    expect([...ids]).toEqual(['ghost'])
  })
})

describe('participantUnionForBill', () => {
  it('includes the payer plus everyone on a split', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 40, other: 60 },
    })
    const union = await participantUnionForBill(billId)
    expect([...union].sort()).toEqual(['me', 'other'])
  })

  it('excludes soft-deleted splits but keeps the payer', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 40, other: 60 },
    })
    const splits = await db.item_splits.toArray()
    const otherSplit = splits.find((s) => s.user_id === 'other')!
    await db.item_splits.update(otherSplit.id, { is_deleted: true })
    const union = await participantUnionForBill(billId)
    expect(union.has('me')).toBe(true)
    expect(union.has('other')).toBe(false)
  })

  it('omits the payer for a deleted bill but still surfaces split rows (not cascade-deleted)', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { other: 50 },
      isDeleted: true,
    })
    const union = await participantUnionForBill(billId)
    expect(union.has('me')).toBe(false)
    expect(union.has('other')).toBe(true)
  })
})

describe('computePairwiseNetForBill', () => {
  it('is positive when the other person owes me (I paid)', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    expect(await computePairwiseNetForBill(billId, 'me', 'other')).toBe(50)
  })

  it('is negative when I owe the other person (they paid)', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'other',
      shares: { me: 30, other: 70 },
    })
    expect(await computePairwiseNetForBill(billId, 'me', 'other')).toBe(-30)
  })

  it('is reduced by a bill-attributed settlement', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    await db.settlements.add(
      makeSettlement({
        bill_id: billId,
        from_user_id: 'other',
        to_user_id: 'me',
        amount: 50,
      }),
    )
    expect(await computePairwiseNetForBill(billId, 'me', 'other')).toBe(0)
  })

  it('ignores settlements attributed to a different bill', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    await db.settlements.add(
      makeSettlement({
        bill_id: 'other-bill',
        from_user_id: 'other',
        to_user_id: 'me',
        amount: 50,
      }),
    )
    expect(await computePairwiseNetForBill(billId, 'me', 'other')).toBe(50)
  })

  it('returns 0 for a deleted bill', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
      isDeleted: true,
    })
    expect(await computePairwiseNetForBill(billId, 'me', 'other')).toBe(0)
  })
})

describe('peer-links fold into viewer-scoped pairwise balances', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('nets a peer-linked id into the pairwise total so balance matches the deduped display', async () => {
    // ME paid a 100 personal bill; SAM_A owes 100 on it. A second id SAM_B exists.
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'SAM_A', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'SAM_B', is_local: true, owner_id: 'ME' }),
    ])
    const bill = makeBill({ id: 'B', group_id: null, created_by: 'ME', paid_by: 'ME', total_amount: 100, currency: 'PHP' })
    await db.bills.add(bill)
    await db.bill_items.add(makeItem({ id: 'I', bill_id: 'B', amount: 100 }))
    await db.item_splits.add(makeSplit({ id: 'S', item_id: 'I', user_id: 'SAM_A', computed_amount: 100 }))

    const before = await computePairwiseNet('ME', 'SAM_A')
    expect(before.get('PHP')).toBe(100)

    // Viewer manually marks SAM_A and SAM_B as the same person.
    await db.profile_peer_links.add({
      ...syncFieldsForTest('PL'),
      owner_user_id: 'ME',
      anchor_profile_id: 'SAM_A',
      peer_profile_id: 'SAM_B',
    })

    // SAM_B owes 50 on a DIFFERENT bill ME paid. Since the viewer linked the two ids, the
    // Person detail page dedups them into one row, so the pairwise net must also fold SAM_B's
    // debt in (-> 150). Leaving balances peer-blind made the displayed amount disagree with the math.
    const bill2 = makeBill({ id: 'B2', group_id: null, created_by: 'ME', paid_by: 'ME', total_amount: 50, currency: 'PHP' })
    await db.bills.add(bill2)
    await db.bill_items.add(makeItem({ id: 'I2', bill_id: 'B2', amount: 50 }))
    await db.item_splits.add(makeSplit({ id: 'S2', item_id: 'I2', user_id: 'SAM_B', computed_amount: 50 }))

    const after = await computePairwiseNet('ME', 'SAM_A')
    expect(after.get('PHP')).toBe(150) // SAM_B's debt folds in via the viewer's peer-link
  })
})
