import { db } from '@/db/db'
import type { MutationEntityType, NotAppliedChange, PendingMutation, WriteFailureKind } from '@/types'
import { generateId, now } from '@/lib/utils'
import { hasUnsyncedLocalDataForUser, isEntityUnsyncedForActor, syncRoundTrip } from '@/sync/sync-service'

type TrackMutationInput = {
  actorUserId: string
  operation: string
  entityType: MutationEntityType
  entityId?: string | null
  payload?: unknown
  routeHint?: string | null
  /** The exact rows to replay. Omitted = a legacy entry, which only the row-scan sync replays. */
  push?: PendingMutation['push']
  rowKeys?: string[]
  submissionId?: string
  failure?: { kind: WriteFailureKind; message: string }
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? {})
  } catch {
    return '{}'
  }
}

/** Appends an entry at the end of the queue (`seq` = last + 1; call inside the staging transaction). */
export async function enqueuePendingMutation(input: TrackMutationInput): Promise<string> {
  const timestamp = now()
  const pendingId = generateId()
  const last = await db.pending_mutations.orderBy('seq').last()
  const row: PendingMutation = {
    id: pendingId,
    actor_user_id: input.actorUserId,
    operation: input.operation,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    payload_json: serializePayload(input.payload),
    status: 'pending',
    retry_count: 0,
    last_error: input.failure?.message ?? null,
    seq: (last?.seq ?? 0) + 1,
    submission_id: input.submissionId ?? generateId(),
    push: input.push ?? null,
    row_keys: input.rowKeys ?? [],
    next_attempt_at: null,
    last_error_kind: input.failure?.kind ?? null,
    route_hint: input.routeHint ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  }
  await db.pending_mutations.put(row)
  return pendingId
}

/** Legacy (`push = null`) entries only: the write queue settles its own entries one by one. */
async function pendingLegacyEntries(actorUserId: string): Promise<PendingMutation[]> {
  return db.pending_mutations
    .where('actor_user_id')
    .equals(actorUserId)
    .filter((m) => m.status === 'pending' && m.push == null)
    .toArray()
}

/**
 * After a clean row-scan sync, marks this actor's LEGACY entries applied. Queue entries (with a
 * `push`) are never settled here: their rows are not part of the row scan.
 */
export async function markPendingMutationsApplied(actorUserId: string): Promise<void> {
  // Don't report success while anything for this actor is still unsynced. A row dropped
  // by push RLS filtering stays synced_at=null even though the sync returned no errors;
  // marking its mutation "applied" would mask a lost write. Leaving it pending lets the
  // next sync retry, and a later clean sync marks everything applied.
  if (await hasUnsyncedLocalDataForUser(actorUserId)) return

  const timestamp = now()
  const pending = await pendingLegacyEntries(actorUserId)
  for (const row of pending) {
    await db.pending_mutations.update(row.id, {
      status: 'applied',
      updated_at: timestamp,
      last_error: null,
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
    // Also resolve the originating pending_mutation: left as 'pending', it would keep counting as
    // an unsent change after the server stored it.
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
