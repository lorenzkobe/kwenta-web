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
} from '@/sync/cloud-first-mutations'
import { resetDb } from '../helpers/db'

// Controllable stubs for the sync layer this module depends on.
const h = vi.hoisted(() => ({
  state: { syncErrors: [] as string[], hasUnsynced: false },
}))

vi.mock('@/sync/sync-service', () => ({
  syncRoundTrip: async () => ({ errors: h.state.syncErrors }),
  hasUnsyncedLocalDataForUser: async () => h.state.hasUnsynced,
}))

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

beforeEach(async () => {
  await resetDb()
  h.state.syncErrors = []
  h.state.hasUnsynced = false
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
