import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  getMillisecondsSinceLastPull,
  hasUnsyncedLocalDataForUser,
  isEntityUnsyncedForActor,
  resolvePaidByForPush,
  isRowApplied,
  shouldApplyPulledRow,
  KWENTA_LAST_PULL_STORAGE_KEY,
} from '@/sync/sync-service'
import { makeBill, makeMember, makeProfile, makeSettlement, resetDb } from '../helpers/db'

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

describe('resolvePaidByForPush', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rewrites a linked local-contact payer to the linked profile id', async () => {
    await db.profiles.add(
      makeProfile({ id: 'LOCAL', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
    )
    expect(await resolvePaidByForPush('LOCAL')).toBe('REMOTE')
  })

  it('leaves an unlinked id unchanged', async () => {
    await db.profiles.add(makeProfile({ id: 'PLAIN' }))
    expect(await resolvePaidByForPush('PLAIN')).toBe('PLAIN')
  })

  it('leaves an unknown id unchanged', async () => {
    expect(await resolvePaidByForPush('GHOST')).toBe('GHOST')
  })
})

describe('isRowApplied', () => {
  it('returns true only when the id is in the applied list for that table', () => {
    const applied = { item_splits: ['a', 'b'], bills: ['x'] }
    expect(isRowApplied(applied as Record<string, string[]>, 'item_splits', 'a')).toBe(true)
    expect(isRowApplied(applied as Record<string, string[]>, 'item_splits', 'z')).toBe(false)
    expect(isRowApplied(applied as Record<string, string[]>, 'bills', 'x')).toBe(true)
    expect(isRowApplied(undefined, 'bills', 'x')).toBe(false)
  })
})

describe('shouldApplyPulledRow', () => {
  it('applies when no local row', () => {
    expect(
      shouldApplyPulledRow(undefined, '2026-06-23T12:00:00.000Z'),
    ).toBe(true)
  })

  it('applies over a synced local row', () => {
    expect(
      shouldApplyPulledRow(
        { updated_at: '2026-06-23T11:00:00.000Z', synced_at: '2026-06-23T11:00:00.000Z' },
        '2026-06-23T12:00:00.000Z',
      ),
    ).toBe(true)
  })

  it('does NOT clobber a newer unsynced local edit', () => {
    expect(
      shouldApplyPulledRow(
        { updated_at: '2026-06-23T13:00:00.000Z', synced_at: null },
        '2026-06-23T12:00:00.000Z',
      ),
    ).toBe(false)
  })

  it('applies a strictly newer server row over an older unsynced edit', () => {
    expect(
      shouldApplyPulledRow(
        { updated_at: '2026-06-23T11:00:00.000Z', synced_at: null },
        '2026-06-23T12:00:00.000Z',
      ),
    ).toBe(true)
  })
})

describe('isEntityUnsyncedForActor', () => {
  const SYNCED = '2026-06-23T10:00:00.000Z'

  it('returns false for a null entityId even when the actor has unrelated unsynced rows', async () => {
    // Unrelated unsynced bill owned by ME.
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(makeBill({ id: 'B', created_by: 'ME', synced_at: null }))
    // A mutation with no entity to scope to must not be flagged stuck by unrelated state.
    expect(await isEntityUnsyncedForActor('settlement', null, 'ME')).toBe(false)
  })

  it('flags a profile mutation when a cascade-deleted membership stayed unsynced (deletePerson)', async () => {
    await db.profiles.add(makeProfile({ id: 'PERSON', synced_at: SYNCED }))
    await db.group_members.add(
      makeMember({ group_id: 'G', user_id: 'PERSON', is_deleted: true, synced_at: null }),
    )
    expect(await isEntityUnsyncedForActor('profile', 'PERSON', 'ME')).toBe(true)
  })

  it('flags a profile mutation when a cascade-deleted settlement stayed unsynced', async () => {
    await db.profiles.add(makeProfile({ id: 'PERSON', synced_at: SYNCED }))
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'PERSON', to_user_id: 'ME', is_deleted: true, synced_at: null }),
    )
    expect(await isEntityUnsyncedForActor('profile', 'PERSON', 'ME')).toBe(true)
  })

  it('returns false for a profile mutation whose row and cascade all synced', async () => {
    await db.profiles.add(makeProfile({ id: 'PERSON', synced_at: SYNCED }))
    await db.group_members.add(
      makeMember({ group_id: 'G', user_id: 'PERSON', is_deleted: true, synced_at: SYNCED }),
    )
    expect(await isEntityUnsyncedForActor('profile', 'PERSON', 'ME')).toBe(false)
  })
})
