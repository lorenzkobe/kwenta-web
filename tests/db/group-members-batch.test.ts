import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { addExistingGroupMembers, createGroup } from '@/db/operations'
import { makeGroup, makeMember, makeProfile, resetDb } from '../helpers/db'

/**
 * perf-pass-1, C14-C16. Adding N people to a group used to be N sequential cloud writes (one
 * `addExistingGroupMember` per pick, awaited in a loop), and creating a group with members was a
 * createGroup write followed by that loop. Both are now ONE submission: one RPC, one Postgres
 * transaction, so the group and its roster land together or not at all.
 *
 * The real `submitCloudWrite` runs against the fake server in `tests/helpers/cloud-sync-mock.ts`,
 * exactly as `tests/db/cloud-first-write.test.ts` drives it; `cloud.pushes` records every
 * submission.
 */

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop',
  refuse: new Set<string>(),
  pushes: [] as Record<string, { id: string }[]>[],
}))

vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))

vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyPaymentRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

type MemberRow = { id: string; user_id: string; group_id: string; display_name: string }

function pushedMembers(i = 0): MemberRow[] {
  return (cloud.pushes[i]?.group_members ?? []) as unknown as MemberRow[]
}

async function activeMemberIds(groupId: string): Promise<string[]> {
  const rows = await db.group_members.where('group_id').equals(groupId).toArray()
  return rows.filter((m) => !m.is_deleted).map((m) => m.user_id).sort()
}

beforeEach(async () => {
  await resetDb()
  cloud.mode = 'ok'
  cloud.refuse = new Set()
  cloud.pushes = []
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'ANN', display_name: 'Ann', is_local: true, owner_id: 'ME', email: '' }),
    makeProfile({ id: 'BEN', display_name: 'Ben', is_local: true, owner_id: 'ME', email: '' }),
    makeProfile({ id: 'CHA', display_name: 'Cha' }),
    // A contact linked to an account: its membership user id is the ACCOUNT id.
    makeProfile({ id: 'ACC', display_name: 'Dee' }),
    makeProfile({
      id: 'DEE_LOCAL',
      display_name: 'Dee',
      is_local: true,
      owner_id: 'ME',
      email: '',
      linked_profile_id: 'ACC',
    }),
  ])
})

async function seedGroup() {
  await db.groups.add(makeGroup({ id: 'G', created_by: 'ME', name: 'Trip' }))
  await db.group_members.add(makeMember({ group_id: 'G', user_id: 'ME', display_name: 'Me' }))
}

