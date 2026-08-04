import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  addExistingGroupMember,
  addGroupMember,
  createBill,
  createBundledGroupSettlement,
  createGroup,
  createSettlement,
  deleteBill,
  deleteBundledPayment,
  deleteGroup,
  deletePerson,
  deleteSettlement,
  getBillWithDetails,
  linkProfileToRemote,
  recordDecomposedSettlement,
  recordPersonPayment,
  removeGroupMember,
  resolveGroupMemberUserId,
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
  seedSimpleBill,
} from '../helpers/db'

// The two write-path guards ask the server what is owed (migration 064). Controlling that answer
// here is what makes the guards testable at all — and lets us pin how each one DEGRADES when the
// server cannot answer, which is the behaviour that differs between them.
const serverMoney = vi.hoisted(() => ({
  owed: 0,
  breakdown: { memberUserId: '', displayName: '', currency: 'PHP', pays: [], receives: [] } as {
    memberUserId: string
    displayName: string
    currency: string
    pays: { memberUserId: string; displayName: string; amount: number }[]
    receives: { memberUserId: string; displayName: string; amount: number }[]
  } | null,
  unreachable: false,
}))
vi.mock('@/api/balances', () => ({
  loadOwedInGroup: vi.fn(async () => {
    if (serverMoney.unreachable) throw new Error('offline')
    return serverMoney.owed
  }),
  loadGroupMemberBreakdownFresh: vi.fn(async () => {
    if (serverMoney.unreachable) throw new Error('offline')
    // Mirrors the real loader: `kwenta_group_member_breakdown` RETURNs NULL when the caller is
    // not an active member of the group, and that refusal is an ERROR, not an empty answer.
    // Resolving it let `removeGroupMember` short-circuit its guard to "settled".
    if (serverMoney.breakdown === null) throw new Error('membership declined')
    return serverMoney.breakdown
  }),
}))

// operations.ts fires sync + notifications as side effects. Stub them so each
// operation is exercised purely against Dexie.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
// Operations no longer route through finalizeMutationSync; they submit directly via
// cloud-write. Stub the module so the pending-mutation queue stays out of these tests.
vi.mock('@/sync/cloud-first-mutations', () => ({ enqueuePendingMutation: vi.fn(async () => 'p1') }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
import { notifyPaymentsRecorded } from '@/lib/kwenta-notifications'
// people.ts loads supabase; give it a benign client so the missing-profile
// fetch path returns false instead of hitting the network.
//
// `kwenta_sync` needs real behaviour rather than a null: operations on the cloud-first write
// path (createBill) submit their rows to the server and only mirror what comes back, so a
// stub that returns nothing reads as "the server stored nothing" and the write correctly
// refuses. Echo the push back with migration 044's `applied` map to stand in for acceptance.
// The dedicated contract tests for accept/reject/drop live in tests/db/cloud-first-write.test.ts.
/**
 * Counts write round trips so tests can assert a multi-leg write submits once, not N times.
 * Both RPCs count: which one the client reaches depends on the server generation, and "how many
 * times did this mutation go to the server" is the same question either way.
 */
const cloudCalls = vi.hoisted(() => ({ mode: 'ok' as const, writeRoundTrips: 0, calls: 0 }))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(cloudCalls)
  return {
    supabase: {
      ...base,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'kwenta_sync' || fn === 'kwenta_write') cloudCalls.writeRoundTrips += 1
        return base.rpc(fn, args)
      },
    },
  }
})

beforeEach(async () => {
  await resetDb()
  serverMoney.owed = 0
  serverMoney.breakdown = {
    memberUserId: '',
    displayName: '',
    currency: 'PHP',
    pays: [],
    receives: [],
  }
  serverMoney.unreachable = false
})

