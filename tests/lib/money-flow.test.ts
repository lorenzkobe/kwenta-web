import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { computePairwiseNetAllContexts } from '@/lib/people'
import { buildPersonMoneyFlow } from '@/lib/money-flow'
import {
  makeGroup,
  makeMember,
  makeProfile,
  makeSettlement,
  resetDb,
  seedSimpleBill,
} from '../helpers/db'

// Distinct, strictly increasing timestamps so ledger ordering is deterministic
// (the shared factory ISO would otherwise leave same-time rows order-unstable).
const T = {
  t1: '2026-06-01T00:00:00.000Z',
  t2: '2026-06-02T00:00:00.000Z',
  t3: '2026-06-03T00:00:00.000Z',
  t4: '2026-06-04T00:00:00.000Z',
}

/** Personal bill I paid; `other` owes me `amount`. Returns the bill id. */
async function theyOweMe(amount: number, createdAt: string, currency = 'PHP'): Promise<string> {
  const id = await seedSimpleBill({ groupId: null, paidBy: 'me', currency, shares: { other: amount } })
  await db.bills.update(id, { created_at: createdAt })
  return id
}

/** Personal bill `other` paid; I owe them `amount`. Returns the bill id. */
async function iOweThem(amount: number, createdAt: string, currency = 'PHP'): Promise<string> {
  const id = await seedSimpleBill({ groupId: null, paidBy: 'other', currency, shares: { me: amount } })
  await db.bills.update(id, { created_at: createdAt })
  return id
}

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([
    makeProfile({ id: 'me', display_name: 'Me' }),
    makeProfile({ id: 'other', display_name: 'Other' }),
  ])
})

describe('buildPersonMoneyFlow — personal bills', () => {
  it('a bill I paid adds a positive row (they owe me)', async () => {
    await theyOweMe(500, T.t1)
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('personal_bill')
    expect(rows[0].currency).toBe('PHP')
    expect(rows[0].rawAmount).toBe(500)
    expect(rows[0].runningNet).toBe(500)
    expect(rows[0].signedAmount).toBe(500)
    expect(currentNet.get('PHP')).toBe(500)
  })

  it('a bill they paid adds a negative row (I owe them)', async () => {
    await iOweThem(300, T.t1)
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('personal_bill')
    expect(rows[0].runningNet).toBe(-300)
    expect(currentNet.get('PHP')).toBe(-300)
  })

  it('accumulates a running balance across bills in chronological order', async () => {
    await theyOweMe(500, T.t1)
    await iOweThem(200, T.t2)
    const { rows } = await buildPersonMoneyFlow('me', 'other')
    expect(rows.map((r) => r.runningNet)).toEqual([500, 300])
  })
})

describe('buildPersonMoneyFlow — payments against debt', () => {
  it('a bill-tagged payment from them reduces the running balance toward zero', async () => {
    const billId = await theyOweMe(500, T.t1)
    await db.settlements.add(
      makeSettlement({
        from_user_id: 'other',
        to_user_id: 'me',
        amount: 200,
        bill_id: billId,
        created_at: T.t2,
      }),
    )
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows.map((r) => [r.type, r.runningNet])).toEqual([
      ['personal_bill', 500],
      ['payment', 300],
    ])
    expect(currentNet.get('PHP')).toBe(300)
  })
})

describe('buildPersonMoneyFlow — overpayment flips the tab (no credit)', () => {
  it('an untargeted overpayment from them flips the balance past zero', async () => {
    await theyOweMe(500, T.t1)
    // Untargeted payment from them: group_id and bill_id both null.
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 800, created_at: T.t2 }),
    )
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows[1].type).toBe('payment')
    expect(rows[1].runningNet).toBe(-300) // flips: I now owe them 300
    expect(currentNet.get('PHP')).toBe(-300)
  })

  it('a later same-direction bill moves the flipped tab back', async () => {
    await theyOweMe(500, T.t1)
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 800, created_at: T.t2 }),
    )
    await theyOweMe(200, T.t3)
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(3)
    expect(rows[2].type).toBe('personal_bill')
    expect(rows[2].runningNet).toBe(-100) // -300 + 200
    expect(currentNet.get('PHP')).toBe(-100)
  })

  it('my own overpayment flips the tab to their favor', async () => {
    await iOweThem(300, T.t1)
    await db.settlements.add(
      makeSettlement({ from_user_id: 'me', to_user_id: 'other', amount: 500, created_at: T.t2 }),
    )
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows[1].runningNet).toBe(200) // -300 + 500 → they owe me 200
    expect(currentNet.get('PHP')).toBe(200)
  })
})

