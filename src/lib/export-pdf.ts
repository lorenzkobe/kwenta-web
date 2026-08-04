import { db } from '@/db/db'
import { CATEGORY_LABELS } from '@/lib/bill-categories'
import type { BillCategory } from '@/lib/bill-categories'
import type {
  BillDetail,
  GroupDetail,
  PersonalBillRow,
  SettlementHistoryItem,
  StatementEvent,
} from '@/api/balances'
import { makeExportFilename } from '@/lib/export-utils'
import { loadSplitsByBill } from '@/lib/export-splits'

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

/** `rows` is the screen's own server-computed list — see the note on `exportBillsToCSV`. */
export async function generateBillsPDF(userId: string, rows: PersonalBillRow[]): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  let y = drawPageHeader(doc, 'Personal Bills', 'Your bills and shared expenses')

  const bills = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // Cols: 22+68+28+32+32 = 182
  const cols: ColDef[] = [
    { label: 'Date', w: 22 },
    { label: 'Bill Title', w: 68 },
    { label: 'Category', w: 28 },
    { label: 'Total', w: 32, align: 'right' },
    { label: 'My Share', w: 32, align: 'right' },
  ]

  // Two queries for the whole export rather than two per bill; see `loadSplitsByBill`.
  const splitsByBill = await loadSplitsByBill(bills.map((b) => b.id))

  const tableRows: (string | number | null | undefined)[][] = []
  for (const bill of bills) {
    // The viewer's own share is a sum of their own split rows — a record, not a balance.
    const myShare = (splitsByBill.get(bill.id) ?? [])
      .filter((s) => s.userId === userId)
      .reduce((sum, s) => sum + s.amount, 0)
    tableRows.push([
      shortDate(bill.createdAt),
      `${bill.title}${bill.settled ? ' ✓' : ''}`,
      catLabel(bill.category),
      fmt(bill.totalAmount, bill.currency),
      myShare > 0 ? fmt(myShare, bill.currency) : '—',
    ])
  }

  y = drawSectionTitle(doc, 'Bills', y)
  drawTable(doc, cols, tableRows, y)
  doc.save(makeExportFilename('Bills', 'pdf'))
}

