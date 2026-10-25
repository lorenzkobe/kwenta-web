import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { addExistingGroupMembers, addGroupMember, deleteGroup, deletePerson, renameSelf } from '@/db/operations'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import { useAppStore } from '@/store/app-store'
import type { Group, GroupMember } from '@/types'
import { makeBill, makeGroup, makeItem, makeMember, makeProfile, makeSettlement, makeSplit, resetDb } from '../helpers/db'

/**
 * Group lifecycle moves to the server (migration 082), written from the run's case table:
 *
 *  C7  deleteGroup online is ONE `kwenta_delete_group({ p_group_id })` call — no kwenta_write
 *      cascade — and the rows it returns are mirrored, including bills this device never held;
 *      dataVersion is bumped. No mirror copy of the group is needed.
 *  C8  offline it refuses ("Connect to the internet…") and sends nothing; a non-creator the mirror
 *      knows about is refused before any request; a server refusal leaves the mirror untouched.
 *  C18 the echo goes through the server-apply rules: a wipe mid-call writes nothing, and a staged
 *      local row newer than the server copy is not clobbered.
 *  C9  deletePerson online runs fullSync BEFORE building, so a membership/payment the mirror lacked
 *      is part of the cascade; offline it does not sync and still queues.
 *  C16 a failed fullSync (errors, or a throw) refuses and sends nothing; a membership stored under
 *      the contact's LINKED account id is left untouched (user decision 2026-10-25: deleting a linked
 *      contact keeps the account's memberships).
 *  C10 re-adding a removed member reuses the soft-deleted membership row (same id, is_deleted
 *      false), and online the roster is refreshed first so a removal made elsewhere is known.
 *  C17 the reused row may sit under the contact id or under its linked account id.
 *
 * The kwenta_delete_group answer is kwenta_write's echo shape (per-table arrays of stored rows),
 * which is what 082's SQL suite pins — no `applied` map. Hand-made rows: every Dexie row and every
 * echoed row is built by tests/helpers/db.ts factories (the app's SyncFields shape); echoed rows
 * carry a later, microsecond server stamp, the form PostgREST serialises timestamptz in.
 */

const SERVER_AT = '2026-10-25T03:00:00.123456+00:00'

const ME = 'ME'
const OWNER = 'OWNER'
const ANN = 'ANN'

type GroupBundle = { group: Group; group_members: GroupMember[] }

const server = vi.hoisted(() => ({
  groups: new Map<string, unknown>(),
  fetchCalls: [] as string[],
  deleteCalls: [] as Record<string, unknown>[],
  deleteEcho: null as Record<string, unknown[]> | null,
  deleteError: null as { message: string; code: string } | null,
  onDelete: null as null | (() => void),
  order: [] as string[],
  cloud: {
    mode: 'ok' as const,
    calls: 0,
    pushes: [] as Record<string, Record<string, unknown>[]>[],
    rpcNames: [] as string[],
  },
}))

const sync = vi.hoisted(() => ({
  impl: null as null | ((userId: string) => Promise<unknown>),
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(server.cloud as never)
  return {
    supabase: {
      ...base,
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        server.order.push(fn)
        if (fn === 'kwenta_fetch_group_bundle') {
          const id = String(args?.p_group_id)
          server.fetchCalls.push(id)
          return { data: server.groups.get(id) ?? null, error: null }
        }
        if (fn === 'kwenta_delete_group') {
          server.cloud.rpcNames.push(fn)
          server.deleteCalls.push(args ?? {})
          server.onDelete?.()
          if (server.deleteError) {
            return { data: null, error: { ...server.deleteError, details: '', hint: '' }, status: 400 }
          }
          return { data: server.deleteEcho, error: null }
        }
        return base.rpc(fn, args)
      },
    },
  }
})
vi.mock('@/sync/sync-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/sync-service')>()
  return {
    ...actual,
    fullSync: vi.fn(async (userId: string) => {
      server.order.push('fullSync')
      if (sync.impl) return sync.impl(userId)
      return { pushed: 0, pulled: 0, changed: 0, errors: [] }
    }),
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

import { fullSync } from '@/sync/sync-service'

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.getState().setOnline(online)
}

function writeRpcCalls(): string[] {
  return server.cloud.rpcNames.filter((n) => n === 'kwenta_write' || n === 'kwenta_sync')
}

