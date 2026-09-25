import { supabase } from '@/lib/supabase'
import { withMetric } from '@/lib/client-metrics'
import { generateId } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { mountedReadSpecs, primeReads, type ReadSpec } from '@/api/primed-reads'
import { trackCloudWrite } from '@/sync/in-flight-writes'
import { SessionEndedError, assertSessionEpoch, currentSessionEpoch } from '@/sync/session-epoch'
import { CloudWriteFailedError, WriteSessionMismatchError, classifyWriteFailure } from '@/sync/write-errors'
import { drainWriteQueue, enqueueWrite, hasPendingQueuedWrites, type QueuedWriteMeta } from '@/sync/write-queue'
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
  rowKey,
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
  WriteFailureKind,
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

/** The server answered and stored nothing. Never replayed: the same rows would be refused again. */
export class CloudWriteRejectedError extends Error {
  code: string
  readonly kind: WriteFailureKind = 'rejected'

  constructor(message: string, code = 'CLOUD_WRITE_REJECTED') {
    super(message)
    this.name = 'CloudWriteRejectedError'
    this.code = code
  }
}

/** A write RPC that has not answered in this long is treated as a transport failure and replayed. */
const WRITE_TIMEOUT_MS = 20_000

type AbortableQuery<T> = PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => PromiseLike<T> }

function withWriteTimeout<T>(query: AbortableQuery<T>): PromiseLike<T> {
  if (typeof query.abortSignal !== 'function' || typeof AbortSignal.timeout !== 'function') return query
  return query.abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))
}

type RpcAnswer = { data: unknown; error: unknown; status?: number }
type MetricFields = Parameters<typeof withMetric>[2]

/**
 * One write RPC. A fetch that throws (or times out) is reported in postgrest's own error shape so
 * one classifier sees every failure; the HTTP status rides on the error for the same reason.
 */
async function callWriteRpc(fn: string, args: Record<string, unknown>, fields: MetricFields): Promise<RpcAnswer> {
  try {
    const answer = (await withMetric(
      'sync.cloudWriteRpc',
      () => withWriteTimeout(supabase.rpc(fn, args) as AbortableQuery<RpcAnswer>),
      fields,
    )) as RpcAnswer
    return answer
  } catch (err) {
    return { data: null, error: err, status: 0 }
  }
}

