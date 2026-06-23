import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  CloudFirstMutationError,
  dismissNotAppliedChange,
  enqueuePendingMutation,
  finalizeMutationSync,
  listPendingConflictsForActor,
  markNotAppliedChangeReapplied,
  markPendingMutationsApplied,
  markPendingMutationsConflict,
  recordNotAppliedChange,
  resolveConflictsForEntity,
  retryNotAppliedChange,
} from '@/sync/cloud-first-mutations'
import { resetDb } from '../helpers/db'

// Controllable stubs for the sync layer this module depends on.
const h = vi.hoisted(() => ({
  state: {
    syncErrors: [] as string[],
    hasUnsynced: false,
    // Per-entity unsynced set: if an entityId is in this set, isEntityUnsyncedForActor
    // returns true for that entity. If not present, falls back to state.hasUnsynced.
    unsyncedEntities: new Set<string>(),
  },
}))

vi.mock('@/sync/sync-service', () => ({
  syncRoundTrip: async () => ({ errors: h.state.syncErrors }),
  hasUnsyncedLocalDataForUser: async () => h.state.hasUnsynced,
  isEntityUnsyncedForActor: async (_entityType: string, entityId: string | null | undefined) => {
    if (entityId && h.state.unsyncedEntities.has(entityId)) return true
    if (entityId && h.state.unsyncedEntities.size > 0 && !h.state.unsyncedEntities.has(entityId)) return false
    return h.state.hasUnsynced
  },
}))

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

beforeEach(async () => {
  await resetDb()
  h.state.syncErrors = []
  h.state.hasUnsynced = false
  h.state.unsyncedEntities = new Set()
  setOnline(true)
})

afterEach(() => {
  setOnline(true)
})

const base = {
  actorUserId: 'ME',
  operation: 'createBill',
  entityType: 'bill' as const,
  entityId: 'B1',
}

describe('enqueuePendingMutation', () => {
  it('creates a pending row with a serialized payload', async () => {
    const id = await enqueuePendingMutation({ ...base, payload: { a: 1 } })
    const row = await db.pending_mutations.get(id)
    expect(row?.status).toBe('pending')
    expect(row?.entity_type).toBe('bill')
    expect(JSON.parse(row!.payload_json)).toEqual({ a: 1 })
  })
})

describe('markPendingMutationsApplied', () => {
  it('marks pending mutations applied when nothing is unsynced', async () => {
    await enqueuePendingMutation(base)
    await markPendingMutationsApplied('ME')
    const rows = await db.pending_mutations.where('actor_user_id').equals('ME').toArray()
    expect(rows.every((r) => r.status === 'applied')).toBe(true)
  })

  it('leaves mutations pending when unsynced data remains', async () => {
    await enqueuePendingMutation(base)
    h.state.hasUnsynced = true
    await markPendingMutationsApplied('ME')
    const rows = await db.pending_mutations.where('actor_user_id').equals('ME').toArray()
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })
})

describe('markPendingMutationsConflict', () => {
  it('marks pending rows conflict and records a not-applied change', async () => {
    await enqueuePendingMutation(base)
    await markPendingMutationsConflict('ME', 'sync_error', 'boom')

    const pending = await db.pending_mutations.where('actor_user_id').equals('ME').first()
    expect(pending?.status).toBe('conflict')
    expect(pending?.last_error).toBe('boom')
    expect(pending?.retry_count).toBe(1)

    const conflicts = await listPendingConflictsForActor('ME')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason_message).toBe('boom')
  })

  it('does not create a duplicate not-applied change for the same mutation', async () => {
    await enqueuePendingMutation(base)
    await markPendingMutationsConflict('ME', 'sync_error', 'boom')
    // Re-flag: the pending row is already conflict, so no new pending rows match;
    // even if it did, the dedupe guard prevents a second not_applied_changes row.
    await markPendingMutationsConflict('ME', 'sync_error', 'boom again')
    expect(await db.not_applied_changes.count()).toBe(1)
  })
})

