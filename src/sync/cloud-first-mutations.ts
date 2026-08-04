import { db } from '@/db/db'
import type { MutationEntityType, NotAppliedChange, PendingMutation } from '@/types'
import { generateId, now } from '@/lib/utils'
import { hasUnsyncedLocalDataForUser, isEntityUnsyncedForActor, syncRoundTrip } from '@/sync/sync-service'

export class CloudFirstMutationError extends Error {
  code: string

  constructor(message: string, code = 'CLOUD_WRITE_FAILED') {
    super(message)
    this.name = 'CloudFirstMutationError'
    this.code = code
  }
}

type TrackMutationInput = {
  actorUserId: string
  operation: string
  entityType: MutationEntityType
  entityId?: string | null
  payload?: unknown
  routeHint?: string | null
}

type FinalizeMutationInput = TrackMutationInput & {
  pendingMutationId?: string
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? {})
  } catch {
    return '{}'
  }
}

export async function enqueuePendingMutation(input: TrackMutationInput): Promise<string> {
  const timestamp = now()
  const pendingId = generateId()
  const row: PendingMutation = {
    id: pendingId,
    actor_user_id: input.actorUserId,
    operation: input.operation,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    payload_json: serializePayload(input.payload),
    status: 'pending',
    retry_count: 0,
    last_error: null,
    idempotency_key: generateId(),
    created_at: timestamp,
    updated_at: timestamp,
  }
  await db.pending_mutations.put(row)
  return pendingId
}

export async function markPendingMutationsApplied(actorUserId: string): Promise<void> {
  // Don't report success while anything for this actor is still unsynced. A row dropped
  // by push RLS filtering stays synced_at=null even though the sync returned no errors;
  // marking its mutation "applied" would mask a lost write. Leaving it pending lets the
  // next sync retry, and a later clean sync marks everything applied.
  if (await hasUnsyncedLocalDataForUser(actorUserId)) return

  const timestamp = now()
  const pending = await db.pending_mutations
    .where('actor_user_id')
    .equals(actorUserId)
    .filter((m) => m.status === 'pending')
    .toArray()
  for (const row of pending) {
    await db.pending_mutations.update(row.id, {
      status: 'applied',
      updated_at: timestamp,
      last_error: null,
    })
  }
}

export async function markPendingMutationsConflict(
  actorUserId: string,
  reasonCode: string,
  reasonMessage: string,
): Promise<void> {
  const timestamp = now()
  const pending = await db.pending_mutations
    .where('actor_user_id')
    .equals(actorUserId)
    .filter((m) => m.status === 'pending')
    .toArray()
  for (const row of pending) {
    await db.pending_mutations.update(row.id, {
      status: 'conflict',
      updated_at: timestamp,
      retry_count: row.retry_count + 1,
      last_error: reasonMessage,
    })
    const existing = await db.not_applied_changes
      .where('pending_mutation_id')
      .equals(row.id)
      .filter((c) => c.resolution === 'pending')
      .first()
    if (existing) continue
    await recordNotAppliedChange({
      actorUserId,
      pendingMutationId: row.id,
      operation: row.operation,
      entityType: row.entity_type,
      entityId: row.entity_id,
      reasonCode,
      reasonMessage,
      payload: row.payload_json,
      routeHint: null,
    })
  }
}

export async function dismissNotAppliedChange(changeId: string): Promise<void> {
  await db.not_applied_changes.update(changeId, {
    resolution: 'dismissed',
    resolved_at: now(),
  })
}

export async function markNotAppliedChangeReapplied(changeId: string): Promise<void> {
  await db.not_applied_changes.update(changeId, {
    resolution: 'reapplied',
    resolved_at: now(),
  })
}

export async function listPendingConflictsForActor(actorUserId: string): Promise<NotAppliedChange[]> {
  const rows = await db.not_applied_changes
    .where('actor_user_id')
    .equals(actorUserId)
    .filter((r) => r.resolution === 'pending')
    .toArray()
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return rows
}

export async function resolveConflictsForEntity(
  entityType: MutationEntityType,
  entityId: string | null | undefined,
  resolution: NotAppliedChange['resolution'],
): Promise<void> {
  if (!entityId) return
  const rows = await db.not_applied_changes
    .where('[entity_type+entity_id]')
    .equals([entityType, entityId])
    .filter((r) => r.resolution === 'pending')
    .toArray()
  const timestamp = now()
  for (const row of rows) {
    await db.not_applied_changes.update(row.id, {
      resolution,
      resolved_at: timestamp,
    })
  }
}

