import { db } from '@/db/db'
import { CATEGORY_LABELS } from '@/lib/bill-categories'
import type { BillCategory } from '@/lib/bill-categories'
import { isPersonalBillFullySettled } from '@/lib/personal-bill-status'
import {
  computePairwiseNetForBill,
  listBillsInvolvingPair,
  listPairwiseSettlementsBetween,
} from '@/lib/people'
import { computeGroupBalances } from '@/lib/settlement'
import { getBillWithDetails } from '@/db/operations'
import { makeExportFilename } from '@/lib/export-utils'

// A4 Portrait: 210 × 297 mm
const PW = 210
const PH = 297
const M = 14           // page margin
const CW = PW - M * 2  // 182 mm content width

// Minimalist palette
const TEAL     = [13, 148, 136]  as const
const INK      = [15, 23, 42]   as const
const BODY     = [30, 41, 59]   as const
const META     = [100, 116, 139] as const
const MUTED    = [148, 163, 184] as const
const RULE     = [226, 232, 240] as const
const HAIRLINE = [241, 245, 249] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any

interface ColDef {
  label: string
  w: number
  align?: 'left' | 'right' | 'center'
}

// ── Number formatting (no Unicode currency symbols) ────────────────────────

const NUM_FMT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function fmt(amount: number, currency: string): string {
  return `${currency} ${NUM_FMT.format(amount)}`
}

function fmtSigned(amount: number, currency: string): string {
  if (Math.abs(amount) < 0.005) return `${currency} 0.00`
  const sign = amount > 0 ? '+' : '-'
  return `${sign}${currency} ${NUM_FMT.format(Math.abs(amount))}`
}

// ── Drawing helpers ────────────────────────────────────────────────────────

function drawPageHeader(doc: Doc, title: string, subtitle: string): number {
  // Thin teal top accent
  doc.setFillColor(...TEAL)
  doc.rect(0, 0, PW, 1.5, 'F')

  // Title
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(...INK)
  doc.text(title, M, 10)

  // Subtitle (may wrap on narrow portrait page)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  const subLines: string[] = doc.splitTextToSize(subtitle, CW * 0.65)
  doc.text(subLines, M, 15.5)
  const subH = subLines.length * 4

  // Brand — top right
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...TEAL)
  doc.text('KWENTA', PW - M, 9.5, { align: 'right' })

  // Date
  const dateStr = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(...MUTED)
  doc.text(dateStr, PW - M, 14, { align: 'right' })

  // Divider
  const dividerY = Math.max(20, 15 + subH)
  doc.setDrawColor(...RULE)
  doc.setLineWidth(0.4)
  doc.line(0, dividerY, PW, dividerY)

  return dividerY + 5
}

function drawSectionTitle(doc: Doc, label: string, y: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7)
  doc.setTextColor(...META)
  doc.text(label.toUpperCase(), M, y + 3.5)

  doc.setDrawColor(...RULE)
  doc.setLineWidth(0.3)
  doc.line(M, y + 5, M + CW, y + 5)

  return y + 9
}

function drawTable(
  doc: Doc,
  cols: ColDef[],
  rows: (string | number | null | undefined)[][],
  startY: number,
): number {
  const LINE_H = 4.2   // mm per wrapped text line
  const PAD_H = 3      // horizontal padding per side (mm)
  const PAD_V = 2      // vertical padding top+bottom per side (mm)
  const HEADER_H = 7   // fixed height for column header row

  if (startY + HEADER_H * 2 > PH - M) {
    doc.addPage()
    startY = 24
  }

  // Pre-compute wrapped lines for every cell using body font
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)

  const wrappedRows = rows.map((row) =>
    cols.map((col, j) => {
      const val = row[j]
      const text = val !== null && val !== undefined ? String(val) : ''
      if (!text) return [] as string[]
      const usable = col.w - PAD_H * 2
      return doc.splitTextToSize(text, usable) as string[]
    }),
  )

  // Row height = max wrapped lines × LINE_H + vertical padding
  const rowHeights = wrappedRows.map((wr) => {
    const maxLines = Math.max(1, ...wr.map((lines) => lines.length))
    return maxLines * LINE_H + PAD_V * 2
  })

  function cellTx(colX: number, colW: number, align: 'left' | 'right' | 'center'): number {
    if (align === 'right') return colX + colW - PAD_H
    if (align === 'center') return colX + colW / 2
    return colX + PAD_H
  }

  function renderHeaderRow(hy: number) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.5)
    doc.setTextColor(...META)
    let hx = M
    for (const col of cols) {
      const a = col.align ?? 'left'
      doc.text(col.label.toUpperCase(), cellTx(hx, col.w, a), hy + HEADER_H - PAD_V, {
        align: a === 'center' ? 'center' : a,
      })
      hx += col.w
    }
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.5)
    doc.line(M, hy + HEADER_H, M + CW, hy + HEADER_H)
  }

  renderHeaderRow(startY)
  let y = startY + HEADER_H

  for (let i = 0; i < rows.length; i++) {
    const rh = rowHeights[i]

    // Page break: ensure header + first line of data fits
    if (y + rh > PH - M) {
      doc.addPage()
      y = 24
      renderHeaderRow(y)
      y += HEADER_H
    }

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...BODY)

    let cx = M
    for (let j = 0; j < cols.length; j++) {
      const col = cols[j]
      const a = col.align ?? 'left'
      const tx = cellTx(cx, col.w, a)
      const lines = wrappedRows[i][j]
      for (let li = 0; li < lines.length; li++) {
        if (lines[li]) {
          doc.text(lines[li], tx, y + PAD_V + LINE_H * 0.8 + li * LINE_H, {
            align: a === 'center' ? 'center' : a,
          })
        }
      }
      cx += col.w
    }

    doc.setDrawColor(...HAIRLINE)
    doc.setLineWidth(0.2)
    doc.line(M, y + rh, M + CW, y + rh)

    y += rh
  }

  doc.setDrawColor(...RULE)
  doc.setLineWidth(0.4)
  doc.line(M, y, M + CW, y)

  return y + 7
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function catLabel(category: string | null | undefined): string {
  if (!category) return ''
  return CATEGORY_LABELS[category as BillCategory] ?? category
}