/** Every settled payment between two people, newest first — what these operations actually write. */
async function paymentsBetween(fromUserId: string, toUserId: string) {
  const rows = await db.settlements.toArray()
  return rows
    .filter(
      (s) =>
        !s.is_deleted &&
        s.is_settled &&
        s.from_user_id === fromUserId &&
        s.to_user_id === toUserId,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

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

  it('rewrites group split user_ids and paid_by to the roster member id', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'ME' }),
      makeMember({ group_id: 'G', user_id: 'REMOTE' }),
    ])
    // ME tracks the remote member as a linked local contact.
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'REMOTE' }),
      makeProfile({ id: 'LOCAL', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
    ])

    const billId = await createBill({
      title: 'Lunch',
      currency: 'PHP',
      groupId: 'G',
      createdBy: 'ME',
      paidBy: 'LOCAL', // local contact as payer
      note: '',
      items: [
        {
          name: 'Pizza',
          amount: 100,
          splits: [
            { userId: 'ME', splitType: 'equal', splitValue: 1 },
            { userId: 'LOCAL', splitType: 'equal', splitValue: 1 }, // local contact as splittee
          ],
        },
      ],
    })

    const bill = await db.bills.get(billId)
    expect(bill?.paid_by).toBe('REMOTE') // rewritten from LOCAL

    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    const splits = await db.item_splits.where('item_id').equals(items[0].id).toArray()
    expect(splits.map((s) => s.user_id).sort()).toEqual(['ME', 'REMOTE']) // LOCAL -> REMOTE
  })

  it('leaves personal-bill split user_ids untouched (no group)', async () => {
    await db.profiles.bulkAdd([makeProfile({ id: 'ME' }), makeProfile({ id: 'FR' })])
    const billId = await createBill({
      title: 'Solo',
      currency: 'PHP',
      groupId: null,
      createdBy: 'ME',
      note: '',
      items: [
        { name: 'X', amount: 50, splits: [{ userId: 'FR', splitType: 'equal', splitValue: 1 }] },
      ],
    })
    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    const splits = await db.item_splits.where('item_id').equals(items[0].id).toArray()
    expect(splits[0].user_id).toBe('FR')
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

  it('rejects a group bill whose split references a non-roster member', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'ME' }),
      makeMember({ group_id: 'G', user_id: 'FR' }),
    ])
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'FR' }),
      // Local contact owned by ME, never added to the group and not linked: the
      // exact orphan-id case that renders as "Unknown" for other members.
      makeProfile({ id: 'ORPHAN', is_local: true, owner_id: 'ME' }),
    ])

    await expect(
      createBill({
        title: 'B',
        currency: 'PHP',
        groupId: 'G',
        createdBy: 'ME',
        note: '',
        items: [
          {
            name: 'I',
            amount: 100,
            splits: [
              { userId: 'ME', splitType: 'equal', splitValue: 1 },
              { userId: 'ORPHAN', splitType: 'equal', splitValue: 1 },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/member/i)

    // The guard runs before the write transaction: nothing is persisted.
    expect(await db.bills.where('group_id').equals('G').count()).toBe(0)
  })

  it('rejects a group bill whose paid_by is a non-roster member', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'ME' }))
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME' }),
      makeProfile({ id: 'ORPHAN', is_local: true, owner_id: 'ME' }),
    ])

    await expect(
      createBill({
        title: 'B',
        currency: 'PHP',
        groupId: 'G',
        createdBy: 'ME',
        paidBy: 'ORPHAN',
        note: '',
        items: [{ name: 'I', amount: 100, splits: [{ userId: 'ME', splitType: 'equal', splitValue: 1 }] }],
      }),
    ).rejects.toThrow(/member/i)
  })

  describe('updateBill identity', () => {
    it('rewrites group split user_ids and paid_by to roster ids on edit', async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'REMOTE' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME' }),
        makeProfile({ id: 'REMOTE' }),
        makeProfile({ id: 'LOCAL', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
      ])
      const billId = await createBill({
        title: 'B',
        currency: 'PHP',
        groupId: 'G',
        createdBy: 'ME',
        note: '',
        items: [{ name: 'I', amount: 100, splits: [{ userId: 'ME', splitType: 'equal', splitValue: 1 }] }],
      })

      await updateBill(billId, 'ME', {
        title: 'B2',
        note: '',
        currency: 'PHP',
        paidBy: 'LOCAL',
        items: [
          { name: 'I2', amount: 80, splits: [{ userId: 'LOCAL', splitType: 'equal', splitValue: 1 }] },
        ],
      })

      const bill = await db.bills.get(billId)
      expect(bill?.paid_by).toBe('REMOTE')
      const items = (await db.bill_items.where('bill_id').equals(billId).toArray()).filter((i) => !i.is_deleted)
      const splits = (await db.item_splits.where('item_id').equals(items[0].id).toArray()).filter((s) => !s.is_deleted)
      expect(splits[0].user_id).toBe('REMOTE')
    })
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
  async function seed3MemberGroup() {
    await db.profiles.bulkAdd([makeProfile({ id: 'A' }), makeProfile({ id: 'B' }), makeProfile({ id: 'C' })])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
      makeMember({ group_id: 'G', user_id: 'C', display_name: 'Cara' }),
    ])
  }

  it('rejects a non-creator', async () => {
    await seed3MemberGroup()
    await expect(removeGroupMember('G', 'C', 'B')).rejects.toThrow(/only the group creator/i)
  })

  it('blocks removal while the member has an outstanding balance', async () => {
    await seed3MemberGroup()
    serverMoney.breakdown = {
      memberUserId: 'C',
      displayName: 'Cara',
      currency: 'PHP',
      pays: [{ memberUserId: 'A', displayName: 'Alice', amount: 30 }],
      receives: [],
    }
    await expect(removeGroupMember('G', 'C', 'A')).rejects.toThrow(/outstanding balance/i)
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    expect(m?.is_deleted).toBe(false) // not removed
  })

  it('refuses removal when the balance cannot be checked at all', async () => {
    await seed3MemberGroup()
    serverMoney.unreachable = true
    // Deliberately NOT the same call as the payment cap below: stranding an unsettled member's
    // debt is invisible to the user afterwards, so an unchecked removal is worse than a blocked one.
    await expect(removeGroupMember('G', 'C', 'A')).rejects.toThrow(/reconnect/i)
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    expect(m?.is_deleted).toBe(false)
  })

  /**
   * The server returns NULL — not an error — when the caller is not an active member of the
   * group, or cannot see it. That resolved successfully, so `breakdown && (...)` short-circuited
   * to false and the guard was skipped entirely: an admin whose own membership had just been
   * removed on another device could remove a member who still owed, stranding the debt on a
   * roster row nobody can settle.
   */
  it('refuses removal when the server declines to answer, rather than reading it as settled', async () => {
    await seed3MemberGroup()
    serverMoney.breakdown = null
    await expect(removeGroupMember('G', 'C', 'A')).rejects.toThrow(/reconnect/i)
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    expect(m?.is_deleted).toBe(false)
  })

  it('still force-removes without consulting the server (the deletePerson cascade)', async () => {
    await seed3MemberGroup()
    serverMoney.unreachable = true
    await removeGroupMember('G', 'C', 'A', { force: true })
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    expect(m?.is_deleted).toBe(true)
  })

  it('removes a settled member without redistributing splits (history preserved)', async () => {
    await seed3MemberGroup()
    // Cara owes 30 then pays it back → settled.
    await db.bills.add(makeBill({ id: 'BILL', group_id: 'G', paid_by: 'A', total_amount: 90 }))
    await db.bill_items.add(makeItem({ id: 'IT', bill_id: 'BILL', amount: 90 }))
    await db.item_splits.bulkAdd([
      makeSplit({ id: 's-a', item_id: 'IT', user_id: 'A', computed_amount: 30 }),
      makeSplit({ id: 's-b', item_id: 'IT', user_id: 'B', computed_amount: 30 }),
      makeSplit({ id: 's-c', item_id: 'IT', user_id: 'C', computed_amount: 30 }),
    ])
    await db.settlements.add(
      makeSettlement({ group_id: 'G', from_user_id: 'C', to_user_id: 'A', amount: 30 }),
    )

    await removeGroupMember('G', 'C', 'A')

    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'C']).first()
    expect(m?.is_deleted).toBe(true)
    // Cara's split is untouched (no redistribution); other splits unchanged.
    const caraSplit = await db.item_splits.get('s-c')
    expect(caraSplit?.is_deleted).toBe(false)
    expect(caraSplit?.computed_amount).toBe(30)
    const bobSplit = await db.item_splits.get('s-b')
    expect(bobSplit?.computed_amount).toBe(30)
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

  describe('createSettlement identity', () => {
    it('rewrites group settlement parties to roster ids (by email)', async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'REMOTE', display_name: 'Sam' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME' }),
        makeProfile({ id: 'REMOTE', display_name: 'Sam', email: 'sam@x.com' }),
        makeProfile({ id: 'LOCALSAM', is_local: true, owner_id: 'ME', email: 'SAM@x.com', display_name: 'Sam' }),
      ])

      const sid = await createSettlement('G', 'LOCALSAM', 'ME', 40, 'PHP', 'ME')
      const s = await db.settlements.get(sid)
      expect(s?.from_user_id).toBe('REMOTE') // LOCALSAM -> roster REMOTE by normalized email
      expect(s?.to_user_id).toBe('ME')
    })

    it('validates bill participation against the RESOLVED ids, not the raw input ids', async () => {
      // The bill's split references REMOTE; the caller passes the email-matched local contact.
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'REMOTE' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME' }),
        makeProfile({ id: 'REMOTE', email: 'sam@x.com' }),
        makeProfile({ id: 'LOCALSAM', is_local: true, owner_id: 'ME', email: 'sam@x.com' }),
      ])
      await db.bills.add(makeBill({ id: 'B', group_id: 'G', created_by: 'ME', paid_by: 'ME' }))
      await db.bill_items.add(makeItem({ id: 'I', bill_id: 'B', amount: 80 }))
      await db.item_splits.add(makeSplit({ id: 'SP', item_id: 'I', user_id: 'REMOTE', computed_amount: 80 }))

      // Raw 'LOCALSAM' is not on the bill, but its resolved id REMOTE is. Must NOT throw.
      const sid = await createSettlement('G', 'ME', 'LOCALSAM', 40, 'PHP', 'ME', undefined, 'B')
      const s = await db.settlements.get(sid)
      expect(s?.to_user_id).toBe('REMOTE')
    })

    it('createBundledGroupSettlement canonicalizes recipients to roster ids (by email)', async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'REMOTE' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME' }),
        makeProfile({ id: 'REMOTE', email: 'sam@x.com' }),
        makeProfile({ id: 'LOCALSAM', is_local: true, owner_id: 'ME', email: 'sam@x.com' }),
      ])

      const { settlementIds } = await createBundledGroupSettlement({
        groupId: 'G',
        fromUserId: 'ME',
        recipients: [{ toUserId: 'LOCALSAM', amount: 30 }],
        currency: 'PHP',
        markedBy: 'ME',
      })
      const s = await db.settlements.get(settlementIds[0])
      expect(s?.to_user_id).toBe('REMOTE') // not the device-private LOCALSAM
    })

    it('records a payment for a non-viewer payer: from_user_id is the payer, activity actor is markedBy', async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'ALICE' }),
        makeMember({ group_id: 'G', user_id: 'BOB' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME' }),
        makeProfile({ id: 'ALICE' }),
        makeProfile({ id: 'BOB' }),
      ])

      // ME (the recorder) records that ALICE paid BOB — ME is neither payer nor recipient.
      const { bundleId, settlementIds } = await createBundledGroupSettlement({
        groupId: 'G',
        fromUserId: 'ALICE',
        recipients: [{ toUserId: 'BOB', amount: 25 }],
        currency: 'PHP',
        markedBy: 'ME',
      })

      const s = await db.settlements.get(settlementIds[0])
      expect(s?.from_user_id).toBe('ALICE')
      expect(s?.to_user_id).toBe('BOB')
      expect(s?.is_settled).toBe(true)

      const log = await db.activity_log.where('entity_id').equals(bundleId).first()
      expect(log?.user_id).toBe('ME') // recorder, independent of the payer
    })

    it('persists the note as the settlement label and appends it to the activity description', async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'BOB', display_name: 'Bob' }),
      ])
      await db.profiles.bulkAdd([
        makeProfile({ id: 'ME', display_name: 'Me' }),
        makeProfile({ id: 'BOB', display_name: 'Bob' }),
      ])

      const { bundleId, settlementIds } = await createBundledGroupSettlement({
        groupId: 'G',
        fromUserId: 'ME',
        recipients: [{ toUserId: 'BOB', amount: 25 }],
        currency: 'PHP',
        markedBy: 'ME',
        label: 'GCash ref 12345',
      })

      const s = await db.settlements.get(settlementIds[0])
      expect(s?.label).toBe('GCash ref 12345')

      const log = await db.activity_log.where('entity_id').equals(bundleId).first()
      expect(log?.description).toContain('GCash ref 12345')
    })
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

