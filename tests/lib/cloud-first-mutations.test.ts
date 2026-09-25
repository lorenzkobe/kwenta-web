import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  dismissNotAppliedChange,
  enqueuePendingMutation,
  listPendingConflictsForActor,
  markNotAppliedChangeReapplied,
  markPendingMutationsApplied,
  recordNotAppliedChange,
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
