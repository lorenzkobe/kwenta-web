import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { buildPersonalReconcilePlan } from '@/lib/people'
import { makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([makeProfile({ id: 'me' }), makeProfile({ id: 'other' })])
})

/** Personal bill where `me` paid → `other` owes `me` their share (net > 0). */
async function theyOweMeBill(amount: number, createdAt?: string): Promise<string> {
  const id = await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { me: 0, other: amount } })
  if (createdAt) await db.bills.update(id, { created_at: createdAt })
  return id
}

/** Personal bill where `other` paid → `me` owes `other` my share (net < 0). */
async function iOweThemBill(amount: number, createdAt?: string): Promise<string> {
  const id = await seedSimpleBill({ groupId: null, paidBy: 'other', shares: { other: 0, me: amount } })
  if (createdAt) await db.bills.update(id, { created_at: createdAt })
  return id
}

/** General (unattached) credit in a direction. */
async function generalCredit(from: string, to: string, amount: number): Promise<void> {
  await db.settlements.add(
    makeSettlement({ from_user_id: from, to_user_id: to, amount, group_id: null, bill_id: null }),
  )
}

describe('buildPersonalReconcilePlan', () => {
  it('with only "they owe me" bills, offset is zero and credit drains one direction', async () => {
    const bill = await theyOweMeBill(100)
    await generalCredit('other', 'me', 60)

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })

    expect(plan.offsetCap).toBe(0)
    expect(plan.creditCap).toBe(60)
    expect(plan.maxApplicable).toBe(60)
    expect(plan.appliedAmount).toBe(60)
    expect(plan.offsetSlices).toEqual([])
    expect(plan.creditSlices).toEqual([
      expect.objectContaining({ billId: bill, amount: 60, direction: 'other_to_me', source: 'credit' }),
    ])
    expect(plan.fullySettled).toBe(false)
    expect(plan.residualRemaining).toBe(40)
    expect(plan.residualDirection).toBe('other_to_me')
  })

  it('fully reconciles the reported scenario: 800 mutual offset + 200 cash → even', async () => {
    // they owe me 1000 across two bills
    const a = await theyOweMeBill(600, '2026-01-01T00:00:00.000Z')
    const b = await theyOweMeBill(400, '2026-01-02T00:00:00.000Z')
    // I owe them 800 across bills they paid
    const c = await iOweThemBill(500, '2026-01-03T00:00:00.000Z')
    const d = await iOweThemBill(300, '2026-01-04T00:00:00.000Z')
    // they handed me 200 cash
    await generalCredit('other', 'me', 200)

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })

    expect(plan.offsetCap).toBe(800)
    expect(plan.creditCap).toBe(200)
    expect(plan.maxApplicable).toBe(1000)
    expect(plan.appliedAmount).toBe(1000)
    expect(plan.fullySettled).toBe(true)
    expect(plan.residualRemaining).toBe(0)

    const offsetTheyOwe = plan.offsetSlices.filter((s) => s.direction === 'other_to_me')
    const offsetIOwe = plan.offsetSlices.filter((s) => s.direction === 'me_to_other')
    expect(offsetTheyOwe.reduce((n, s) => n + s.amount, 0)).toBe(800)
    expect(offsetIOwe.reduce((n, s) => n + s.amount, 0)).toBe(800)
    // I-owe-them side fully offset (both bills c+d)
    expect(offsetIOwe.map((s) => s.billId).sort()).toEqual([c, d].sort())
    // the 200 cash credit lands on the they-owe-me side
    expect(plan.creditSlices.reduce((n, s) => n + s.amount, 0)).toBe(200)
    expect(plan.creditSlices.every((s) => s.direction === 'other_to_me')).toBe(true)
    // every they-owe-me bill is referenced (offset 800 + credit 200 = 1000)
    const allTheyOwe = [...offsetTheyOwe, ...plan.creditSlices].map((s) => s.billId)
    expect(new Set(allTheyOwe)).toEqual(new Set([a, b]))
  })

  it('net-debtor with no cash: offsets what cancels, leaves remainder you owe', async () => {
    await theyOweMeBill(300)
    await iOweThemBill(500)

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })

    expect(plan.offsetCap).toBe(300)
    expect(plan.creditCap).toBe(0)
    expect(plan.appliedAmount).toBe(300)
    expect(plan.creditSlices).toEqual([])
    expect(plan.offsetSlices.filter((s) => s.direction === 'other_to_me').reduce((n, s) => n + s.amount, 0)).toBe(300)
    expect(plan.offsetSlices.filter((s) => s.direction === 'me_to_other').reduce((n, s) => n + s.amount, 0)).toBe(300)
    expect(plan.fullySettled).toBe(false)
    expect(plan.residualRemaining).toBe(200)
    expect(plan.residualDirection).toBe('me_to_other')
  })

  it('partial amountToApply fills the free offset first', async () => {
    await theyOweMeBill(1000)
    await iOweThemBill(800)
    await generalCredit('other', 'me', 200)

    const plan = await buildPersonalReconcilePlan({
      meId: 'me',
      otherId: 'other',
      currency: 'PHP',
      amountToApply: 500,
    })

    expect(plan.appliedAmount).toBe(500)
    // all 500 goes to offset (both sides), none to credit yet
    expect(plan.offsetSlices.filter((s) => s.direction === 'other_to_me').reduce((n, s) => n + s.amount, 0)).toBe(500)
    expect(plan.offsetSlices.filter((s) => s.direction === 'me_to_other').reduce((n, s) => n + s.amount, 0)).toBe(500)
    expect(plan.creditSlices).toEqual([])
  })

  it('drains credit oldest-first across they-owe-me bills', async () => {
    const older = await theyOweMeBill(300, '2026-01-01T00:00:00.000Z')
    const newer = await theyOweMeBill(300, '2026-02-01T00:00:00.000Z')
    await generalCredit('other', 'me', 400)

    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })

    expect(plan.creditSlices.map((s) => ({ billId: s.billId, amount: s.amount }))).toEqual([
      { billId: older, amount: 300 },
      { billId: newer, amount: 100 },
    ])
  })

  it('returns an empty, fully-settled plan when nothing is outstanding', async () => {
    const plan = await buildPersonalReconcilePlan({ meId: 'me', otherId: 'other', currency: 'PHP' })
    expect(plan.maxApplicable).toBe(0)
    expect(plan.appliedAmount).toBe(0)
    expect(plan.offsetSlices).toEqual([])
    expect(plan.creditSlices).toEqual([])
    expect(plan.residualDirection).toBe(null)
  })
})
