import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  addExistingGroupMembers,
  createBill,
  deleteGroup,
  deletePerson,
  removeGroupMember,
  updateGroup,
} from '@/db/operations'
import { GroupUnavailableError, refreshGroupIntoMirror } from '@/sync/group-mirror'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import type { Group, GroupMember } from '@/types'
import { makeGroup, makeMember, makeProfile, resetDb } from '../helpers/db'

/**
 * The Add bill dialog lists the group's members from the SERVER (`kwenta_group_detail`), while the
 * write path judged membership from this device's mirror. A roster the mirror had not caught up on
 * made `createBill` refuse a real member with "non-member participant(s)" — the user's own id
 * included, when it was their own membership row that had not arrived.
 */

type GroupBundle = { group: Group; group_members: GroupMember[] }

const server = vi.hoisted(() => ({
  groups: new Map<string, unknown>(),
  fetchCalls: [] as string[],
  fetchError: null as { message: string } | null,
  /** Runs while the fetch is in flight (e.g. a wipe landing mid-request). */
  onFetch: null as null | (() => void),
  deleteCalls: [] as Record<string, unknown>[],
  deleteEcho: null as Record<string, unknown[]> | null,
  deleteError: null as { message: string; code: string } | null,
  cloud: { mode: 'ok' as const, calls: 0, pushes: [] as Record<string, { id: string }[]>[] },
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(server.cloud)
  return {
    supabase: {
      ...base,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'kwenta_fetch_group_bundle') {
          const id = String(args?.p_group_id)
          server.fetchCalls.push(id)
          server.onFetch?.()
          if (server.fetchError) return { data: null, error: server.fetchError }
          return { data: server.groups.get(id) ?? null, error: null }
        }
        // 082: deleteGroup is one server call whose answer is the cascade it applied.
        if (fn === 'kwenta_delete_group') {
          server.deleteCalls.push(args ?? {})
          if (server.deleteError) return { data: null, error: { ...server.deleteError, details: '', hint: '' }, status: 400 }
          return { data: server.deleteEcho, error: null }
        }
        return base.rpc(fn, args)
      },
    },
  }
})
vi.mock('@/api/balances', () => ({
  loadOwedInGroup: vi.fn(async () => 0),
  loadGroupMemberBreakdownFresh: vi.fn(async (_g: string, memberUserId: string) => ({
    memberUserId,
    displayName: memberUserId,
    currency: 'PHP',
    pays: [],
    receives: [],
  })),
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

const OWNER = 'OWNER'
const ME = 'ME'
const ANN = 'ANN'

function serverGroup(memberIds: string[]): GroupBundle {
  const group = makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' })
  return {
    group,
    group_members: memberIds.map((id) =>
      makeMember({ id: `gm-${id}`, group_id: 'G', user_id: id, display_name: id }),
    ),
  }
}

function groupBill(splitIds: string[], paidBy = ME) {
  return {
    title: 'Dinner',
    currency: 'PHP',
    groupId: 'G',
    createdBy: ME,
    paidBy,
    note: '',
    items: [
      {
        name: 'Food',
        amount: 300,
        splits: splitIds.map((userId) => ({ userId, splitType: 'equal' as const, splitValue: 1 })),
      },
    ],
  }
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

/** The group row and the roster minus `missing`, as a mirror that has not caught up would hold. */
async function mirrorWithout(bundle: GroupBundle, missing: string[]) {
  await db.groups.add(bundle.group)
  await db.group_members.bulkAdd(bundle.group_members.filter((m) => !missing.includes(m.user_id)))
}

async function activeMirrorMemberIds(): Promise<string[]> {
  const rows = await db.group_members.where('group_id').equals('G').toArray()
  return rows.filter((m) => !m.is_deleted).map((m) => m.user_id).sort()
}

function pushed<T>(table: string): T[] {
  return (server.cloud.pushes[0]?.[table] ?? []) as unknown as T[]
}

function pushedSplitUserIds(): string[] {
  const splits = (server.cloud.pushes[0]?.item_splits ?? []) as unknown as { user_id: string }[]
  return splits.map((s) => s.user_id).sort()
}

beforeEach(async () => {
  await resetDb()
  server.groups.clear()
  server.fetchCalls = []
  server.fetchError = null
  server.onFetch = null
  server.deleteCalls = []
  server.deleteEcho = null
  server.deleteError = null
  setOnline(true)
  server.cloud.mode = 'ok'
  server.cloud.calls = 0
  server.cloud.pushes = []
  await db.profiles.bulkAdd([
    makeProfile({ id: ME, display_name: 'Me' }),
    makeProfile({ id: OWNER, display_name: 'Owner' }),
    makeProfile({ id: ANN, display_name: 'Ann' }),
  ])
})

describe('createBill against a roster this device has not caught up on', () => {
  it('C1: a member the server has but the mirror lacks is not refused', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [ANN])

    await createBill(groupBill([ME, ANN]))

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushedSplitUserIds()).toEqual([ANN, ME])
    expect(await activeMirrorMemberIds()).toEqual([ANN, ME, OWNER])
  })

  it("C2: the caller's own membership row missing from the mirror does not refuse the caller", async () => {
    const bundle = serverGroup([OWNER, ME])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [ME])

    await createBill(groupBill([ME, OWNER]))

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<{ paid_by: string }>('bills')[0].paid_by).toBe(ME)
  })

  it('C2: a group whose roster never reached the mirror at all is loaded, not treated as empty', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)

    await createBill(groupBill([ME, ANN]))

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushedSplitUserIds()).toEqual([ANN, ME])
  })

  it('C3: someone the server roster does not have either is still refused, and nothing is sent', async () => {
    const bundle = serverGroup([OWNER, ME])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [])

    await expect(createBill(groupBill([ME, ANN]))).rejects.toThrow(/non-member participant/)

    expect(server.cloud.pushes).toHaveLength(0)
    expect(server.fetchCalls).toEqual(['G'])
    expect(await db.bills.count()).toBe(0)
  })

  it('C3: a member the server has since removed is refused once the roster is refreshed', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    const removed = { ...bundle.group_members[2], is_deleted: true, updated_at: '2030-01-01T00:00:00.000Z' }
    await mirrorWithout(bundle, [ANN])
    server.groups.set('G', { ...bundle, group_members: [bundle.group_members[0], bundle.group_members[1], removed] })

    await expect(createBill(groupBill([ME, ANN]))).rejects.toThrow(/non-member participant/)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('C4: when the roster cannot be refreshed the bill is submitted and the server decides', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    await mirrorWithout(bundle, [ANN])
    server.fetchError = { message: 'Failed to fetch' }

    await createBill(groupBill([ME, ANN]))

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushedSplitUserIds()).toEqual([ANN, ME])
  })

  it('C4: offline, the roster is not fetched and the bill is still saved (queued)', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    await mirrorWithout(bundle, [ANN])
    setOnline(false)

    await createBill(groupBill([ME, ANN]))

    expect(server.fetchCalls).toEqual([])
    expect(await db.bills.count()).toBe(1)
  })

  it('C5: a complete mirror roster costs no extra request', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [])

    await createBill(groupBill([ME, ANN, OWNER]))

    expect(server.fetchCalls).toEqual([])
    expect(server.cloud.pushes).toHaveLength(1)
  })
})

