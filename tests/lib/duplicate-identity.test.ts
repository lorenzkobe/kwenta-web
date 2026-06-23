import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { findDuplicateIdentityCandidates } from '@/lib/duplicate-identity'
import {
  makeGroup,
  makeMember,
  makeProfile,
  resetDb,
  seedSimpleBill,
} from '../helpers/db'

const VIEWER = 'viewer-user'

/**
 * Seed the classic "Jello" duplicate: the viewer owns a local contact ("Jello")
 * AND the real account "Jello" is also in the group. Both participate in a bill,
 * so each id carries a balance. Only the owner can resolve it.
 */
async function seedDuplicate(opts: {
  localName?: string
  realName?: string
  linked?: boolean
} = {}) {
  const group = makeGroup({ id: 'g1', created_by: VIEWER })
  await db.groups.add(group)

  // viewer's own account
  await db.profiles.add(makeProfile({ id: VIEWER, display_name: 'Me', is_local: false }))
  // viewer-owned local contact for Jello (unlinked unless opts.linked)
  await db.profiles.add(
    makeProfile({
      id: 'jello-local',
      display_name: opts.localName ?? 'Jello',
      is_local: true,
      owner_id: VIEWER,
      linked_profile_id: opts.linked ? 'jello-real' : null,
    }),
  )
  // real account Jello (a co-member; their profile may be present via co-member fetch)
  await db.profiles.add(
    makeProfile({ id: 'jello-real', display_name: opts.realName ?? 'Jello', is_local: false }),
  )

  await db.group_members.bulkAdd([
    makeMember({ group_id: 'g1', user_id: VIEWER, display_name: 'Me' }),
    makeMember({ group_id: 'g1', user_id: 'jello-local', display_name: opts.localName ?? 'Jello' }),
    makeMember({ group_id: 'g1', user_id: 'jello-real', display_name: opts.realName ?? 'Jello' }),
  ])

  // jello-real paid a bill; jello-local owes a share -> opposite-sign balances
  await seedSimpleBill({
    groupId: 'g1',
    paidBy: 'jello-real',
    createdBy: VIEWER,
    shares: { 'jello-local': 100, [VIEWER]: 30 },
  })
}

describe('findDuplicateIdentityCandidates', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('flags a viewer-owned local contact that duplicates a real-account member', async () => {
    await seedDuplicate()
    const candidates = await findDuplicateIdentityCandidates('g1', VIEWER)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      groupId: 'g1',
      localId: 'jello-local',
      targetId: 'jello-real',
    })
  })

  it('does not flag a local contact that is already linked', async () => {
    await seedDuplicate({ linked: true })
    const candidates = await findDuplicateIdentityCandidates('g1', VIEWER)
    expect(candidates).toHaveLength(0)
  })

  it('does not flag when display names differ', async () => {
    await seedDuplicate({ localName: 'Jello', realName: 'Jelly' })
    const candidates = await findDuplicateIdentityCandidates('g1', VIEWER)
    expect(candidates).toHaveLength(0)
  })

  it('matches names case-insensitively and trimming whitespace', async () => {
    await seedDuplicate({ localName: '  jello ', realName: 'Jello' })
    const candidates = await findDuplicateIdentityCandidates('g1', VIEWER)
    expect(candidates).toHaveLength(1)
  })

  it('does not flag a local contact owned by another user', async () => {
    await seedDuplicate()
    await db.profiles.update('jello-local', { owner_id: 'someone-else' })
    const candidates = await findDuplicateIdentityCandidates('g1', VIEWER)
    expect(candidates).toHaveLength(0)
  })

  it('does not flag a lone local contact with no real-account counterpart', async () => {
    const group = makeGroup({ id: 'g2', created_by: VIEWER })
    await db.groups.add(group)
    await db.profiles.add(makeProfile({ id: VIEWER, display_name: 'Me', is_local: false }))
    await db.profiles.add(
      makeProfile({ id: 'solo-local', display_name: 'Solo', is_local: true, owner_id: VIEWER }),
    )
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'g2', user_id: VIEWER, display_name: 'Me' }),
      makeMember({ group_id: 'g2', user_id: 'solo-local', display_name: 'Solo' }),
    ])
    await seedSimpleBill({ groupId: 'g2', paidBy: VIEWER, shares: { 'solo-local': 50, [VIEWER]: 50 } })
    const candidates = await findDuplicateIdentityCandidates('g2', VIEWER)
    expect(candidates).toHaveLength(0)
  })
})
