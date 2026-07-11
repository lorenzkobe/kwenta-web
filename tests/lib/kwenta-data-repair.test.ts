import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { planKwentaDataRepair, applyKwentaDataRepair } from '@/lib/kwenta-data-repair'
import { computePairwiseNetAllContexts } from '@/lib/people'
import { makeGroup, makeMember, makeProfile, makeSettlement, resetDb, seedSimpleBill } from '../helpers/db'

// The repair fires a sync round trip; stub it so we assert Dexie state only.
vi.mock('@/sync/cloud-first-mutations', () => ({ finalizeMutationSync: vi.fn(async () => {}) }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyPaymentsRecorded: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([makeProfile({ id: 'me' }), makeProfile({ id: 'other' })])
})

describe('planKwentaDataRepair', () => {
  it('flags a settlement referencing a deleted bill as an orphan', async () => {
    const billId = await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } })
    await db.settlements.add(
      makeSettlement({ id: 'S', bill_id: billId, from_user_id: 'other', to_user_id: 'me', amount: 100 }),
    )
    await db.bills.update(billId, { is_deleted: true })

    const plan = await planKwentaDataRepair('me')
    expect(plan.orphanSettlements.map((o) => o.id)).toContain('S')
    expect(plan.orphanSettlements[0].reason).toBe('missing_bill')
  })

  it('flags exact-duplicate rows and keeps the earliest', async () => {
    const base = {
      from_user_id: 'other',
      to_user_id: 'me',
      amount: 50,
      created_at: '2026-06-01T00:00:00.000Z',
    }
    // Byte-identical rows (same created_at too) — a double-write, safe to collapse.
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'A', ...base }),
      makeSettlement({ id: 'B', ...base }),
    ])
    const plan = await planKwentaDataRepair('me')
    expect(plan.duplicateSettlements).toHaveLength(1)
    expect(plan.duplicateSettlements[0].id).toBe('B') // A sorts first by id
    expect(plan.duplicateSettlements[0].keptId).toBe('A')
  })

  it('flags a party id that points at a linked local contact', async () => {
    await db.profiles.add(
      makeProfile({ id: 'localOther', is_local: true, owner_id: 'me', linked_profile_id: 'other' }),
    )
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'localOther', to_user_id: 'me', amount: 30 }),
    )
    const plan = await planKwentaDataRepair('me')
    const nc = plan.nonCanonicalSettlements.find((n) => n.id === 'S')
    expect(nc?.field).toBe('from_user_id')
    expect(nc?.to).toBe('other') // rewritten to the linked account id
  })

  it('reports nothing to repair on clean data', async () => {
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } })
    await db.settlements.add(
      makeSettlement({ from_user_id: 'other', to_user_id: 'me', amount: 40 }),
    )
    const plan = await planKwentaDataRepair('me')
    expect(plan.summary.total).toBe(0)
  })

  it('never orphans a group settlement whose counterparty is a co-member with no local profile', async () => {
    // Privacy boundary: a co-member's profile is NOT synced into my device, but they ARE on
    // the group roster — the settlement is real and must survive repair (the data-loss bug).
    await db.groups.add(makeGroup({ id: 'G', created_by: 'me' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'me', display_name: 'Me' }),
      makeMember({ group_id: 'G', user_id: 'ghost', display_name: 'Ghost' }), // no profile row
    ])
    await db.settlements.add(
      makeSettlement({ id: 'S', group_id: 'G', from_user_id: 'ghost', to_user_id: 'me', amount: 40 }),
    )
    const plan = await planKwentaDataRepair('me')
    expect(plan.orphanSettlements.map((o) => o.id)).not.toContain('S')
    expect(plan.summary.total).toBe(0)
  })

  it('orphans a settlement whose party resolves to no known person', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'phantom', to_user_id: 'me', amount: 10 }),
    )
    const plan = await planKwentaDataRepair('me')
    expect(plan.orphanSettlements.find((o) => o.id === 'S')?.reason).toBe('missing_profile')
  })

  it('does not merge two same-field payments that differ only by method', async () => {
    const base = { from_user_id: 'other', to_user_id: 'me', amount: 20, created_at: '2026-06-01T00:00:00.000Z' }
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'A', ...base, method: 'cash' }),
      makeSettlement({ id: 'B', ...base, method: 'gcash' }),
    ])
    const plan = await planKwentaDataRepair('me')
    expect(plan.duplicateSettlements).toHaveLength(0)
  })
})

