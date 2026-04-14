import { db } from '@/db/db'
import type { MutationEntityType, NotAppliedChange, PendingMutation } from '@/types'
import { generateId, now } from '@/lib/utils'
import { syncRoundTrip } from '@/sync/sync-service'

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

  await db.pending_mutations.update(pendingId, {
    status: 'applied',
    updated_at: now(),
    last_error: null,
  })
  await resolveConflictsForEntity(input.entityType, input.entityId ?? null, 'auto_resolved')
}

