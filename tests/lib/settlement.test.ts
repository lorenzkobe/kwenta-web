import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { computeAllGroupBalances, computeGroupBalances } from '@/lib/settlement'
import {
  makeGroup,
  makeMember,
  makeProfile,
  makeSettlement,
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

  it('canonicalizes a linked local contact onto its remote member id', async () => {
    await seedGroupWithTwoMembers()
    // Local contact "Lc" links to remote member B; a split references the local id.
    await db.profiles.add(
      makeProfile({ id: 'Lc', is_local: true, owner_id: 'A', linked_profile_id: 'B' }),
    )
    await seedSimpleBill({ groupId: 'G', paidBy: 'A', shares: { A: 50, Lc: 50 } })
    const summary = await computeGroupBalances('G', 'A')
    const byId = Object.fromEntries(summary!.balances.map((b) => [b.userId, b.amount]))
    // The Lc debit collapses onto B — no separate "Lc" entry, B owes 50.
    expect(byId.Lc).toBeUndefined()
    expect(byId.B).toBe(-50)
    expect(byId.A).toBe(50)
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
