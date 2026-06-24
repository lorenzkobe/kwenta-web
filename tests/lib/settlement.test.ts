import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import {
  computeAllGroupBalances,
  computeAllGroupPairwiseBalances,
  computeGroupBalances,
  computeGroupPairwiseBalances,
  computeGroupPairwiseNet,
  computeGroupSuggestions,
  computeMemberPaymentBreakdown,
  listSettlementHistoryForBill,
  owedInGroup,
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

    expect(balanceValues(ownerView)).toEqual(balanceValues(otherView))
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

    it('both members compute identical balances when ids are canonical', async () => {
      await seedCanonical()
      const asMe = await computeGroupBalances('G', 'ME')
      const asSam = await computeGroupBalances('G', 'SAM')
      // Same per-member balances regardless of viewer.
      const norm = (s: NonNullable<typeof asMe>) =>
        [...s.balances].sort((a, b) => a.userId.localeCompare(b.userId)).map((b) => [b.userId, b.amount])
      expect(norm(asMe!)).toEqual(norm(asSam!))
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

describe('computeGroupPairwiseBalances', () => {
  async function seedGroup3(creator = 'A') {
    await db.groups.add(makeGroup({ id: 'G', created_by: creator }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
      makeMember({ group_id: 'G', user_id: 'C', display_name: 'Cara' }),
    ])
  }

  it('shows each member the viewer-perspective pairwise net', async () => {
    await seedGroup3()
    // Alice paid 90, split 30/30/30 → Bob owes Alice 30, Cara owes Alice 30.
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 30, B: 30, C: 30 } })

    const summary = await computeGroupPairwiseBalances('G', 'A')
    expect(summary).not.toBeNull()
    const byId = Object.fromEntries(summary!.entries.map((e) => [e.memberUserId, e.net]))
    expect(byId.B).toBe(30)
    expect(byId.C).toBe(30)
    expect(summary!.totalToReceive).toBe(60)
    expect(summary!.totalToPay).toBe(0)
    // The viewer never appears in their own entries.
    expect(summary!.entries.some((e) => e.memberUserId === 'A')).toBe(false)
  })

  it('is symmetric: Bob sees he owes Alice', async () => {
    await seedGroup3()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 30, B: 30, C: 30 } })

    const summary = await computeGroupPairwiseBalances('G', 'B')
    const byId = Object.fromEntries(summary!.entries.map((e) => [e.memberUserId, e.net]))
    expect(byId.A).toBe(-30) // Bob owes Alice
    expect(byId.C).toBe(0) // Bob and Cara never transacted
    expect(summary!.totalToPay).toBe(30)
    expect(summary!.totalToReceive).toBe(0)
  })

  it('applies settled payments to the pairwise net', async () => {
    await seedGroup3()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 30, B: 30, C: 30 } })
    // Bob pays Alice the 30 he owes.
    await db.settlements.add(
      makeSettlement({ group_id: 'G', from_user_id: 'B', to_user_id: 'A', amount: 30 }),
    )
    const summary = await computeGroupPairwiseBalances('G', 'A')
    const byId = Object.fromEntries(summary!.entries.map((e) => [e.memberUserId, e.net]))
    expect(byId.B).toBe(0)
    expect(byId.C).toBe(30)
    expect(summary!.totalToReceive).toBe(30)
  })

  it('resolves names from the roster, never "Unknown", incl. removed members', async () => {
    await seedGroup3()
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 30, B: 30, C: 30 } })
    // Cara is removed (soft-deleted) but still appears in the historical bill.
    const cara = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    await db.group_members.update(cara!.id, { is_deleted: true })

    const summary = await computeGroupPairwiseBalances('G', 'A')
    const cEntry = summary!.entries.find((e) => e.memberUserId === 'C')
    expect(cEntry?.displayName).toBe('Cara')
    expect(summary!.entries.some((e) => e.displayName === 'Unknown')).toBe(false)
  })
})

