import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { syncRoundTrip, KWENTA_LAST_REFRESH_STORAGE_KEY, PULL_SINCE_EPOCH } from '@/sync/sync-service'
import { makeProfile, makeSettlement, resetDb } from '../helpers/db'

/**
 * Round-trip behaviour of the cloud-first read path: every sync asks for the COMPLETE bundle and
 * mirrors it into Dexie. These are the guarantees that replaced the incremental cursor — the
 * cursor could permanently skip rows (client clock) and made server-side changes undeliverable,
 * which is what forced "reset local data" to recover.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  session: { user: { id: 'me' } } as { user: { id: string } } | null,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: { getSession: async () => ({ data: { session: mocks.session } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

const EMPTY_BUNDLE = {
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

function bundleWith(over: Partial<typeof EMPTY_BUNDLE>) {
  return { ...EMPTY_BUNDLE, ...over }
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  mocks.session = { user: { id: 'me' } }
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: EMPTY_BUNDLE, error: null })
})

describe('syncRoundTrip', () => {
  it('always requests the complete bundle, never a delta from a stored marker', async () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, '2026-07-01T00:00:00.000Z')

    await syncRoundTrip('me')

    expect(mocks.rpc).toHaveBeenCalledWith('kwenta_sync', {
      p_since: PULL_SINCE_EPOCH,
      p_push: expect.anything(),
    })
  })

  it('applies a server row the device has never seen, with no cursor reset', async () => {
    // The regression that forced a local wipe: a row whose updated_at predates the device's
    // bookmark (e.g. hand-fixed on the server, or newly visible after a profile link) was
    // invisible forever. A full bundle delivers it on the next sync.
    const old = makeSettlement({
      id: 'S',
      from_user_id: 'them',
      to_user_id: 'me',
      amount: 500,
      updated_at: '2020-01-01T00:00:00.000Z',
    })
    mocks.rpc.mockResolvedValue({ data: bundleWith({ settlements: [old] }), error: null })

    const result = await syncRoundTrip('me')

    expect(result.errors).toEqual([])
    const stored = await db.settlements.get('S')
    expect(stored?.amount).toBe(500)
    // Mirrored rows count as synced, so they are not pushed straight back.
    expect(stored?.synced_at).toBe(old.updated_at)
  })

  it('resurrects a row the server says is live (is_deleted flipped back)', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S', to_user_id: 'me', amount: 500, is_deleted: true }),
    )
    mocks.rpc.mockResolvedValue({
      data: bundleWith({
        settlements: [
          makeSettlement({
            id: 'S',
            to_user_id: 'me',
            amount: 500,
            is_deleted: false,
            updated_at: '2026-08-01T00:00:00.000Z',
          }),
        ],
      }),
      error: null,
    })

    await syncRoundTrip('me')

    expect((await db.settlements.get('S'))?.is_deleted).toBe(false)
  })

  it('keeps a rejected local edit queued when the server reports it was not applied', async () => {
    // Migration 044 contract: a row missing from `applied` was NOT stored, so it must stay
    // unsynced and retry — and the server's older copy of it must not overwrite the local edit.
    await db.profiles.add(
      makeProfile({
        id: 'me',
        display_name: 'Edited offline',
        updated_at: '2026-08-02T00:00:00.000Z',
        synced_at: null,
      }),
    )
    mocks.rpc.mockResolvedValue({
      data: {
        ...bundleWith({
          profiles: [
            makeProfile({
              id: 'me',
              display_name: 'Stale server copy',
              updated_at: '2026-08-01T00:00:00.000Z',
            }),
          ],
        }),
        applied: {}, // server stored nothing
      },
      error: null,
    })

    await syncRoundTrip('me')

    const profile = await db.profiles.get('me')
    expect(profile?.display_name).toBe('Edited offline')
    expect(profile?.synced_at).toBeNull() // still queued for the next push
  })

  it('refuses a server echo older than what it just pushed, even without an applied map', async () => {
    // Pre-044 servers report nothing about what they stored, so a silently dropped push used to
    // be stamped synced and then overwritten by the server's older copy — losing the edit. Full
    // bundles return that older copy on every sync, so the echo must lose to what we sent.
    await db.profiles.add(
      makeProfile({
        id: 'me',
        display_name: 'Edited offline',
        updated_at: '2026-08-02T00:00:00.000Z',
        synced_at: null,
      }),
    )
    mocks.rpc.mockResolvedValue({
      data: bundleWith({
        profiles: [
          makeProfile({
            id: 'me',
            display_name: 'Stale server copy',
            updated_at: '2026-08-01T00:00:00.000Z',
          }),
        ],
      }),
      error: null,
    })

    await syncRoundTrip('me')

    const profile = await db.profiles.get('me')
    expect(profile?.display_name).toBe('Edited offline')
    // And it must stay QUEUED. Stamping it synced on the strength of the push alone (the old
    // behaviour) is what made the loss permanent: the row stopped being re-pushed, so on the next
    // sync nothing guarded it and the complete bundle wrote the stale copy over the edit.
    expect(profile?.synced_at).toBeNull()
  })

  it('stamps a pushed row synced when the bundle echoes it back, with no applied map', async () => {
    // The other half of the pre-044 rule: evidence of storage is the echo itself. Without this a
    // row would never settle and every sync would re-push it forever.
    await db.profiles.add(
      makeProfile({
        id: 'me',
        display_name: 'Edited offline',
        updated_at: '2026-08-02T00:00:00.000Z',
        synced_at: null,
      }),
    )
    mocks.rpc.mockResolvedValue({
      data: bundleWith({
        profiles: [
          makeProfile({
            id: 'me',
            display_name: 'Edited offline',
            updated_at: '2026-08-02T00:00:00.000Z',
          }),
        ],
      }),
      error: null,
    })

    await syncRoundTrip('me')

    expect((await db.profiles.get('me'))?.synced_at).toBe('2026-08-02T00:00:00.000Z')
  })

  it('applies a same-instant echo rendered in Postgres timezone format', async () => {
    // Postgres `to_jsonb` renders timestamptz as `...+00:00`; the client writes `...Z`. Comparing
    // those as TEXT ranks '+' (0x2B) below 'Z' (0x5A), so the echo guard read every same-instant
    // echo as "older than what we pushed" and dropped it — silently discarding the server-side
    // party canonicalization (042/045) that comes back in exactly that echo. The payment then kept
    // pointing at the local contact instead of the linked account and never netted against that
    // person's balance.
    await db.settlements.add(
      makeSettlement({
        id: 'S',
        from_user_id: 'local-contact',
        to_user_id: 'me',
        amount: 500,
        updated_at: '2026-08-03T15:04:05.123Z',
        synced_at: null,
      }),
    )
    mocks.rpc.mockResolvedValue({
      data: bundleWith({
        settlements: [
          makeSettlement({
            id: 'S',
            from_user_id: 'remote-account', // canonicalized server-side
            to_user_id: 'me',
            amount: 500,
            updated_at: '2026-08-03T15:04:05.123+00:00',
          }),
        ],
      }),
      error: null,
    })

    await syncRoundTrip('me')

    expect((await db.settlements.get('S'))?.from_user_id).toBe('remote-account')
  })

  it('accepts a server echo that is newer than what it pushed (server wins on conflict)', async () => {
    await db.profiles.add(
      makeProfile({
        id: 'me',
        display_name: 'My offline edit',
        updated_at: '2026-08-02T00:00:00.000Z',
        synced_at: null,
      }),
    )
    mocks.rpc.mockResolvedValue({
      data: bundleWith({
        profiles: [
          makeProfile({
            id: 'me',
            display_name: 'Newer change from my other device',
            updated_at: '2026-08-03T00:00:00.000Z',
          }),
        ],
      }),
      error: null,
    })

    await syncRoundTrip('me')

    expect((await db.profiles.get('me'))?.display_name).toBe('Newer change from my other device')
  })

  it('marks the refresh complete only on success', async () => {
    await syncRoundTrip('me')
    expect(localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)).not.toBeNull()
  })

  it('leaves the cache and the refresh marker untouched when the sync fails', async () => {
    await db.settlements.add(makeSettlement({ id: 'S', to_user_id: 'me', amount: 500 }))
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'network down', code: '500' } })

    const result = await syncRoundTrip('me')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(await db.settlements.get('S')).toBeDefined() // cache still serves the app offline
    expect(localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)).toBeNull()
  })

  it('skips entirely when there is no session', async () => {
    mocks.session = null

    const result = await syncRoundTrip('me')

    expect(result.errors).toEqual(['Sync skipped: not signed in'])
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)).toBeNull()
  })
})