describe('refreshGroupIntoMirror', () => {
  it('C6: never overwrites a staged local member row that is newer than the server copy', async () => {
    const bundle = serverGroup([OWNER, ME])
    server.groups.set('G', bundle)
    const staged = { ...bundle.group_members[1], display_name: 'Me (edited)', updated_at: '2030-01-01T00:00:00.000Z', synced_at: null }
    await db.groups.add(bundle.group)
    await db.group_members.add(staged)

    expect(await refreshGroupIntoMirror('G')).toBe('present')

    expect((await db.group_members.get(staged.id))?.display_name).toBe('Me (edited)')
    expect(await activeMirrorMemberIds()).toEqual([ME, OWNER])
  })

  it('C6: a wipe while the fetch is in flight writes nothing', async () => {
    server.groups.set('G', serverGroup([OWNER, ME]))
    server.onFetch = () => bumpSessionEpoch()

    await refreshGroupIntoMirror('G')

    expect(await db.groups.count()).toBe(0)
    expect(await db.group_members.count()).toBe(0)
  })

  it('reports not_found for a group the server does not return, and unreachable for a failed fetch', async () => {
    expect(await refreshGroupIntoMirror('G')).toBe('not_found')
    server.fetchError = { message: 'Failed to fetch' }
    expect(await refreshGroupIntoMirror('G')).toBe('unreachable')
    setOnline(false)
    server.fetchCalls = []
    expect(await refreshGroupIntoMirror('G')).toBe('unreachable')
    expect(server.fetchCalls).toEqual([])
  })
})

