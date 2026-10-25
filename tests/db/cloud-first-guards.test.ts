import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  addExistingGroupMembers,
  addGroupMember,
  createBundledGroupSettlement,
  createGroup,
  linkProfileToRemote,
  mergeProfileIdentity,
  recordDecomposedSettlement,
  removeProfilePeerLink,
  renameSelf,
  updateBundledPaymentDetails,
  updateSettlement,
} from '@/db/operations'
import { fetchRemoteProfileIntoDexie } from '@/lib/people'
import { fullSync } from '@/sync/sync-service'
import { drainWriteQueue } from '@/sync/write-queue'
import { useAppStore } from '@/store/app-store'
import type { Group, GroupMember, Profile, ProfilePeerLink, Settlement } from '@/types'
import { makeGroup, makeMember, makeProfile, makeSettlement, resetDb } from '../helpers/db'

/**
 * cloud-first-guards-and-screens, C1 C3-C6 C11-C13 C16. No group/payment/contact action may
 * refuse ("Group not found") or silently do nothing because THIS device's copy is behind: a miss is
 * loaded from the server, and what cannot be loaded is reported with the reason (gone vs offline).
 *
 * Server answer shapes are the migrations' own:
 *   kwenta_fetch_group_bundle      -> { group, group_members } | null   (src/sync/group-mirror.ts)
 *   kwenta_fetch_settlement        -> { settlement } | null             (013_kwenta_realtime_fetch_bundles.sql)
 *   kwenta_fetch_profile_for_linking -> profile row | null              (039_fetch_profile_for_linking_reduced_projection.sql)
 */

