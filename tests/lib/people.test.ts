import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import {
  computePairwiseNetForBill,
  expandProfileIdsForSplitMatching,
  participantUnionForBill,
} from '@/lib/people'
import { makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

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
