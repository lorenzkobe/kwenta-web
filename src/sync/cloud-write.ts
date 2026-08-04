import { supabase } from '@/lib/supabase'
import { withMetric } from '@/lib/client-metrics'
import { generateId } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import {
  PULL_SINCE_EPOCH,
  TABLE_NAMES,
  type TableName,
  compareTimestamps,
  getLocalTable,
  isPullBundle,
  isRowApplied,
  markRefreshed,
  resolvePaidByForPush,
  resolveSettlementPartyIdForPush,
  resolveSplitUserIdForPush,
  shouldApplyPulledRow,
  syncErrMessage,
} from '@/sync/sync-service'
import type {
  ActivityLog,
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  Profile,
  ProfilePeerLink,
  Settlement,
  SyncFields,
} from '@/types'

/** Rows a single mutation implies, grouped by table. Built in memory, never staged in Dexie first. */
export type CloudWritePayload = {
  profiles?: Profile[]
  groups?: Group[]
  group_members?: GroupMember[]
  bills?: Bill[]
  bill_items?: BillItem[]
  item_splits?: ItemSplit[]
  settlements?: Settlement[]
  activity_log?: ActivityLog[]
  profile_peer_links?: ProfilePeerLink[]
}

/** Rows for one table, erased to the common sync shape for the generic push/confirm loops. */
function rowsFor(payload: CloudWritePayload, table: TableName): SyncFields[] {
  return (payload[table] ?? []) as SyncFields[]
}

export class CloudWriteRejectedError extends Error {
  code: string

  constructor(message: string, code = 'CLOUD_WRITE_REJECTED') {
    super(message)
    this.name = 'CloudWriteRejectedError'
    this.code = code
  }
}

export function isCloudWritePayloadEmpty(payload: CloudWritePayload): boolean {
  return TABLE_NAMES.every((table) => rowsFor(payload, table).length === 0)
}

function countRows(payload: CloudWritePayload): number {
  let total = 0
  for (const table of TABLE_NAMES) total += rowsFor(payload, table).length
  return total
}

/**
 * Rewrite local-contact ids to their linked Kwenta account ids, exactly as the sync push does.
 * Postgres RLS and the push validators match on `auth.uid()`, so a row still carrying a local
 * contact id is dropped server-side. Doing this inside the submit keeps every caller correct by
 * construction rather than relying on each operation to remember.
 */
async function normalizeForPush(payload: CloudWritePayload): Promise<CloudWritePayload> {
  const out: CloudWritePayload = { ...payload }

  if (out.item_splits?.length) {
    out.item_splits = await Promise.all(
      (out.item_splits as ItemSplit[]).map(async (s) => {
        const resolved = await resolveSplitUserIdForPush(s.user_id)
        return resolved === s.user_id ? s : { ...s, user_id: resolved }
      }),
    )
  }
  if (out.group_members?.length) {
    out.group_members = await Promise.all(
      (out.group_members as GroupMember[]).map(async (m) => {
        const resolved = await resolveSplitUserIdForPush(m.user_id)
        return resolved === m.user_id ? m : { ...m, user_id: resolved }
      }),
    )
  }
  if (out.bills?.length) {
    out.bills = await Promise.all(
      (out.bills as Bill[]).map(async (b) => {
        const resolved = await resolvePaidByForPush(b.paid_by)
        return resolved === b.paid_by ? b : { ...b, paid_by: resolved }
      }),
    )
  }
  if (out.settlements?.length) {
    out.settlements = await Promise.all(
      (out.settlements as Settlement[]).map(async (s) => {
        const [from, to] = await Promise.all([
          resolveSettlementPartyIdForPush(s.from_user_id),
          resolveSettlementPartyIdForPush(s.to_user_id),
        ])
        return from === s.from_user_id && to === s.to_user_id
          ? s
          : { ...s, from_user_id: from, to_user_id: to }
      }),
    )
  }

  return out
}


/**
 * Whether this server understands `p_submission_id` (migration 050). Probed once per session:
 * PostgREST reports an unknown overload as PGRST202, and there is no point paying for that
 * round trip on every write against a database where the migration has not been applied yet.
 */