describe('computeGroupPairwiseNet / owedInGroup', () => {
  async function seed() {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
    ])
    // Alice paid 100, split 50/50 → Bob owes Alice 50.
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, B: 50 } })
  }

  it('returns the viewer-perspective net', async () => {
    await seed()
    expect(await computeGroupPairwiseNet('G', 'A', 'B')).toBe(50) // Bob owes Alice
    expect(await computeGroupPairwiseNet('G', 'B', 'A')).toBe(-50) // Bob owes Alice
  })

  it('owedInGroup is what the payer owes, else 0', async () => {
    await seed()
    expect(await owedInGroup('G', 'B', 'A')).toBe(50) // Bob owes Alice 50
    expect(await owedInGroup('G', 'A', 'B')).toBe(0) // Alice owes Bob nothing
  })
})

describe('computeAllGroupPairwiseBalances', () => {
  it('returns BOTH nonzero totalToReceive and totalToPay when viewer owes one member and is owed by another', async () => {
    // Seed a 3-member group: Alice (viewer), Bob, Cara.
    // Bill 1: Bob paid 60, only Alice is split (Alice=60) → Alice owes Bob 60.
    // Bill 2: Alice paid 30, only Cara is split (Cara=30) → Cara owes Alice 30.
    // Result for ALICE: totalToReceive=30 (from Cara) AND totalToPay=60 (to Bob) — BOTH nonzero.
    // This is exactly the case the single-net model (computeAllGroupBalances) got wrong — it collapses
    // both directions into one net scalar per group and can only show one nonzero total.
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ALICE', display_name: 'Alice' }),
      makeProfile({ id: 'BOB', display_name: 'Bob' }),
      makeProfile({ id: 'CARA', display_name: 'Cara' }),
    ])
    await db.groups.add(makeGroup({ id: 'GG', created_by: 'ALICE' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'GG', user_id: 'ALICE', display_name: 'Alice' }),
      makeMember({ group_id: 'GG', user_id: 'BOB', display_name: 'Bob' }),
      makeMember({ group_id: 'GG', user_id: 'CARA', display_name: 'Cara' }),
    ])
    // Bill 1: Bob paid 60; only Alice is on the split — Alice owes Bob 60.
    await seedSimpleBill({ groupId: 'GG', paidBy: 'BOB', shares: { ALICE: 60 } })
    // Bill 2: Alice paid 30; only Cara is on the split — Cara owes Alice 30.
    await seedSimpleBill({ groupId: 'GG', paidBy: 'ALICE', shares: { CARA: 30 } })

    const summaries = await computeAllGroupPairwiseBalances('ALICE')
    expect(summaries).toHaveLength(1)
    const s = summaries[0]
    expect(s.groupId).toBe('GG')
    // Alice is owed by Cara (30) — totalToReceive must be nonzero.
    expect(s.totalToReceive).toBeGreaterThan(0.005)
    // Alice owes Bob (60) — totalToPay must be nonzero.
    expect(s.totalToPay).toBeGreaterThan(0.005)
    expect(s.totalToReceive).toBeCloseTo(30, 2)
    expect(s.totalToPay).toBeCloseTo(60, 2)
  })

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
    const summaries = await computeAllGroupPairwiseBalances('A')
    expect(summaries.map((s) => s.groupId).sort()).toEqual(['G1', 'G2'])
  })

  it('excludes groups where the membership is soft-deleted', async () => {
    await db.profiles.add(makeProfile({ id: 'A' }))
    await db.groups.add(makeGroup({ id: 'G1', created_by: 'A' }))
    await db.group_members.add(
      makeMember({ group_id: 'G1', user_id: 'A', is_deleted: true }),
    )
    expect(await computeAllGroupPairwiseBalances('A')).toEqual([])
  })
})

