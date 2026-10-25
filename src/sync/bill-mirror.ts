import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
import { getLocalTable, isMirrorRowSynced, rowKey, selectServerRowsToApply, type TableName } from '@/sync/sync-service'
import { completeBillRestore, completePendingRestores, refusedBaseVersions } from '@/sync/write-queue'
import type { Bill, BillItem, ItemSplit, SyncFields } from '@/types'

export type BillUnavailableKind = 'not_found' | 'unreachable'

/**
 * A bill this device could not load. The two kinds read differently on purpose: a connection blip
 * must never be told to the user as "this bill no longer exists".
 */
export class BillUnavailableError extends Error {
  readonly kind: BillUnavailableKind

  constructor(kind: BillUnavailableKind) {
    super(
      kind === 'not_found'
        ? 'This bill no longer exists, or you no longer have access to it.'
        : "Couldn't load this bill. Check your connection and try again.",
    )
    this.name = 'BillUnavailableError'
    this.kind = kind
  }
}

type BillBundle = { bill?: Bill | null; bill_items?: BillItem[]; item_splits?: ItemSplit[] }

/**
 * Store only the rows this device does not already hold. A row that is here may carry an unsynced
 * edit, and this path has no business deciding whose copy wins — that is the sync's job
 * (`shouldApplyPulledRow`); the caller only needs the bill to be present.
 */
async function addMissingRows<T extends SyncFields>(
  table: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]>; bulkAdd: (rows: T[]) => Promise<unknown> },
  rows: T[],
): Promise<void> {
  if (rows.length === 0) return
  const existing = await table.bulkGet(rows.map((r) => r.id))
  const missing = rows
    .filter((_, i) => existing[i] === undefined)
    .map((r) => ({ ...r, synced_at: r.updated_at }))
  if (missing.length > 0) await table.bulkAdd(missing)
}

/**
 * Mirror the server's rows under the realtime rules (`selectServerRowsToApply`: a staged local row
 * stays unless the server copy is strictly newer, or only a refused write owns it), as one read and
 * one write for the table.
 */
async function applyServerRows<T extends SyncFields>(
  name: TableName,
  table: {
    bulkGet: (ids: string[]) => Promise<(T | undefined)[]>
    bulkPut: (rows: T[]) => Promise<unknown>
  },
  rows: T[],
): Promise<void> {
  if (rows.length === 0) return
  const existing = await table.bulkGet(rows.map((r) => r.id))
  const apply = await selectServerRowsToApply(name, rows, existing)
  const toPut: T[] = []
  rows.forEach((row, i) => {
    if (apply[i]) toPut.push({ ...(existing[i] ?? {}), ...row, synced_at: row.updated_at })
  })
  if (toPut.length > 0) await table.bulkPut(toPut)
}

/**
 * Make sure a bill is on this device before something acts on it.
 *
 * Dexie is a mirror (rule 7): a bill added from another device may simply not have arrived yet,
 * and treating that as "there is nothing to do" is what let an edit or delete silently report
 * success. Resolves when the bill is present — including a bill deleted on the server, which is
 * mirrored as deleted so the caller can decide what that means. Throws `BillUnavailableError`
 * otherwise.
 *
 * `fresh` is for a caller about to build a change from the bill (the edit form, a delete): online
 * it always fetches and brings the rows into the mirror under the realtime rules, so the change
 * is built from what the server holds, not from whenever this device last heard. Offline, or when
 * the fetch fails, a bill already here is used as it is; a successful answer that has no such bill
 * means it is gone (or no longer yours) and throws `not_found`.
 */
