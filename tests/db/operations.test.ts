import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  addGroupMember,
  createBill,
  createGroup,
  createSettlement,
  deleteBill,
  deleteGroup,
  getBillWithDetails,
  linkProfileToRemote,
  removeGroupMember,
  updateBill,
} from '@/db/operations'
import {
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSettlement,
  makeSplit,
  resetDb,
} from '../helpers/db'

// operations.ts fires sync + notifications as side effects. Stub them so each
// operation is exercised purely against Dexie.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/cloud-first-mutations', () => ({ finalizeMutationSync: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
// people.ts loads supabase; give it a benign client so the missing-profile
// fetch path returns false instead of hitting the network.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

beforeEach(async () => {
  await resetDb()
})

describe('createBill', () => {
  it('writes the bill, items, equal splits, and an activity log entry', async () => {
    await db.profiles.bulkAdd([makeProfile({ id: 'ME' }), makeProfile({ id: 'FR' })])
    const billId = await createBill({
      title: 'Lunch',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: '',
      items: [
        {
          name: 'Pizza',
          amount: 100,
          splits: [
            { userId: 'ME', splitType: 'equal', splitValue: 1 },
            { userId: 'FR', splitType: 'equal', splitValue: 1 },
          ],
        },
      ],
    })

    const bill = await db.bills.get(billId)
    expect(bill?.total_amount).toBe(100)
    expect(bill?.paid_by).toBe('ME') // defaults to createdBy

    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    expect(items).toHaveLength(1)
    const splits = await db.item_splits.where('item_id').equals(items[0].id).toArray()
    expect(splits.map((s) => s.computed_amount).sort()).toEqual([50, 50])

    const log = await db.activity_log.where('entity_id').equals(billId).first()
    expect(log?.action).toBe('created')
  })

  it('honors an explicit paidBy', async () => {
    const billId = await createBill({
      title: 'Dinner',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      paidBy: 'FR',
      note: '',
      items: [],
    })
    expect((await db.bills.get(billId))?.paid_by).toBe('FR')
  })
})

describe('updateBill', () => {
  it('replaces items and updates fields for the creator', async () => {
    const billId = await createBill({
      title: 'Old',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: 'n',
      items: [{ name: 'A', amount: 40, splits: [{ userId: 'ME', splitType: 'equal', splitValue: 1 }] }],
    })

    await updateBill(billId, 'ME', {
      title: 'New',
      note: 'updated',
      currency: 'USD',
      items: [{ name: 'B', amount: 60, splits: [{ userId: 'ME', splitType: 'equal', splitValue: 1 }] }],
    })

    const bill = await db.bills.get(billId)
    expect(bill?.title).toBe('New')
    expect(bill?.currency).toBe('USD')
    expect(bill?.total_amount).toBe(60)

    const activeItems = (await db.bill_items.where('bill_id').equals(billId).toArray()).filter(
      (i) => !i.is_deleted,
    )
    expect(activeItems).toHaveLength(1)
    expect(activeItems[0].name).toBe('B')
  })

  it('ignores edits from a non-creator', async () => {
    const billId = await createBill({
      title: 'Mine',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: '',
      items: [],
    })
    await updateBill(billId, 'INTRUDER', {
      title: 'Hacked',
      note: '',
      currency: 'PHP',
      items: [],
    })
    expect((await db.bills.get(billId))?.title).toBe('Mine')
  })
})

describe('deleteBill', () => {
  it('soft-deletes the bill and its items/splits for the creator', async () => {
    const billId = await createBill({
      title: 'Trash',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: '',
      items: [{ name: 'A', amount: 10, splits: [{ userId: 'ME', splitType: 'equal', splitValue: 1 }] }],
    })
    await deleteBill(billId, 'ME')

    expect((await db.bills.get(billId))?.is_deleted).toBe(true)
    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    expect(items.every((i) => i.is_deleted)).toBe(true)
  })

  it('does nothing for a non-creator', async () => {
    const billId = await createBill({
      title: 'Keep',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: '',
      items: [],
    })
    await deleteBill(billId, 'OTHER')
    expect((await db.bills.get(billId))?.is_deleted).toBe(false)
  })
})