describe('computeMemberPaymentBreakdown', () => {
  // Group G with members A, B, C.
  // Bill1: B paid 90, split equally A/B/C (30 each) → A owes B 30, C owes B 30.
  // Bill2: A paid 40, split A/C (20 each)          → C owes A 20.
  async function seedThreeMemberGroup() {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'A', display_name: 'Alice' }),
      makeProfile({ id: 'B', display_name: 'Bob' }),
      makeProfile({ id: 'C', display_name: 'Carol' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
      makeMember({ group_id: 'G', user_id: 'C', display_name: 'Carol' }),
    ])
    await seedSimpleBill({ groupId: 'G', paidBy: 'B', shares: { A: 30, B: 30, C: 30 } })
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 20, C: 20 } })
  }

  it('returns null for a missing group', async () => {
    expect(await computeMemberPaymentBreakdown('nope', 'A')).toBeNull()
  })

  it("splits a member's pairwise nets into who they pay and who pays them", async () => {
    await seedThreeMemberGroup()
    // From Alice's perspective: she owes Bob 30 (pays), Carol owes her 20 (receives).
    const breakdown = await computeMemberPaymentBreakdown('G', 'A')
    expect(breakdown).not.toBeNull()
    expect(breakdown!.memberUserId).toBe('A')
    expect(breakdown!.displayName).toBe('Alice')
    expect(breakdown!.currency).toBe('PHP')
    expect(breakdown!.pays).toEqual([
      { memberUserId: 'B', displayName: 'Bob', amount: 30 },
    ])
    expect(breakdown!.receives).toEqual([
      { memberUserId: 'C', displayName: 'Carol', amount: 20 },
    ])
  })

  it('computes the same numbers from any member perspective', async () => {
    await seedThreeMemberGroup()
    // Carol owes both Bob (30) and Alice (20); receives from nobody.
    const breakdown = await computeMemberPaymentBreakdown('G', 'C')
    expect(breakdown!.pays).toEqual([
      { memberUserId: 'A', displayName: 'Alice', amount: 20 },
      { memberUserId: 'B', displayName: 'Bob', amount: 30 },
    ])
    expect(breakdown!.receives).toEqual([])
  })

  it('excludes settled (net-zero) relationships from both lists', async () => {
    await seedThreeMemberGroup()
    // Alice settles her 30 debt to Bob.
    await db.settlements.add(
      makeSettlement({ group_id: 'G', from_user_id: 'A', to_user_id: 'B', amount: 30 }),
    )
    const breakdown = await computeMemberPaymentBreakdown('G', 'A')
    expect(breakdown!.pays).toEqual([])
    expect(breakdown!.receives).toEqual([
      { memberUserId: 'C', displayName: 'Carol', amount: 20 },
    ])
  })
})

describe('computeGroupSuggestions', () => {
  it('cuts the middleman and backs each transfer with real pairwise legs', async () => {
    // Group: Ana owes Carlo 200 (Carlo paid), Carlo owes John 100 (John paid).
    await db.groups.add(makeGroup({ id: 'G', name: 'Trip', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'Ana', display_name: 'Ana' }),
      makeMember({ group_id: 'G', user_id: 'Carlo', display_name: 'Carlo' }),
      makeMember({ group_id: 'G', user_id: 'John', display_name: 'John' }),
    ])
    await db.bills.bulkAdd([
      makeBill({ id: 'B1', group_id: 'G', paid_by: 'Carlo', currency: 'PHP' }),
      makeBill({ id: 'B2', group_id: 'G', paid_by: 'John', currency: 'PHP' }),
    ])
    await db.bill_items.bulkAdd([
      makeItem({ id: 'I1', bill_id: 'B1' }),
      makeItem({ id: 'I2', bill_id: 'B2' }),
    ])
    await db.item_splits.bulkAdd([
      makeSplit({ id: 'S1', item_id: 'I1', user_id: 'Ana', computed_amount: 200 }),
      makeSplit({ id: 'S2', item_id: 'I2', user_id: 'Carlo', computed_amount: 100 }),
    ])

    const summary = await computeGroupSuggestions('G')
    expect(summary).not.toBeNull()
    expect(summary!.currency).toBe('PHP')
    expect(summary!.payers).toHaveLength(1)
    const ana = summary!.payers[0]
    expect(ana.fromUserId).toBe('Ana')
    expect(ana.fromName).toBe('Ana')
    expect(ana.total).toBe(200)
    expect(ana.recipients.map((r) => `${r.toName}:${r.amount}`).sort()).toEqual([
      'Carlo:100',
      'John:100',
    ])
    expect(ana.legs).toEqual([
      { fromUserId: 'Ana', toUserId: 'Carlo', amount: 200 },
      { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
    ])
  })

  it('returns no payers when the group is settled', async () => {
    await db.groups.add(makeGroup({ id: 'G2', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G2', user_id: 'X', display_name: 'X' }),
      makeMember({ group_id: 'G2', user_id: 'Y', display_name: 'Y' }),
    ])
    const summary = await computeGroupSuggestions('G2')
    expect(summary!.payers).toEqual([])
  })
})