export async function loadBillIntoMirror(billId: string, options?: { fresh?: boolean }): Promise<void> {
  const present = (await db.bills.get(billId)) !== undefined
  if (present && !options?.fresh) return

  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  if (offline) {
    if (present) return
    throw new BillUnavailableError('unreachable')
  }

  if (options?.fresh) await completePendingRestores()

  const epoch = currentSessionEpoch()
  let bundle: BillBundle | null
  try {
    const { data, error } = await supabase.rpc('kwenta_fetch_bill_bundle', { p_bill_id: billId })
    if (error) throw error
    bundle = (data ?? null) as BillBundle | null
  } catch {
    if (present) return
    throw new BillUnavailableError('unreachable')
  }
  if (!bundle?.bill) {
    // The server answered: it has no such bill for this account. A bill this device created and
    // has not sent yet is the one case where that is expected.
    const local = await db.bills.get(billId)
    if (local && !isMirrorRowSynced(local)) return
    throw new BillUnavailableError('not_found')
  }
  // The mirror was wiped (sign-out, account switch) while this was in flight: the bill belongs to
  // the ended session. The action that asked for it dies with that session (its write is refused
  // by the same check in cloud-write), so nothing is written and nothing is reported.
  if (!isSessionEpochCurrent(epoch)) return

  if (options?.fresh) {
    const serverKeys = new Set([
      rowKey('bills', bundle.bill.id),
      ...(bundle.bill_items ?? []).map((r) => rowKey('bill_items', r.id)),
      ...(bundle.item_splits ?? []).map((r) => rowKey('item_splits', r.id)),
    ])
    await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log, db.pending_mutations], async () => {
      if (!isSessionEpochCurrent(epoch)) return
      await applyServerRows('bills', db.bills, [bundle.bill as Bill])
      await applyServerRows('bill_items', db.bill_items, bundle.bill_items ?? [])
      await applyServerRows('item_splits', db.item_splits, bundle.item_splits ?? [])
      await completeBillRestore(billId, serverKeys)
    })
    return
  }

  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits], async () => {
    await addMissingRows(db.bills, [bundle.bill as Bill])
    await addMissingRows(db.bill_items, bundle.bill_items ?? [])
    await addMissingRows(db.item_splits, bundle.item_splits ?? [])
  })
}

/** What an edit form was built from: the server versions it loaded and the rows it showed. */
export type LoadedBillVersion = {
  /** `table:id` → `updated_at`, for the rows that were synced when the form loaded. */
  versions: Record<string, string>
  itemIds: string[]
  splitIds: string[]
  /**
   * `table:id` of loaded rows that were staged by a pending write at load and have no version.
   * If one has been synced by the time of the save, another change reached it since: the save must
   * not be based on that newer version, so it is refused (see `loadedRowsSyncedSince`).
   */
  stagedKeys: string[]
}

/**
 * Record the bill as the mirror holds it right now. The save is based on these versions, not on
 * whatever the mirror holds when Save is pressed, so a copy that changed under the open form makes
 * the server refuse the save instead of being overwritten. A row staged by a pending write has no
 * server version and gets none.
 */
export async function captureBillVersion(billId: string): Promise<LoadedBillVersion> {
  const bill = await db.bills.get(billId)
  const items = (await db.bill_items.where('bill_id').equals(billId).toArray()).filter((i) => !i.is_deleted)
  const splits =
    items.length === 0
      ? []
      : (await db.item_splits.where('item_id').anyOf(items.map((i) => i.id)).toArray()).filter((s) => !s.is_deleted)

  const versions: Record<string, string> = {}
  const staged: string[] = []
  const record = (table: 'bills' | 'bill_items' | 'item_splits', row: SyncFields | undefined) => {
    if (!row) return
    if (isMirrorRowSynced(row)) versions[rowKey(table, row.id)] = row.updated_at
    else staged.push(rowKey(table, row.id))
  }
  record('bills', bill)
  for (const item of items) record('bill_items', item)
  for (const split of splits) record('item_splits', split)
  // A row a refused write still stages was built from the version that write carries; the form's
  // next save must stay based on it, or it would overwrite what the refusal protected.
  for (const [key, base] of await refusedBaseVersions(staged)) versions[key] = base
  const stagedKeys = staged.filter((key) => !(key in versions))
  return { versions, itemIds: items.map((i) => i.id), splitIds: splits.map((s) => s.id), stagedKeys }
}

/**
 * Whether a row the form loaded as staged has been synced since: the queued write that staged it
 * landed, or another device's version arrived. The form never saw that version, so a save is refused.
 */
export async function loadedRowsSyncedSince(loaded: LoadedBillVersion): Promise<boolean> {
  const idsByTable = new Map<TableName, string[]>()
  for (const key of loaded.stagedKeys) {
    const at = key.indexOf(':')
    const table = key.slice(0, at) as TableName
    idsByTable.set(table, [...(idsByTable.get(table) ?? []), key.slice(at + 1)])
  }
  for (const [table, ids] of idsByTable) {
    const rows = await getLocalTable(table).bulkGet(ids)
    if (rows.some((row) => row && isMirrorRowSynced(row))) return true
  }
  return false
}