describe('createGroup', () => {
  it('creates the group plus a creator membership row', async () => {
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me' }))
    const groupId = await createGroup('Trip', 'PHP', 'ME')

    const group = await db.groups.get(groupId)
    expect(group?.name).toBe('Trip')
    expect(group?.invite_code).toHaveLength(6)

    const members = await db.group_members.where('group_id').equals(groupId).toArray()
    expect(members).toHaveLength(1)
    expect(members[0].user_id).toBe('ME')
    expect(members[0].display_name).toBe('Me')
  })
})

describe('addGroupMember', () => {
  it('creates a local contact and adds them to the group', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    const groupId = await createGroup('G', 'PHP', 'ME')

    const userId = await addGroupMember(groupId, 'Bob', 'ME')
    const profile = await db.profiles.get(userId)
    expect(profile?.is_local).toBe(true)
    expect(profile?.owner_id).toBe('ME')

    const member = await db.group_members
      .where('[group_id+user_id]')
      .equals([groupId, userId])
      .first()
    expect(member?.display_name).toBe('Bob')
  })

  it('does not duplicate an existing member by name', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    const groupId = await createGroup('G', 'PHP', 'ME')
    const first = await addGroupMember(groupId, 'Bob', 'ME')
    const second = await addGroupMember(groupId, 'bob', 'ME') // case-insensitive
    expect(second).toBe(first)
    const active = (await db.group_members.where('group_id').equals(groupId).toArray()).filter(
      (m) => !m.is_deleted,
    )
    // creator + Bob only
    expect(active).toHaveLength(2)
  })

  it('does not duplicate a co-member whose profile row is not held locally', async () => {
    // Privacy boundary: a real co-member "Jello" exists in group_members (synced
    // display_name) but the viewer has no profile row for them. Adding "Jello" as
    // a local contact must reuse the existing member, not mint a duplicate id.
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'ME', display_name: 'Me' }),
      makeMember({ group_id: 'G', user_id: 'jello-real', display_name: 'Jello' }),
    ])

    const id = await addGroupMember('G', 'jello', 'ME') // case-insensitive

    expect(id).toBe('jello-real')
    const active = (await db.group_members.where('group_id').equals('G').toArray()).filter(
      (m) => !m.is_deleted,
    )
    expect(active).toHaveLength(2) // no new member row
    // and no stray local contact was created
    expect(await db.profiles.where('owner_id').equals('ME').count()).toBe(0)
  })
})

describe('removeGroupMember', () => {
  it('soft-deletes membership and redistributes equal splits', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'A' }),
      makeProfile({ id: 'B' }),
      makeProfile({ id: 'C' }),
    ])
    // Seed a group with three equal members and one 90.00 bill split equally.
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A' }),
      makeMember({ group_id: 'G', user_id: 'B' }),
      makeMember({ group_id: 'G', user_id: 'C' }),
    ])
    await db.bills.add(makeBill({ id: 'BILL', group_id: 'G', paid_by: 'A', total_amount: 90 }))
    await db.bill_items.add(makeItem({ id: 'IT', bill_id: 'BILL', amount: 90 }))
    await db.item_splits.bulkAdd([
      makeSplit({ id: 's1', item_id: 'IT', user_id: 'A', computed_amount: 30 }),
      makeSplit({ id: 's2', item_id: 'IT', user_id: 'B', computed_amount: 30 }),
      makeSplit({ id: 's3', item_id: 'IT', user_id: 'C', computed_amount: 30 }),
    ])

    await removeGroupMember('G', 'C', 'A')

    const member = await db.group_members
      .where('[group_id+user_id]')
      .equals(['G', 'C'])
      .first()
    expect(member?.is_deleted).toBe(true)

    const splits = (await db.item_splits.where('item_id').equals('IT').toArray()).filter(
      (s) => !s.is_deleted,
    )
    expect(splits).toHaveLength(2)
    // 90 split across 2 remaining → 45 each.
    expect(splits.map((s) => s.computed_amount).sort()).toEqual([45, 45])
  })
})

describe('createSettlement', () => {
  it('records a personal settlement', async () => {
    await db.profiles.bulkAdd([makeProfile({ id: 'A' }), makeProfile({ id: 'B' })])
    const id = await createSettlement(null, 'B', 'A', 50, 'PHP', 'A', 'Cash')
    const s = await db.settlements.get(id)
    expect(s?.from_user_id).toBe('B')
    expect(s?.to_user_id).toBe('A')
    expect(s?.amount).toBe(50)
    expect(s?.is_settled).toBe(true)
  })

  it('rejects a settlement attributed to a missing bill', async () => {
    await expect(
      createSettlement(null, 'B', 'A', 50, 'PHP', 'A', '', 'no-such-bill'),
    ).rejects.toThrow('Bill not found')
  })
})