export async function recordNotAppliedChange(input: {
  actorUserId: string
  pendingMutationId?: string | null
  operation: string
  entityType: MutationEntityType
  entityId?: string | null
  reasonCode: string
  reasonMessage: string
  payload?: unknown
  routeHint?: string | null
}): Promise<string> {
  const id = generateId()
  const timestamp = now()
  const row: NotAppliedChange = {
    id,
    actor_user_id: input.actorUserId,
    pending_mutation_id: input.pendingMutationId ?? null,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    operation: input.operation,
    reason_code: input.reasonCode,
    reason_message: input.reasonMessage,
    payload_json: serializePayload(input.payload),
    route_hint: input.routeHint ?? null,
    created_at: timestamp,
    resolved_at: null,
    resolution: 'pending',
  }
  await db.not_applied_changes.put(row)
  return id
}

export async function retryNotAppliedChange(change: NotAppliedChange): Promise<boolean> {
  const result = await syncRoundTrip(change.actor_user_id)
  if (result.errors.length === 0 && !(await isEntityUnsyncedForActor(change.entity_type, change.entity_id, change.actor_user_id))) {
    await markNotAppliedChangeReapplied(change.id)
    // Also resolve the originating pending_mutation. Left as 'pending', the next sync-error path
    // (markPendingMutationsConflict) would re-escalate this already-saved change to 'conflict'
    // and spawn a fresh not_applied_change — a spurious "could not be saved" notice.
    if (change.pending_mutation_id) {
      await db.pending_mutations.update(change.pending_mutation_id, {
        status: 'applied',
        updated_at: now(),
        last_error: null,
      })
    }
    return true
  }
  return false
}

/**
 * @deprecated Superseded by `commitCloudFirstWrite` (`src/sync/cloud-write.ts`) and no longer
 * called by any operation.
 *
 * This is the OLD write-then-sync shape: the caller committed to Dexie first and called this
 * afterwards, so a rejected write stayed local, still moved balances, and was pushed by a later
 * background sync — the duplicate-bill bug. Do not wire new operations to it. Kept only so the
 * pending-mutation/conflict behaviour it exercises stays covered while the offline replay path
 * (sync-manager) continues to rely on the same helpers; safe to delete with its tests.
 */
export async function finalizeMutationSync(input: FinalizeMutationInput): Promise<void> {
  const isOnline = typeof navigator !== 'undefined' && navigator.onLine
  if (!isOnline) {
    if (!input.pendingMutationId) {
      await enqueuePendingMutation(input)
    }
    return
  }

  const pendingId = input.pendingMutationId ?? (await enqueuePendingMutation(input))
  const result = await syncRoundTrip(input.actorUserId)
  if (result.errors.length > 0) {
    const timestamp = now()
    await db.pending_mutations.update(pendingId, {
      status: 'conflict',
      updated_at: timestamp,
      retry_count: ((await db.pending_mutations.get(pendingId))?.retry_count ?? 0) + 1,
      last_error: result.errors.join(' | '),
    })
    await recordNotAppliedChange({
      actorUserId: input.actorUserId,
      pendingMutationId: pendingId,
      operation: input.operation,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      reasonCode: 'sync_error',
      reasonMessage: result.errors.join(' | '),
      payload: input.payload,
      routeHint: input.routeHint ?? null,
    })
    throw new CloudFirstMutationError('Could not save to cloud. Your change was not applied.', 'SYNC_ERROR')
  }

  // Sync returned no transport error — but a row silently dropped by server RLS stays
  // unsynced (synced_at=null). Do not declare success while the actor still has unsynced
  // data; leave the mutation pending so the next sync retries, and once retries exceed the
  // threshold, surface it as a not_applied_change instead of a silent forever-pending row.
  const STUCK_RETRY_THRESHOLD = 3
  if (await isEntityUnsyncedForActor(input.entityType, input.entityId ?? null, input.actorUserId)) {
    const current = await db.pending_mutations.get(pendingId)
    const retryCount = (current?.retry_count ?? 0) + 1
    await db.pending_mutations.update(pendingId, {
      status: 'pending',
      updated_at: now(),
      retry_count: retryCount,
      last_error: 'Cloud accepted the sync but did not store this change (possibly filtered).',
    })
    if (retryCount >= STUCK_RETRY_THRESHOLD) {
      const existing = await db.not_applied_changes
        .where('pending_mutation_id').equals(pendingId)
        .filter((c) => c.resolution === 'pending').first()
      if (!existing) {
        await recordNotAppliedChange({
          actorUserId: input.actorUserId,
          pendingMutationId: pendingId,
          operation: input.operation,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          reasonCode: 'silently_dropped',
          reasonMessage: 'This change could not be saved to the cloud after several attempts.',
          payload: input.payload,
          routeHint: input.routeHint ?? null,
        })
      }
    }
    return
  }

  await db.pending_mutations.update(pendingId, {
    status: 'applied',
    updated_at: now(),
    last_error: null,
  })
  await resolveConflictsForEntity(input.entityType, input.entityId ?? null, 'auto_resolved')
}