let submissionIdSupported: boolean | null = null

/** Test seam — resets the probe so a suite can exercise both server generations. */
export function resetSubmissionIdSupport(): void {
  submissionIdSupported = null
}

function isMissingOverloadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  return e.code === 'PGRST202' || /could not find the function|does not exist/i.test(e.message ?? '')
}

/**
 * Submit a mutation's rows straight to the server and mirror the result locally.
 *
 * This is the cloud-first write path. `syncRoundTrip` builds its push payload by scanning
 * Dexie for rows with `synced_at = null`, which means a write has to be committed locally
 * *before* it can be sent — the structural reason the old path could not be cloud-first.
 * Here the rows are handed to `kwenta_sync` directly, so nothing exists locally until the
 * server has accepted it.
 *
 * On rejection this throws and writes nothing. That is the guarantee that closes the
 * duplicate-on-retry bug: a failed save leaves no orphan row for a later background sync
 * to push behind the user's back, so pressing Save again produces one bill, not two.
 *
 * The same server-side validators and RLS rules apply as on the sync path, and one RPC is
 * one Postgres transaction — so a bill plus its items, splits and activity row land
 * atomically without any new server work.
 */
export async function submitCloudWrite(input: {
  actorUserId: string
  payload: CloudWritePayload
  /**
   * Stable id for this logical write. Retrying with the SAME id can never apply twice — the
   * server returns the original outcome instead. Covers the case the local-first fix cannot:
   * the request lands, the row is stored, and the response is lost, so the client cannot tell
   * success from failure and retries.
   */
  submissionId?: string
}): Promise<{ pulled: number }> {
  if (isCloudWritePayloadEmpty(input.payload)) {
    throw new CloudWriteRejectedError('Nothing to save.', 'EMPTY_PAYLOAD')
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.user?.id) {
    throw new CloudWriteRejectedError('You are signed out. Sign in and try again.', 'NOT_SIGNED_IN')
  }

  const payload = await normalizeForPush(input.payload)

  const args: Record<string, unknown> = { p_since: PULL_SINCE_EPOCH, p_push: payload }
  const useSubmissionId = input.submissionId !== undefined && submissionIdSupported !== false
  if (useSubmissionId) args.p_submission_id = input.submissionId

  let { data: bundle, error: rpcError } = await withMetric(
    'sync.cloudWriteRpc',
    () => supabase.rpc('kwenta_sync', args),
    { rows: countRows(payload), idempotent: useSubmissionId },
  )

  // Older database without migration 050: retry without the submission id. The write still
  // succeeds, it just loses replay protection — which is strictly better than refusing to save.
  if (rpcError && useSubmissionId && isMissingOverloadError(rpcError)) {
    submissionIdSupported = false
    ;({ data: bundle, error: rpcError } = await withMetric(
      'sync.cloudWriteRpc',
      () => supabase.rpc('kwenta_sync', { p_since: PULL_SINCE_EPOCH, p_push: payload }),
      { rows: countRows(payload), idempotent: false },
    ))
  } else if (!rpcError && useSubmissionId) {
    submissionIdSupported = true
  }

  if (rpcError) {
    throw new CloudWriteRejectedError(
      `Could not save to cloud: ${syncErrMessage(rpcError)}`,
      'RPC_ERROR',
    )
  }
  if (!isPullBundle(bundle)) {
    throw new CloudWriteRejectedError('Cloud returned an unexpected response.', 'BAD_RESPONSE')
  }

  const bundleRowsById = new Map<TableName, Map<string, SyncFields>>()
  for (const table of TABLE_NAMES) {
    const byId = new Map<string, SyncFields>()
    for (const row of (bundle[table] as SyncFields[]) ?? []) byId.set(row.id, row)
    bundleRowsById.set(table, byId)
  }

  // Confirm the server actually stored every row before anything touches Dexie. A push can be
  // accepted at the transport level and still be dropped by a validator or RLS — treating that
  // as success is precisely what let silently-dropped writes look saved.
  //
  // `activity_log` is deliberately exempt. It is an audit trail, not money: refusing to save a
  // bill because its log line could not be confirmed would turn a cosmetic gap into a failed
  // write. This matters against a pre-044 server, where there is no `applied` map and the only
  // evidence is an echo the pull bundle may not carry for every table.
  const applied = (bundle as { applied?: Record<string, string[]> }).applied
  for (const table of TABLE_NAMES) {
    if (table === 'activity_log') continue
    for (const row of rowsFor(payload, table)) {
      const echo = bundleRowsById.get(table)?.get(row.id)
      const stored =
        applied !== undefined
          ? isRowApplied(applied, table, row.id)
          : echo !== undefined && compareTimestamps(echo.updated_at, row.updated_at) >= 0
      if (!stored) {
        throw new CloudWriteRejectedError(
          'The cloud did not store this change. Nothing was saved.',
          'NOT_STORED',
        )
      }
    }
  }

  const submittedIds = new Map<TableName, Set<string>>()
  for (const table of TABLE_NAMES) {
    submittedIds.set(table, new Set(rowsFor(payload, table).map((r) => r.id)))
  }

  let pulled = 0
  for (const table of TABLE_NAMES) {
    const rows = (bundle[table] as SyncFields[]) ?? []
    pulled += rows.length
    if (rows.length === 0) continue
    const localTable = getLocalTable(table)
    const mine = submittedIds.get(table)!
    const existingRows = await localTable.bulkGet(rows.map((r) => r.id))
    const toPut: SyncFields[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const existing = existingRows[i] as
        | { updated_at: string; synced_at: string | null }
        | undefined
      // Rows this call just submitted are written unconditionally: the server's copy IS the
      // record, and it has just been confirmed stored above. The freshness guard below exists
      // to protect concurrent *local* edits, and would otherwise drop our own confirmed write
      // whenever the device clock runs ahead of the server clock — the row would be saved in
      // the cloud but never appear on the device that saved it.
      if (!mine.has(row.id) && !shouldApplyPulledRow(existing, row.updated_at)) continue
      toPut.push({ ...(existing ?? {}), ...row, synced_at: row.updated_at })
    }
    if (toPut.length > 0) await localTable.bulkPut(toPut)
  }

  markRefreshed()
  return { pulled }
}

