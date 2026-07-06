import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { settleUpPersonalBills } from '@/db/operations'
import {
  buildPersonalReconcilePlan,
  computeAvailableGeneralCredit,
  computePairwiseNetForBill,
  listPairwiseSettlementsBetween,
} from '@/lib/people'
import { makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

// operations.ts fires sync + notifications as side effects. Stub them so the
// operation is exercised purely against Dexie.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/cloud-first-mutations', () => ({ finalizeMutationSync: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([makeProfile({ id: 'me' }), makeProfile({ id: 'other' })])
})

const theyOweMeBill = (amount: number) =>
  seedSimpleBill({ groupId: null, paidBy: 'me', shares: { me: 0, other: amount } })
const iOweThemBill = (amount: number) =>
  seedSimpleBill({ groupId: null, paidBy: 'other', shares: { other: 0, me: amount } })

describe('settleUpPersonalBills', () => {
  it('records offset settlements on both bills and zeroes each, consuming no credit', async () => {
    const x = await theyOweMeBill(500) // other owes me 500
    const y = await iOweThemBill(500) // I owe other 500

    const result = await settleUpPersonalBills({
      meId: 'me',
      otherId: 'other',
      currency: 'PHP',
      markedBy: 'me',
      offsetSlices: [
        { billId: x, amount: 500, direction: 'other_to_me' },
        { billId: y, amount: 500, direction: 'me_to_other' },
      ],
      creditSlices: [],
    })

    expect(result.settlementIds).toHaveLength(2)
    const sX = await db.settlements.where('bill_id').equals(x).first()
    const sY = await db.settlements.where('bill_id').equals(y).first()
    expect(sX?.is_settled).toBe(true)
    expect(sY?.is_settled).toBe(true)
    // both settlements grouped under one logical settle-up
    expect(sX?.bundle_id).toBeTruthy()
    expect(sX?.bundle_id).toBe(sY?.bundle_id)
    // each bill nets to zero now
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    expect(await computePairwiseNetForBill(y, 'me', 'other')).toBe(0)
    // notes explain the reason
    expect(sX?.label.toLowerCase()).toContain('offset')
    expect(sY?.label.toLowerCase()).toContain('offset')
  })

  it('re-tags fully-consumed general credit onto the bill instead of deleting it (payment log survives)', async () => {
    const x = await theyOweMeBill(300)
    const y = await iOweThemBill(200)
    const creditId = (
      await db.settlements.add(
        makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 100, group_id: null, bill_id: null }),
      )
    ).valueOf() as string

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })
    await settleUpPersonalBills({
      meId: 'me',
      otherId: 'other',
      currency: 'PHP',
      markedBy: 'me',
      offsetSlices: plan.offsetSlices.map((s) => ({ billId: s.billId, amount: s.amount, direction: s.direction })),
      creditSlices: plan.creditSlices.map((s) => ({ billId: s.billId, amount: s.amount, direction: s.direction })),
    })

    // The general credit row is NOT deleted — it is re-tagged onto the bill it funded,
    // so the payment stays visible and its money is traceable.
    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(false)
    expect(credit?.amount).toBe(100)
    expect(credit?.bill_id).toBe(x)
    expect(credit?.label.toLowerCase()).toContain('credit')
    // both bills settle to zero
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    expect(await computePairwiseNetForBill(y, 'me', 'other')).toBe(0)
    // the payment is still in the pairwise history, not lost
    const history = await listPairwiseSettlementsBetween('me', 'other')
    expect(history.some((h) => h.id === creditId)).toBe(true)
  })

  it('partially consumes credit by splitting: source keeps the remainder, no row is deleted', async () => {
    const x = await theyOweMeBill(40) // they owe me 40
    const creditId = (
      await db.settlements.add(
        makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 100, group_id: null, bill_id: null }),
      )
    ).valueOf() as string

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })
    await settleUpPersonalBills({
      meId: 'me',
      otherId: 'other',
      currency: 'PHP',
      markedBy: 'me',
      offsetSlices: plan.offsetSlices.map((s) => ({ billId: s.billId, amount: s.amount, direction: s.direction })),
      creditSlices: plan.creditSlices.map((s) => ({ billId: s.billId, amount: s.amount, direction: s.direction })),
    })

    // Nothing is deleted; the source row survives as the leftover credit (100 - 40 = 60).
    expect(await db.settlements.filter((s) => s.is_deleted).count()).toBe(0)
    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(false)
    expect(credit?.bill_id).toBe(null)
    expect(credit?.amount).toBe(60)
    // The consumed 40 is now a bill-tagged settlement on x, so the bill nets to zero.
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    // 60 of general credit remains available.
    expect(
      await computeAvailableGeneralCredit({
        meId: 'me',
        otherId: 'other',
        fromUserId: 'other',
        toUserId: 'me',
        currency: 'PHP',
      }),
    ).toBe(60)
  })

  it('rejects a slice that exceeds the current bill balance', async () => {
    const x = await theyOweMeBill(100)
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 200, group_id: null, bill_id: null }),
    )

    await expect(
      settleUpPersonalBills({
        meId: 'me',
        otherId: 'other',
        currency: 'PHP',
        markedBy: 'me',
        offsetSlices: [],
        creditSlices: [{ billId: x, amount: 200, direction: 'other_to_me' }],
      }),
    ).rejects.toThrow()
  })
})
