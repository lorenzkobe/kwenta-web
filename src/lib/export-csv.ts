import { db } from '@/db/db'
import { CATEGORY_LABELS } from '@/lib/bill-categories'
import type { BillCategory } from '@/lib/bill-categories'
import type {
  GroupDetail,
  PersonalBillRow,
  SettlementHistoryItem,
  StatementEvent,
} from '@/api/balances'
import { makeExportFilename } from '@/lib/export-utils'
import { loadSplitsByBill } from '@/lib/export-splits'

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function csvRow(...cells: (string | number | null | undefined)[]): string {
  return cells.map(escapeCsv).join(',')
}

function section(label: string): string[] {
  // Two blank rows before for gap, bold-like === markers since CSV has no formatting,
  // one blank row after so column headers don't run directly against the section header.
  return ['', '', `=== ${label.toUpperCase()} ===`, '']
}

function triggerDownload(content: string, filename: string) {
  // \r\n line endings for broad compatibility (Excel on Windows, Numbers, Google Sheets)
  // UTF-8 BOM ensures Excel auto-detects the encoding correctly
  const bom = '﻿'
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * `rows` is the list the user is looking at, already server-computed.
 *
 * Recomputing the settled flag here instead would let an export disagree with the screen it was
 * exported from — the flag is derived from a cross-group person tab, so a stale local mirror
 * answers it differently.
 *
 * Callers pass BOTH buckets. The pre-migration exporter concatenated `mine` and `shared`
 * internally; when the rows became a parameter every caller passed only `mine`, so a user who is
 * a participant on someone else's personal bills silently exported an incomplete record.
 */
export async function exportBillsToCSV(
  userId: string,
  rows: PersonalBillRow[],
): Promise<void> {
  const bills = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const splitsByBill = await loadSplitsByBill(bills.map((b) => b.id))

  const lines: string[] = [
    csvRow('Personal Bills'),
    csvRow('Exported', new Date().toLocaleString()),
    ...section('Bills'),
    csvRow(
      'Date',
      'Bill Title',
      'Category',
      'Currency',
      'Total Amount',
      'Paid By',
      'My Share',
      'Settled',
    ),
  ]

  for (const bill of bills) {
    const date = new Date(bill.createdAt).toLocaleDateString()
    const catLabel = bill.category ? (CATEGORY_LABELS[bill.category as BillCategory] ?? bill.category) : ''
    // The viewer's own share is a sum of their own split rows — a record they hold, not a
    // cross-entity balance, so it stays local.
    const myShare = (splitsByBill.get(bill.id) ?? [])
      .filter((s) => s.userId === userId)
      .reduce((sum, s) => sum + s.amount, 0)
    lines.push(
      csvRow(
        date,
        bill.title,
        catLabel,
        bill.currency,
        bill.totalAmount,
        bill.payorName,
        myShare || '',
        bill.settled ? 'Yes' : 'No',
      ),
    )
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename('Bills', 'csv'))
}

/**
 * `detail` and `payments` are the screen's own server payloads, so the export cannot disagree
 * with it.
 *
 * Everything that carries meaning comes from those two: the roster, the bills, the payer names,
 * the balances and the payment log. The only local read left is the per-member share matrix,
 * which is a record of who was on which item — descriptive, not derived money. Mixing the two
 * sources was itself the bug: server balances accounted for a bill the mirror had not pulled yet,
 * so the file did not reconcile with itself, and a missing `groups` row made the whole export
 * return silently with no file and no error.
 */
export async function exportGroupToCSV(
  detail: GroupDetail,
  payments: SettlementHistoryItem[],
): Promise<void> {
  const group = detail.group
  const members = detail.members
  const memberNames: Record<string, string> = {}
  for (const m of members) memberNames[m.userId] = m.profileName

  const bills = [...detail.bills].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const memberBalances = detail.memberBalances
  const pairwiseEntries = detail.pairwise

  const lines: string[] = [
    csvRow('Group', group.name),
    csvRow('Currency', group.currency),
    csvRow('Members', members.length),
    csvRow('Exported', new Date().toLocaleString()),
  ]

  {
    lines.push(...section('Member Balances'))
    lines.push(csvRow('Member', 'Balance', 'Currency', 'Status'))
    for (const b of memberBalances) {
      // Roster name first: a co-member's profile row is not on this device by design.
      const name = memberNames[b.userId] ?? b.displayName
      const amt = Math.round(b.amount * 100) / 100
      const status = Math.abs(amt) <= 0.01 ? 'Even' : amt > 0 ? 'Receives' : 'Pays'
      lines.push(csvRow(name, Math.abs(amt), group.currency, status))
    }

    if (pairwiseEntries.some((e) => Math.abs(e.net) > 0.005)) {
      lines.push(...section('Your Balances'))
      lines.push(csvRow('Person', 'Status', 'Amount', 'Currency'))
      for (const entry of pairwiseEntries) {
        if (Math.abs(entry.net) <= 0.005) continue
        const name = memberNames[entry.memberUserId] ?? entry.displayName
        lines.push(csvRow(name, entry.net > 0 ? 'Owes you' : 'You owe', Math.abs(entry.net), group.currency))
      }
    }
  }

  const memberIds = members.map((m) => m.userId)
  const splitsByBill = await loadSplitsByBill(bills.map((b) => b.id))
  lines.push(...section('Bills'))
  lines.push(csvRow('Date', 'Bill Title', 'Category', 'Currency', 'Total Amount', 'Paid By', ...memberIds.map((uid) => memberNames[uid] ?? uid)))

  for (const bill of bills) {
    const date = new Date(bill.createdAt).toLocaleDateString()
    const catLabel = bill.category ? (CATEGORY_LABELS[bill.category as BillCategory] ?? bill.category) : ''
    const shareByUser: Record<string, number> = {}
    for (const s of splitsByBill.get(bill.id) ?? []) {
      shareByUser[s.userId] = (shareByUser[s.userId] ?? 0) + s.amount
    }
    lines.push(csvRow(date, bill.title, catLabel, bill.currency, bill.totalAmount, bill.payorName, ...memberIds.map((uid) => shareByUser[uid] ?? '')))
  }

  // One row per stored leg, not per bundle: `legs` is what the settlements table holds, and a
  // bundled payment that moved through an intermediary is several real transfers.
  const legs = payments
    .flatMap((p) => p.legs.map((l) => ({ ...l, createdAt: p.createdAt, label: p.label })))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  if (legs.length > 0) {
    lines.push(...section('Payments'))
    lines.push(csvRow('Date', 'From', 'To', 'Amount', 'Currency', 'Note'))
    for (const leg of legs) {
      const date = new Date(leg.createdAt).toLocaleDateString()
      lines.push(
        csvRow(date, leg.fromName, leg.toName, leg.amount, group.currency, leg.label),
      )
    }
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename(group.name, 'csv'))
}

/**
 * Built from the SAME statement events the Person page renders (migration 062).
 *
 * The old version re-derived a per-bill net locally, which is how an export could show a
 * different set of bills — and different amounts — from the statement directly above the export
 * button. Deriving both from one payload makes them equal by construction rather than by
 * two implementations agreeing.
 */
export async function exportPersonToCSV(
  personId: string,
  viewerId: string,
  events: StatementEvent[],
  payments: SettlementHistoryItem[],
): Promise<void> {
  const personProfile = await db.profiles.get(personId)
  const viewerProfile = await db.profiles.get(viewerId)
  const personName = personProfile?.display_name ?? 'Person'
  const viewerName = viewerProfile?.display_name ?? 'You'

  const ordered = [...events].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  const bills = ordered.filter((e) => e.type !== 'payment')

  const lines: string[] = [
    csvRow('Person', personName),
    csvRow('Exported by', viewerName),
    csvRow('Exported', new Date().toLocaleString()),
    ...section('Bills'),
    csvRow('Date', 'Bill Title', 'Category', 'Group', 'Currency', 'Balance', 'Direction'),
  ]

  for (const ev of bills) {
    const date = new Date(ev.createdAt).toLocaleDateString()
    const direction =
      Math.abs(ev.delta) < 0.005
        ? 'Even'
        : ev.delta > 0
          ? `${personName} owes you`
          : `You owe ${personName}`
    lines.push(
      csvRow(
        date,
        ev.title,
        ev.category ? (CATEGORY_LABELS[ev.category as BillCategory] ?? ev.category) : '',
        ev.contextLabel,
        ev.currency,
        Math.abs(ev.delta) < 0.005 ? 0 : Math.abs(ev.delta),
        direction,
      ),
    )
  }

  // Payments come from the settlement-history payload rather than the statement events, because
  // an event carries only a generated description ("You paid X"). The From/To parties and the
  // user's own note (`label`) exist on the stored rows and nowhere else — deriving this section
  // from the events silently dropped both, so a note like "rent June, half" could not be exported
  // at all.
  const legs = payments
    .flatMap((p) =>
      p.legs.map((l) => ({
        ...l,
        createdAt: p.createdAt,
        label: p.label,
        currency: p.currency,
        groupName: p.groupName ?? '',
      })),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  if (legs.length > 0) {
    lines.push(...section('Payments'))
    lines.push(csvRow('Date', 'From', 'To', 'Amount', 'Currency', 'Group', 'Note'))
    for (const leg of legs) {
      lines.push(
        csvRow(
          new Date(leg.createdAt).toLocaleDateString(),
          leg.fromName,
          leg.toName,
          leg.amount,
          leg.currency,
          leg.groupName,
          leg.label,
        ),
      )
    }
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename('Person', 'csv'))
}