/**
 * Land a mutation's rows, cloud-first.
 *
 * Online: the server decides. On success its returned rows become the local mirror; on
 * rejection this throws and Dexie is untouched, so there is nothing on screen to retry
 * against and nothing for a later background sync to push.
 *
 * Offline: the rows are staged locally (`synced_at = null`) and queued, which is what keeps
 * the app usable without a connection. The existing sync manager replays them on reconnect.
 */
export async function commitCloudFirstWrite(input: {
  actorUserId: string
  payload: CloudWritePayload
  /** Stage the same rows in Dexie for the offline path. Only called when offline. */
  stageOffline: () => Promise<void>
  /** Queue the mutation for replay. Only called when offline. */
  queueOffline: () => Promise<void>
  /** Stable id for this logical write; see submitCloudWrite. Generated when omitted. */
  submissionId?: string
}): Promise<{ mode: 'cloud' | 'queued' }> {
  const isOnline = typeof navigator === 'undefined' || navigator.onLine

  if (!isOnline) {
    await input.stageOffline()
    await input.queueOffline()
    // A queued write changes what the user should see (pending count, staged rows), and
    // server-backed screens have no Dexie subscription to notice it.
    useAppStore.getState().bumpDataVersion()
    return { mode: 'queued' }
  }

  await submitCloudWrite({
    actorUserId: input.actorUserId,
    payload: input.payload,
    submissionId: input.submissionId ?? generateId(),
  })
  // Balances are computed on the server now, so a saved bill only reaches the screen when the
  // server-backed reads run again. Without this the user saves and nothing visibly changes.
  useAppStore.getState().bumpDataVersion()
  return { mode: 'cloud' }
}