const server = vi.hoisted(() => ({
  groups: new Map<string, unknown>(),
  groupFetchCalls: [] as string[],
  groupFetchError: null as { message: string } | null,
  settlements: new Map<string, unknown>(),
  settlementFetchCalls: [] as string[],
  settlementFetchError: null as { message: string } | null,
  profiles: new Map<string, unknown>(),
  profileFetchCalls: [] as string[],
  profileFetchError: null as { message: string } | null,
  cloud: {
    mode: 'ok' as 'ok' | 'reject',
    calls: 0,
    pushes: [] as Record<string, { id: string }[]>[],
  },
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
          server.groupFetchCalls.push(id)
          if (server.groupFetchError) return { data: null, error: server.groupFetchError }
          return { data: server.groups.get(id) ?? null, error: null }
        }
        if (fn === 'kwenta_fetch_settlement') {
          const id = String(args?.p_settlement_id)
          server.settlementFetchCalls.push(id)
          if (server.settlementFetchError) return { data: null, error: server.settlementFetchError }
          const row = server.settlements.get(id)
          return { data: row ? { settlement: row } : null, error: null }
        }
        if (fn === 'kwenta_fetch_profile_for_linking') {
          const id = String(args?.p_id)
          server.profileFetchCalls.push(id)
          if (server.profileFetchError) return { data: null, error: server.profileFetchError }
          return { data: server.profiles.get(id) ?? null, error: null }
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
vi.mock('@/lib/kwenta-notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyPaymentRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
// The background refresh after a drained link is observed here; every other export stays real.
vi.mock('@/sync/sync-service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, changed: 0, errors: [] })),
}))

const ME = 'ME'
const OWNER = 'OWNER'
const ANN = 'ANN'
const SERVER_TIME = '2026-10-20T00:00:00.000Z'

type GroupBundle = { group: Group; group_members: GroupMember[] }

function serverGroup(memberIds: string[], createdBy = OWNER): GroupBundle {
  return {
    group: makeGroup({ id: 'G', created_by: createdBy, name: 'Trip' }),
    group_members: memberIds.map((id) =>
      makeMember({ id: `gm-${id}`, group_id: 'G', user_id: id, display_name: id }),
    ),
  }
}

async function mirrorWithout(bundle: GroupBundle, missing: string[]) {
  await db.groups.add(bundle.group)
  await db.group_members.bulkAdd(bundle.group_members.filter((m) => !missing.includes(m.user_id)))
}

/** An account row as 039 returns it to a co-member: non-local, with an email. */
function serverAccount(id: string, name: string): Profile {
  return makeProfile({ id, display_name: name, email: `${id.toLowerCase()}@example.com`, is_local: false })
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.getState().setOnline(online)
}

function pushed<T>(table: string, index = 0): T[] {
  return (server.cloud.pushes[index]?.[table] ?? []) as unknown as T[]
}

function nothingSent() {
  expect(server.cloud.pushes).toHaveLength(0)
}

async function nothingQueued() {
  expect(await db.pending_mutations.count()).toBe(0)
}

const bundledPayment = () =>
  createBundledGroupSettlement({
    groupId: 'G',
    fromUserId: ME,
    recipients: [{ toUserId: ANN, amount: 100 }],
    currency: 'PHP',
    markedBy: ME,
  })

const decomposedPayment = () =>
  recordDecomposedSettlement({
    groupId: 'G',
    currency: 'PHP',
    legs: [{ fromUserId: ME, toUserId: ANN, amount: 100 }],
    markedBy: ME,
  })

beforeEach(async () => {
  await resetDb()
  server.groups.clear()
  server.groupFetchCalls = []
  server.groupFetchError = null
  server.settlements.clear()
  server.settlementFetchCalls = []
  server.settlementFetchError = null
  server.profiles.clear()
  server.profileFetchCalls = []
  server.profileFetchError = null
  server.cloud.mode = 'ok'
  server.cloud.calls = 0
  server.cloud.pushes = []
  vi.mocked(fullSync).mockClear()
  setOnline(true)
  await db.profiles.bulkAdd([
    makeProfile({ id: ME, display_name: 'Me' }),
    makeProfile({ id: OWNER, display_name: 'Owner' }),
    makeProfile({ id: ANN, display_name: 'Ann' }),
  ])
})

// ── C1 / C11 ──────────────────────────────────────────────────────────────────

describe('C1: group actions on a group this device does not hold', () => {
  it('C1: addGroupMember loads the group (one fetch) and adds the member instead of "Group not found"', async () => {
    server.groups.set('G', serverGroup([ME], ME))

    await addGroupMember('G', 'Zed', ME)

    expect(server.groupFetchCalls).toEqual(['G'])
    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<{ group_id: string; display_name: string }>('group_members')).toEqual([
      expect.objectContaining({ group_id: 'G', display_name: 'Zed' }),
    ])
  })

  it('C1: createBundledGroupSettlement loads the group and records the payment', async () => {
    server.groups.set('G', serverGroup([OWNER, ME, ANN]))

    await bundledPayment()

    expect(server.groupFetchCalls).toEqual(['G'])
    expect(pushed<Settlement>('settlements')).toEqual([
      expect.objectContaining({ group_id: 'G', from_user_id: ME, to_user_id: ANN, amount: 100 }),
    ])
  })

  it('C1: recordDecomposedSettlement loads the group and records the legs', async () => {
    server.groups.set('G', serverGroup([OWNER, ME, ANN]))

    await decomposedPayment()

    expect(server.groupFetchCalls).toEqual(['G'])
    expect(pushed<Settlement>('settlements')).toEqual([
      expect.objectContaining({ group_id: 'G', from_user_id: ME, to_user_id: ANN, amount: 100 }),
    ])
  })

  it('C1: a group the server does not return either is reported as no longer existing, nothing sent', async () => {
    await expect(addGroupMember('G', 'Zed', ME)).rejects.toThrow(/no longer exists/i)
    await expect(bundledPayment()).rejects.toThrow(/no longer exists/i)
    await expect(decomposedPayment()).rejects.toThrow(/no longer exists/i)
    nothingSent()
    await nothingQueued()
  })

  it('C1: offline with no copy of the group reports a connection problem, not a missing group', async () => {
    setOnline(false)

    for (const action of [() => addGroupMember('G', 'Zed', ME), bundledPayment, decomposedPayment]) {
      const err = await action().then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toMatch(/connection/i)
      expect(err!.message).not.toMatch(/not found|no longer exists/i)
    }
    expect(server.groupFetchCalls).toEqual([])
    nothingSent()
    await nothingQueued()
  })

  it('C1: an unreachable server while online also reads as a connection problem', async () => {
    server.groupFetchError = { message: 'Failed to fetch' }
    await expect(bundledPayment()).rejects.toThrow(/check your connection/i)
    nothingSent()
  })
})

// ── C16 / C11 ─────────────────────────────────────────────────────────────────

describe('C16: group payments refresh the roster only when a party is missing', () => {
  it('C16: createBundledGroupSettlement on a complete roster makes zero kwenta_fetch_group_bundle calls', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [])

    await bundledPayment()

    expect(server.groupFetchCalls).toEqual([])
    expect(server.cloud.pushes).toHaveLength(1)
  })

  it('C16: recordDecomposedSettlement on a complete roster makes zero kwenta_fetch_group_bundle calls', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [])

    await decomposedPayment()

    expect(server.groupFetchCalls).toEqual([])
    expect(server.cloud.pushes).toHaveLength(1)
  })

  it('C16: a recipient missing from the device roster triggers exactly one roster refresh', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [ANN])

    await bundledPayment()

    expect(server.groupFetchCalls).toEqual(['G'])
    expect(pushed<Settlement>('settlements').map((s) => s.to_user_id)).toEqual([ANN])
    const annRow = await db.group_members.get('gm-ANN')
    expect(annRow?.is_deleted).toBe(false)
  })

  it('C16: a decomposed leg whose payer is missing from the device roster triggers exactly one refresh', async () => {
    const bundle = serverGroup([OWNER, ME, ANN])
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [ANN])

    await recordDecomposedSettlement({
      groupId: 'G',
      currency: 'PHP',
      legs: [{ fromUserId: ANN, toUserId: OWNER, amount: 40 }],
      markedBy: ME,
    })

    expect(server.groupFetchCalls).toEqual(['G'])
    expect(pushed<Settlement>('settlements')).toEqual([
      expect.objectContaining({ from_user_id: ANN, to_user_id: OWNER, amount: 40 }),
    ])
  })
})