describe('addExistingGroupMembers', () => {
  it('C14: adding N members submits exactly one write carrying N membership rows', async () => {
    await seedGroup()

    await addExistingGroupMembers('G', ['ANN', 'BEN', 'CHA'], 'ME')

    expect(cloud.pushes).toHaveLength(1)
    expect(pushedMembers().map((m) => m.user_id).sort()).toEqual(['ANN', 'BEN', 'CHA'])
    expect(pushedMembers().every((m) => m.group_id === 'G')).toBe(true)
    expect(await activeMemberIds('G')).toEqual(['ANN', 'BEN', 'CHA', 'ME'])
    const ann = await db.group_members.where('[group_id+user_id]').equals(['G', 'ANN']).first()
    expect(ann?.display_name).toBe('Ann')
  })

  it('C14: a rejected submit leaves Dexie untouched', async () => {
    await seedGroup()
    cloud.mode = 'error'

    await expect(addExistingGroupMembers('G', ['ANN', 'BEN', 'CHA'], 'ME')).rejects.toThrow()

    expect(await activeMemberIds('G')).toEqual(['ME'])
    expect(await db.group_members.count()).toBe(1)
    expect(await db.activity_log.count()).toBe(0)
  })

  it('C14: a partial server-side drop of the membership rows stores none of them', async () => {
    await seedGroup()
    cloud.refuse = new Set(['group_members'])

    await expect(addExistingGroupMembers('G', ['ANN', 'BEN'], 'ME')).rejects.toThrow()

    expect(await activeMemberIds('G')).toEqual(['ME'])
  })

  it('C15: skips an id that is already an active member by its local id', async () => {
    await seedGroup()
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'ANN', display_name: 'Ann' }))

    await addExistingGroupMembers('G', ['ANN', 'BEN'], 'ME')

    expect(cloud.pushes).toHaveLength(1)
    expect(pushedMembers().map((m) => m.user_id)).toEqual(['BEN'])
    expect(await activeMemberIds('G')).toEqual(['ANN', 'BEN', 'ME'])
  })

  it('C15: skips a linked contact whose account is already an active member', async () => {
    await seedGroup()
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'ACC', display_name: 'Dee' }))

    await addExistingGroupMembers('G', ['DEE_LOCAL', 'BEN'], 'ME')

    expect(pushedMembers().map((m) => m.user_id)).toEqual(['BEN'])
    expect(await activeMemberIds('G')).toEqual(['ACC', 'BEN', 'ME'])
  })

  it('C15: two picks resolving to the same account produce ONE membership row, under the account id', async () => {
    await seedGroup()

    await addExistingGroupMembers('G', ['DEE_LOCAL', 'ACC'], 'ME')

    expect(cloud.pushes).toHaveLength(1)
    expect(pushedMembers().map((m) => m.user_id)).toEqual(['ACC'])
    expect(await activeMemberIds('G')).toEqual(['ACC', 'ME'])
  })

  it('C15: the same id picked twice is added once', async () => {
    await seedGroup()

    await addExistingGroupMembers('G', ['ANN', 'ANN'], 'ME')

    expect(pushedMembers().map((m) => m.user_id)).toEqual(['ANN'])
  })

  it('C15: re-adding a member whose membership row was soft-deleted adds them again', async () => {
    await seedGroup()
    await db.group_members.add(
      makeMember({ group_id: 'G', user_id: 'ANN', display_name: 'Ann', is_deleted: true }),
    )

    await addExistingGroupMembers('G', ['ANN'], 'ME')

    expect(cloud.pushes).toHaveLength(1)
    expect(await activeMemberIds('G')).toEqual(['ANN', 'ME'])
  })

  it('C15: an empty list submits nothing', async () => {
    await seedGroup()

    await addExistingGroupMembers('G', [], 'ME')

    expect(cloud.pushes).toHaveLength(0)
  })

  it('C15: a list whose every id is already a member submits nothing', async () => {
    await seedGroup()
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'ACC', display_name: 'Dee' }))

    await addExistingGroupMembers('G', ['ME', 'DEE_LOCAL', 'ACC'], 'ME')

    expect(cloud.pushes).toHaveLength(0)
  })

  it('refuses a caller who is not the group creator, and submits nothing', async () => {
    await seedGroup()

    await expect(addExistingGroupMembers('G', ['ANN'], 'CHA')).rejects.toThrow(/only the group creator/i)
    expect(cloud.pushes).toHaveLength(0)
    expect(await activeMemberIds('G')).toEqual(['ME'])
  })
})

describe('createGroup with members', () => {
  it('C16: the group, the creator and every member go in ONE submit', async () => {
    const groupId = await createGroup('Trip', 'PHP', 'ME', ['ANN', 'CHA', 'DEE_LOCAL'])

    expect(cloud.pushes).toHaveLength(1)
    const push = cloud.pushes[0]
    expect(push.groups.map((g) => g.id)).toEqual([groupId])
    // The linked contact joins under its account id, as a single add would.
    expect(pushedMembers().map((m) => m.user_id).sort()).toEqual(['ACC', 'ANN', 'CHA', 'ME'])

    const group = await db.groups.get(groupId)
    expect(group?.name).toBe('Trip')
    expect(group?.currency).toBe('PHP')
    expect(await activeMemberIds(groupId)).toEqual(['ACC', 'ANN', 'CHA', 'ME'])
  })

  it('C16: the creator listed among the members is not added twice', async () => {
    const groupId = await createGroup('Trip', 'PHP', 'ME', ['ME', 'ANN'])

    expect(pushedMembers().map((m) => m.user_id).sort()).toEqual(['ANN', 'ME'])
    expect(await activeMemberIds(groupId)).toEqual(['ANN', 'ME'])
  })

  it('C16: with no members it is still one submit carrying the creator only', async () => {
    const groupId = await createGroup('Trip', 'PHP', 'ME')

    expect(cloud.pushes).toHaveLength(1)
    expect(pushedMembers().map((m) => m.user_id)).toEqual(['ME'])
    expect(await activeMemberIds(groupId)).toEqual(['ME'])
  })

  it('C16: a rejected submit leaves no group and no members', async () => {
    cloud.mode = 'error'

    await expect(createGroup('Trip', 'PHP', 'ME', ['ANN', 'BEN'])).rejects.toThrow()

    expect(await db.groups.count()).toBe(0)
    expect(await db.group_members.count()).toBe(0)
    expect(await db.activity_log.count()).toBe(0)
  })

  it('C16: a server that stores the group but drops the roster leaves no group either', async () => {
    cloud.refuse = new Set(['group_members'])

    await expect(createGroup('Trip', 'PHP', 'ME', ['ANN'])).rejects.toThrow()

    expect(await db.groups.count()).toBe(0)
    expect(await db.group_members.count()).toBe(0)
  })
})