function pushedRows(table: string): Record<string, unknown>[] {
  return server.cloud.pushes.flatMap((p) => p[table] ?? [])
}

/** What the server stores for a soft-deleted row: the row, deleted, with the server's stamp. */
function deletedOnServer<T extends object>(row: T): T {
  return { ...row, is_deleted: true, updated_at: SERVER_AT, synced_at: SERVER_AT }
}

function emptyEcho(): Record<string, unknown[]> {
  return {
    profiles: [],
    groups: [],
    group_members: [],
    bills: [],
    bill_items: [],
    item_splits: [],
    settlements: [],
    activity_log: [],
    profile_peer_links: [],
  }
}

beforeEach(async () => {
  await resetDb()
  server.groups.clear()
  server.fetchCalls = []
  server.deleteCalls = []
  server.deleteEcho = null
  server.deleteError = null
  server.onDelete = null
  server.order = []
  server.cloud.calls = 0
  server.cloud.pushes = []
  server.cloud.rpcNames = []
  sync.impl = null
  vi.mocked(fullSync).mockClear()
  setOnline(true)
  await db.profiles.bulkAdd([
    makeProfile({ id: ME, display_name: 'Me' }),
    makeProfile({ id: OWNER, display_name: 'Owner' }),
    makeProfile({ id: ANN, display_name: 'Ann' }),
  ])
})

// ─── deleteGroup ────────────────────────────────────────────────────────────

/** A group ME created: roster ME + ANN, one bill this device holds, one it never saw. */
function groupFixture() {
  const group = makeGroup({ id: 'G', created_by: ME, name: 'Trip' })
  const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
  const mAnn = makeMember({ id: 'gm-ann', group_id: 'G', user_id: ANN, display_name: 'Ann' })
  const known = makeBill({ id: 'B1', group_id: 'G', created_by: ME, paid_by: ME, title: 'Hotel' })
  const knownItem = makeItem({ id: 'I1', bill_id: 'B1' })
  const knownSplit = makeSplit({ id: 'S1', item_id: 'I1', user_id: ANN })
  // Ann's bill, never opened on this device.
  const unseen = makeBill({ id: 'B2', group_id: 'G', created_by: ANN, paid_by: ANN, title: 'Taxi' })
  const unseenItem = makeItem({ id: 'I2', bill_id: 'B2' })
  const unseenSplit = makeSplit({ id: 'S2', item_id: 'I2', user_id: ME })
  const payment = makeSettlement({ id: 'P1', group_id: 'G', from_user_id: ANN, to_user_id: ME })
  const echo = {
    ...emptyEcho(),
    groups: [deletedOnServer(group)],
    group_members: [deletedOnServer(mMe), deletedOnServer(mAnn)],
    bills: [deletedOnServer(known), deletedOnServer(unseen)],
    bill_items: [deletedOnServer(knownItem), deletedOnServer(unseenItem)],
    item_splits: [deletedOnServer(knownSplit), deletedOnServer(unseenSplit)],
    settlements: [deletedOnServer(payment)],
  }
  return { group, mMe, mAnn, known, knownItem, knownSplit, unseen, payment, echo }
}

async function mirrorKnownRows(f: ReturnType<typeof groupFixture>) {
  await db.groups.add(f.group)
  await db.group_members.bulkAdd([f.mMe, f.mAnn])
  await db.bills.add(f.known)
  await db.bill_items.add(f.knownItem)
  await db.item_splits.add(f.knownSplit)
}

