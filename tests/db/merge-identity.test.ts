import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { mergeProfileIdentity } from '@/db/operations'
import { computeGroupPairwiseBalances } from '@/lib/settlement'
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

  it('collapses the duplicate and preserves the net', async () => {
    await seedJelloDuplicate()

    // Before: the duplicate is detected.
    expect(await findDuplicateIdentityCandidates('g1', ME)).toHaveLength(1)

    await mergeProfileIdentity('jello-local', 'jello-real', ME)

    // After: rows rewritten, contact linked, duplicate gone.
    expect((await db.profiles.get('jello-local'))?.linked_profile_id).toBe('jello-real')
    expect((await db.item_splits.where('user_id').equals('jello-local').count())).toBe(0)
    expect(await findDuplicateIdentityCandidates('g1', ME)).toHaveLength(0)

    // Net is preserved: ME owes 30 to the single (merged) Jello.
    const after = await computeGroupPairwiseBalances('g1', ME)
    const jelloEntry = after!.entries.find((e) => e.memberUserId === 'jello-real')
    expect(jelloEntry?.net).toBe(-30) // ME owes 30 to the single Jello
    // No leftover entry under the old local id:
    expect(after!.entries.some((e) => e.memberUserId === 'jello-local')).toBe(false)
  })

  it('refuses when the source is not a viewer-owned local contact', async () => {
    await seedJelloDuplicate()
    // jello-real is a real account, not the viewer's local contact -> no-op
    await mergeProfileIdentity('jello-real', ME, ME)
    expect((await db.profiles.get('jello-real'))?.linked_profile_id).toBeNull()
  })
})
