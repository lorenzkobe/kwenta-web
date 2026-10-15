import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVENT_LOG_TRUST_MS } from '@/sync/sync-service'

/**
 * An open trusts the event log (one probe, then a per-entity catch-up) for up to EVENT_LOG_TRUST_MS
 * since the server last confirmed this device's copy. The housekeeping job in 073 hard-deletes
 * events older than its interval, so a longer trust window would let a catch-up miss changes
 * silently. Lengthen one, check the other.
 */
const migration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/073_client_grants_and_housekeeping.sql'),
  'utf8',
)

describe('event log retention vs the open-time trust window', () => {
  it('trusts the log for less time than the prune job keeps it, with days to spare', () => {
    const match = migration.match(/kwenta_prune_user_events\(now\(\) - interval '(\d+) days'\)/)
    expect(match, 'the prune job schedule in 073').not.toBeNull()
    const pruneMs = Number(match![1]) * 24 * 60 * 60 * 1000
    expect(EVENT_LOG_TRUST_MS).toBeLessThanOrEqual(pruneMs - 3 * 24 * 60 * 60 * 1000)
  })
})