// ── Export functions ───────────────────────────────────────────────────────

export async function generateBillsPDF(userId: string): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  let y = drawPageHeader(doc, 'Personal Bills', 'Your bills and shared expenses')

  const allBills = await db.bills.toArray()
  const myBills = allBills.filter((b) => !b.is_deleted && b.group_id === null && b.created_by === userId)

  const mySplits = (await db.item_splits.where('user_id').equals(userId).toArray()).filter((s) => !s.is_deleted)
  const splitItemIds = new Set(mySplits.map((s) => s.item_id))
  const splitItemsArr = splitItemIds.size > 0 ? await db.bill_items.where('id').anyOf([...splitItemIds]).toArray() : []
  const splitBillIds = new Set(splitItemsArr.filter((i) => !i.is_deleted).map((i) => i.bill_id))
  const splitBillsRaw = splitBillIds.size > 0 ? await db.bills.where('id').anyOf([...splitBillIds]).toArray() : []
  const sharedBills = splitBillsRaw.filter((b) => !b.is_deleted && b.group_id === null && b.created_by !== userId)

  const bills = [...myBills, ...sharedBills]
  bills.sort((a, b) => a.created_at.localeCompare(b.created_at))

  // Cols: 22+68+28+32+32 = 182
  const cols: ColDef[] = [
    { label: 'Date', w: 22 },
    { label: 'Bill Title', w: 68 },
    { label: 'Category', w: 28 },
    { label: 'Total', w: 32, align: 'right' },
    { label: 'My Share', w: 32, align: 'right' },
  ]

  const rows: (string | number | null | undefined)[][] = []
  for (const bill of bills) {
    const items = (await db.bill_items.where('bill_id').equals(bill.id).toArray()).filter((i) => !i.is_deleted)
    let myShare = 0
    for (const item of items) {
      const splits = (await db.item_splits.where('item_id').equals(item.id).toArray()).filter((s) => !s.is_deleted)
      for (const s of splits) if (s.user_id === userId) myShare += s.computed_amount
    }
    const settled = await isPersonalBillFullySettled(bill.id, userId)
    rows.push([
      shortDate(bill.created_at),
      `${bill.title}${settled ? ' ✓' : ''}`,
      catLabel(bill.category),
      fmt(bill.total_amount, bill.currency),
      myShare > 0 ? fmt(myShare, bill.currency) : '—',
    ])
  }

  y = drawSectionTitle(doc, 'Bills', y)
  drawTable(doc, cols, rows, y)
  doc.save(makeExportFilename('Bills', 'pdf'))
}

