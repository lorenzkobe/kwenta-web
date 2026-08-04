/**
 * Rows this device has written but not yet sent to the server.
 *
 * Reads are server-scoped (CLAUDE.md rule 7) and the offline cache is never consulted to decide
 * whether a row EXISTS. These helpers do not break that rule: a row with `synced_at === null` is
 * not an inference about what the server holds, it is a fact about this device — "I wrote this and
 * have not pushed it". Nothing here decides that a server row is absent or deleted.
 *
 * They exist because the read migration made offline writes invisible. A bill saved offline was
 * staged in Dexie and queued, but the Bills list is the server response, and `withPending` can only
 * decorate rows the server already returned — so the bill appeared nowhere and its URL reported a
 * load failure. Users read that as "the save failed" and entered the bill again, which is the
 * duplicate-bill path the cloud-first write was built to close.
 *
 * Money is deliberately absent. A staged bill carries `settled: false` (nothing can be settled
 * against a bill the server has never seen) and no pairwise nets, rather than a client-computed
 * balance — rule 8 still holds.
 */
import { db } from '@/db/db'
import { isUnsyncedRow } from '@/sync/sync-service'
import { getBillWithDetails } from '@/db/operations'
import { resolveProfileDisplay } from '@/lib/people'
import type { BillDetail, ContactBalanceRow, PersonalBillRow } from '@/api/balances'
import type { Bill } from '@/types'

/** Unsent, undeleted personal bills this user created, newest first. */
async function stagedPersonalBills(userId: string): Promise<Bill[]> {
  // Dexie cannot index null, so `where('synced_at').equals(null)` matches nothing — the push path
  // scans and filters for the same reason.
  const rows = await db.bills.toArray()
  return rows
    .filter(
      (b) => !b.is_deleted && b.group_id === null && b.created_by === userId && isUnsyncedRow(b),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * Staged personal bills shaped like the server's list rows, so the Bills page can render them
 * beside the confirmed ones.
 */
export async function loadStagedPersonalBillRows(userId: string): Promise<PersonalBillRow[]> {
  const bills = await stagedPersonalBills(userId)
  if (bills.length === 0) return []

  const billIds = bills.map((b) => b.id)
  // One pass per table rather than per bill: this runs on every Bills render.
  const items = (await db.bill_items.where('bill_id').anyOf(billIds).toArray()).filter(
    (i) => !i.is_deleted,
  )
  const itemIds = items.map((i) => i.id)
  const splits =
    itemIds.length > 0
      ? (await db.item_splits.where('item_id').anyOf(itemIds).toArray()).filter(
          (s) => !s.is_deleted,
        )
      : []

  const itemsByBill = new Map<string, string[]>()
  for (const item of items) {
    const list = itemsByBill.get(item.bill_id) ?? []
    list.push(item.id)
    itemsByBill.set(item.bill_id, list)
  }
  const splitUserIdsByItem = new Map<string, string[]>()
  for (const split of splits) {
    const list = splitUserIdsByItem.get(split.item_id) ?? []
    list.push(split.user_id)
    splitUserIdsByItem.set(split.item_id, list)
  }

  const names = new Map<string, string>()
  const allUserIds = new Set(splits.map((s) => s.user_id))
  for (const b of bills) allUserIds.add(b.paid_by)
  for (const id of allUserIds) {
    names.set(id, (await resolveProfileDisplay(id, userId)).displayName)
  }

  return bills.map((bill) => {
    const ownItemIds = itemsByBill.get(bill.id) ?? []
    const participantIds = new Set<string>()
    for (const itemId of ownItemIds) {
      for (const uid of splitUserIdsByItem.get(itemId) ?? []) participantIds.add(uid)
    }
    return {
      id: bill.id,
      title: bill.title,
      currency: bill.currency,
      totalAmount: bill.total_amount,
      createdAt: bill.created_at,
      createdBy: bill.created_by,
      payorName: names.get(bill.paid_by) ?? 'Unknown',
      itemCount: ownItemIds.length,
      // Not a computed balance: a bill the server has never seen cannot have been settled.
      settled: false,
      category: bill.category ?? null,
      participants: [...participantIds].map((id) => ({
        id,
        label: names.get(id) ?? 'Unknown',
      })),
    }
  })
}

/**
 * The bill detail screen for a bill that has not been sent yet.
 *
 * Everything here is descriptive — the bill, its items, its splits and the names on them. `pairs`
 * is empty and `mySplitTotal` is the viewer's own share of THIS bill (a bounded sum over one
 * bill's splits, not a cross-context balance), because the pairwise nets and `squareOverall` are
 * server aggregates that no device can answer for a row the server has never seen.
 */
export async function loadStagedBillDetail(
  billId: string,
  userId: string,
): Promise<BillDetail | null> {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted || !isUnsyncedRow(bill)) return null

  const detail = await getBillWithDetails(billId)
  if (!detail) return null

  const items = detail.items.map((item) => ({
    id: item.id,
    name: item.name,
    amount: item.amount,
    splits: item.splits.map((split) => ({
      id: split.id,
      userId: split.user_id,
      displayName: split.displayName,
      splitType: split.split_type,
      splitValue: split.split_value,
      computedAmount: split.computed_amount,
    })),
  }))

  let mySplitTotal: number | null = null
  if (bill.group_id === null) {
    const mine = items.flatMap((i) => i.splits).filter((s) => s.userId === userId)
    // Absent from every split means the viewer is not on this bill — null, not 0, so the screen
    // omits "Your share" rather than claiming a zero share.
    mySplitTotal = mine.length > 0 ? mine.reduce((sum, s) => sum + s.computedAmount, 0) : null
  }

  const group = bill.group_id ? await db.groups.get(bill.group_id) : null

  return {
    bill: {
      id: detail.id,
      title: detail.title,
      note: detail.note ?? '',
      currency: detail.currency,
      totalAmount: detail.total_amount,
      createdAt: detail.created_at,
      createdBy: detail.created_by,
      paidBy: detail.paid_by,
      groupId: detail.group_id,
      category: detail.category ?? null,
      creatorName: detail.creatorName,
      payorName: detail.payorName,
    },
    groupName: group?.name ?? null,
    items,
    mySplitTotal,
    pairs: [],
  }
}

/**
 * Unsent local contacts this user created, shaped like the server's contact rows.
 *
 * Contact discovery moved to `kwenta_contacts_with_balances`, so a contact added offline was
 * absent from /app/people while the Dexie duplicate guard still rejected adding it again — the
 * user got "already exists" for someone who was not on the screen.
 */
export async function loadStagedContactRows(userId: string): Promise<ContactBalanceRow[]> {
  const rows = await db.profiles.toArray()
  return rows
    .filter(
      (p) => !p.is_deleted && p.is_local && p.owner_id === userId && isUnsyncedRow(p),
    )
    .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }))
    .map((p) => ({
      peerId: p.id,
      displayName: p.display_name,
      subtitle: 'Local contact',
      net: {},
    }))
}