// ── C3 / C12 / C11 ────────────────────────────────────────────────────────────

describe('C3/C12: updateSettlement on a payment this device does not hold', () => {
  const patch = { fromUserId: ME, toUserId: ANN, amount: 150, currency: 'PHP', label: 'Lunch' }

  function serverPayment(over: Partial<Settlement> = {}): Settlement {
    // Rows as the server stores them: synced, a server timestamp, a NOT NULL label.
    return makeSettlement({
      id: 'S1',
      group_id: null,
      from_user_id: ME,
      to_user_id: ANN,
      amount: 100,
      label: 'Lunch',
      method: 'GCash',
      created_at: SERVER_TIME,
      updated_at: SERVER_TIME,
      synced_at: SERVER_TIME,
      ...over,
    })
  }

  it('C3: fetches the payment once (kwenta_fetch_settlement) and submits the edit', async () => {
    server.settlements.set('S1', serverPayment())

    await updateSettlement('S1', patch, ME)

    expect(server.settlementFetchCalls).toEqual(['S1'])
    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<Settlement>('settlements')).toEqual([
      expect.objectContaining({ id: 'S1', amount: 150, from_user_id: ME, to_user_id: ANN }),
    ])
    // The edit was built from the server's row: a field the patch does not touch (method) survives.
    expect(pushed<Settlement>('settlements')[0].method).toBe('GCash')
  })

  it('C11: a payment already on the device costs no fetch', async () => {
    await db.settlements.add(serverPayment())

    await updateSettlement('S1', patch, ME)

    expect(server.settlementFetchCalls).toEqual([])
    expect(server.cloud.pushes).toHaveLength(1)
  })

  it('C3: a payment deleted on this device throws "no longer exists" instead of returning silently', async () => {
    await db.settlements.add(serverPayment({ is_deleted: true }))

    await expect(updateSettlement('S1', patch, ME)).rejects.toThrow(/no longer exists/i)
    nothingSent()
  })

  it('C12: a NULL fetch says it could not be loaded, not that it no longer exists (013 misses linked-contact payments)', async () => {
    const err = await updateSettlement('S1', patch, ME).then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/couldn.t load this payment/i)
    expect(err!.message).not.toMatch(/no longer exists/i)
    expect(server.settlementFetchCalls).toEqual(['S1'])
    nothingSent()
    await nothingQueued()
  })

  it('C12: offline, a payment missing locally gives a connection message and makes no request', async () => {
    setOnline(false)

    await expect(updateSettlement('S1', patch, ME)).rejects.toThrow(/connection/i)
    expect(server.settlementFetchCalls).toEqual([])
    nothingSent()
    await nothingQueued()
  })

  it('C12: a failed fetch online is reported (never a silent return) and nothing is sent', async () => {
    server.settlementFetchError = { message: 'Failed to fetch' }

    await expect(updateSettlement('S1', patch, ME)).rejects.toThrow()
    nothingSent()
  })

  it('C3: a server refusal of the edit throws', async () => {
    server.settlements.set('S1', serverPayment())
    server.cloud.mode = 'reject'

    await expect(updateSettlement('S1', patch, ME)).rejects.toThrow()
  })
})