export async function generateBillDetailPDF(billId: string): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const bill = await getBillWithDetails(billId)
  if (!bill) return

  const dateStr = new Date(bill.created_at).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
  const sub = `Paid by ${bill.payorName} · ${bill.currency} · ${dateStr}${bill.note ? ` · ${bill.note}` : ''}`
  let y = drawPageHeader(doc, bill.title, sub)

  // Collect participants
  const participantIds: string[] = []
  const participantNames: Record<string, string> = {}
  for (const item of bill.items) {
    for (const split of item.splits) {
      if (!participantIds.includes(split.user_id)) {
        participantIds.push(split.user_id)
        participantNames[split.user_id] = split.displayName
      }
    }
  }

  // Item(70) + Amount(30) + per-person distributed from remaining 82mm (max 4 people)
  const showPerPerson = participantIds.length > 0 && participantIds.length <= 4
  const fixedW = 70 + 30
  const remaining = CW - fixedW  // 82mm
  const personColW = showPerPerson ? Math.floor(remaining / participantIds.length) : 0
  const itemColW = 70 + (showPerPerson ? 0 : remaining)

  const cols: ColDef[] = [
    { label: 'Item', w: itemColW },
    { label: 'Amount', w: 30, align: 'right' },
    ...(showPerPerson
      ? participantIds.map((uid) => ({
          label: participantNames[uid] ?? uid,
          w: personColW,
          align: 'right' as const,
        }))
      : []),
  ]

  const personTotals: Record<string, number> = {}
  const rows: (string | number | null | undefined)[][] = []
  for (const item of bill.items) {
    const splitMap: Record<string, number> = {}
    for (const split of item.splits) {
      splitMap[split.user_id] = split.computed_amount
      personTotals[split.user_id] = (personTotals[split.user_id] ?? 0) + split.computed_amount
    }
    const row: (string | number | null | undefined)[] = [item.name, fmt(item.amount, bill.currency)]
    if (showPerPerson) {
      for (const uid of participantIds) row.push(splitMap[uid] != null ? fmt(splitMap[uid], bill.currency) : '—')
    }
    rows.push(row)
  }

  // Totals row
  const totalRow: (string | number | null | undefined)[] = ['Total', fmt(bill.total_amount, bill.currency)]
  if (showPerPerson) {
    for (const uid of participantIds) totalRow.push(personTotals[uid] ? fmt(personTotals[uid], bill.currency) : '—')
  }
  rows.push(totalRow)

  y = drawSectionTitle(doc, 'Items & Splits', y)
  drawTable(doc, cols, rows, y)
  doc.save(makeExportFilename('Bills', 'pdf'))
}

export async function generateGroupPDF(groupId: string, currentUserId: string): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const group = await db.groups.get(groupId)
  if (!group) return

  const members = (await db.group_members.where('group_id').equals(groupId).toArray()).filter((m) => !m.is_deleted)
  const memberNames: Record<string, string> = {}
  for (const m of members) {
    const p = await db.profiles.get(m.user_id)
    memberNames[m.user_id] = p?.display_name ?? m.display_name
  }

  const balanceSummary = await computeGroupBalances(groupId, currentUserId)
  const bills = (await db.bills.where('group_id').equals(groupId).toArray()).filter((b) => !b.is_deleted)
  bills.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const settlements = (await db.settlements.where('group_id').equals(groupId).toArray()).filter((s) => !s.is_deleted)
  settlements.sort((a, b) => a.created_at.localeCompare(b.created_at))

  let y = drawPageHeader(
    doc, group.name,
    `${group.currency} · ${members.length} member${members.length !== 1 ? 's' : ''}`,
  )

  if (balanceSummary) {
    // Member balances — 82+48+52 = 182
    y = drawSectionTitle(doc, 'Member Balances', y)
    const balCols: ColDef[] = [
      { label: 'Member', w: 82 },
      { label: 'Balance', w: 48, align: 'right' },
      { label: 'Status', w: 52 },
    ]
    const balRows = balanceSummary.balances.map((b) => {
      const amt = Math.round(b.amount * 100) / 100
      const status = Math.abs(amt) <= 0.01 ? 'Settled up' : amt > 0 ? 'Receives' : 'Owes'
      return [b.displayName, fmtSigned(amt, group.currency), status]
    })
    y = drawTable(doc, balCols, balRows, y)

    if (balanceSummary.groupedSuggestions.length > 0) {
      // Suggested payments — 78+78+26 = 182
      y = drawSectionTitle(doc, 'Suggested Payments', y)
      const sugCols: ColDef[] = [
        { label: 'From', w: 78 },
        { label: 'To', w: 78 },
        { label: 'Amount', w: 26, align: 'right' },
      ]
      const sugRows: (string | number | null | undefined)[][] = []
      for (const s of balanceSummary.groupedSuggestions) {
        const toLabel = s.recipients.length === 1
          ? s.recipients[0].toName
          : s.recipients.map((r) => r.toName).join(', ')
        sugRows.push([s.fromName, toLabel, fmt(s.totalAmount, group.currency)])
      }
      y = drawTable(doc, sugCols, sugRows, y)
    }
  }

  // Bills — per-member split columns shown when group has ≤ 5 members.
  // With 6+ members portrait width can't fit readable columns; layout stays fixed.
  const memberIds = members.map((m) => m.user_id)
  const showMemberSplits = memberIds.length > 0 && memberIds.length <= 5

  // Allocate 74 mm pool for member columns; distribute evenly.
  const memberColW = showMemberSplits ? Math.floor(74 / memberIds.length) : 0
  const memberTotalW = memberColW * memberIds.length
  // Date(22) + Total(26) + Paid By(26) = 74 fixed; title takes whatever remains.
  const titleW = CW - 22 - 26 - 26 - memberTotalW

  function truncateName(name: string, maxW: number): string {
    const maxChars = Math.max(4, Math.floor(maxW / 1.8))
    return name.length <= maxChars ? name : `${name.slice(0, maxChars - 1)}…`
  }

  y = drawSectionTitle(doc, 'Bills', y)
  const billCols: ColDef[] = [
    { label: 'Date', w: 22 },
    { label: 'Title', w: titleW },
    { label: 'Total', w: 26, align: 'right' },
    { label: 'Paid By', w: 26 },
    ...(showMemberSplits
      ? memberIds.map((uid) => ({
          label: truncateName(memberNames[uid] ?? uid, memberColW),
          w: memberColW,
          align: 'right' as const,
        }))
      : []),
  ]

  const billRows: (string | number | null | undefined)[][] = []
  for (const bill of bills) {
    const paidBy = memberNames[bill.created_by] ?? 'Unknown'
    const shareByUser: Record<string, number> = {}
    if (showMemberSplits) {
      const items = (await db.bill_items.where('bill_id').equals(bill.id).toArray()).filter((i) => !i.is_deleted)
      for (const item of items) {
        const splits = (await db.item_splits.where('item_id').equals(item.id).toArray()).filter((s) => !s.is_deleted)
        for (const s of splits) shareByUser[s.user_id] = (shareByUser[s.user_id] ?? 0) + s.computed_amount
      }
    }
    billRows.push([
      shortDate(bill.created_at),
      bill.title,
      fmt(bill.total_amount, bill.currency),
      paidBy,
      ...(showMemberSplits
        ? memberIds.map((uid) => (shareByUser[uid] ? fmt(shareByUser[uid], bill.currency) : '—'))
        : []),
    ])
  }
  y = drawTable(doc, billCols, billRows, y)

  if (settlements.length > 0) {
    // Payments — 22+48+48+36+28 = 182
    y = drawSectionTitle(doc, 'Payments', y)
    const payCols: ColDef[] = [
      { label: 'Date', w: 22 },
      { label: 'From', w: 48 },
      { label: 'To', w: 48 },
      { label: 'Amount', w: 36, align: 'right' },
      { label: 'Note', w: 28 },
    ]
    const payRows = await Promise.all(settlements.map(async (s) => [
      shortDate(s.created_at),
      memberNames[s.from_user_id] ?? 'Unknown',
      memberNames[s.to_user_id] ?? 'Unknown',
      fmt(s.amount, s.currency),
      s.label,
    ]))
    drawTable(doc, payCols, payRows, y)
  }

  doc.save(makeExportFilename(group.name, 'pdf'))
}

