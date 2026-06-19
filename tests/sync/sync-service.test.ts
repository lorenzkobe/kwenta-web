import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  getMillisecondsSinceLastPull,
  hasUnsyncedLocalDataForUser,
  KWENTA_LAST_PULL_STORAGE_KEY,
} from '@/sync/sync-service'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

// sync-service imports the Supabase client at module load; neither function
// under test makes a network call, so a benign stub is enough.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
})

describe('getMillisecondsSinceLastPull', () => {
  it('returns Infinity when no cursor is stored', () => {
    expect(getMillisecondsSinceLastPull()).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns Infinity for an unparseable cursor', () => {
    localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, 'not-a-date')
    expect(getMillisecondsSinceLastPull()).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns the elapsed time for a valid cursor', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, tenMinutesAgo)
    const elapsed = getMillisecondsSinceLastPull()
    expect(elapsed).toBeGreaterThanOrEqual(10 * 60 * 1000 - 2000)
    expect(elapsed).toBeLessThan(11 * 60 * 1000)
  })

  it('never returns a negative value for a future cursor', () => {
    localStorage.setItem(
      KWENTA_LAST_PULL_STORAGE_KEY,
      new Date(Date.now() + 60_000).toISOString(),
    )
    expect(getMillisecondsSinceLastPull()).toBe(0)
  })
})

describe('hasUnsyncedLocalDataForUser', () => {
  it('returns false for an empty database', async () => {
    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(false)
  })

  it('returns false when every row is already synced', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(makeBill({ id: 'B', created_by: 'ME', paid_by: 'ME' }))
    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(false)
  })

  it("detects the user's own unsynced bill", async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(makeBill({ id: 'B', created_by: 'ME', paid_by: 'ME', synced_at: null }))
    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(true)
  })

  it('ignores unsynced rows the user is not allowed to push (RLS filtered)', async () => {
    await db.profiles.bulkAdd([makeProfile({ id: 'ME' }), makeProfile({ id: 'OTHER' })])
    // A bill created by someone else, in no shared group — ME cannot push it.
    await db.bills.add(
      makeBill({ id: 'B', created_by: 'OTHER', paid_by: 'OTHER', group_id: null, synced_at: null }),
    )
    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(false)
  })

  it('treats updated_at newer than synced_at as unsynced', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(
      makeBill({
        id: 'B',
        created_by: 'ME',
        paid_by: 'ME',
        synced_at: '2026-06-18T00:00:00.000Z',
        updated_at: '2026-06-18T01:00:00.000Z',
      }),
    )
    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(true)
  })
})