function errorWithStatus(answer: RpcAnswer): unknown {
  const { error, status } = answer
  if (error && typeof error === 'object' && status !== undefined && !('status' in error)) {
    return { ...(error as object), message: (error as { message?: unknown }).message, status }
  }
  return error
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

/**
 * Whether the server has migration `066` (`kwenta_write`). Probed the same way and for the same
 * reason: against an older database the write still has to go through `kwenta_sync`, downloading
 * the whole bundle to confirm one row.
 */
let writeRpcSupported: boolean | null = null

/** Test seam — resets the probes so a suite can exercise every server generation. */
export function resetSubmissionIdSupport(): void {
  submissionIdSupported = null
  writeRpcSupported = null
}

/**
 * One `p_reads` element. Only the fields `kwenta_read` dispatches on — the RPC parameter name a
 * direct PostgREST call needs is a client-side concern and is deliberately not sent.
 */
function toReadArg(spec: ReadSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { key: spec.key, fn: spec.fn }
  if (spec.id !== undefined) out.id = spec.id
  if (spec.limit !== undefined) out.limit = spec.limit
  return out
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
  /**
   * `table:id` of rows a LATER queued write still owns. Their local copy is that later edit, not
   * yet sent, so this write's echo must not overwrite it (the edit would visibly revert until the
   * later entry drains).
   */
  preserveLocalKeys?: ReadonlySet<string>
}): Promise<{ stored: number }> {
  if (isCloudWritePayloadEmpty(input.payload)) {
    throw new CloudWriteRejectedError('Nothing to save.', 'EMPTY_PAYLOAD')
  }
  const epoch = currentSessionEpoch()

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.user?.id) {
    // Nothing was sent, so nothing was refused: the rows wait for a session.
    throw new CloudWriteFailedError('You are signed out. Sign in and try again.', 'transport')
  }
  if (session.user.id !== input.actorUserId) throw new WriteSessionMismatchError()

  const payload = await normalizeForPush(input.payload)

  let bundle: unknown = null
  let rpcError: unknown = null
  // Which endpoints are on screen right now. The server recomputes exactly these AFTER applying
  // the push and hands them back, so the re-read triggered below costs no request.
  const reads = mountedReadSpecs()
  let usedWriteRpc = false

  if (writeRpcSupported !== false) {
    const attempt = await callWriteRpc(
      'kwenta_write',
      {
        p_push: payload,
        p_submission_id: input.submissionId ?? null,
        p_reads: reads.map(toReadArg),
      },
      { rows: countRows(payload), reads: reads.length, rpc: 'kwenta_write' },
    )
    if (attempt.error && isMissingOverloadError(attempt.error)) {
      // Database without migration 066. Fall through to the old path, and remember, so every
      // later write in this session goes straight there.
      writeRpcSupported = false
    } else {
      // A request that never got an answer says nothing about which RPCs the server has.
      if (!attempt.error || classifyWriteFailure(errorWithStatus(attempt)) !== 'transport') writeRpcSupported = true
      usedWriteRpc = true
      bundle = attempt.data
      rpcError = attempt.error ? errorWithStatus(attempt) : null
    }
  }

  if (!usedWriteRpc) {
    const args: Record<string, unknown> = { p_since: PULL_SINCE_EPOCH, p_push: payload }
    const useSubmissionId = input.submissionId !== undefined && submissionIdSupported !== false
    if (useSubmissionId) args.p_submission_id = input.submissionId

    let legacy = await callWriteRpc('kwenta_sync', args, {
      rows: countRows(payload),
      idempotent: useSubmissionId,
      rpc: 'kwenta_sync',
    })

    // Older database without migration 050: retry without the submission id. The write still
    // succeeds, it just loses replay protection — which is strictly better than refusing to save.
    if (legacy.error && useSubmissionId && isMissingOverloadError(legacy.error)) {
      submissionIdSupported = false
      legacy = await callWriteRpc(
        'kwenta_sync',
        { p_since: PULL_SINCE_EPOCH, p_push: payload },
        { rows: countRows(payload), idempotent: false, rpc: 'kwenta_sync' },
      )
    } else if (!legacy.error && useSubmissionId) {
      submissionIdSupported = true
    }

    bundle = legacy.data
    rpcError = legacy.error ? errorWithStatus(legacy) : null
  }

  if (rpcError) {
    const kind = classifyWriteFailure(rpcError)
    const message = `Could not save to cloud: ${syncErrMessage(rpcError)}`
    if (kind === 'rejected') throw new CloudWriteRejectedError(message, 'RPC_ERROR')
    throw new CloudWriteFailedError(message, kind)
  }
  if (!isPullBundle(bundle)) {
    // Doubtful — a proxy or a truncated body, not a refusal — so it is replayed, not dropped.
    throw new CloudWriteFailedError('Cloud returned an unexpected response.', 'transport')
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

  // The server stored it, but a wipe (sign-out, account switch) ran while the request was out: the
  // mirror now belongs to the next session, and this response must not be written into it.
  assertSessionEpoch(epoch)
  let stored = 0
  for (const table of TABLE_NAMES) {
    // A replayed submission (050) answers with its original `applied` map and no rows: the server
    // stored exactly what was submitted, so the submitted rows stand in for the missing echo.
    const echoed = (bundle[table] as SyncFields[]) ?? []
    const echoedIds = new Set(echoed.map((r) => r.id))
    const unechoed = rowsFor(payload, table).filter(
      (r) => !echoedIds.has(r.id) && applied !== undefined && isRowApplied(applied, table, r.id),
    )
    const rows = unechoed.length > 0 ? [...echoed, ...unechoed] : echoed
    stored += rows.length
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
      if (input.preserveLocalKeys?.has(rowKey(table, row.id))) continue
      if (!mine.has(row.id) && !shouldApplyPulledRow(existing, row.updated_at)) continue
      toPut.push({ ...(existing ?? {}), ...row, synced_at: row.updated_at })
    }
    if (toPut.length === 0) continue
    assertSessionEpoch(epoch)
    await localTable.bulkPut(toPut)
  }
  assertSessionEpoch(epoch)

  if (usedWriteRpc) {
    // The payloads for the screens that were on display, recomputed by the server after this
    // write. `bumpDataVersion` (in the caller) makes every mounted hook re-read; each is served
    // from here without a request.
    primeReads((bundle as { reads?: Record<string, unknown> }).reads)
  } else {
    // Only the legacy path pulled the caller's complete row set, so only it may claim the mirror
    // is fresh. Stamping the marker after a `kwenta_write` would permanently satisfy the backup
    // timer's staleness gate and the initial-hydration check, and the mirror would stop refreshing.
    markRefreshed()
  }
  return { stored }
}