// ── C19 ───────────────────────────────────────────────────────────────────────

describe('C19: updateBundledPaymentDetails on a bundle this device does not hold', () => {
  it('throws "no longer exists" for a bundle with no rows, and sends nothing', async () => {
    await expect(updateBundledPaymentDetails('BU', { label: 'Trip' }, ME)).rejects.toThrow(/no longer exists/i)
    nothingSent()
    await nothingQueued()
  })

  it('throws when every leg is deleted on the device', async () => {
    await db.settlements.add(makeSettlement({ id: 'S1', bundle_id: 'BU', is_deleted: true }))

    await expect(updateBundledPaymentDetails('BU', { label: 'Trip' }, ME)).rejects.toThrow(/no longer exists/i)
    nothingSent()
  })

  it('still submits the new label on every live leg', async () => {
    await db.settlements.bulkAdd([
      makeSettlement({ id: 'S1', bundle_id: 'BU', from_user_id: ME, to_user_id: ANN }),
      makeSettlement({ id: 'S2', bundle_id: 'BU', from_user_id: ME, to_user_id: OWNER }),
    ])

    await updateBundledPaymentDetails('BU', { label: 'Trip' }, ME)

    expect(pushed<Settlement>('settlements').map((s) => s.label)).toEqual(['Trip', 'Trip'])
  })
})

// ── C4 ────────────────────────────────────────────────────────────────────────