describe('not-applied change resolution', () => {
  it('dismiss and reapply set the resolution + resolved_at', async () => {
    const id = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'sync_error',
      reasonMessage: 'x',
    })
    await dismissNotAppliedChange(id)
    expect((await db.not_applied_changes.get(id))?.resolution).toBe('dismissed')

    const id2 = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B2',
      reasonCode: 'sync_error',
      reasonMessage: 'y',
    })
    await markNotAppliedChangeReapplied(id2)
    expect((await db.not_applied_changes.get(id2))?.resolution).toBe('reapplied')
  })

  it('listPendingConflictsForActor returns only pending, newest first', async () => {
    await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'a',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'c',
      reasonMessage: 'old',
    })
    const dismissed = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'b',
      entityType: 'bill',
      entityId: 'B2',
      reasonCode: 'c',
      reasonMessage: 'dismissed',
    })
    await dismissNotAppliedChange(dismissed)

    const rows = await listPendingConflictsForActor('ME')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_message).toBe('old')
  })

  it('resolveConflictsForEntity updates all pending changes for the entity', async () => {
    await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'a',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'c',
      reasonMessage: 'm',
    })
    await resolveConflictsForEntity('bill', 'B1', 'auto_resolved')
    const row = await db.not_applied_changes.where('entity_id').equals('B1').first()
    expect(row?.resolution).toBe('auto_resolved')
  })

  it('resolveConflictsForEntity is a no-op without an entity id', async () => {
    await expect(resolveConflictsForEntity('bill', null, 'auto_resolved')).resolves.toBeUndefined()
  })
})

describe('finalizeMutationSync', () => {
  it('only enqueues a pending mutation while offline', async () => {
    setOnline(false)
    await finalizeMutationSync(base)
    const rows = await db.pending_mutations.where('actor_user_id').equals('ME').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
  })

  it('marks the mutation applied on a clean sync', async () => {
    await finalizeMutationSync(base)
    const row = await db.pending_mutations.where('actor_user_id').equals('ME').first()
    expect(row?.status).toBe('applied')
  })

  it('auto-resolves prior pending conflicts for the entity on success', async () => {
    const changeId = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'sync_error',
      reasonMessage: 'earlier',
    })
    await finalizeMutationSync(base)
    expect((await db.not_applied_changes.get(changeId))?.resolution).toBe('auto_resolved')
  })

  it('records a conflict and throws on sync error', async () => {
    h.state.syncErrors = ['server rejected']
    await expect(finalizeMutationSync(base)).rejects.toBeInstanceOf(CloudFirstMutationError)

    const row = await db.pending_mutations.where('actor_user_id').equals('ME').first()
    expect(row?.status).toBe('conflict')
    expect(row?.last_error).toBe('server rejected')
    const conflicts = await listPendingConflictsForActor('ME')
    expect(conflicts).toHaveLength(1)
  })
})

describe('finalizeMutationSync surfaces silently-dropped writes', () => {
  beforeEach(async () => {
    await resetDb()
    h.state.syncErrors = []
    h.state.hasUnsynced = false
    h.state.unsyncedEntities = new Set()
  })

  it('does NOT mark applied when sync returned no errors but the row is still unsynced', async () => {
    h.state.hasUnsynced = true
    await finalizeMutationSync({
      actorUserId: 'ME', operation: 'create_bill', entityType: 'bill', entityId: 'B1',
    })
    const muts = await db.pending_mutations.where('actor_user_id').equals('ME').toArray()
    expect(muts[0].status).not.toBe('applied') // left pending for retry
    expect(muts[0].retry_count).toBeGreaterThan(0)
  })

  it('records a not_applied_change once retries exceed the threshold', async () => {
    h.state.hasUnsynced = true
    for (let i = 0; i < 3; i++) {
      const pending = await db.pending_mutations.where('actor_user_id').equals('ME').first()
      await finalizeMutationSync({
        actorUserId: 'ME', operation: 'create_bill', entityType: 'bill', entityId: 'B1',
        pendingMutationId: pending?.id,
      }).catch(() => {})
    }
    const changes = await db.not_applied_changes.where('actor_user_id').equals('ME').toArray()
    expect(changes.some((c) => c.reason_code === 'silently_dropped')).toBe(true)
  })

  it('marks applied normally when sync clean and nothing unsynced', async () => {
    h.state.hasUnsynced = false
    await finalizeMutationSync({
      actorUserId: 'ME', operation: 'create_bill', entityType: 'bill', entityId: 'B1',
    })
    const muts = await db.pending_mutations.where('actor_user_id').equals('ME').toArray()
    expect(muts[0].status).toBe('applied')
  })
})

