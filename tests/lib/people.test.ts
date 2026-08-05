import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import {
  expandProfileIdsForSplitMatching,
  listCanonicalRelatedProfileIds,
  participantUnionForBill,
} from '@/lib/people'

/**
 * What is left here is identity and contact discovery — the part of this module that stays local
 * because a local contact exists only on the device that created it.
 *
 * The pairwise balances this file used to cover moved into SQL with the code (CLAUDE.md rule 10):
 * personal nets and identity expansion to `052_money_identity_and_personal_net.test.sql`, the
 * per-context breakdown to `053_money_group_net_and_breakdown.test.sql`, the per-bill net to
 * `060_bill_detail.test.sql`. The peer-link merge cases live in `055` and `052`; the canonical-peer
 * rule below is deliberately kept in BOTH places, because the two implementations have to agree.
 */
import { makeGroup, makeMember, makeProfile, resetDb, seedSimpleBill } from '../helpers/db'

const ISO = '2026-06-18T00:00:00.000Z'
function syncFieldsForTest(id: string) {
  return { id, created_at: ISO, updated_at: ISO, synced_at: ISO, is_deleted: false, device_id: 'test-device' }
}

beforeEach(async () => {
  await resetDb()
})

describe('expandProfileIdsForSplitMatching', () => {
  it('returns just the id for a plain profile', async () => {
    await db.profiles.add(makeProfile({ id: 'P' }))
    const ids = await expandProfileIdsForSplitMatching('P')
    expect([...ids].sort()).toEqual(['P'])
  })

  it('includes the linked remote id and siblings linking to the same remote', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'local1', is_local: true, owner_id: 'me', linked_profile_id: 'R' }),
      makeProfile({ id: 'local2', is_local: true, owner_id: 'x', linked_profile_id: 'R' }),
      makeProfile({ id: 'R' }),
    ])
    const ids = await expandProfileIdsForSplitMatching('local1')
    expect(ids.has('local1')).toBe(true)
    expect(ids.has('R')).toBe(true)
    expect(ids.has('local2')).toBe(true)
  })

  it('includes local contacts that link to the queried id', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'R' }),
      makeProfile({ id: 'local', is_local: true, owner_id: 'me', linked_profile_id: 'R' }),
    ])
    const ids = await expandProfileIdsForSplitMatching('R')
    expect(ids.has('R')).toBe(true)
    expect(ids.has('local')).toBe(true)
  })

  it('still returns the id when the profile is missing', async () => {
    const ids = await expandProfileIdsForSplitMatching('ghost')
    expect([...ids]).toEqual(['ghost'])
  })

  /**
   * The duplicate-People bug: the cluster is only reachable by MIXING a peer link with a profile
   * link, and the walk used to follow profile links from the anchor alone. Expansion has to be an
   * equivalence relation — `iterCanonicalPeerIds` keys a person by the minimum of this set, so two
   * ids that disagree become two rows. SQL twin: `067_close_identity_cluster.test.sql`.
   */
  describe('closes over profile links and peer links together', () => {
    const VIEWER = 'me'
    beforeEach(async () => {
      await db.profiles.bulkAdd([
        makeProfile({ id: 'contact', is_local: true, owner_id: VIEWER }),
        makeProfile({ id: 'account' }),
        makeProfile({ id: 'theirs', is_local: true, owner_id: 'other', linked_profile_id: 'account' }),
      ])
      await db.profile_peer_links.add({
        ...syncFieldsForTest('link1'),
        owner_user_id: VIEWER,
        anchor_profile_id: 'contact',
        peer_profile_id: 'account',
      })
    })

    it('reaches the account and its other linked contacts from the merged contact', async () => {
      const ids = await expandProfileIdsForSplitMatching('contact', VIEWER)
      expect([...ids].sort()).toEqual(['account', 'contact', 'theirs'])
    })

    it('gives every member of the cluster the same set', async () => {
      const from = async (id: string) =>
        [...(await expandProfileIdsForSplitMatching(id, VIEWER))].sort()
      const expected = ['account', 'contact', 'theirs']
      expect(await from('contact')).toEqual(expected)
      expect(await from('account')).toEqual(expected)
      expect(await from('theirs')).toEqual(expected)
    })

    it('keeps the merge private to the viewer who made it', async () => {
      expect([...(await expandProfileIdsForSplitMatching('contact', 'someone-else'))]).toEqual([
        'contact',
      ])
      expect([...(await expandProfileIdsForSplitMatching('contact'))]).toEqual(['contact'])
    })

    it('does not resurrect a soft-deleted contact from either end', async () => {
      await db.profiles.add(
        makeProfile({
          id: 'dead',
          is_local: true,
          owner_id: VIEWER,
          linked_profile_id: 'account',
          is_deleted: true,
        }),
      )
      expect((await expandProfileIdsForSplitMatching('account', VIEWER)).has('dead')).toBe(false)
      expect([...(await expandProfileIdsForSplitMatching('dead', VIEWER))]).toEqual(['dead'])
    })

    // Deleting the row does not un-say "these are the same person". The old body returned early on
    // a deleted anchor, which is the asymmetry itself: the contacts still reached the account.
    it('still clusters live contacts when the account row is soft-deleted', async () => {
      await db.profiles.update('account', { is_deleted: true })
      const ids = await expandProfileIdsForSplitMatching('account', VIEWER)
      expect([...ids].sort()).toEqual(['account', 'contact', 'theirs'])
    })
  })
})