describe('C4: no silent early return', () => {
  async function errorOf(p: Promise<unknown>): Promise<Error> {
    const err = await p.then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message.trim().length).toBeGreaterThan(0)
    return err!
  }

  function link(over: Partial<ProfilePeerLink> = {}): ProfilePeerLink {
    return {
      id: 'L1',
      created_at: SERVER_TIME,
      updated_at: SERVER_TIME,
      synced_at: SERVER_TIME,
      is_deleted: false,
      device_id: 'test-device',
      owner_user_id: ME,
      anchor_profile_id: 'LOCAL',
      peer_profile_id: ANN,
      ...over,
    }
  }

  beforeEach(async () => {
    await db.profiles.add(makeProfile({ id: 'LOCAL', display_name: 'Ann (contact)', email: '', is_local: true, owner_id: ME }))
  })

  it('C4: removeProfilePeerLink on a link not on this device throws', async () => {
    await errorOf(removeProfilePeerLink('L1', ME))
    nothingSent()
  })

  it("C4: removeProfilePeerLink on someone else's link throws", async () => {
    await db.profile_peer_links.add(link({ owner_user_id: OWNER }))
    await errorOf(removeProfilePeerLink('L1', ME))
    nothingSent()
  })

  it('C4: removeProfilePeerLink on the primary account link throws its own message', async () => {
    await db.profiles.update('LOCAL', { linked_profile_id: ANN })
    await db.profile_peer_links.add(link())
    const primary = await errorOf(removeProfilePeerLink('L1', ME))
    const missing = await errorOf(removeProfilePeerLink('NOPE', ME))
    expect(primary.message).not.toBe(missing.message)
    nothingSent()
  })

  it('C4: removeProfilePeerLink on an ordinary link still submits the removal', async () => {
    await db.profile_peer_links.add(link())
    await removeProfilePeerLink('L1', ME)
    expect(pushed<ProfilePeerLink>('profile_peer_links')).toEqual([
      expect.objectContaining({ id: 'L1', is_deleted: true }),
    ])
  })

  it('C4: mergeProfileIdentity of a contact into itself throws', async () => {
    await errorOf(mergeProfileIdentity('LOCAL', 'LOCAL', ME))
    nothingSent()
  })

  it('C4: mergeProfileIdentity from a profile that is not my local contact throws', async () => {
    await errorOf(mergeProfileIdentity(ANN, 'LOCAL', ME))
    nothingSent()
  })

  it('C4: mergeProfileIdentity of an already-merged contact throws', async () => {
    await db.profiles.update('LOCAL', { linked_profile_id: ANN })
    await errorOf(mergeProfileIdentity('LOCAL', OWNER, ME))
    nothingSent()
  })

  it('C4: renameSelf with a blank name throws', async () => {
    await errorOf(renameSelf(ME, '   '))
    nothingSent()
  })

  it('C4: renameSelf when the own profile is not on this device throws', async () => {
    await db.profiles.delete(ME)
    await errorOf(renameSelf(ME, 'New name'))
    nothingSent()
  })
})

// ── C5 / C13 / C11 ────────────────────────────────────────────────────────────

describe('C5/C13: adding people whose profile is not on this device', () => {
  const REMOTE = 'REMOTE'
  const GHOST = 'GHOST'

  async function creatorGroupOnDevice() {
    const bundle = serverGroup([ME], ME)
    server.groups.set('G', bundle)
    await mirrorWithout(bundle, [])
  }

  it('C5: addExistingGroupMembers fetches a missing pick first and adds them', async () => {
    await creatorGroupOnDevice()
    server.profiles.set(REMOTE, serverAccount(REMOTE, 'Remy'))

    await addExistingGroupMembers('G', [REMOTE], ME)

    expect(server.profileFetchCalls).toContain(REMOTE)
    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<GroupMember>('group_members').map((m) => [m.user_id, m.display_name])).toEqual([
      [REMOTE, 'Remy'],
    ])
  })

  it('C5: createGroup fetches a missing pick first and creates the group with them', async () => {
    server.profiles.set(REMOTE, serverAccount(REMOTE, 'Remy'))

    await createGroup('Trip', 'PHP', ME, [REMOTE])

    expect(server.cloud.pushes).toHaveLength(1)
    expect(pushed<GroupMember>('group_members').map((m) => m.user_id).sort()).toEqual([ME, REMOTE])
  })

  it('C11: picks already on the device cost no profile fetch', async () => {
    await creatorGroupOnDevice()

    await addExistingGroupMembers('G', [ANN], ME)

    expect(server.profileFetchCalls).not.toContain(ANN)
    expect(pushed<GroupMember>('group_members').map((m) => m.user_id)).toEqual([ANN])
  })

  it('C5: a pick the server does not know makes the add throw naming the count, and nothing is sent', async () => {
    await creatorGroupOnDevice()

    await expect(addExistingGroupMembers('G', [ANN, GHOST], ME)).rejects.toThrow(/\b1\b/)
    nothingSent()
    await nothingQueued()
  })

  it('C5: two unknown picks are counted as 2', async () => {
    await creatorGroupOnDevice()

    await expect(addExistingGroupMembers('G', [GHOST, 'GHOST2'], ME)).rejects.toThrow(/\b2\b/)
    nothingSent()
  })

  it('C5: createGroup with an unknown pick throws and creates no group', async () => {
    await expect(createGroup('Trip', 'PHP', ME, [GHOST])).rejects.toThrow(/\b1\b/)
    nothingSent()
    await nothingQueued()
    expect(await db.groups.count()).toBe(0)
  })

  it('C13: a deleted pick names the count and nothing is sent', async () => {
    await creatorGroupOnDevice()
    await db.profiles.update(ANN, { is_deleted: true })

    await expect(addExistingGroupMembers('G', [ANN], ME)).rejects.toThrow(/\b1\b/)
    nothingSent()
  })

  it('C13: a pick whose fetch fails (unreachable) gives a connection message, nothing sent', async () => {
    await creatorGroupOnDevice()
    server.profileFetchError = { message: 'Failed to fetch' }

    await expect(addExistingGroupMembers('G', [REMOTE], ME)).rejects.toThrow(/connection/i)
    nothingSent()
    await nothingQueued()
  })

  it('C13: offline, a pick not on the device gives a connection message, makes no request, queues nothing', async () => {
    await creatorGroupOnDevice()
    setOnline(false)

    await expect(addExistingGroupMembers('G', [REMOTE], ME)).rejects.toThrow(/connection/i)
    expect(server.profileFetchCalls).toEqual([])
    nothingSent()
    await nothingQueued()
  })
})

