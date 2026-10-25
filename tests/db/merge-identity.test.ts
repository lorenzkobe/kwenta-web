import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { mergeProfileIdentity } from '@/db/operations'
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
// linkProfileToRemote is cloud-first: it submits the link and every id rewrite it implies in
// one round trip, so the stub has to behave like a server that stores them.
const cloud = vi.hoisted(() => ({ mode: 'ok' as const, calls: 0 }))
vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

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

  // Intentional change (081 work): the merge links the contact and the SERVER rewrites the rows
  // that named it (045, same transaction), so the rewrite and the vanishing duplicate are asserted
  // in SQL (081_base_version_conflicts C17), not against a stubbed server that has no trigger.
  it('links the duplicate to the account', async () => {
    await seedJelloDuplicate()

    expect(await findDuplicateIdentityCandidates('g1', ME)).toHaveLength(1)

    await mergeProfileIdentity('jello-local', 'jello-real', ME)

    expect((await db.profiles.get('jello-local'))?.linked_profile_id).toBe('jello-real')
  })

  it('refuses when the source is not a viewer-owned local contact', async () => {
    await seedJelloDuplicate()
    // jello-real is a real account, not the viewer's local contact -> no-op
    await mergeProfileIdentity('jello-real', ME, ME)
    expect((await db.profiles.get('jello-real'))?.linked_profile_id).toBeNull()
  })
})