describe('buildPersonMoneyFlow — groups', () => {
  async function seedGroup(memberIds: string[], currency = 'PHP'): Promise<string> {
    const group = makeGroup({ created_by: 'me', currency })
    await db.groups.add(group)
    await db.group_members.bulkAdd(
      memberIds.map((uid) => makeMember({ group_id: group.id, user_id: uid, display_name: uid })),
    )
    return group.id
  }

  it('a 2-member group bill I paid contributes a positive pairwise row', async () => {
    const gid = await seedGroup(['me', 'other'])
    const billId = await seedSimpleBill({ groupId: gid, paidBy: 'me', shares: { other: 100 } })
    await db.bills.update(billId, { created_at: T.t1 })
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('group_bill')
    expect(rows[0].runningNet).toBe(100)
    expect(currentNet.get('PHP')).toBe(100)
  })

  it('a 3+ member group bill surfaces only the pairwise slice with this person', async () => {
    const gid = await seedGroup(['me', 'other', 'third'])
    // I paid 200; other and third each owe 100. My pair with `other` is only 100.
    const billId = await seedSimpleBill({ groupId: gid, paidBy: 'me', shares: { other: 100, third: 100 } })
    await db.bills.update(billId, { created_at: T.t1 })
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(rows[0].runningNet).toBe(100)
    expect(currentNet.get('PHP')).toBe(100)
  })

  it('interleaves personal and group events into one running balance', async () => {
    const gid = await seedGroup(['me', 'other'])
    await theyOweMe(500, T.t1) // personal: +500
    const gBill = await seedSimpleBill({ groupId: gid, paidBy: 'me', shares: { other: 300 } })
    await db.bills.update(gBill, { created_at: T.t2 }) // group: +300 → 800
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows.map((r) => [r.type, r.runningNet])).toEqual([
      ['personal_bill', 500],
      ['group_bill', 800],
    ])
    expect(currentNet.get('PHP')).toBe(800)
  })
})

describe('buildPersonMoneyFlow — exclusions', () => {
  it('ignores soft-deleted bills and unsettled / deleted settlements', async () => {
    await theyOweMe(500, T.t1)
    const deletedBill = await theyOweMe(999, T.t2)
    await db.bills.update(deletedBill, { is_deleted: true })
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 100, is_settled: false, created_at: T.t3 }),
    )
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 100, is_deleted: true, created_at: T.t4 }),
    )
    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(currentNet.get('PHP')).toBe(500)
  })
})

describe('buildPersonMoneyFlow — multi-currency', () => {
  it('keeps an independent running balance per currency', async () => {
    await theyOweMe(500, T.t1, 'PHP')
    await iOweThem(20, T.t2, 'USD')
    const { currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(currentNet.get('PHP')).toBe(500)
    expect(currentNet.get('USD')).toBe(-20)
  })
})

describe('buildPersonMoneyFlow — peer-linked identity', () => {
  it('counts one split per item when a person has two peer-linked ids on it (no double-count)', async () => {
    // 'otherPeer' is a second id for the same person, joined to 'other' by a manual peer link.
    await db.profiles.add(makeProfile({ id: 'otherPeer', display_name: 'Other (peer)' }))
    await db.profile_peer_links.add({
      id: 'link-1',
      created_at: T.t1,
      updated_at: T.t1,
      synced_at: T.t1,
      is_deleted: false,
      device_id: 'test',
      owner_user_id: 'me',
      anchor_profile_id: 'other',
      peer_profile_id: 'otherPeer',
    })
    // One personal item I paid, with a split under EACH of the person's two ids.
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { other: 50, otherPeer: 50 },
    })
    await db.bills.update(billId, { created_at: T.t1 })

    const { rows, currentNet } = await buildPersonMoneyFlow('me', 'other')
    expect(rows).toHaveLength(1)
    expect(rows[0].rawAmount).toBe(50) // one split, not 100
    expect(currentNet.get('PHP')).toBe(50)
    // Must reconcile to the headline balance (the invariant the double-count broke).
    const truth = await computePairwiseNetAllContexts('me', 'other')
    expect(currentNet.get('PHP')).toBeCloseTo(truth.get('PHP') ?? 0, 2)
  })
})

describe('buildPersonMoneyFlow — name resolution', () => {
  it('titles a payment with a live roster name, not a soft-deleted membership', async () => {
    await db.profiles.update('other', { is_deleted: true }) // no usable profile name
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'g', user_id: 'other', display_name: 'Removed', is_deleted: true }),
      makeMember({ group_id: 'g', user_id: 'other', display_name: 'Active', is_deleted: false }),
    ])
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 100, created_at: T.t1 }),
    )
    const { rows } = await buildPersonMoneyFlow('me', 'other')
    const payment = rows.find((r) => r.type === 'payment')
    expect(payment?.title).toBe('Active paid you')
  })
})

describe('buildPersonMoneyFlow — symmetry & invariant', () => {
  it('is the mirror image from the other person perspective', async () => {
    await theyOweMe(500, T.t1)
    const mine = await buildPersonMoneyFlow('me', 'other')
    const theirs = await buildPersonMoneyFlow('other', 'me')
    expect(mine.currentNet.get('PHP')).toBe(500)
    expect(theirs.currentNet.get('PHP')).toBe(-500)
  })

  it('final running net reconciles to computePairwiseNetAllContexts', async () => {
    const gid = makeGroup({ created_by: 'me', currency: 'PHP' })
    await db.groups.add(gid)
    await db.group_members.bulkAdd([
      makeMember({ group_id: gid.id, user_id: 'me', display_name: 'Me' }),
      makeMember({ group_id: gid.id, user_id: 'other', display_name: 'Other' }),
    ])
    await theyOweMe(500, T.t1)
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 800, created_at: T.t2 }),
    )
    const gBill = await seedSimpleBill({ groupId: gid.id, paidBy: 'other', shares: { me: 150 } })
    await db.bills.update(gBill, { created_at: T.t3 })

    const { currentNet } = await buildPersonMoneyFlow('me', 'other')
    const truth = await computePairwiseNetAllContexts('me', 'other')
    for (const cur of new Set([...currentNet.keys(), ...truth.keys()])) {
      expect(currentNet.get(cur) ?? 0).toBeCloseTo(truth.get(cur) ?? 0, 2)
    }
  })
})