describe('C5/C13: fetchRemoteProfileIntoDexie reports three outcomes', () => {
  it('present for a profile on the device (no request) or one the server returns', async () => {
    expect(await fetchRemoteProfileIntoDexie(ANN)).toBe('present')
    expect(server.profileFetchCalls).toEqual([])

    server.profiles.set('REMOTE', serverAccount('REMOTE', 'Remy'))
    expect(await fetchRemoteProfileIntoDexie('REMOTE')).toBe('present')
    expect((await db.profiles.get('REMOTE'))?.display_name).toBe('Remy')
  })

  it('not_found when the server answers with no row', async () => {
    expect(await fetchRemoteProfileIntoDexie('GHOST')).toBe('not_found')
    expect(await db.profiles.get('GHOST')).toBeUndefined()
  })

  it('unreachable when the fetch fails, and offline without making a request', async () => {
    server.profileFetchError = { message: 'Failed to fetch' }
    expect(await fetchRemoteProfileIntoDexie('REMOTE')).toBe('unreachable')

    server.profileFetchError = null
    server.profileFetchCalls = []
    setOnline(false)
    expect(await fetchRemoteProfileIntoDexie('REMOTE')).toBe('unreachable')
    expect(server.profileFetchCalls).toEqual([])
  })
})

// ── C6 ────────────────────────────────────────────────────────────────────────

describe('C6: a queued link_profile entry applied by the write queue', () => {
  beforeEach(async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'LOCAL', display_name: 'Remy (contact)', email: '', is_local: true, owner_id: ME }),
      serverAccount('REMOTE', 'Remy'),
    ])
  })

  async function queueLink() {
    setOnline(false)
    const { mode } = await linkProfileToRemote('LOCAL', 'REMOTE', ME)
    expect(mode).toBe('queued')
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
    setOnline(true)
  }

  it('C6: runs one background fullSync after the drain applies the link', async () => {
    await queueLink()

    await drainWriteQueue(ME)

    expect(pushed<Profile>('profiles')).toEqual([
      expect.objectContaining({ id: 'LOCAL', linked_profile_id: 'REMOTE' }),
    ])
    await vi.waitFor(() => expect(vi.mocked(fullSync)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(fullSync).mock.calls[0][0]).toBe(ME)
    expect(await db.pending_mutations.count()).toBe(0)
  })

  it('C6: a link the server refuses triggers no fullSync', async () => {
    await queueLink()
    server.cloud.mode = 'reject'

    await drainWriteQueue(ME)
    await new Promise((r) => setTimeout(r, 0))

    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })

  it('C6: draining an entry that is not a link triggers no fullSync', async () => {
    setOnline(false)
    await renameSelf(ME, 'Me again')
    setOnline(true)

    await drainWriteQueue(ME)
    await new Promise((r) => setTimeout(r, 0))

    expect(server.cloud.pushes).toHaveLength(1)
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })
})