describe('resolveGroupMemberUserId', () => {
  it('returns the id unchanged when it is already a member user_id', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'MEMBER1' }))
    expect(await resolveGroupMemberUserId('G', 'MEMBER1')).toBe('MEMBER1')
  })

  it('maps a linked local contact to the member it links to', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'REMOTE' }))
    await db.profiles.add(
      makeProfile({ id: 'LOCAL', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
    )
    expect(await resolveGroupMemberUserId('G', 'LOCAL')).toBe('REMOTE')
  })

  it('maps via a member whose profile links back to the chosen id', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'LOCALMEMBER' }))
    await db.profiles.add(
      makeProfile({ id: 'LOCALMEMBER', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
    )
    expect(await resolveGroupMemberUserId('G', 'REMOTE')).toBe('LOCALMEMBER')
  })

  it('matches by email when no link exists', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'MEMBER' }))
    await db.profiles.add(makeProfile({ id: 'MEMBER', email: 'sam@x.com' }))
    await db.profiles.add(
      makeProfile({ id: 'OTHERLOCAL', is_local: true, owner_id: 'ME', email: 'SAM@x.com' }),
    )
    expect(await resolveGroupMemberUserId('G', 'OTHERLOCAL')).toBe('MEMBER')
  })

  it('does NOT match by display_name alone (two distinct people can share a name)', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'MEMBER', display_name: 'Sam' }))
    await db.profiles.add(makeProfile({ id: 'MEMBER', email: '', display_name: 'Sam' }))
    await db.profiles.add(
      makeProfile({ id: 'LOCALSAM', is_local: true, owner_id: 'ME', email: '', display_name: ' sam ' }),
    )
    // Name matching is deliberately not on the live write path: it would mis-attribute money to a
    // same-named member. Only exact identity (id/link/email) canonicalizes; otherwise unchanged.
    expect(await resolveGroupMemberUserId('G', 'LOCALSAM')).toBe('LOCALSAM')
  })

  it('returns the id unchanged when the group has no matching member', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: 'MEMBER', display_name: 'Sam' }))
    await db.profiles.add(makeProfile({ id: 'MEMBER', email: '', display_name: 'Sam' }))
    expect(await resolveGroupMemberUserId('G', 'UNRELATED')).toBe('UNRELATED')
  })
})

