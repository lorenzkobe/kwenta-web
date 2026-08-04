import { db } from '@/db/db'
import { resolveProfileDisplay } from '@/lib/people'

export type ExportBillItem = {
  id: string
  name: string
  amount: number
  splits: { id: string; displayName: string; computed_amount: number }[]
}

/**
 * Items and name-resolved splits for a set of bills, without a query per bill.
 *
 * The Person export sheet called `getBillWithDetails` once per unsettled bill, and that helper
 * loads the bill, its items, its splits and then resolves every participant name one profile at a
 * time. Sixty open bills meant hundreds of sequential IndexedDB reads before the sheet could
 * paint — and because it ran inside a `useLiveQuery`, the whole fan-out re-ran on any local write
 * while the sheet was open.
 */
export async function loadBillExportItems(
  billIds: string[],
  viewerUserId: string,
): Promise<Map<string, ExportBillItem[]>> {
  const out = new Map<string, ExportBillItem[]>()
  if (billIds.length === 0) return out

  const items = (await db.bill_items.where('bill_id').anyOf(billIds).toArray())
    .filter((i) => !i.is_deleted)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  if (items.length === 0) return out

  const splits = (
    await db.item_splits.where('item_id').anyOf(items.map((i) => i.id)).toArray()
  ).filter((s) => !s.is_deleted)

  // One resolve per distinct person for the whole export, not per split row.
  const names = new Map<string, string>()
  for (const userId of new Set(splits.map((s) => s.user_id))) {
    names.set(userId, (await resolveProfileDisplay(userId, viewerUserId)).displayName)
  }

  const splitsByItem = new Map<string, typeof splits>()
  for (const split of splits) {
    const list = splitsByItem.get(split.item_id) ?? []
    list.push(split)
    splitsByItem.set(split.item_id, list)
  }

  for (const item of items) {
    const list = out.get(item.bill_id) ?? []
    list.push({
      id: item.id,
      name: item.name,
      amount: item.amount,
      splits: (splitsByItem.get(item.id) ?? []).map((s) => ({
        id: s.id,
        displayName: names.get(s.user_id) ?? 'Unknown',
        computed_amount: s.computed_amount,
      })),
    })
    out.set(item.bill_id, list)
  }
  return out
}

/**
 * Every split row for these bills, in two queries.
 *
 * Shared by the CSV and PDF exporters, which both need the per-person share matrix. They used to
 * walk `bill_items` per bill and then `item_splits` per item — roughly 1,500 sequential IndexedDB
 * round trips for a 300-bill export, which froze the download for seconds.
 *
 * Splits are records the user holds, not derived money, so reading them from the local mirror is
 * allowed under CLAUDE.md rule 8. Reading them one at a time was the problem, not reading them.
 */
export async function loadSplitsByBill(
  billIds: string[],
): Promise<Map<string, { userId: string; amount: number }[]>> {
  const out = new Map<string, { userId: string; amount: number }[]>()
  if (billIds.length === 0) return out

  const items = (await db.bill_items.where('bill_id').anyOf(billIds).toArray()).filter(
    (i) => !i.is_deleted,
  )
  if (items.length === 0) return out

  const billIdByItem = new Map(items.map((i) => [i.id, i.bill_id]))
  const splits = (
    await db.item_splits.where('item_id').anyOf([...billIdByItem.keys()]).toArray()
  ).filter((s) => !s.is_deleted)

  for (const split of splits) {
    const billId = billIdByItem.get(split.item_id)
    if (!billId) continue
    const list = out.get(billId) ?? []
    list.push({ userId: split.user_id, amount: split.computed_amount })
    out.set(billId, list)
  }
  return out
}
