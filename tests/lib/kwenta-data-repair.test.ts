import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  previewSettlementRepair,
  repairSettlementsViaServer,
  maybeAutoRepairData,
  __resetAutoRepairGuardForTests,
} from '@/lib/kwenta-data-repair'
import { makeSettlement, resetDb } from '../helpers/db'

/**
 * Repair is server-authoritative (migration 048). The rules themselves live in SQL and are NOT
 * covered by this runner (no Postgres) — verify those against a branch database by hand. What
 * matters here is the client contract:
 *
 *   - it ASKS and never decides — no local soft-deletes, whatever the cache looks like
 *   - it mirrors the server's result back into Dexie, and says so honestly when that mirror fails
 *   - it never throws from the automatic path, and retries next session on failure
 *
 * The "never decides" tests are the regression guard for the bug that deleted real payments: a
 * device cannot see other users' account profiles, so anything it concludes about existence from
 * its own cache is a guess.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] as string[] })),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

vi.mock('@/sync/sync-service', () => ({ fullSync: mocks.fullSync }))

const CLEAN = { orphans: 0, duplicates: 0, canonicalized: 0, total: 0, dryRun: false }

beforeEach(async () => {
  await resetDb()
  __resetAutoRepairGuardForTests()
  mocks.rpc.mockReset()
  mocks.fullSync.mockReset()
  mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] })
  mocks.rpc.mockResolvedValue({ data: { orphans: 0, duplicates: 0, canonicalized: 0, total: 0 }, error: null })
})

describe('repairSettlementsViaServer', () => {
  it('delegates the decision to the server RPC', async () => {
    mocks.rpc.mockResolvedValue({
      data: { orphans: 2, duplicates: 1, canonicalized: 3, total: 6 },
      error: null,
    })

    const result = await repairSettlementsViaServer('me')

    expect(mocks.rpc).toHaveBeenCalledWith('kwenta_repair_settlements', { p_dry_run: false })
    expect(result).toEqual({ orphans: 2, duplicates: 1, canonicalized: 3, total: 6, dryRun: false })
  })

  it('mirrors the repair back into Dexie only when something changed', async () => {
    await repairSettlementsViaServer('me')
    expect(mocks.fullSync).not.toHaveBeenCalled()

    mocks.rpc.mockResolvedValue({ data: { ...CLEAN, orphans: 1, total: 1 }, error: null })
    await repairSettlementsViaServer('me')
    expect(mocks.fullSync).toHaveBeenCalledWith('me')
  })

  it('mirrors through the deduping wrapper, not the raw round trip', async () => {
    // fullSync serializes round trips per user. Calling syncRoundTrip directly let the repair's
    // pull overlap with the sync manager's; since every bundle carries the COMPLETE row set, the
    // loser could write its older snapshot over a row the winner had just synced.
    mocks.rpc.mockResolvedValue({ data: { ...CLEAN, orphans: 1, total: 1 }, error: null })
    await repairSettlementsViaServer('me')
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('reports a failed mirror as a failure, not as a successful repair', async () => {
    // syncRoundTrip/fullSync signal failure by RETURNING errors, never by throwing. Dropping that
    // channel showed a green "removed 3" toast while Dexie still held every bad row.
    mocks.rpc.mockResolvedValue({ data: { ...CLEAN, orphans: 3, total: 3 }, error: null })
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: ['kwenta_sync: offline'] })

    await expect(repairSettlementsViaServer('me')).rejects.toThrow(/could not refresh this device/i)
  })

  it('never soft-deletes a payment locally, even one whose counterparty is invisible here', async () => {
    // The original data-loss shape: a real payment to an account this device cannot see. The
    // client must leave it completely alone and let the server judge.
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'me', to_user_id: 'invisibleAccount', amount: 500 }),
    )

    await repairSettlementsViaServer('me')

    const row = await db.settlements.get('S')
    expect(row?.is_deleted).toBe(false)
    expect(row?.synced_at).not.toBeNull() // untouched, so still considered synced
  })

  it('surfaces an RPC failure to the caller', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(repairSettlementsViaServer('me')).rejects.toBeTruthy()
  })

  it('treats a malformed RPC response as "nothing repaired" rather than guessing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect(await repairSettlementsViaServer('me')).toEqual(CLEAN)
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })
})

describe('previewSettlementRepair', () => {
  it('asks the server what it would change and writes nothing', async () => {
    mocks.rpc.mockResolvedValue({
      data: { dry_run: true, orphans: 1, duplicates: 0, canonicalized: 2, total: 3 },
      error: null,
    })

    const result = await previewSettlementRepair()

    expect(mocks.rpc).toHaveBeenCalledWith('kwenta_repair_settlements', { p_dry_run: true })
    expect(result).toEqual({ orphans: 1, duplicates: 0, canonicalized: 2, total: 3, dryRun: true })
    // A preview must never trigger the mirror — there is nothing to mirror.
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })

  it('trusts the server flag over the requested mode', async () => {
    // If an older server ignores p_dry_run and reports dry_run:false, the panel must not label
    // the result "nothing has been changed yet".
    mocks.rpc.mockResolvedValue({ data: { dry_run: false, orphans: 1, total: 1 }, error: null })
    expect((await previewSettlementRepair()).dryRun).toBe(false)
  })
})

describe('maybeAutoRepairData', () => {
  it('runs the server repair once per session', async () => {
    await maybeAutoRepairData('me')
    await maybeAutoRepairData('me')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)

    // A fresh session (page reload, or sign-out) checks again.
    __resetAutoRepairGuardForTests()
    await maybeAutoRepairData('me')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('never throws when the repair fails, and retries next session', async () => {
    mocks.rpc.mockRejectedValue(new Error('network down'))

    await expect(maybeAutoRepairData('me')).resolves.toBeUndefined()

    // Guard not consumed by a failure.
    mocks.rpc.mockResolvedValue({ data: CLEAN, error: null })
    await maybeAutoRepairData('me')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('does not consume the guard when only the mirror failed', async () => {
    mocks.rpc.mockResolvedValue({ data: { ...CLEAN, orphans: 1, total: 1 }, error: null })
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: ['offline'] })

    await expect(maybeAutoRepairData('me')).resolves.toBeUndefined()

    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] })
    await maybeAutoRepairData('me')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('leaves local rows untouched no matter what the cache contains', async () => {
    await db.settlements.add(
      makeSettlement({ id: 'S', from_user_id: 'ghost', to_user_id: 'me', amount: 40 }),
    )

    await maybeAutoRepairData('me')

    expect((await db.settlements.get('S'))?.is_deleted).toBe(false)
  })
})