export async function generatePersonPDF(personId: string, viewerId: string): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const personProfile = await db.profiles.get(personId)
  const personName = personProfile?.display_name ?? 'Person'

  let y = drawPageHeader(doc, personName, 'Balance summary and shared bills')

  const bills = await listBillsInvolvingPair(viewerId, personId)
  bills.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const settlements = await listPairwiseSettlementsBetween(viewerId, personId)

  // Bills — 22+68+32+30+30 = 182
  y = drawSectionTitle(doc, 'Shared Bills', y)
  const billCols: ColDef[] = [
    { label: 'Date', w: 22 },
    { label: 'Bill Title', w: 68 },
    { label: 'Balance', w: 36, align: 'right' },
    { label: 'Group', w: 30 },
    { label: 'Category', w: 26 },
  ]

  const billRows: (string | number | null | undefined)[][] = []
  for (const bill of bills) {
    const net = await computePairwiseNetForBill(bill.id, viewerId, personId)
    billRows.push([
      shortDate(bill.created_at),
      bill.title,
      Math.abs(net) < 0.005 ? '—' : fmtSigned(net, bill.currency),
      bill.groupName ?? 'Personal',
      catLabel(bill.category),
    ])
  }
  y = drawTable(doc, billCols, billRows, y)

  if (settlements.length > 0) {
    // Payments — 22+46+46+36+32 = 182
    y = drawSectionTitle(doc, 'Payments', y)
    const payCols: ColDef[] = [
      { label: 'Date', w: 22 },
      { label: 'From', w: 46 },
      { label: 'To', w: 46 },
      { label: 'Amount', w: 36, align: 'right' },
      { label: 'Note', w: 32 },
    ]
    const payRows = settlements.map((s) => [
      shortDate(s.createdAt),
      s.fromName,
      s.toName,
      fmt(s.amount, s.currency),
      s.label,
    ])
    drawTable(doc, payCols, payRows, y)
  }

  doc.save(makeExportFilename('Person', 'pdf'))
}
