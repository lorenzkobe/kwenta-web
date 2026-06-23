import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { mergeProfileIdentity } from '@/db/operations'
import { computeGroupBalances } from '@/lib/settlement'
import { findDuplicateIdentityCandidates } from '@/lib/duplicate-identity'
import { makeGroup, makeMember, makeProfile, resetDb, seedSimpleBill } from '../helpers/db'

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

const ME = 'ME'

async function seedJelloDuplicate() {
  await db.groups.add(makeGroup({ id: 'g1', created_by: ME }))
  await db.profiles.bulkAdd([
    makeProfile({ id: ME, display_name: 'Me', is_local: false }),
    makeProfile({ id: 'jello-local', display_name: 'Jello', is_local: true, owner_id: ME }),
    makeProfile({ id: 'jello-real', display_name: 'Jello', is_local: false, email: 'jello@x.com' }),
  ])
  await db.group_members.bulkAdd([
    makeMember({ group_id: 'g1', user_id: ME, display_name: 'Me' }),
    makeMember({ group_id: 'g1', user_id: 'jello-local', display_name: 'Jello' }),
    makeMember({ group_id: 'g1', user_id: 'jello-real', display_name: 'Jello' }),
  ])
  // jello-real paid; jello-local owes -> Jello appears on both sides of the optimizer
  await seedSimpleBill({
    groupId: 'g1',
    paidBy: 'jello-real',
    createdBy: ME,
    shares: { 'jello-local': 100, [ME]: 30 },
  })
}

describe('mergeProfileIdentity', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('collapses the duplicate so no self-payment suggestion remains', async () => {
    await seedJelloDuplicate()

    // Before: the duplicate is detected and the optimizer pays "Jello" -> "Jello".
    expect(await findDuplicateIdentityCandidates('g1', ME)).toHaveLength(1)
    const before = await computeGroupBalances('g1', ME)
    const selfPayBefore = before!.groupedSuggestions.some((s) =>
      s.recipients.some((r) => r.toName === s.fromName),
    )
    expect(selfPayBefore).toBe(true)

    await mergeProfileIdentity('jello-local', 'jello-real', ME)

    // After: rows rewritten, contact linked, duplicate gone, no self-payment.
    expect((await db.profiles.get('jello-local'))?.linked_profile_id).toBe('jello-real')
    expect((await db.item_splits.where('user_id').equals('jello-local').count())).toBe(0)
    expect(await findDuplicateIdentityCandidates('g1', ME)).toHaveLength(0)

    const after = await computeGroupBalances('g1', ME)
    const selfPayAfter = after!.groupedSuggestions.some((s) =>
      s.recipients.some((r) => r.toName === s.fromName),
    )
    expect(selfPayAfter).toBe(false)
    // Net is preserved: ME owes 30 to the single Jello.
    expect(after!.suggestions).toEqual([
      expect.objectContaining({ fromUserId: ME, toUserId: 'jello-real', amount: 30 }),
    ])
  })

  it('refuses when the source is not a viewer-owned local contact', async () => {
    await seedJelloDuplicate()
    // jello-real is a real account, not the viewer's local contact -> no-op
    await mergeProfileIdentity('jello-real', ME, ME)
    expect((await db.profiles.get('jello-real'))?.linked_profile_id).toBeNull()
  })
})
