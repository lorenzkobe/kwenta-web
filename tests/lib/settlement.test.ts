import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import {
  computeAllGroupBalances,
  computeGroupBalances,
  listSettlementHistoryForBill,
} from '@/lib/settlement'
import {
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSettlement,
  makeSplit,
  resetDb,
  seedSimpleBill,
} from '../helpers/db'

beforeEach(async () => {
  await resetDb()
})

async function seedGroupWithTwoMembers(currency = 'PHP') {
  const a = makeProfile({ id: 'A', display_name: 'Alice' })
  const b = makeProfile({ id: 'B', display_name: 'Bob' })
  await db.profiles.bulkAdd([a, b])
  const group = makeGroup({ id: 'G', created_by: 'A', currency })
  await db.groups.add(group)
  await db.group_members.bulkAdd([
    makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
    makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
  ])
  return group
}

describe('computeGroupBalances', () => {
  it('returns null for a missing group', async () => {
    expect(await computeGroupBalances('nope', 'A')).toBeNull()
  })

  it('returns null for a soft-deleted group', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A', is_deleted: true }))
    expect(await computeGroupBalances('G', 'A')).toBeNull()
  })

  it('credits the payer and debits each split participant', async () => {
    await seedGroupWithTwoMembers()
    // Alice paid 100; split evenly (A 50 / B 50).
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })

    const summary = await computeGroupBalances('G', 'A')
    expect(summary).not.toBeNull()
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    expect(byId.A).toBe(50)
    expect(byId.B).toBe(-50)
    expect(summary!.totalToReceive).toBe(50)
    expect(summary!.totalToPay).toBe(0)
  })

  it('reports totalToPay from the current user perspective', async () => {
    await seedGroupWithTwoMembers()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
    const summary = await computeGroupBalances('G', 'B')
    expect(summary!.totalToPay).toBe(50)
    expect(summary!.totalToReceive).toBe(0)
  })

  it('applies settled settlements to zero out the balance', async () => {
    await seedGroupWithTwoMembers()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
    // Bob pays Alice the 50 he owes.
    await db.settlements.add(
      makeSettlement({ group_id: 'G', from_user_id: 'B', to_user_id: 'A', amount: 50 }),
    )
    const summary = await computeGroupBalances('G', 'A')
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    expect(byId.A).toBe(0)
    expect(byId.B).toBe(0)
    expect(summary!.suggestions).toEqual([])
  })

  it('ignores unsettled settlements', async () => {
    await seedGroupWithTwoMembers()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
    await db.settlements.add(
      makeSettlement({
        group_id: 'G',
        from_user_id: 'B',
        to_user_id: 'A',
        amount: 50,
        is_settled: false,
      }),
    )
    const summary = await computeGroupBalances('G', 'A')
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    expect(byId.A).toBe(50)
  })

  it('produces a settlement suggestion from payer to receiver', async () => {
    await seedGroupWithTwoMembers()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
    const summary = await computeGroupBalances('G', 'A')
    expect(summary!.suggestions).toHaveLength(1)
    expect(summary!.suggestions[0]).toMatchObject({
      fromUserId: 'B',
      toUserId: 'A',
      amount: 50,
    })
  })

  it('skips bills whose currency differs from the group', async () => {
    await seedGroupWithTwoMembers('PHP')
    await seedSimpleBill({
      groupId: 'G',
      paidBy: 'A',
      currency: 'USD',
      shares: { A: 50, B: 50 },
    })
    const summary = await computeGroupBalances('G', 'A')
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    expect(byId.A).toBe(0)
    expect(byId.B).toBe(0)
  })

  it('credits the linked member once splits carry the remote id', async () => {
    await seedGroupWithTwoMembers()
    // After linkProfileToRemote rewrites the rows, the split references the remote
    // member id B directly — the shared, synced, canonical state.
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
    const summary = await computeGroupBalances('G', 'A')
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    expect(byId.B).toBe(-50)
    expect(byId.A).toBe(50)
  })

  it('produces identical balances and suggestions regardless of viewer-private contacts', async () => {
    // A stale split references a local-contact id "Lc" that only the contact's owner (A)
    // can resolve to member B. Another member never receives that local contact (privacy
    // boundary). Balances/suggestions must NOT depend on whether the viewer holds the
    // private Lc->B link, otherwise different members see different suggested payments.
    await seedGroupWithTwoMembers()
    await db.profiles.add(
      makeProfile({ id: 'Lc', is_local: true, owner_id: 'A', linked_profile_id: 'B' }),
    )
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, Lc: 50 } })

    // Owner A's device: holds the Lc->B link profile.
    const ownerView = await computeGroupBalances('G', 'A')

    // Another member's device: the private local contact is not present.
    await db.profiles.delete('Lc')
    const otherView = await computeGroupBalances('G', 'A')

    // Compare the value-bearing fields (ids + amounts). Display names of an unresolved
    // stale id are best-effort and not part of the settlement math.
    const balanceValues = (s: typeof ownerView) =>
      [...s!.balances]
        .map((b) => ({ userId: b.userId, amount: b.amount }))
        .sort((a, b) => a.userId.localeCompare(b.userId))
    const suggestionValues = (s: typeof ownerView) =>
      s!.suggestions
        .map((x) => ({ fromUserId: x.fromUserId, toUserId: x.toUserId, amount: x.amount }))
        .sort((a, b) => a.fromUserId.localeCompare(b.fromUserId))

    expect(balanceValues(ownerView)).toEqual(balanceValues(otherView))
    expect(suggestionValues(ownerView)).toEqual(suggestionValues(otherView))
  })

  describe('two-device convergence (canonical ids)', () => {
    beforeEach(async () => {
      await resetDb()
    })

    async function seedCanonical() {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME', currency: 'PHP' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME', display_name: 'Me' }),
        makeMember({ group_id: 'G', user_id: 'SAM', display_name: 'Sam' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME', display_name: 'Me' }),
        makeProfile({ id: 'SAM', display_name: 'Sam' }),
      ])
      // ME paid 100; SAM owes 50, ME owes 50.
      await db.bills.add(makeBill({ id: 'B', group_id: 'G', created_by: 'ME', paid_by: 'ME', total_amount: 100, currency: 'PHP' }))
      await db.bill_items.add(makeItem({ id: 'I', bill_id: 'B', amount: 100 }))
      await db.item_splits.bulkAdd([
        makeSplit({ id: 'S1', item_id: 'I', user_id: 'ME', computed_amount: 50 }),
        makeSplit({ id: 'S2', item_id: 'I', user_id: 'SAM', computed_amount: 50 }),
      ])
    }

    it('both members compute identical balances + suggestions when ids are canonical', async () => {
      await seedCanonical()
      const asMe = await computeGroupBalances('G', 'ME')
      const asSam = await computeGroupBalances('G', 'SAM')
      // Same per-member balances regardless of viewer.
      const norm = (s: NonNullable<typeof asMe>) =>
        [...s.balances].sort((a, b) => a.userId.localeCompare(b.userId)).map((b) => [b.userId, b.amount])
      expect(norm(asMe!)).toEqual(norm(asSam!))
      // Same single suggestion: SAM pays ME 50.
      expect(asMe!.suggestions).toEqual(asSam!.suggestions)
      expect(asMe!.suggestions).toEqual([
        expect.objectContaining({ fromUserId: 'SAM', toUserId: 'ME', amount: 50 }),
      ])
    })

    it('a leaked local id (pre-fix) produces a phantom balance entry — the bug canonicalization removes', async () => {
      await seedCanonical()
      // Simulate Device B that wrote SAM's split under a local id instead of the roster id.
      await db.item_splits.update('S2', { user_id: 'LOCALSAM_B' })
      const asMe = await computeGroupBalances('G', 'ME')
      // SAM's debit now lands on a non-member id -> an extra balance bucket appears.
      const ids = asMe!.balances.map((b) => b.userId).sort()
      expect(ids).toContain('LOCALSAM_B') // phantom entry (Unknown payer/owe)
      // After Task 1-8 this row would have been written/repaired as 'SAM' and this entry would not exist.
    })
  })

  it('optimizes a three-way imbalance into minimal transfers', async () => {
    const group = makeGroup({ id: 'G', created_by: 'A', currency: 'PHP' })
    await db.groups.add(group)
    await db.profiles.bulkAdd([
      makeProfile({ id: 'A', display_name: 'Alice' }),
      makeProfile({ id: 'B', display_name: 'Bob' }),
      makeProfile({ id: 'C', display_name: 'Cara' }),
    ])
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A' }),
      makeMember({ group_id: 'G', user_id: 'B' }),
      makeMember({ group_id: 'G', user_id: 'C' }),
    ])
    // Alice paid 90, split three ways: B and C each owe 30.
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 30, B: 30, C: 30 } })
    const summary = await computeGroupBalances('G', 'A')
    expect(summary!.suggestions).toHaveLength(2)
    for (const s of summary!.suggestions) {
      expect(s.toUserId).toBe('A')
      expect(s.amount).toBe(30)
    }
    // Both payers bundle under no single payer; grouped by payer => 2 bundles.
    expect(summary!.groupedSuggestions).toHaveLength(2)
  })
})