describe('linkProfileToRemote', () => {
  it('rewrites membership, split, paid_by, and settlement ids to the remote profile', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'LOCAL', is_local: true, owner_id: 'ME', linked_profile_id: null }),
      makeProfile({ id: 'REMOTE', is_local: false, email: 'remote@example.com' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'LOCAL' }))
    await db.bills.add(makeBill({ id: 'B', group_id: 'G', paid_by: 'LOCAL' }))
    await db.bill_items.add(makeItem({ id: 'I', bill_id: 'B' }))
    await db.item_splits.add(makeSplit({ id: 'S', item_id: 'I', user_id: 'LOCAL' }))
    await db.settlements.add(
      makeSettlement({ id: 'SET', group_id: 'G', from_user_id: 'LOCAL', to_user_id: 'ME', amount: 10 }),
    )

    await linkProfileToRemote('LOCAL', 'REMOTE', 'ME')

    expect((await db.profiles.get('LOCAL'))?.linked_profile_id).toBe('REMOTE')
    expect((await db.group_members.where('user_id').equals('REMOTE').first())?.user_id).toBe('REMOTE')
    expect((await db.item_splits.get('S'))?.user_id).toBe('REMOTE')
    expect((await db.bills.get('B'))?.paid_by).toBe('REMOTE')
    expect((await db.settlements.get('SET'))?.from_user_id).toBe('REMOTE')
  })

  it('refuses to link a non-owned or non-local profile', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'NOTLOCAL', is_local: false }),
      makeProfile({ id: 'REMOTE', email: 'r@example.com' }),
    ])
    await linkProfileToRemote('NOTLOCAL', 'REMOTE', 'ME')
    expect((await db.profiles.get('NOTLOCAL'))?.linked_profile_id).toBeNull()
  })
})

describe('deleteGroup', () => {
  it('cascades soft-delete to bills, settlements, and members for the creator', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    const groupId = await createGroup('G', 'PHP', 'ME')
    await db.bills.add(makeBill({ id: 'B', group_id: groupId, paid_by: 'ME' }))
    await db.settlements.add(
      makeSettlement({ id: 'SET', group_id: groupId, from_user_id: 'ME', to_user_id: 'X', amount: 5 }),
    )

    await deleteGroup(groupId, 'ME')

    expect((await db.groups.get(groupId))?.is_deleted).toBe(true)
    expect((await db.bills.get('B'))?.is_deleted).toBe(true)
    expect((await db.settlements.get('SET'))?.is_deleted).toBe(true)
    const members = await db.group_members.where('group_id').equals(groupId).toArray()
    expect(members.every((m) => m.is_deleted)).toBe(true)
  })

  it('does nothing for a non-creator', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    const groupId = await createGroup('G', 'PHP', 'ME')
    await deleteGroup(groupId, 'OTHER')
    expect((await db.groups.get(groupId))?.is_deleted).toBe(false)
  })
})

describe('getBillWithDetails', () => {
  it('returns the bill with resolved split, creator, and payor names', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME', display_name: 'Me' }),
      makeProfile({ id: 'FR', display_name: 'Friend' }),
    ])
    const billId = await createBill({
      title: 'Dinner',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      paidBy: 'FR',
      note: '',
      items: [
        {
          name: 'Main',
          amount: 80,
          splits: [
            { userId: 'ME', splitType: 'equal', splitValue: 1 },
            { userId: 'FR', splitType: 'equal', splitValue: 1 },
          ],
        },
      ],
    })

    const details = await getBillWithDetails(billId)
    expect(details?.creatorName).toBe('Me')
    expect(details?.payorName).toBe('Friend')
    expect(details?.items).toHaveLength(1)
    const names = details!.items[0].splits.map((s) => s.displayName).sort()
    expect(names).toEqual(['Friend', 'Me'])
  })

  it('returns null for a missing or deleted bill', async () => {
    expect(await getBillWithDetails('nope')).toBeNull()
  })
})
