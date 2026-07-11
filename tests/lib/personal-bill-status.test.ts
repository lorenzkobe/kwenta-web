import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { isPersonalBillFullySettled } from '@/lib/personal-bill-status'
import { makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

beforeEach(async () => {
  await resetDb()
})

describe('isPersonalBillFullySettled', () => {
  it('treats a missing bill as settled', async () => {
    expect(await isPersonalBillFullySettled('nope', 'me')).toBe(true)
  })

  it('treats a deleted bill as settled', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
      isDeleted: true,
    })
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(true)
  })

  it('is not settled while another participant still owes', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(false)
  })

  it('becomes settled once the outstanding balance is paid', async () => {
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
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(true)
  })

  it('is settled when the only participant is the current user', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 100 },
    })
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(true)
  })

  it('treats a sub-half-cent shortfall as settled (net rounds to zero)', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    // 49.996 leaves a 0.004 net, which the cent-rounding in computePairwiseNetForBill
    // collapses to 0 — settled.
    await db.settlements.add(
      makeSettlement({
        bill_id: billId,
        from_user_id: 'other',
        to_user_id: 'me',
        amount: 49.996,
      }),
    )
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(true)
  })

  it('is not settled when a single cent remains outstanding', async () => {
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
        amount: 49.99,
      }),
    )
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(false)
  })

  it('stays settled in its own currency despite an open balance in another', async () => {
    // A PHP bill, fully paid...
    const phpBill = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      currency: 'PHP',
      shares: { me: 50, other: 50 },
    })
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 50, currency: 'PHP' }),
    )
    // ...but an unrelated USD bill with the same person is still open.
    await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      currency: 'USD',
      shares: { me: 30, other: 30 },
    })
    // The PHP bill is settled in PHP; the open USD balance must not flip it to unpaid.
    expect(await isPersonalBillFullySettled(phpBill, 'me')).toBe(true)
  })

  it('an untargeted payment that clears the tab settles the bill (stuck-unpaid fix)', async () => {
    // Status is derived from the person tab, not bill-tagged payments: a general payment
    // that squares you up marks the bill settled — the exact "still shows unpaid" bug.
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 50, other: 50 },
    })
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(false)
    await db.settlements.add(
      makeSettlement({
        bill_id: null, // untargeted — not tagged to this bill
        from_user_id: 'other',
        to_user_id: 'me',
        amount: 50,
      }),
    )
    expect(await isPersonalBillFullySettled(billId, 'me')).toBe(true)
  })
})
