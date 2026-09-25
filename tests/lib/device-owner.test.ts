import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { ensureDeviceOwnedBy } from '@/lib/device-owner'
import { KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

/**
 * Who this device's mirror belongs to (plan: Auth; skeptic amendment H1.4).
 *
 * `KWENTA_LOCAL_USER_KEY` was declared and cleared but never WRITTEN, so an upgraded device has no
 * key at all. Wiping every such device would throw away the user's own offline copy and unsent
 * work; adopting every one would hand the previous account's mirror to whoever signs in next.
 * The rule: with no key, adopt unless the mirror provably belongs to someone else.
 *
 * Assertions are on observable state (Dexie rows, the owner key) rather than on the return value,
 * whose shape the plan does not fix.
 */

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getSession: async () => ({ data: { session: null } }), signOut: vi.fn(async () => ({})) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))
vi.mock('@/sync/sync-manager', () => ({ triggerSync: vi.fn(), requestSyncNow: vi.fn() }))

const ME = 'me-uid'
const OTHER = 'other-uid'

function queueEntry(actor: string, status: 'pending' | 'conflict' = 'pending') {
  const ts = '2026-09-20T00:00:00.000Z'
  return {
    id: `pm-${actor}-${status}`,
    actor_user_id: actor,
    operation: 'createBill',
    entity_type: 'bill',
    entity_id: 'bill-x',
    payload_json: '{}',
    status,
    retry_count: 0,
    last_error: null,
    submission_id: `sub-${actor}`,
    seq: 1,
    push: { bills: [] },
    row_keys: ['bills:bill-x'],
    next_attempt_at: null,
    last_error_kind: null,
    created_at: ts,
    updated_at: ts,
  } as never
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
})

describe('ensureDeviceOwnedBy — owner key present', () => {
  it('C25: keeps the mirror when the stored owner is the signing-in user', async () => {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, ME)
    await db.profiles.add(makeProfile({ id: ME }))
    await db.bills.add(makeBill({ id: 'b-mine', created_by: ME, paid_by: ME, synced_at: null }))
    await db.pending_mutations.add(queueEntry(ME))

    await ensureDeviceOwnedBy(ME)

    expect(await db.bills.get('b-mine')).toBeTruthy()
    expect(await db.pending_mutations.count()).toBe(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('C24: wipes the previous owner’s mirror when a different user signs in with nothing unsent', async () => {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, OTHER)
    await db.profiles.add(makeProfile({ id: OTHER }))
    await db.bills.add(makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER }))

    await ensureDeviceOwnedBy(ME)

    expect(await db.bills.count()).toBe(0)
    expect(await db.profiles.get(OTHER)).toBeUndefined()
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('C24: does NOT wipe while the previous owner has unsent changes — it reports that it must ask', async () => {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, OTHER)
    await db.profiles.add(makeProfile({ id: OTHER }))
    await db.bills.add(makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER, synced_at: null }))
    await db.pending_mutations.add(queueEntry(OTHER))

    const result = await ensureDeviceOwnedBy(ME)

    expect(await db.bills.get('b-theirs')).toBeTruthy()
    expect(await db.pending_mutations.count()).toBe(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(OTHER)
    // Shape not pinned by the plan: any result naming the need to confirm/warn about unsent work.
    expect(JSON.stringify(result ?? null)).toMatch(/confirm|warn|unsent/i)
  })
})

describe('ensureDeviceOwnedBy — no owner key (upgraded device, H1.4)', () => {
  it('adopts an empty device and records the owner', async () => {
    await ensureDeviceOwnedBy(ME)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('C34: adopts the same user’s mirror — own profile present, contacts linked to other accounts', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: ME }),
      makeProfile({ id: 'acct-friend' }),
      makeProfile({ id: 'c-friend', is_local: true, owner_id: ME, linked_profile_id: 'acct-friend' }),
      makeProfile({ id: 'c-plain', is_local: true, owner_id: ME }),
    ])
    await db.bills.add(makeBill({ id: 'b-mine', created_by: ME, paid_by: ME }))
    await db.pending_mutations.add(queueEntry(ME))

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.count()).toBe(4)
    expect(await db.bills.get('b-mine')).toBeTruthy()
    expect(await db.pending_mutations.count()).toBe(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('adopts when the only foreign-owned row is another user’s contact LINKED to me (049 exception)', async () => {
    await db.profiles.add(
      makeProfile({ id: 'their-contact-of-me', is_local: true, owner_id: OTHER, linked_profile_id: ME }),
    )

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.get('their-contact-of-me')).toBeTruthy()
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('adopts when a foreign account row IS referenced by one of my contacts (own row not yet seeded)', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'acct-friend' }),
      makeProfile({ id: 'c-friend', is_local: true, owner_id: ME, linked_profile_id: 'acct-friend' }),
    ])

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.count()).toBe(2)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('wipes when a queued write was made by another actor', async () => {
    await db.profiles.add(makeProfile({ id: 'c-x', is_local: true, owner_id: ME }))
    await db.pending_mutations.add(queueEntry(OTHER))

    await ensureDeviceOwnedBy(ME)

    expect(await db.pending_mutations.count()).toBe(0)
    expect(await db.profiles.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('wipes when a local contact is owned by someone else and not linked to me', async () => {
    await db.profiles.add(makeProfile({ id: 'c-theirs', is_local: true, owner_id: OTHER, linked_profile_id: null }))
    await db.bills.add(makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER }))

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.get('c-theirs')).toBeUndefined()
    expect(await db.bills.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  // review-2 H2.3: user A's leftover mirror (a non-voluntary sign-out never wiped) where A's only
  // contacts are linked to B and B's account row was hydrated in. My own row being present used to
  // short-circuit to "adopt", handing A's account row, groups and bills to B.
  it('H2.3: wipes a previous user’s mirror whose contacts all link to me, even with my row hydrated', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: OTHER }),
      makeProfile({ id: ME }),
      makeProfile({ id: 'c-me', is_local: true, owner_id: OTHER, linked_profile_id: ME }),
    ])
    await db.bills.add(makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER }))

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.get(OTHER)).toBeUndefined()
    expect(await db.bills.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  // The same ruling's other half: unsent work that is provably all mine is never wiped, even when
  // a stray account row would otherwise condemn the mirror (wiping costs a resync; this would be lost).
  it('H2.3: adopts when every unsent change is mine, despite a stray account row', async () => {
    await db.profiles.bulkAdd([makeProfile({ id: ME }), makeProfile({ id: 'acct-stray' })])
    await db.bills.add(makeBill({ id: 'b-unsent', created_by: ME, paid_by: ME, synced_at: null }))

    await ensureDeviceOwnedBy(ME)

    expect(await db.bills.get('b-unsent')).toBeTruthy()
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('H2.3: a never-pushed row authored by someone else does not count as mine', async () => {
    await db.profiles.add(makeProfile({ id: OTHER }))
    await db.bills.bulkAdd([
      makeBill({ id: 'b-mine', created_by: ME, paid_by: ME, synced_at: null }),
      makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER, synced_at: null }),
    ])

    await ensureDeviceOwnedBy(ME)

    expect(await db.bills.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })

  it('wipes when an unreferenced foreign account row is present and my own row is absent', async () => {
    await db.profiles.add(makeProfile({ id: OTHER }))
    await db.bills.add(makeBill({ id: 'b-theirs', created_by: OTHER, paid_by: OTHER }))

    await ensureDeviceOwnedBy(ME)

    expect(await db.profiles.get(OTHER)).toBeUndefined()
    expect(await db.bills.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe(ME)
  })
})