describe('applyKwentaDataRepair', () => {
  it('removes junk, preserves real payments, and corrects the balance', async () => {
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } }) // they owe me 100
    // One genuine payment.
    await db.settlements.add(
      makeSettlement({ id: 'REAL', from_user_id: 'other', to_user_id: 'me', amount: 30 }),
    )
    // A byte-identical duplicate pair (double-write) — one is junk.
    const dupBase = { from_user_id: 'other', to_user_id: 'me', amount: 20, created_at: '2026-06-05T00:00:00.000Z' }
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'DUP_A', ...dupBase }),
      makeSettlement({ id: 'DUP_B', ...dupBase }),
    ])
    // An orphan tagged to a deleted bill.
    const orphanBill = await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 5 } })
    await db.settlements.add(
      makeSettlement({ id: 'ORPH', bill_id: orphanBill, from_user_id: 'other', to_user_id: 'me', amount: 15 }),
    )
    await db.bills.update(orphanBill, { is_deleted: true })

    const plan = await planKwentaDataRepair('me')
    await applyKwentaDataRepair('me', plan)

    // Junk soft-deleted; genuine rows survive.
    expect((await db.settlements.get('DUP_B'))?.is_deleted).toBe(true)
    expect((await db.settlements.get('ORPH'))?.is_deleted).toBe(true)
    expect((await db.settlements.get('REAL'))?.is_deleted).toBe(false)
    expect((await db.settlements.get('DUP_A'))?.is_deleted).toBe(false)

    // Corrected balance = 100 owed − 30 (real) − 20 (single dup) = 50; the junk no longer skews it.
    const net = (await computePairwiseNetAllContexts('me', 'other')).get('PHP') ?? 0
    expect(net).toBeCloseTo(50, 2)
  })

  it('is idempotent — a second run finds nothing to do', async () => {
    await db.profiles.add(
      makeProfile({ id: 'localOther', is_local: true, owner_id: 'me', linked_profile_id: 'other' }),
    )
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'localOther', to_user_id: 'me', amount: 30 }),
    )
    await applyKwentaDataRepair('me', await planKwentaDataRepair('me'))
    const second = await planKwentaDataRepair('me')
    expect(second.summary.total).toBe(0)
  })

  it('writes a repair activity_log row with a UUID entity_id (not a sync-poisoning literal)', async () => {
    await db.profiles.add(
      makeProfile({ id: 'localOther', is_local: true, owner_id: 'me', linked_profile_id: 'other' }),
    )
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'localOther', to_user_id: 'me', amount: 30 }),
    )
    await applyKwentaDataRepair('me', await planKwentaDataRepair('me'))
    const logs = await db.activity_log.toArray()
    expect(logs).toHaveLength(1)
    expect(logs[0].entity_id).not.toBe('data-repair')
    expect(logs[0].entity_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('collapses a local-vs-linked duplicate pair in a single apply (canonicalize then dedup)', async () => {
    // Two settlement rows for ONE real payment: one under the local contact id, one under its
    // linked remote id, identical otherwise. Dedup must run AFTER canonicalization or both
    // survive and double-count.
    await db.profiles.add(
      makeProfile({ id: 'localOther', is_local: true, owner_id: 'me', linked_profile_id: 'other' }),
    )
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } }) // they owe me 100
    const base = { to_user_id: 'me', amount: 30, created_at: '2026-06-01T00:00:00.000Z' }
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'A', from_user_id: 'localOther', ...base }),
      makeSettlement({ id: 'B', from_user_id: 'other', ...base }),
    ])

    await applyKwentaDataRepair('me', await planKwentaDataRepair('me'))

    const live = (await db.settlements.toArray()).filter((s) => !s.is_deleted)
    expect(live).toHaveLength(1)
    expect(live[0].from_user_id).toBe('other') // canonicalized
    // 100 owed − 30 paid = 70 (a surviving double would wrongly give 40).
    const net = (await computePairwiseNetAllContexts('me', 'other')).get('PHP') ?? 0
    expect(net).toBeCloseTo(70, 2)
  })
})