describe('deleteGroup is one server call (C7)', () => {
  it('C7: online, deleteGroup calls kwenta_delete_group once with { p_group_id } and sends no kwenta_write cascade', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    server.deleteEcho = f.echo

    await deleteGroup('G', ME)

    expect(server.deleteCalls).toEqual([{ p_group_id: 'G' }])
    expect(writeRpcCalls()).toEqual([])
    expect(server.cloud.pushes).toHaveLength(0)
  })

  it('C7: the returned rows are mirrored — a bill this device never held arrives as deleted', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    server.deleteEcho = f.echo

    await deleteGroup('G', ME)

    expect((await db.groups.get('G'))?.is_deleted).toBe(true)
    expect((await db.group_members.get('gm-me'))?.is_deleted).toBe(true)
    expect((await db.group_members.get('gm-ann'))?.is_deleted).toBe(true)
    expect((await db.bills.get('B1'))?.is_deleted).toBe(true)
    expect((await db.bills.get('B2'))?.is_deleted).toBe(true)
    expect((await db.bills.get('B2'))?.created_by).toBe(ANN)
    expect((await db.bill_items.get('I2'))?.is_deleted).toBe(true)
    expect((await db.item_splits.get('S2'))?.is_deleted).toBe(true)
    expect((await db.settlements.get('P1'))?.is_deleted).toBe(true)
    expect((await db.bills.get('B1'))?.updated_at).toBe(SERVER_AT)
  })

  it('C7: dataVersion is bumped after the delete', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    server.deleteEcho = f.echo
    const before = useAppStore.getState().dataVersion

    await deleteGroup('G', ME)

    expect(useAppStore.getState().dataVersion).toBeGreaterThan(before)
  })

  it('C7: a group the mirror does not hold is still deleted by the server (no "tap Refresh" refusal)', async () => {
    const f = groupFixture()
    server.deleteEcho = f.echo

    await deleteGroup('G', ME)

    expect(server.deleteCalls).toEqual([{ p_group_id: 'G' }])
    expect((await db.groups.get('G'))?.is_deleted).toBe(true)
    expect((await db.bills.get('B2'))?.is_deleted).toBe(true)
  })
})

describe('deleteGroup refusals (C8)', () => {
  it('C8: offline, deleteGroup throws a connect message and sends nothing', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    setOnline(false)

    await expect(deleteGroup('G', ME)).rejects.toThrow(/connect to the internet/i)

    expect(server.deleteCalls).toEqual([])
    expect(writeRpcCalls()).toEqual([])
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.groups.get('G'))?.is_deleted).toBe(false)
    expect((await db.bills.get('B1'))?.is_deleted).toBe(false)
  })

  it('C8: a non-creator the mirror knows about is refused before any request', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }))
    await db.group_members.add(makeMember({ id: 'gm-me', group_id: 'G', user_id: ME }))

    await expect(deleteGroup('G', ME)).rejects.toThrow(/only the group creator/i)

    expect(server.deleteCalls).toEqual([])
    expect(writeRpcCalls()).toEqual([])
    expect((await db.groups.get('G'))?.is_deleted).toBe(false)
  })

  it('C8: a server refusal throws and leaves the mirror untouched', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    server.deleteError = { code: 'P0001', message: 'Only the group creator can delete this group.' }

    await expect(deleteGroup('G', ME)).rejects.toThrow()

    expect(server.deleteCalls).toHaveLength(1)
    expect((await db.groups.get('G'))?.is_deleted).toBe(false)
    expect((await db.bills.get('B1'))?.is_deleted).toBe(false)
    expect(await db.pending_mutations.count()).toBe(0)
  })
})

describe('deleteGroup mirrors under the server-apply rules (C18)', () => {
  it('C18: a wipe while kwenta_delete_group is in flight writes nothing into the mirror', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    server.deleteEcho = f.echo
    server.onDelete = () => bumpSessionEpoch()

    await deleteGroup('G', ME).catch(() => {})

    expect(await db.bills.get('B2')).toBeUndefined()
    expect(await db.settlements.get('P1')).toBeUndefined()
    expect((await db.groups.get('G'))?.is_deleted).toBe(false)
    expect((await db.bills.get('B1'))?.is_deleted).toBe(false)
  })

  it('C18: a staged local row newer than the server copy is not clobbered by the echo', async () => {
    const f = groupFixture()
    await mirrorKnownRows(f)
    // An unsent edit of B1 made after the server's stamp.
    await db.bills.put({ ...f.known, title: 'Hotel (edited offline)', updated_at: '2030-01-01T00:00:00.000Z', synced_at: null })
    server.deleteEcho = f.echo

    await deleteGroup('G', ME)

    const b1 = await db.bills.get('B1')
    expect(b1?.title).toBe('Hotel (edited offline)')
    expect(b1?.is_deleted).toBe(false)
    expect((await db.bills.get('B2'))?.is_deleted).toBe(true)
  })
})

// ─── deletePerson ───────────────────────────────────────────────────────────

const CONTACT = 'CONTACT'
const ACCT = 'ACCT'

