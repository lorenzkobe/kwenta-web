import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { resetSubmissionIdSupport, submitCloudWrite } from '@/sync/cloud-write'
import { readLastRefreshAt } from '@/lib/kwenta-storage-keys'
import { fetchBalancesOverview } from '@/api/balances'
import { clearPrimedReads, markReadMounted, markReadUnmounted } from '@/api/primed-reads'
import { makeBill, resetDb } from '../helpers/db'

/**
 * A write asks the server to recompute the screens that are on display and returns them with the
 * stored rows, so the re-read that follows costs no request.
 *
 * Why it cannot be done any other way: the balance a mutation moves is computed in SQL (CLAUDE.md
 * rule 8), so it is not derivable on the client from the rows the write echoes back. Recomputing
 * it here would be a second implementation of every money rule — exactly what the 052–064
 * migration removed.
 */

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop',
  calls: 0,
  submissionIds: [] as (string | undefined)[],
  rejectSubmissionId: false,
  rejectWriteRpc: false,
  seen: new Map<string, Record<string, string[]>>(),
  readSpecs: [] as Record<string, unknown>[][],
  readPayloads: {} as Record<string, unknown>,
  rpcNames: [] as string[],
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

const RAW_OVERVIEW = {
  personalReceive: { PHP: '50' },
  personalPay: {},
  combinedReceive: { PHP: '50' },
  combinedPay: {},
  groupReceive: {},
  groupPay: {},
}

function payloadFor(id: string) {
  return { bills: [makeBill({ id, group_id: null, created_by: 'ME', paid_by: 'ME' })] }
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  clearPrimedReads()
  cloud.mode = 'ok'
  cloud.calls = 0
  cloud.submissionIds = []
  cloud.rejectSubmissionId = false
  cloud.rejectWriteRpc = false
  cloud.seen = new Map()
  cloud.readSpecs = []
  cloud.readPayloads = {}
  cloud.rpcNames = []
  resetSubmissionIdSupport()
})

describe('a write carries the screens that are on display', () => {
  it('asks for exactly the mounted endpoints', async () => {
    await fetchBalancesOverview('ME') // gives the registry this endpoint's RPC spec
    markReadMounted('overview')

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    expect(cloud.readSpecs).toEqual([[{ key: 'overview', fn: 'kwenta_balances_overview' }]])
  })

  it('asks for nothing when no screen is mounted', async () => {
    // A background replay of a queued offline write has no screen behind it; paying the server to
    // recompute payloads nobody is looking at would be pure waste.
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    expect(cloud.readSpecs).toEqual([[]])
  })

  it('does not ask for a screen that has since unmounted', async () => {
    await fetchBalancesOverview('ME')
    markReadMounted('overview')
    markReadUnmounted('overview')

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    expect(cloud.readSpecs).toEqual([[]])
  })

  it('serves the returned payload to the next read without a request', async () => {
    await fetchBalancesOverview('ME')
    markReadMounted('overview')
    cloud.readPayloads = { overview: RAW_OVERVIEW }

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    cloud.rpcNames = []
    const overview = await fetchBalancesOverview('ME')

    expect(cloud.rpcNames).toEqual([])
    expect(overview.data.combinedReceive).toEqual({ PHP: 50 })
    expect(overview.fromCache).toBe(false)
  })

  it('primes nothing when the write is rejected', async () => {
    // Nothing was applied, so there is no new state to show. Priming here would paint a screen
    // with numbers from a write that did not happen.
    await fetchBalancesOverview('ME')
    markReadMounted('overview')
    cloud.readPayloads = { overview: RAW_OVERVIEW }
    cloud.mode = 'drop'

    await expect(
      submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') }),
    ).rejects.toThrow()

    expect(await db.bills.get('B1')).toBeUndefined()

    cloud.rpcNames = []
    await fetchBalancesOverview('ME').catch(() => undefined)
    // It had to go and ask, because nothing was primed.
    expect(cloud.rpcNames).toEqual(['kwenta_balances_overview'])
  })
})

describe('the write no longer downloads the whole dataset', () => {
  it('does not claim the local mirror was refreshed', async () => {
    // `kwenta_write` returns only this submission's rows, so the mirror is NOT up to date after
    // it. Stamping the refresh marker would permanently satisfy the backup timer's staleness gate
    // and the initial-hydration check, and the mirror would quietly stop refreshing.
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    expect(readLastRefreshAt()).toBeNull()
  })

  it('still mirrors the stored rows into Dexie', async () => {
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    const stored = await db.bills.get('B1')
    expect(stored).toBeDefined()
    expect(stored?.synced_at).toBe(stored?.updated_at)
  })
})

describe('against a database without migration 066', () => {
  it('falls back to kwenta_sync and still saves', async () => {
    cloud.rejectWriteRpc = true

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'S1' })

    expect(await db.bills.get('B1')).toBeDefined()
    expect(cloud.submissionIds).toEqual(['S1'])
  })

  it('marks the mirror refreshed on that path, because it really did pull everything', async () => {
    cloud.rejectWriteRpc = true

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    expect(readLastRefreshAt()).not.toBeNull()
  })

  it('probes once and then goes straight to the fallback', async () => {
    // The probe costs a failed round trip. Repeating it on every write against an un-migrated
    // database would double the request count for the whole session.
    cloud.rejectWriteRpc = true
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1') })

    cloud.rpcNames = []
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B2') })

    expect(cloud.rpcNames).not.toContain('kwenta_write')
  })

  it('a pre-050 database still falls all the way back to the two-argument sync', async () => {
    // A database old enough to lack 050 certainly lacks 066, so the client walks the whole chain:
    // kwenta_write → kwenta_sync with a submission id → kwenta_sync without one.
    cloud.rejectSubmissionId = true

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'S1' })

    expect(await db.bills.get('B1')).toBeDefined()
    expect(cloud.submissionIds).toEqual([undefined])
  })
})