describe('participantUnionForBill', () => {
  it('includes the payer plus everyone on a split', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 40, other: 60 },
    })
    const union = await participantUnionForBill(billId)
    expect([...union].sort()).toEqual(['me', 'other'])
  })

  it('excludes soft-deleted splits but keeps the payer', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { me: 40, other: 60 },
    })
    const splits = await db.item_splits.toArray()
    const otherSplit = splits.find((s) => s.user_id === 'other')!
    await db.item_splits.update(otherSplit.id, { is_deleted: true })
    const union = await participantUnionForBill(billId)
    expect(union.has('me')).toBe(true)
    expect(union.has('other')).toBe(false)
  })

  it('omits the payer for a deleted bill but still surfaces split rows (not cascade-deleted)', async () => {
    const billId = await seedSimpleBill({
      groupId: null,
      paidBy: 'me',
      shares: { other: 50 },
      isDeleted: true,
    })
    const union = await participantUnionForBill(billId)
    expect(union.has('me')).toBe(false)
    expect(union.has('other')).toBe(true)
  })
})


describe('listCanonicalRelatedProfileIds — one row per real person', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('collapses a manual merge of two owned contacts into a single peer', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'A1', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'A2', is_local: true, owner_id: 'ME' }),
    ])
    expect((await listCanonicalRelatedProfileIds('ME')).sort()).toEqual(['A1', 'A2'])

    await db.profile_peer_links.add({
      ...syncFieldsForTest('PL'),
      owner_user_id: 'ME',
      anchor_profile_id: 'A1',
      peer_profile_id: 'A2',
    })

    // One person, one row. Previously both survived, and because balance math already honoured
    // the merge, each reported the same amount and the Home rollup added it twice.
    expect(await listCanonicalRelatedProfileIds('ME')).toEqual(['A1'])
  })

  // The other half of the 055 fix — that the Home rollup stops double-counting a merged pair —
  // is asserted server-side now, in `054_money_contacts_and_rollups.test.sql`. The peer collapse
  // above is the client's share of it, and the two must agree.

  it('collapses a transitive merge chain, which one-hop resolution cannot', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'A1', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'A2', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'A3', is_local: true, owner_id: 'ME' }),
    ])
    await db.profile_peer_links.bulkAdd([
      { ...syncFieldsForTest('PL1'), owner_user_id: 'ME', anchor_profile_id: 'A1', peer_profile_id: 'A2' },
      { ...syncFieldsForTest('PL2'), owner_user_id: 'ME', anchor_profile_id: 'A2', peer_profile_id: 'A3' },
    ])

    expect(await listCanonicalRelatedProfileIds('ME')).toEqual(['A1'])
  })

  it('keeps a local contact and the account it links to as one peer', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'BOB' }),
      makeProfile({ id: 'C_BOB', is_local: true, owner_id: 'ME', linked_profile_id: 'BOB' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ id: 'M1', group_id: 'G', user_id: 'ME' }),
      makeMember({ id: 'M2', group_id: 'G', user_id: 'BOB' }),
    ])

    // The viewer's own contact wins, so they keep the name they filed him under.
    expect(await listCanonicalRelatedProfileIds('ME')).toEqual(['C_BOB'])
  })

  /**
   * The production shape behind the duplicate: the viewer's contact is joined to the account by a
   * MANUAL merge, while a third user's contact hangs off that same account by a profile link. The
   * cluster spans both edge kinds, so a walk that closed over only one produced two keys — and the
   * People page showed one human twice, permanently.
   *
   * `A_THEIRS` sorts FIRST on purpose. The key is the minimum of the cluster, so the two keys only
   * diverge when the id that one walk misses is the smallest — which is exactly how it presented
   * in production. Name it so it sorts last and this test passes against the broken code.
   */
  it('collapses a merged contact and its account when a third party also links to it', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'JELLO' }),
      makeProfile({ id: 'C_JELLO', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'A_THEIRS', is_local: true, owner_id: 'OTHER', linked_profile_id: 'JELLO' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ id: 'M1', group_id: 'G', user_id: 'ME' }),
      makeMember({ id: 'M2', group_id: 'G', user_id: 'JELLO' }),
    ])
    await db.profile_peer_links.add({
      ...syncFieldsForTest('PL'),
      owner_user_id: 'ME',
      anchor_profile_id: 'C_JELLO',
      peer_profile_id: 'JELLO',
    })

    expect(await listCanonicalRelatedProfileIds('ME')).toEqual(['C_JELLO'])
  })

  it('keeps genuinely different people separate', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'A1', is_local: true, owner_id: 'ME' }),
      makeProfile({ id: 'B1', is_local: true, owner_id: 'ME' }),
    ])
    expect((await listCanonicalRelatedProfileIds('ME')).sort()).toEqual(['A1', 'B1'])
  })
})