/** What the complete bundle brings that the mirror lacked: the group, a membership, a payment. */
function bundleBrings(membershipUserId: string) {
  return async () => {
    await db.groups.put(makeGroup({ id: 'G', created_by: ME, name: 'Trip' }))
    await db.group_members.bulkPut([
      makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' }),
      makeMember({ id: 'gm-person', group_id: 'G', user_id: membershipUserId, display_name: 'Erin' }),
    ])
    await db.settlements.put(makeSettlement({ id: 'PAY', group_id: null, from_user_id: CONTACT, to_user_id: ME }))
    return { pushed: 0, pulled: 5, changed: 5, errors: [] }
  }
}

describe('deletePerson builds from complete data (C9)', () => {
  it('C9: online, one fullSync runs before the cascade is sent', async () => {
    await db.profiles.add(makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '' }))
    sync.impl = bundleBrings(CONTACT)

    await deletePerson(CONTACT, ME)

    expect(vi.mocked(fullSync)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fullSync).mock.calls[0][0]).toBe(ME)
    const syncAt = server.order.indexOf('fullSync')
    const writeAt = server.order.findIndex((n) => n === 'kwenta_write' || n === 'kwenta_sync')
    expect(syncAt).toBeGreaterThanOrEqual(0)
    expect(writeAt).toBeGreaterThan(syncAt)
  })

  it('C9: a membership and a payment the mirror lacked before the sync are part of the cascade', async () => {
    await db.profiles.add(makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '' }))
    sync.impl = bundleBrings(CONTACT)

    await deletePerson(CONTACT, ME)

    expect(pushedRows('group_members')).toEqual([expect.objectContaining({ id: 'gm-person', is_deleted: true })])
    expect(pushedRows('settlements')).toEqual([expect.objectContaining({ id: 'PAY', is_deleted: true })])
    expect(pushedRows('profiles')).toEqual([expect.objectContaining({ id: CONTACT, is_deleted: true })])
  })

  it('C9: offline, deletePerson does not sync and still queues the cascade', async () => {
    await db.profiles.add(makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '' }))
    setOnline(false)

    await deletePerson(CONTACT, ME)

    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
    expect(writeRpcCalls()).toEqual([])
    expect(await db.pending_mutations.count()).toBe(1)
    expect((await db.profiles.get(CONTACT))?.is_deleted).toBe(true)
  })
})

describe('deletePerson refusals and linked memberships (C16)', () => {
  it('C16: a fullSync that reports errors refuses and sends nothing', async () => {
    await db.profiles.add(makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '' }))
    sync.impl = async () => ({ pushed: 0, pulled: 0, changed: 0, errors: ['Pull failed: Failed to fetch'] })

    await expect(deletePerson(CONTACT, ME)).rejects.toThrow(/refresh your data/i)

    expect(writeRpcCalls()).toEqual([])
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.profiles.get(CONTACT))?.is_deleted).toBe(false)
  })

  it('C16: a fullSync that throws refuses and sends nothing', async () => {
    await db.profiles.add(makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '' }))
    sync.impl = async () => {
      throw new Error('Failed to fetch')
    }

    await expect(deletePerson(CONTACT, ME)).rejects.toThrow()

    expect(writeRpcCalls()).toEqual([])
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.profiles.get(CONTACT))?.is_deleted).toBe(false)
  })

  // Decision (rule 10: the case changed because the requirement did): deleting a phonebook contact
  // must not remove a real user from groups, so a membership stored under the linked ACCOUNT id is
  // left alone. (Memberships made under the contact's own id are rewritten to the account id by 045
  // when the contact is linked, so there is nothing of the contact's own to remove.)
  it("C16: a membership stored under the contact's linked account id is left untouched", async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: ACCT, display_name: 'Erin' }),
      makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '', linked_profile_id: ACCT }),
    ])
    sync.impl = bundleBrings(ACCT)

    await deletePerson(CONTACT, ME)

    expect(pushedRows('group_members')).toEqual([])
    expect((await db.group_members.get('gm-person'))?.is_deleted).toBe(false)
    expect(pushedRows('profiles')).toEqual([expect.objectContaining({ id: CONTACT, is_deleted: true })])
  })
})

// ─── Re-adding a removed member ─────────────────────────────────────────────

function rosterBundle(members: GroupMember[]): GroupBundle {
  return { group: makeGroup({ id: 'G', created_by: ME, name: 'Trip' }), group_members: members }
}