/** `detail` is the screen's own payload — see the note on `exportBillsToCSV`. */
export async function generateBillDetailPDF(detail: BillDetail): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const bill = { ...detail.bill, items: detail.items }

  const dateStr = new Date(bill.createdAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
  const sub = `Paid by ${bill.payorName} · ${bill.currency} · ${dateStr}${bill.note ? ` · ${bill.note}` : ''}`
  let y = drawPageHeader(doc, bill.title, sub)

  // Collect participants
  const participantIds: string[] = []
  const participantNames: Record<string, string> = {}
  for (const item of bill.items) {
    for (const split of item.splits) {
      if (!participantIds.includes(split.userId)) {
        participantIds.push(split.userId)
        participantNames[split.userId] = split.displayName
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
      splitMap[split.userId] = split.computedAmount
      personTotals[split.userId] = (personTotals[split.userId] ?? 0) + split.computedAmount
    }
    const row: (string | number | null | undefined)[] = [item.name, fmt(item.amount, bill.currency)]
    if (showPerPerson) {
      for (const uid of participantIds) row.push(splitMap[uid] != null ? fmt(splitMap[uid], bill.currency) : '—')
    }
    rows.push(row)
  }

  // Totals row
  const totalRow: (string | number | null | undefined)[] = ['Total', fmt(bill.totalAmount, bill.currency)]
  if (showPerPerson) {
    for (const uid of participantIds) totalRow.push(personTotals[uid] ? fmt(personTotals[uid], bill.currency) : '—')
  }
  rows.push(totalRow)

  y = drawSectionTitle(doc, 'Items & Splits', y)
  drawTable(doc, cols, rows, y)
  doc.save(makeExportFilename('Bills', 'pdf'))
}

/**
 * `detail` and `payments` are the screen's own server payloads — see `exportGroupToCSV` for why
 * the roster, bills and payment log must not come from the local mirror.
 */
export async function generateGroupPDF(
  detail: GroupDetail,
  payments: SettlementHistoryItem[],
): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const group = detail.group
  const members = detail.members
  const memberNames: Record<string, string> = {}
  for (const m of members) memberNames[m.userId] = m.profileName

  const memberBalances = detail.memberBalances
  const pairwiseEntries = detail.pairwise
  const bills = [...detail.bills].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const settlements = payments
    .flatMap((p) => p.legs.map((l) => ({ ...l, createdAt: p.createdAt, label: p.label })))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  let y = drawPageHeader(
    doc, group.name,
    `${group.currency} · ${members.length} member${members.length !== 1 ? 's' : ''}`,
  )

  {
    // Member balances — 82+48+52 = 182
    y = drawSectionTitle(doc, 'Member Balances', y)
    const balCols: ColDef[] = [
      { label: 'Member', w: 82 },
      { label: 'Balance', w: 48, align: 'right' },
      { label: 'Status', w: 52 },
    ]
    const balRows = memberBalances.map((b) => {
      const amt = Math.round(b.amount * 100) / 100
      const status = Math.abs(amt) <= 0.01 ? 'Settled up' : amt > 0 ? 'Receives' : 'Owes'
      return [b.displayName, fmtSigned(amt, group.currency), status]
    })
    y = drawTable(doc, balCols, balRows, y)

    if (pairwiseEntries.some((e) => Math.abs(e.net) > 0.005)) {
      // Your Balances — 104+52+26 = 182
      y = drawSectionTitle(doc, 'Your Balances', y)
      const balCols: ColDef[] = [
        { label: 'Person', w: 104 },
        { label: 'Status', w: 52 },
        { label: 'Amount', w: 26, align: 'right' },
      ]
      const balRows: (string | number | null | undefined)[][] = []
      for (const e of pairwiseEntries) {
        if (Math.abs(e.net) <= 0.005) continue
        balRows.push([e.displayName, e.net > 0 ? 'Owes you' : 'You owe', fmt(Math.abs(e.net), group.currency)])
      }
      y = drawTable(doc, balCols, balRows, y)
    }
  }

  // Bills — per-member split columns shown when group has ≤ 5 members.
  // With 6+ members portrait width can't fit readable columns; layout stays fixed.
  const memberIds = members.map((m) => m.userId)
  const showMemberSplits = memberIds.length > 0 && memberIds.length <= 5
  const splitsByBill = showMemberSplits
    ? await loadSplitsByBill(bills.map((b) => b.id))
    : new Map<string, { userId: string; amount: number }[]>()

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
    const shareByUser: Record<string, number> = {}
    for (const s of splitsByBill.get(bill.id) ?? []) {
      shareByUser[s.userId] = (shareByUser[s.userId] ?? 0) + s.amount
    }
    billRows.push([
      shortDate(bill.createdAt),
      bill.title,
      fmt(bill.totalAmount, bill.currency),
      bill.payorName,
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
    const payRows = settlements.map((s) => [
      shortDate(s.createdAt),
      s.fromName,
      s.toName,
      fmt(s.amount, group.currency),
      s.label,
    ])
    drawTable(doc, payCols, payRows, y)
  }

  doc.save(makeExportFilename(group.name, 'pdf'))
}

export async function generatePersonPDF(
  personId: string,
  events: StatementEvent[],
  payments: SettlementHistoryItem[],
): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

  const personProfile = await db.profiles.get(personId)
  const personName = personProfile?.display_name ?? 'Person'

  let y = drawPageHeader(doc, personName, 'Balance summary and shared bills')

  // The same events the statement on screen renders (migration 062), so the two agree by
  // construction rather than by two implementations happening to match.
  const ordered = [...events].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  const statementBills = ordered.filter((e) => e.type !== 'payment')
  // From the stored payment rows, not the statement events: only these carry the From/To parties
  // and the user's own note.
  const settlements = payments
    .flatMap((p) =>
      p.legs.map((l) => ({ ...l, createdAt: p.createdAt, label: p.label, currency: p.currency })),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

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
  for (const ev of statementBills) {
    billRows.push([
      shortDate(ev.createdAt),
      ev.title,
      Math.abs(ev.delta) < 0.005 ? '—' : fmtSigned(ev.delta, ev.currency),
      ev.contextLabel,
      catLabel(ev.category),
    ])
  }
  y = drawTable(doc, billCols, billRows, y)

  if (settlements.length > 0) {
    // Payments — 22+44+44+36+36 = 182
    y = drawSectionTitle(doc, 'Payments', y)
    const payCols: ColDef[] = [
      { label: 'Date', w: 22 },
      { label: 'From', w: 44 },
      { label: 'To', w: 44 },
      { label: 'Amount', w: 36, align: 'right' },
      { label: 'Note', w: 36 },
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