describe('finalizeMutationSync blast-radius scoping', () => {
  beforeEach(async () => {
    await resetDb()
    h.state.syncErrors = []
    h.state.hasUnsynced = false
    h.state.unsyncedEntities = new Set()
  })

  it('marks B1 applied even when an UNRELATED entity OTHER is permanently unsynced', async () => {
    // OTHER (a different bill) is permanently stuck unsynced.
    // B1 (the entity we just wrote) is synced -- it should NOT be blocked by OTHER.
    h.state.unsyncedEntities = new Set(['OTHER'])
    // h.state.hasUnsynced is NOT used when unsyncedEntities has entries and entityId is known.

    await finalizeMutationSync({
      actorUserId: 'ME',
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
    })

    const row = await db.pending_mutations.where('actor_user_id').equals('ME').first()
    expect(row?.status).toBe('applied')
  })

  it('leaves B1 pending when B1 itself is the unsynced entity', async () => {
    h.state.unsyncedEntities = new Set(['B1'])

    await finalizeMutationSync({
      actorUserId: 'ME',
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
    })

    const row = await db.pending_mutations.where('actor_user_id').equals('ME').first()
    expect(row?.status).not.toBe('applied')
    expect(row?.retry_count).toBeGreaterThan(0)
  })
})

describe('retryNotAppliedChange', () => {
  it('marks reapplied when the retry sync clears all unsynced data', async () => {
    h.state.syncErrors = []
    h.state.hasUnsynced = false
    const id = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'create_bill',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'sync_error',
      reasonMessage: 'x',
    })
    const change = await db.not_applied_changes.get(id)
    const { retryNotAppliedChange } = await import('@/sync/cloud-first-mutations')
    expect(await retryNotAppliedChange(change!)).toBe(true)
    expect((await db.not_applied_changes.get(id))?.resolution).toBe('reapplied')
  })

  it('returns false and leaves it pending when retry still fails', async () => {
    h.state.syncErrors = ['boom']
    const id = await recordNotAppliedChange({
      actorUserId: 'ME',
      operation: 'create_bill',
      entityType: 'bill',
      entityId: 'B2',
      reasonCode: 'sync_error',
      reasonMessage: 'x',
    })
    const change = await db.not_applied_changes.get(id)
    const { retryNotAppliedChange } = await import('@/sync/cloud-first-mutations')
    expect(await retryNotAppliedChange(change!)).toBe(false)
    expect((await db.not_applied_changes.get(id))?.resolution).toBe('pending')
  })
})

describe('retryNotAppliedChange', () => {
  it('resolves BOTH the not-applied change and its still-pending mutation', async () => {
    // A mutation stuck 'pending' with a surfaced not_applied_change (the stuck-detection path).
    const pendingId = await enqueuePendingMutation({ ...base })
    await recordNotAppliedChange({
      actorUserId: 'ME',
      pendingMutationId: pendingId,
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'silently_dropped',
      reasonMessage: 'x',
    })
    const change = (await listPendingConflictsForActor('ME'))[0]
    expect(change.pending_mutation_id).toBe(pendingId)

    h.state.syncErrors = []
    h.state.hasUnsynced = false
    const ok = await retryNotAppliedChange(change)

    expect(ok).toBe(true)
    expect((await db.not_applied_changes.get(change.id))?.resolution).toBe('reapplied')
    // The bug: leaving the mutation 'pending' let a later sync error escalate it to a
    // spurious 'conflict' and spawn a fresh not_applied_change for already-saved data.
    expect((await db.pending_mutations.get(pendingId))?.status).toBe('applied')
  })

  it('does not resolve anything when the entity is still unsynced after retry', async () => {
    const pendingId = await enqueuePendingMutation({ ...base })
    await recordNotAppliedChange({
      actorUserId: 'ME',
      pendingMutationId: pendingId,
      operation: 'createBill',
      entityType: 'bill',
      entityId: 'B1',
      reasonCode: 'silently_dropped',
      reasonMessage: 'x',
    })
    const change = (await listPendingConflictsForActor('ME'))[0]

    h.state.syncErrors = []
    h.state.unsyncedEntities = new Set(['B1']) // still stuck

    const ok = await retryNotAppliedChange(change)
    expect(ok).toBe(false)
    expect((await db.not_applied_changes.get(change.id))?.resolution).toBe('pending')
    expect((await db.pending_mutations.get(pendingId))?.status).toBe('pending')
  })
})