async function rowsFor(groupId: string, userId: string) {
  return db.group_members.where('[group_id+user_id]').equals([groupId, userId]).toArray()
}

describe('re-adding reuses the removed membership row (C10)', () => {
  it('C10: addExistingGroupMembers revives the soft-deleted row (same id) instead of minting one', async () => {
    const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
    const removed = makeMember({ id: 'gm-ann', group_id: 'G', user_id: ANN, display_name: 'Ann', is_deleted: true })
    await db.groups.add(rosterBundle([]).group)
    await db.group_members.bulkAdd([mMe, removed])
    server.groups.set('G', rosterBundle([mMe, removed]))

    await addExistingGroupMembers('G', [ANN], ME)

    expect(pushedRows('group_members')).toEqual([
      expect.objectContaining({ id: 'gm-ann', group_id: 'G', user_id: ANN, is_deleted: false }),
    ])
    const rows = await rowsFor('G', ANN)
    expect(rows.map((r) => [r.id, r.is_deleted])).toEqual([['gm-ann', false]])
  })

  it('C10: online, the roster is refreshed first, so a removal made on another device is known and revived', async () => {
    const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
    const staleLive = makeMember({ id: 'gm-ann', group_id: 'G', user_id: ANN, display_name: 'Ann' })
    await db.groups.add(rosterBundle([]).group)
    await db.group_members.bulkAdd([mMe, staleLive])
    // Another device removed Ann after this mirror last synced.
    server.groups.set('G', rosterBundle([
      { ...mMe, updated_at: SERVER_AT, synced_at: SERVER_AT },
      { ...staleLive, is_deleted: true, updated_at: SERVER_AT, synced_at: SERVER_AT },
    ]))

    await addExistingGroupMembers('G', [ANN], ME)

    expect(server.fetchCalls).toContain('G')
    expect(server.order.indexOf('kwenta_fetch_group_bundle')).toBeLessThan(server.order.indexOf('kwenta_write'))
    expect(pushedRows('group_members')).toEqual([expect.objectContaining({ id: 'gm-ann', is_deleted: false })])
    expect((await db.group_members.get('gm-ann'))?.is_deleted).toBe(false)
  })

  it('C10: offline, the roster is not fetched and the known removed row is still the one revived (queued)', async () => {
    const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
    const removed = makeMember({ id: 'gm-ann', group_id: 'G', user_id: ANN, display_name: 'Ann', is_deleted: true })
    await db.groups.add(rosterBundle([]).group)
    await db.group_members.bulkAdd([mMe, removed])
    setOnline(false)

    await addExistingGroupMembers('G', [ANN], ME)

    expect(server.fetchCalls).toEqual([])
    const rows = await rowsFor('G', ANN)
    expect(rows.map((r) => [r.id, r.is_deleted])).toEqual([['gm-ann', false]])
  })

  it('C10: addGroupMember by name revives the removed contact\'s row (same id), no new contact', async () => {
    const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
    const removed = makeMember({ id: 'gm-cha', group_id: 'G', user_id: 'CHA', display_name: 'Cha', is_deleted: true })
    await db.profiles.add(makeProfile({ id: 'CHA', display_name: 'Cha', is_local: true, owner_id: ME, email: '' }))
    await db.groups.add(rosterBundle([]).group)
    await db.group_members.bulkAdd([mMe, removed])
    server.groups.set('G', rosterBundle([mMe, removed]))

    await addGroupMember('G', 'Cha', ME)

    expect(server.fetchCalls).toContain('G')
    expect(pushedRows('profiles')).toEqual([])
    expect(pushedRows('group_members')).toEqual([
      expect.objectContaining({ id: 'gm-cha', user_id: 'CHA', is_deleted: false }),
    ])
    expect((await rowsFor('G', 'CHA')).map((r) => [r.id, r.is_deleted])).toEqual([['gm-cha', false]])
  })
})