describe('deletePerson atomic cascade', () => {
  it('fires exactly one sync for a person spanning a group, a personal bill, and a settlement', async () => {
    // The cascade is now submitted directly, so "exactly one sync" is counted as kwenta_sync
    // round trips: every affected row lands in a single transaction, not one call per entity.
    const before = cloudCalls.writeRoundTrips
    await db.profiles.bulkAdd([makeProfile({ id: 'ME' }), makeProfile({ id: 'P', is_local: true, owner_id: 'ME' })])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'ME' }),
      makeMember({ group_id: 'G', user_id: 'P' }),
    ])
    await db.bills.add(makeBill({ id: 'GB', group_id: 'G', created_by: 'ME', paid_by: 'ME', total_amount: 50 }))
    await db.bill_items.add(makeItem({ id: 'GI', bill_id: 'GB', amount: 50 }))
    await db.item_splits.add(makeSplit({ id: 'GS', item_id: 'GI', user_id: 'P', computed_amount: 50 }))
    await db.settlements.add(makeSettlement({ id: 'ST', group_id: 'G', from_user_id: 'P', to_user_id: 'ME', amount: 10 }))

    await deletePerson('P', 'ME')

    expect(cloudCalls.writeRoundTrips - before).toBe(1)
    expect((await db.profiles.get('P'))?.is_deleted).toBe(true)
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'P']).first()
    expect(m?.is_deleted).toBe(true)
    expect((await db.settlements.get('ST'))?.is_deleted).toBe(true)
  })
})