describe('group actions on a group the mirror does not hold', () => {
  function asCreator() {
    const bundle = { ...serverGroup([ME, ANN]), group: makeGroup({ id: 'G', created_by: ME, name: 'Trip' }) }
    server.groups.set('G', bundle)
    return bundle
  }

  it('C7: updateGroup loads the group and submits the rename', async () => {
    asCreator()

    await updateGroup('G', { name: 'Beach' }, ME)

    expect(server.fetchCalls).toEqual(['G'])
    expect(pushed<{ name: string }>('groups')[0].name).toBe('Beach')
  })

  it('C7: updateGroup by a non-creator throws instead of returning as if saved', async () => {
    server.groups.set('G', serverGroup([OWNER, ME]))

    await expect(updateGroup('G', { name: 'Beach' }, ME)).rejects.toThrow(/only the group creator/i)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  // 082: the server walks the group's bills, payments and roster itself, so the mirror no longer
  // needs the group before a delete. The old "tap Refresh" refusal is gone with the mirror cascade.
  it('C14: deleteGroup on a group the mirror lacks is still sent to the server, fetching nothing', async () => {
    const bundle = asCreator()
    const deletedAt = '2026-10-25T03:00:00.123456+00:00'
    server.deleteEcho = {
      profiles: [],
      groups: [{ ...bundle.group, is_deleted: true, updated_at: deletedAt, synced_at: deletedAt }],
      group_members: [],
      bills: [],
      bill_items: [],
      item_splits: [],
      settlements: [],
      activity_log: [],
      profile_peer_links: [],
    }

    await deleteGroup('G', ME)

    expect(server.fetchCalls).toEqual([])
    expect(server.deleteCalls).toEqual([{ p_group_id: 'G' }])
    expect((await db.groups.get('G'))?.is_deleted).toBe(true)
  })

  it('deleteGroup for a group the mirror holds sends one kwenta_delete_group and no cascade push', async () => {
    const bundle = asCreator()
    await mirrorWithout(bundle, [])
    const deletedAt = '2026-10-25T03:00:00.123456+00:00'
    server.deleteEcho = {
      profiles: [],
      groups: [{ ...bundle.group, is_deleted: true, updated_at: deletedAt, synced_at: deletedAt }],
      group_members: bundle.group_members.map((m) => ({ ...m, is_deleted: true, updated_at: deletedAt, synced_at: deletedAt })),
      bills: [],
      bill_items: [],
      item_splits: [],
      settlements: [],
      activity_log: [],
      profile_peer_links: [],
    }

    await deleteGroup('G', ME)

    expect(server.fetchCalls).toEqual([])
    expect(server.deleteCalls).toEqual([{ p_group_id: 'G' }])
    expect(server.cloud.pushes).toHaveLength(0)
    expect((await db.groups.get('G'))?.is_deleted).toBe(true)
    expect((await activeMirrorMemberIds())).toEqual([])
  })

  it('C14: deleteGroup by a non-creator throws and deletes nothing', async () => {
    await mirrorWithout(serverGroup([OWNER, ME]), [])

    await expect(deleteGroup('G', ME)).rejects.toThrow(/only the group creator/i)
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('C8: removeGroupMember loads a group the mirror lacks and removes the member', async () => {
    asCreator()

    await removeGroupMember('G', ANN, ME)

    expect(pushed<{ user_id: string; is_deleted: boolean }>('group_members')).toEqual([
      expect.objectContaining({ user_id: ANN, is_deleted: true }),
    ])
  })

  it("C8: removeGroupMember refreshes a roster that lacks the member's row", async () => {
    const bundle = asCreator()
    await mirrorWithout(bundle, [ANN])

    await removeGroupMember('G', ANN, ME)

    expect(server.fetchCalls).toEqual(['G'])
    expect(pushed<{ user_id: string }>('group_members').map((m) => m.user_id)).toEqual([ANN])
  })

  it('C8: an unknown group is reported, not silently ignored', async () => {
    await expect(removeGroupMember('G', ANN, ME)).rejects.toThrow(GroupUnavailableError)
    await expect(updateGroup('G', { name: 'x' }, ME)).rejects.toThrow(/no longer exists/i)
    // The server is the one that knows the group is gone (082), so its refusal is what is reported.
    server.deleteError = { code: 'P0001', message: 'This group no longer exists, or you no longer have access to it.' }
    await expect(deleteGroup('G', ME)).rejects.toThrow(/no longer exists/i)
  })

  it('C8: an unreachable server reads as a connection problem, not a missing group', async () => {
    server.fetchError = { message: 'Failed to fetch' }
    await expect(updateGroup('G', { name: 'x' }, ME)).rejects.toThrow(/check your connection/i)
  })

  it('C9: addExistingGroupMembers loads the group and submits one write', async () => {
    const bundle = { ...serverGroup([ME]), group: makeGroup({ id: 'G', created_by: ME, name: 'Trip' }) }
    server.groups.set('G', bundle)

    await addExistingGroupMembers('G', [ANN], ME)

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<{ user_id: string }>('group_members').map((m) => m.user_id)).toEqual([ANN])
  })
})

describe('deletePerson cascade', () => {
  it('C15: a membership whose group or member row the mirror lacks neither fetches nor throws', async () => {
    const contact = makeProfile({ id: 'CONTACT', display_name: 'Contact', is_local: true, owner_id: ME })
    await db.profiles.add(contact)
    await db.group_members.add(makeMember({ id: 'gm-contact', group_id: 'G', user_id: 'CONTACT', display_name: 'Contact' }))
    server.groups.set('G', serverGroup([OWNER, ME, 'CONTACT']))

    await expect(deletePerson('CONTACT', ME)).resolves.toBeUndefined()

    expect(server.fetchCalls).toEqual([])
    expect((await db.profiles.get('CONTACT'))?.is_deleted).toBe(true)
  })
})
