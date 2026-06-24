import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { settleUpPersonalBills } from '@/db/operations'
import { buildPersonalReconcilePlan, computePairwiseNetForBill } from '@/lib/people'
import { makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

// operations.ts fires sync + notifications as side effects. Stub them so the
// operation is exercised purely against Dexie.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/cloud-first-mutations', () => ({ finalizeMutationSync: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentRecorded: vi.fn(async () => {}),
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

  it('consumes general credit for credit slices but not for offset slices', async () => {
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

    // the general credit row was consumed (soft-deleted to 0)
    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(true)
    // both bills settle to zero
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    expect(await computePairwiseNetForBill(y, 'me', 'other')).toBe(0)
    // a credit-sourced settlement carries a credit note, not an offset note
    const creditSettlement = (await db.settlements.where('bill_id').equals(x).toArray()).find((s) =>
      s.label.toLowerCase().includes('credit'),
    )
    expect(creditSettlement).toBeTruthy()
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