describe('computeAllGroupBalances', () => {
  it('returns one summary per active membership', async () => {
    await db.profiles.add(makeProfile({ id: 'A' }))
    await db.groups.bulkAdd([
      makeGroup({ id: 'G1', created_by: 'A' }),
      makeGroup({ id: 'G2', created_by: 'A' }),
    ])
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G1', user_id: 'A' }),
      makeMember({ group_id: 'G2', user_id: 'A' }),
    ])
    const summaries = await computeAllGroupBalances('A')
    expect(summaries.map((s) => s.groupId).sort()).toEqual(['G1', 'G2'])
  })

  it('excludes groups where the membership is soft-deleted', async () => {
    await db.profiles.add(makeProfile({ id: 'A' }))
    await db.groups.add(makeGroup({ id: 'G1', created_by: 'A' }))
    await db.group_members.add(
      makeMember({ group_id: 'G1', user_id: 'A', is_deleted: true }),
    )
    expect(await computeAllGroupBalances('A')).toEqual([])
  })
})

describe('listSettlementHistoryForBill', () => {
  it('returns settled, non-deleted settlements attributed to the bill', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'A', display_name: 'Alice' }),
      makeProfile({ id: 'B', display_name: 'Bob' }),
    ])
    await db.bills.add(makeBill({ id: 'BILL', title: 'Dinner', paid_by: 'A' }))
    await db.settlements.add(
      makeSettlement({
        id: 'S1',
        bill_id: 'BILL',
        from_user_id: 'B',
        to_user_id: 'A',
        amount: 25,
        is_settled: true,
      }),
    )

    const history = await listSettlementHistoryForBill('BILL')
    expect(history).toHaveLength(1)
    expect(history[0].fromUserId).toBe('B')
    expect(history[0].toUserId).toBe('A')
    expect(history[0].amount).toBe(25)
  })

  it('excludes unsettled and soft-deleted settlements', async () => {
    await db.bills.add(makeBill({ id: 'BILL', paid_by: 'A' }))
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'S1', bill_id: 'BILL', amount: 10, is_settled: false }),
      makeSettlement({ id: 'S2', bill_id: 'BILL', amount: 10, is_deleted: true }),
    ])
    expect(await listSettlementHistoryForBill('BILL')).toEqual([])
  })

  it('does not include settlements attributed to other bills', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S1', bill_id: 'OTHER', amount: 10 }),
    )
    expect(await listSettlementHistoryForBill('BILL')).toEqual([])
  })

  it('falls back to group_members.display_name when the profile is not visible (privacy boundary)', async () => {
    // Bob's profile row is a local contact owned by another user, so it is NOT
    // synced into this viewer's Dexie (kwenta_build_pull_bundle scoping). Only
    // the group_members row carries his display_name for this viewer.
    await db.profiles.add(makeProfile({ id: 'A', display_name: 'Alice' }))
    const group = makeGroup({ id: 'G', created_by: 'A' })
    await db.groups.add(group)
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
    ])
    await db.bills.add(makeBill({ id: 'BILL', group_id: 'G', title: 'Dinner', paid_by: 'A' }))
    await db.settlements.add(
      makeSettlement({
        id: 'S1',
        group_id: 'G',
        bill_id: 'BILL',
        from_user_id: 'B',
        to_user_id: 'A',
        amount: 25,
        is_settled: true,
      }),
    )

    const history = await listSettlementHistoryForBill('BILL')
    expect(history).toHaveLength(1)
    expect(history[0].fromName).toBe('Bob')
    expect(history[0].toName).toBe('Alice')
    expect(history[0].recipients[0].toName).toBe('Alice')
  })
})