/** How long a save may wait on older queued writes before it queues behind them instead. */
const SAVE_DRAIN_BUDGET_MS = 10_000

/**
 * Land a mutation's rows, cloud-first.
 *
 * Online: the server decides. On success its returned rows become the local mirror; on a refusal
 * (or an inactive account) this throws and Dexie is untouched, so there is nothing on screen to
 * retry against and nothing for a later background sync to push.
 *
 * Staged and queued instead (`mode: 'queued'`, never a throw):
 *  - offline;
 *  - a transport failure — the request may or may not have landed, so the SAME submission id is
 *    replayed and a lost response cannot become a second bill;
 *  - older writes still pending in the queue that do not drain within the save's budget: sending
 *    this one ahead of them would reorder edits to the same rows. Only `pending` entries count; a
 *    refused entry waits for the user and never holds a new save back.
 */
export async function commitCloudFirstWrite(input: {
  actorUserId: string
  payload: CloudWritePayload
  /** What the Settings "not applied" list shows if this write is later refused. */
  pending: QueuedWriteMeta
  /** Stable id for this logical write; see submitCloudWrite. Generated when omitted. */
  submissionId?: string
}): Promise<{ mode: 'cloud' | 'queued'; submissionId: string }> {
  const submissionId = input.submissionId ?? generateId()
  const epoch = currentSessionEpoch()
  const queue = async (failure?: { kind: WriteFailureKind; message: string }) => {
    assertSessionEpoch(epoch)
    await enqueueWrite({
      actorUserId: input.actorUserId,
      payload: input.payload,
      pending: input.pending,
      submissionId,
      failure,
    })
    // A queued write changes what the user should see (pending count, staged rows), and
    // server-backed screens have no Dexie subscription to notice it.
    useAppStore.getState().bumpDataVersion()
    return { mode: 'queued' as const, submissionId }
  }

  const isOnline = typeof navigator === 'undefined' || navigator.onLine
  if (!isOnline) return queue()

  if (await hasPendingQueuedWrites(input.actorUserId)) {
    await drainWriteQueue(input.actorUserId, { budgetMs: SAVE_DRAIN_BUDGET_MS })
    if (await hasPendingQueuedWrites(input.actorUserId)) return queue()
  }

  try {
    // Tracked so the realtime path can wait for this write's rows to be mirrored before it
    // decides whether their events are this write's own echoes.
    await trackCloudWrite(
      submitCloudWrite({ actorUserId: input.actorUserId, payload: input.payload, submissionId }),
    )
  } catch (err) {
    if (
      err instanceof SessionEndedError ||
      err instanceof WriteSessionMismatchError ||
      classifyWriteFailure(err) !== 'transport'
    ) {
      throw err
    }
    return queue({ kind: 'transport', message: err instanceof Error ? err.message : String(err) })
  }
  // Balances are computed on the server now, so a saved bill only reaches the screen when the
  // server-backed reads run again. Without this the user saves and nothing visibly changes.
  useAppStore.getState().bumpDataVersion()
  return { mode: 'cloud', submissionId }
}