describe('member management permissions', () => {
  async function seedGroupOwnedBy(creator: string) {
    await db.profiles.bulkAdd([
      makeProfile({ id: creator }),
      makeProfile({ id: 'OUTSIDER' }),
      makeProfile({ id: 'NEW' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: creator }))
    await db.group_members.add(makeMember({ group_id: 'G', user_id: creator }))
  }

  it('addExistingGroupMember rejects a non-creator', async () => {
    await seedGroupOwnedBy('OWNER')
    await expect(addExistingGroupMember('G', 'NEW', 'OUTSIDER')).rejects.toThrow(
      /only the group creator/i,
    )
  })

  it('addExistingGroupMember allows the creator', async () => {
    await seedGroupOwnedBy('OWNER')
    await addExistingGroupMember('G', 'NEW', 'OWNER')
    const m = await db.group_members.where('[group_id+user_id]').equals(['G', 'NEW']).first()
    expect(m?.is_deleted).toBe(false)
  })
})

describe('payment caps', () => {
  async function seedDebt() {
    await db.profiles.bulkAdd([makeProfile({ id: 'A' }), makeProfile({ id: 'B' })])
    await db.groups.add(makeGroup({ id: 'G', created_by: 'A' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
    ])
    // Alice paid 100, split 50/50 → Bob owes Alice 50.
    await db.bills.add(makeBill({ id: 'BILL', group_id: 'G', paid_by: 'A', total_amount: 100 }))
    await db.bill_items.add(makeItem({ id: 'IT', bill_id: 'BILL', amount: 100 }))
    await db.item_splits.bulkAdd([
      makeSplit({ item_id: 'IT', user_id: 'A', computed_amount: 50 }),
      makeSplit({ item_id: 'IT', user_id: 'B', computed_amount: 50 }),
    ])
  }

  it('createSettlement with enforceCap rejects overpaying', async () => {
    await seedDebt()
    serverMoney.owed = 50
    await expect(
      createSettlement('G', 'B', 'A', 80, 'PHP', 'B', undefined, null, { enforceCap: true }),
    ).rejects.toThrow(/can only pay up to/i)
  })

  it('createSettlement with enforceCap allows paying up to what is owed', async () => {
    await seedDebt()
    serverMoney.owed = 50
    const id = await createSettlement('G', 'B', 'A', 50, 'PHP', 'B', undefined, null, {
      enforceCap: true,
    })
    expect(await db.settlements.get(id)).toBeTruthy()
  })

  it('skips the cap when the server cannot answer, rather than blocking the payment', async () => {
    await seedDebt()
    serverMoney.unreachable = true
    // The cap is an affordance, not an invariant: overpaying is legal and flips the sign, so
    // refusing offline would deny a payment the user is entitled to make.
    const id = await createSettlement('G', 'B', 'A', 80, 'PHP', 'B', undefined, null, {
      enforceCap: true,
    })
    expect(await db.settlements.get(id)).toBeTruthy()
  })

  it('createBundledGroupSettlement with enforceCap rejects an over-cap recipient', async () => {
    await seedDebt()
    serverMoney.breakdown = {
      memberUserId: 'B',
      displayName: 'Bob',
      currency: 'PHP',
      pays: [{ memberUserId: 'A', displayName: 'Alice', amount: 50 }],
      receives: [],
    }
    await expect(
      createBundledGroupSettlement({
        groupId: 'G',
        fromUserId: 'B',
        recipients: [{ toUserId: 'A', amount: 80 }],
        currency: 'PHP',
        markedBy: 'B',
        enforceCap: true,
      }),
    ).rejects.toThrow(/can only pay up to/i)
  })

  it('caps a recipient the payer owes nothing at zero', async () => {
    await seedDebt()
    serverMoney.breakdown = {
      memberUserId: 'B',
      displayName: 'Bob',
      currency: 'PHP',
      pays: [],
      receives: [],
    }
    await expect(
      createBundledGroupSettlement({
        groupId: 'G',
        fromUserId: 'B',
        recipients: [{ toUserId: 'A', amount: 10 }],
        currency: 'PHP',
        markedBy: 'B',
        enforceCap: true,
      }),
    ).rejects.toThrow(/can only pay up to 0/i)
  })

  /**
   * The two sides of the cap comparison come from different id spaces. `pays` is keyed by the ids
   * the SERVER's roster holds, while the recipient id has been through `resolveGroupMemberUserId`,
   * which deliberately maps an account id BACK to a local contact id when this device's roster row
   * holds the local one. Matching literally made a recipient look like someone owed 0, so the cap
   * rejected a settle-up the same screen had just offered.
   */
  it('matches the server’s roster id through the identity set, not literally', async () => {
    await db.groups.add(makeGroup({ id: 'G2', name: 'Trip', currency: 'PHP', created_by: 'B' }))
    // This device tracks Alice as its own local contact, linked to her account id 'A-remote'.
    await db.profiles.bulkAdd([
      makeProfile({ id: 'B', display_name: 'Bob' }),
      makeProfile({
        id: 'A-local',
        display_name: 'Alice',
        is_local: true,
        owner_id: 'B',
        email: '',
        linked_profile_id: 'A-remote',
      }),
      makeProfile({ id: 'A-remote', display_name: 'Alice' }),
    ])
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G2', user_id: 'B', display_name: 'Bob' }),
      makeMember({ group_id: 'G2', user_id: 'A-local', display_name: 'Alice' }),
    ])
    // The server answers with the id ITS roster holds — the account id.
    serverMoney.breakdown = {
      memberUserId: 'B',
      displayName: 'Bob',
      currency: 'PHP',
      pays: [{ memberUserId: 'A-remote', displayName: 'Alice', amount: 50 }],
      receives: [],
    }

    // Within the cap: allowed, even though the resolved recipient id is the LOCAL one.
    const { settlementIds } = await createBundledGroupSettlement({
      groupId: 'G2',
      fromUserId: 'B',
      recipients: [{ toUserId: 'A-local', amount: 50 }],
      currency: 'PHP',
      markedBy: 'B',
      enforceCap: true,
    })
    expect(settlementIds).toHaveLength(1)

    // And the cap is still a cap: over it, the payment is refused for the right reason.
    await expect(
      createBundledGroupSettlement({
        groupId: 'G2',
        fromUserId: 'B',
        recipients: [{ toUserId: 'A-local', amount: 80 }],
        currency: 'PHP',
        markedBy: 'B',
        enforceCap: true,
      }),
    ).rejects.toThrow(/can only pay up to 50/i)
  })
})

