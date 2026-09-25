import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
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
 * Make sure a bill is on this device before something acts on it.
 *
 * Dexie is a mirror (rule 7): a bill added from another device may simply not have arrived yet,
 * and treating that as "there is nothing to do" is what let an edit or delete silently report
 * success. Resolves when the bill is present — including a bill deleted on the server, which is
 * mirrored as deleted so the caller can decide what that means. Throws `BillUnavailableError`
 * otherwise.
 */
export async function loadBillIntoMirror(billId: string): Promise<void> {
  if (await db.bills.get(billId)) return

  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  if (offline) throw new BillUnavailableError('unreachable')

  const epoch = currentSessionEpoch()
  let bundle: BillBundle | null
  try {
    const { data, error } = await supabase.rpc('kwenta_fetch_bill_bundle', { p_bill_id: billId })
    if (error) throw error
    bundle = (data ?? null) as BillBundle | null
  } catch {
    throw new BillUnavailableError('unreachable')
  }
  if (!bundle?.bill) throw new BillUnavailableError('not_found')
  // The mirror was wiped (sign-out, account switch) while this was in flight: the bill belongs to
  // the ended session. The action that asked for it dies with that session (its write is refused
  // by the same check in cloud-write), so nothing is written and nothing is reported.
  if (!isSessionEpochCurrent(epoch)) return

  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits], async () => {
    await addMissingRows(db.bills, [bundle.bill as Bill])
    await addMissingRows(db.bill_items, bundle.bill_items ?? [])
    await addMissingRows(db.item_splits, bundle.item_splits ?? [])
  })
}