describe('re-adding a contact that was linked after removal (C17)', () => {
  async function linkedContactRemovedUnder(rowUserId: string) {
    const mMe = makeMember({ id: 'gm-me', group_id: 'G', user_id: ME, display_name: 'Me' })
    const removed = makeMember({ id: 'gm-old', group_id: 'G', user_id: rowUserId, display_name: 'Erin', is_deleted: true })
    await db.profiles.bulkAdd([
      makeProfile({ id: ACCT, display_name: 'Erin' }),
      makeProfile({ id: CONTACT, display_name: 'Erin', is_local: true, owner_id: ME, email: '', linked_profile_id: ACCT }),
    ])
    await db.groups.add(rosterBundle([]).group)
    await db.group_members.bulkAdd([mMe, removed])
    server.groups.set('G', rosterBundle([mMe, removed]))
  }

  it('C17: addExistingGroupMembers reuses the removed row stored under the linked account id', async () => {
    await linkedContactRemovedUnder(ACCT)

    await addExistingGroupMembers('G', [CONTACT], ME)

    expect(pushedRows('group_members')).toEqual([
      expect.objectContaining({ id: 'gm-old', user_id: ACCT, is_deleted: false }),
    ])
  })

  it('C17: addExistingGroupMembers reuses the removed row stored under the contact id', async () => {
    await linkedContactRemovedUnder(CONTACT)

    await addExistingGroupMembers('G', [CONTACT], ME)

    const pushed = pushedRows('group_members')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ id: 'gm-old', is_deleted: false })
  })

  it('C17: addGroupMember by name reuses the removed row stored under the linked account id', async () => {
    await linkedContactRemovedUnder(ACCT)

    await addGroupMember('G', 'Erin', ME)

    expect(pushedRows('profiles')).toEqual([])
    expect(pushedRows('group_members')).toEqual([
      expect.objectContaining({ id: 'gm-old', user_id: ACCT, is_deleted: false }),
    ])
  })

  it('C17: addGroupMember by name reuses the removed row stored under the contact id', async () => {
    await linkedContactRemovedUnder(CONTACT)

    await addGroupMember('G', 'Erin', ME)

    const pushed = pushedRows('group_members')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ id: 'gm-old', is_deleted: false })
  })
})

// ─── renameSelf (C26) ───────────────────────────────────────────────────────

describe('renameSelf skips memberships of deleted groups (C26)', () => {
  it('C26: a live membership under a deleted group is not pushed and the rename still applies', async () => {
    await db.groups.bulkAdd([
      makeGroup({ id: 'LIVE', created_by: OWNER, name: 'Live' }),
      makeGroup({ id: 'GONE', created_by: OWNER, name: 'Gone', is_deleted: true }),
    ])
    await db.group_members.bulkAdd([
      makeMember({ id: 'gm-live', group_id: 'LIVE', user_id: ME, display_name: 'Me' }),
      makeMember({ id: 'gm-gone', group_id: 'GONE', user_id: ME, display_name: 'Me' }),
    ])

    await renameSelf(ME, 'Renamed')

    expect(pushedRows('group_members').map((m) => m.id)).toEqual(['gm-live'])
    expect(pushedRows('profiles')).toEqual([expect.objectContaining({ id: ME, display_name: 'Renamed' })])
    expect((await db.profiles.get(ME))?.display_name).toBe('Renamed')
    expect((await db.group_members.get('gm-gone'))?.display_name).toBe('Me')
  })

  it('C26: a membership whose group is not on this device is not pushed either', async () => {
    await db.group_members.add(makeMember({ id: 'gm-orphan', group_id: 'ABSENT', user_id: ME, display_name: 'Me' }))

    await renameSelf(ME, 'Renamed')

    expect(pushedRows('group_members')).toEqual([])
    expect((await db.profiles.get(ME))?.display_name).toBe('Renamed')
  })

  it('C26: memberships under live groups are still renamed', async () => {
    await db.groups.bulkAdd([
      makeGroup({ id: 'A', created_by: OWNER, name: 'A' }),
      makeGroup({ id: 'B', created_by: ME, name: 'B' }),
    ])
    await db.group_members.bulkAdd([
      makeMember({ id: 'gm-a', group_id: 'A', user_id: ME, display_name: 'Me' }),
      makeMember({ id: 'gm-b', group_id: 'B', user_id: ME, display_name: 'Me' }),
    ])

    await renameSelf(ME, 'Renamed')

    expect(pushedRows('group_members').map((m) => m.id).sort()).toEqual(['gm-a', 'gm-b'])
    expect(pushedRows('group_members').every((m) => m.display_name === 'Renamed')).toBe(true)
    expect((await db.group_members.get('gm-a'))?.display_name).toBe('Renamed')
  })
})