describe('recordDecomposedSettlement', () => {
  async function seedChain() {
    // Ana owes Carlo 200 (Carlo paid); Carlo owes John 100 (John paid).
    await db.groups.add(makeGroup({ id: 'G', name: 'Trip', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'Ana', display_name: 'Ana' }),
      makeMember({ group_id: 'G', user_id: 'Carlo', display_name: 'Carlo' }),
      makeMember({ group_id: 'G', user_id: 'John', display_name: 'John' }),
    ])
    await db.profiles.bulkAdd([
      makeProfile({ id: 'Ana', display_name: 'Ana' }),
      makeProfile({ id: 'Carlo', display_name: 'Carlo' }),
      makeProfile({ id: 'John', display_name: 'John' }),
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
  }

  it('writes one bundle with a row per leg, allowing heterogeneous payers', async () => {
    await seedChain()
    const { bundleId, settlementIds } = await recordDecomposedSettlement({
      groupId: 'G',
      currency: 'PHP',
      markedBy: 'Ana',
      legs: [
        { fromUserId: 'Ana', toUserId: 'Carlo', amount: 200 },
        { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
      ],
    })
    expect(settlementIds).toHaveLength(2)
    const rows = await db.settlements.where('bundle_id').equals(bundleId).toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.is_settled && r.group_id === 'G')).toBe(true)
    const byFrom = new Map(rows.map((r) => [r.from_user_id, r]))
    expect(byFrom.get('Ana')?.to_user_id).toBe('Carlo')
    expect(byFrom.get('Ana')?.amount).toBe(200)
    expect(byFrom.get('Carlo')?.to_user_id).toBe('John')
    expect(byFrom.get('Carlo')?.amount).toBe(100)
  })

  it('settles every screen to zero after recording all suggested legs', async () => {
    await seedChain()
    await recordDecomposedSettlement({
      groupId: 'G',
      currency: 'PHP',
      markedBy: 'Ana',
      legs: [
        { fromUserId: 'Ana', toUserId: 'Carlo', amount: 200 },
        { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
      ],
    })
    // What this operation owes the caller is the ROWS: one settled leg per suggested transfer,
    // in the group, for the exact amounts. That those rows then zero every screen is arithmetic
    // over the whole ledger, which is asserted server-side (061_group_detail.test.sql).
    expect((await paymentsBetween('Ana', 'Carlo')).map((r) => r.amount)).toEqual([200])
    expect((await paymentsBetween('Carlo', 'John')).map((r) => r.amount)).toEqual([100])
    const all = (await db.settlements.toArray()).filter((r) => !r.is_deleted && r.is_settled)
    expect(all).toHaveLength(2)
    expect(all.every((r) => r.group_id === 'G' && r.currency === 'PHP')).toBe(true)
  })

  it('drops sub-cent legs and throws when nothing is left', async () => {
    await seedChain()
    await expect(
      recordDecomposedSettlement({
        groupId: 'G',
        currency: 'PHP',
        markedBy: 'Ana',
        legs: [{ fromUserId: 'Ana', toUserId: 'Carlo', amount: 0.004 }],
      }),
    ).rejects.toThrow()
  })
})

describe('recordPersonPayment', () => {
  beforeEach(async () => {
    await db.profiles.bulkAdd([makeProfile({ id: 'me' }), makeProfile({ id: 'other' })])
  })

  it('a personal payment reduces the personal tab and syncs exactly once', async () => {
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } }) // they owe me 100
    // A payment is now submitted straight to the server, so "syncs exactly once" is counted
    // as kwenta_sync round trips rather than calls to the old local-then-sync entry point.
    const before = cloudCalls.writeRoundTrips
    const { settlementIds, bundleId } = await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 100,
      allocations: [{ context: 'personal', amount: 100 }],
      currency: 'PHP',
      markedBy: 'me',
    })
    expect(settlementIds).toHaveLength(1)
    expect(bundleId).toBeNull()
    const legs = await paymentsBetween('other', 'me')
    expect(legs.map((l) => [l.amount, l.group_id])).toEqual([[100, null]])
    expect(cloudCalls.writeRoundTrips - before).toBe(1)
  })

  it('a group-tagged payment reduces that group pairwise net', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'me', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'me' }),
      makeMember({ group_id: 'G', user_id: 'other' }),
    ])
    await seedSimpleBill({ groupId: 'G', paidBy: 'me', shares: { other: 100 } }) // owe me 100 in group
    await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 100,
      allocations: [{ context: { groupId: 'G' }, amount: 100 }],
      currency: 'PHP',
      markedBy: 'me',
    })
    // Tagged to the group, so it reduces the group leg rather than the personal one.
    const legs = await paymentsBetween('other', 'me')
    expect(legs.map((l) => [l.amount, l.group_id])).toEqual([[100, 'G']])
  })

  it('attributes the notification to the group when every leg is that one group', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: 'me', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'me' }),
      makeMember({ group_id: 'G', user_id: 'other' }),
    ])
    await seedSimpleBill({ groupId: 'G', paidBy: 'me', shares: { other: 100 } })
    vi.mocked(notifyPaymentsRecorded).mockClear()
    await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 100,
      allocations: [{ context: { groupId: 'G' }, amount: 100 }],
      currency: 'PHP',
      markedBy: 'other', // recipient is 'me'; a real notification is emitted
    })
    expect(vi.mocked(notifyPaymentsRecorded)).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'G' }),
    )
  })

  it('leaves the notification un-grouped for a personal payment', async () => {
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } })
    vi.mocked(notifyPaymentsRecorded).mockClear()
    await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 100,
      allocations: [{ context: 'personal', amount: 100 }],
      currency: 'PHP',
      markedBy: 'other',
    })
    expect(vi.mocked(notifyPaymentsRecorded)).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: null }),
    )
  })

  it('splits across personal + group into one bundle, reducing both contexts', async () => {
    await db.groups.add(makeGroup({ id: 'G2', created_by: 'me', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G2', user_id: 'me' }),
      makeMember({ group_id: 'G2', user_id: 'other' }),
    ])
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 60 } }) // personal: owe me 60
    await seedSimpleBill({ groupId: 'G2', paidBy: 'me', shares: { other: 40 } }) // group: owe me 40
    const { settlementIds, bundleId } = await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 100,
      allocations: [
        { context: 'personal', amount: 60 },
        { context: { groupId: 'G2' }, amount: 40 },
      ],
      currency: 'PHP',
      markedBy: 'me',
    })
    expect(settlementIds).toHaveLength(2)
    expect(bundleId).not.toBeNull()
    const legs = await db.settlements.where('bundle_id').equals(bundleId as string).toArray()
    expect(legs).toHaveLength(2)
    // The total is PARTITIONED across contexts, never duplicated into each — that is the whole
    // reason a bundle exists.
    expect(legs.reduce((sum, l) => sum + l.amount, 0)).toBe(100)
    expect(legs.map((l) => [l.group_id, l.amount]).sort()).toEqual([
      [null, 60],
      ['G2', 40],
    ])
  })

  it('an overpayment flips the tab — no credit banked', async () => {
    await seedSimpleBill({ groupId: null, paidBy: 'me', shares: { other: 100 } }) // they owe me 100
    await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 150,
      allocations: [{ context: 'personal', amount: 150 }],
      currency: 'PHP',
      markedBy: 'me',
    })
    // Nothing is clamped and no credit row is invented: the full 150 is recorded, and the sign
    // flip is the ledger's business (052_money_identity_and_personal_net.test.sql pins it).
    const legs = await paymentsBetween('other', 'me')
    expect(legs.map((l) => l.amount)).toEqual([150])
  })

  it('stores the method and note on the payment for the audit', async () => {
    const { settlementIds } = await recordPersonPayment({
      meId: 'me',
      otherId: 'other',
      direction: 'they_paid_me',
      totalAmount: 50,
      allocations: [{ context: 'personal', amount: 50 }],
      currency: 'PHP',
      markedBy: 'me',
      method: 'GCash',
      note: 'lunch',
    })
    const row = await db.settlements.get(settlementIds[0])
    expect(row?.method).toBe('GCash')
    expect(row?.label).toBe('lunch')
  })
})

