import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { applyGeneralCreditToSelection } from '@/db/operations'
import {
  computeAvailableGeneralCredit,
  computePairwiseNetForBill,
  listEligibleSharedGroupsForGeneralCredit,
  listPairwiseSettlementsBetween,
} from '@/lib/people'
import { makeGroup, makeMember, makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

// operations.ts fires sync + notifications as side effects. Stub them so the
// operation is exercised purely against Dexie.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/cloud-first-mutations', () => ({ finalizeMutationSync: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
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

const theyPrepaidMe = (amount: number) =>
  db.settlements.add(
    makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount, group_id: null, bill_id: null }),
  ) as unknown as Promise<string>

describe('applyGeneralCreditToSelection — preserves the payment log (re-tag, never delete)', () => {
  it('re-tags a fully-applied credit onto the personal bill instead of deleting it', async () => {
    const x = await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { me: 0, other: 100 } }) // they owe me 100
    const creditId = (await theyPrepaidMe(100)).valueOf() as string

    await applyGeneralCreditToSelection({
      fromUserId: 'other',
      toUserId: 'me',
      currency: 'PHP',
      markedBy: 'me',
      appliedAmount: 100,
      personalSlices: [{ billId: x, amount: 100 }],
      groupAllocations: [],
    })

    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(false)
    expect(credit?.bill_id).toBe(x)
    expect(credit?.amount).toBe(100)
    expect(await db.settlements.filter((s) => s.is_deleted).count()).toBe(0)
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    expect(
      await computeAvailableGeneralCredit({ meId: 'me', otherId: 'other', fromUserId: 'other', toUserId: 'me', currency: 'PHP' }),
    ).toBe(0)
    const history = await listPairwiseSettlementsBetween('me', 'other')
    expect(history.some((h) => h.id === creditId)).toBe(true)
  })

  it('partially applies by splitting: source keeps the remainder, nothing is deleted', async () => {
    const x = await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { me: 0, other: 40 } }) // they owe me 40
    const creditId = (await theyPrepaidMe(100)).valueOf() as string

    await applyGeneralCreditToSelection({
      fromUserId: 'other',
      toUserId: 'me',
      currency: 'PHP',
      markedBy: 'me',
      appliedAmount: 40,
      personalSlices: [{ billId: x, amount: 40 }],
      groupAllocations: [],
    })

    expect(await db.settlements.filter((s) => s.is_deleted).count()).toBe(0)
    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(false)
    expect(credit?.bill_id).toBe(null)
    expect(credit?.amount).toBe(60)
    expect(await computePairwiseNetForBill(x, 'me', 'other')).toBe(0)
    expect(
      await computeAvailableGeneralCredit({ meId: 'me', otherId: 'other', fromUserId: 'other', toUserId: 'me', currency: 'PHP' }),
    ).toBe(60)
  })

  it('re-tags credit into a group settlement when applied to a group balance', async () => {
    const g = makeGroup({ id: 'G', created_by: 'me', currency: 'PHP' })
    await db.groups.add(g)
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'me' }),
      makeMember({ group_id: 'G', user_id: 'other' }),
    ])
    await seedSimpleBill({ groupId: 'G', paidBy: 'me', shares: { me: 0, other: 50 } }) // they owe me 50 in the group
    const creditId = (await theyPrepaidMe(50)).valueOf() as string

    // Sanity-check the setup is actually eligible before applying.
    const eligible = await listEligibleSharedGroupsForGeneralCredit({
      meId: 'me',
      otherId: 'other',
      fromUserId: 'other',
      toUserId: 'me',
      currency: 'PHP',
    })
    expect(eligible.find((e) => e.groupId === 'G')?.allocatableAmount).toBe(50)

    await applyGeneralCreditToSelection({
      fromUserId: 'other',
      toUserId: 'me',
      currency: 'PHP',
      markedBy: 'me',
      appliedAmount: 50,
      personalSlices: [],
      groupAllocations: [{ groupId: 'G', amount: 50 }],
    })

    // The personal credit is preserved — re-tagged into the group as a group settlement.
    const credit = await db.settlements.get(creditId)
    expect(credit?.is_deleted).toBe(false)
    expect(credit?.group_id).toBe('G')
    expect(credit?.amount).toBe(50)
    expect(await db.settlements.filter((s) => s.is_deleted).count()).toBe(0)
    // No longer personal available credit (moved into the group).
    expect(
      await computeAvailableGeneralCredit({ meId: 'me', otherId: 'other', fromUserId: 'other', toUserId: 'me', currency: 'PHP' }),
    ).toBe(0)
    // Still visible in the pair's payment history (listPairwiseSettlementsBetween spans groups).
    const history = await listPairwiseSettlementsBetween('me', 'other')
    expect(history.some((h) => h.id === creditId)).toBe(true)
  })
})