/**
 * Both delete paths resolve rows from the Dexie MIRROR while the ids come from a server-fetched
 * settlement-history list, and the two can legitimately disagree — a payment another member
 * recorded is listed as soon as the endpoint answers, before realtime or the next sync has
 * mirrored the row.
 */
describe('settlement deletes against an incomplete mirror', () => {
  it('refuses rather than silently succeeding when the row is not mirrored yet', async () => {
    // The dialog treated a resolved promise as success: it called onSaved()/onClose() with no
    // toast, the payment was still listed after the refetch, and the user pressed Remove again.
    await expect(deleteSettlement('not-mirrored-yet', 'me')).rejects.toThrow(/finished syncing/i)
  })

  it('is idempotent for a row already soft-deleted', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S1', from_user_id: 'a', to_user_id: 'b', amount: 10, is_deleted: true }),
    )
    await expect(deleteSettlement('S1', 'me')).resolves.toBeUndefined()
  })

  /**
   * The worse half: `where('bundle_id')` returns the legs this device happens to hold, so a
   * bundle whose legs had not all arrived was deleted PARTIALLY — the survivors keep moving the
   * balance and the payment can never be reassembled.
   */
  it('refuses a bundle whose legs are not all mirrored, instead of deleting the ones it has', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S1', bundle_id: 'BU1', from_user_id: 'a', to_user_id: 'b', amount: 30 }),
    )

    await expect(deleteBundledPayment('BU1', 'me', ['S1', 'S2'])).rejects.toThrow(/finished syncing/i)

    const survivor = await db.settlements.get('S1')
    expect(survivor?.is_deleted).toBe(false)
  })

  it('deletes every leg when the mirror holds the whole bundle', async () => {
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'S1', bundle_id: 'BU1', from_user_id: 'a', to_user_id: 'b', amount: 30 }),
      makeSettlement({ id: 'S2', bundle_id: 'BU1', from_user_id: 'b', to_user_id: 'c', amount: 30 }),
    ])

    await deleteBundledPayment('BU1', 'me', ['S1', 'S2'])

    const rows = await db.settlements.where('bundle_id').equals('BU1').toArray()
    expect(rows.every((r) => r.is_deleted)).toBe(true)
  })
})
