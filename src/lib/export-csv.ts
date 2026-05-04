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
import { makeExportFilename } from '@/lib/export-utils'

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

async function resolveDisplayName(userId: string, groupId?: string | null): Promise<string> {
  const profile = await db.profiles.get(userId)
  if (profile?.display_name) return profile.display_name
  if (groupId) {
    const member = await db.group_members
      .where('[group_id+user_id]')
      .equals([groupId, userId])
      .first()
    if (member?.display_name) return member.display_name
  }
  return 'Unknown'
}

export async function exportBillsToCSV(userId: string): Promise<void> {
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

  const lines: string[] = [
    csvRow('Personal Bills'),
    csvRow('Exported', new Date().toLocaleString()),
    ...section('Bills'),
    csvRow('Date', 'Bill Title', 'Category', 'Currency', 'Total Amount', 'My Share', 'Settled'),
  ]

  for (const bill of bills) {
    const date = new Date(bill.created_at).toLocaleDateString()
    const catLabel = bill.category ? (CATEGORY_LABELS[bill.category as BillCategory] ?? bill.category) : ''
    const items = (await db.bill_items.where('bill_id').equals(bill.id).toArray()).filter((i) => !i.is_deleted)
    let myShare = 0
    for (const item of items) {
      const splits = (await db.item_splits.where('item_id').equals(item.id).toArray()).filter((s) => !s.is_deleted)
      for (const s of splits) if (s.user_id === userId) myShare += s.computed_amount
    }
    const settled = await isPersonalBillFullySettled(bill.id, userId)
    lines.push(csvRow(date, bill.title, catLabel, bill.currency, bill.total_amount, myShare || '', settled ? 'Yes' : 'No'))
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename('Bills', 'csv'))
}

export async function exportGroupToCSV(groupId: string, currentUserId: string): Promise<void> {
  const group = await db.groups.get(groupId)
  if (!group) return

  const members = (await db.group_members.where('group_id').equals(groupId).toArray()).filter((m) => !m.is_deleted)
  const memberNames: Record<string, string> = {}
  for (const m of members) {
    const p = await db.profiles.get(m.user_id)
    memberNames[m.user_id] = p?.display_name ?? m.display_name
  }

  const bills = (await db.bills.where('group_id').equals(groupId).toArray()).filter((b) => !b.is_deleted)
  bills.sort((a, b) => a.created_at.localeCompare(b.created_at))

  const balanceSummary = await computeGroupBalances(groupId, currentUserId)

  const lines: string[] = [
    csvRow('Group', group.name),
    csvRow('Currency', group.currency),
    csvRow('Members', members.length),
    csvRow('Exported', new Date().toLocaleString()),
  ]

  if (balanceSummary) {
    lines.push(...section('Member Balances'))
    lines.push(csvRow('Member', 'Balance', 'Currency', 'Status'))
    for (const b of balanceSummary.balances) {
      const name = memberNames[b.userId] ?? b.displayName
      const amt = Math.round(b.amount * 100) / 100
      const status = Math.abs(amt) <= 0.01 ? 'Even' : amt > 0 ? 'Receives' : 'Pays'
      lines.push(csvRow(name, Math.abs(amt), group.currency, status))
    }

    if (balanceSummary.groupedSuggestions.length > 0) {
      lines.push(...section('Suggested Payments'))
      lines.push(csvRow('From', 'To', 'Amount', 'Currency'))
      for (const s of balanceSummary.groupedSuggestions) {
        if (s.recipients.length === 1) {
          lines.push(csvRow(s.fromName, s.recipients[0].toName, s.totalAmount, group.currency))
        } else {
          lines.push(csvRow(s.fromName, `${s.recipients.length} people`, s.totalAmount, group.currency))
          for (const r of s.recipients) lines.push(csvRow('', r.toName, r.amount, group.currency))
        }
      }
    }
  }

  const memberIds = members.map((m) => m.user_id)
  lines.push(...section('Bills'))
  lines.push(csvRow('Date', 'Bill Title', 'Category', 'Currency', 'Total Amount', 'Paid By', ...memberIds.map((uid) => memberNames[uid] ?? uid)))

  for (const bill of bills) {
    const date = new Date(bill.created_at).toLocaleDateString()
    const catLabel = bill.category ? (CATEGORY_LABELS[bill.category as BillCategory] ?? bill.category) : ''
    const paidBy = await resolveDisplayName(bill.paid_by, groupId)
    const items = (await db.bill_items.where('bill_id').equals(bill.id).toArray()).filter((i) => !i.is_deleted)
    const shareByUser: Record<string, number> = {}
    for (const item of items) {
      const splits = (await db.item_splits.where('item_id').equals(item.id).toArray()).filter((s) => !s.is_deleted)
      for (const s of splits) shareByUser[s.user_id] = (shareByUser[s.user_id] ?? 0) + s.computed_amount
    }
    lines.push(csvRow(date, bill.title, catLabel, bill.currency, bill.total_amount, paidBy, ...memberIds.map((uid) => shareByUser[uid] ?? '')))
  }

  const settlements = (await db.settlements.where('group_id').equals(groupId).toArray()).filter((s) => !s.is_deleted)
  settlements.sort((a, b) => a.created_at.localeCompare(b.created_at))

  if (settlements.length > 0) {
    lines.push(...section('Payments'))
    lines.push(csvRow('Date', 'From', 'To', 'Amount', 'Currency', 'Note'))
    for (const s of settlements) {
      const date = new Date(s.created_at).toLocaleDateString()
      lines.push(csvRow(date, await resolveDisplayName(s.from_user_id, groupId), await resolveDisplayName(s.to_user_id, groupId), s.amount, s.currency, s.label))
    }
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename(group.name, 'csv'))
}

export async function exportPersonToCSV(personId: string, viewerId: string): Promise<void> {
  const personProfile = await db.profiles.get(personId)
  const viewerProfile = await db.profiles.get(viewerId)
  const personName = personProfile?.display_name ?? 'Person'
  const viewerName = viewerProfile?.display_name ?? 'You'

  const bills = await listBillsInvolvingPair(viewerId, personId)
  bills.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const settlements = await listPairwiseSettlementsBetween(viewerId, personId)

  const lines: string[] = [
    csvRow('Person', personName),
    csvRow('Exported by', viewerName),
    csvRow('Exported', new Date().toLocaleString()),
    ...section('Bills'),
    csvRow('Date', 'Bill Title', 'Group', 'Category', 'Currency', 'Balance', 'Direction'),
  ]

  for (const bill of bills) {
    const date = new Date(bill.created_at).toLocaleDateString()
    const catLabel = bill.category ? (CATEGORY_LABELS[bill.category as BillCategory] ?? bill.category) : ''
    const net = await computePairwiseNetForBill(bill.id, viewerId, personId)
    const direction = Math.abs(net) < 0.005 ? 'Even' : net > 0 ? `${personName} owes you` : `You owe ${personName}`
    lines.push(csvRow(date, bill.title, bill.groupName ?? 'Personal', catLabel, bill.currency, Math.abs(net) < 0.005 ? 0 : Math.abs(net), direction))
  }

  if (settlements.length > 0) {
    lines.push(...section('Payments'))
    lines.push(csvRow('Date', 'From', 'To', 'Amount', 'Currency', 'Group', 'Note'))
    for (const s of settlements) {
      lines.push(csvRow(new Date(s.createdAt).toLocaleDateString(), s.fromName, s.toName, s.amount, s.currency, s.groupName ?? 'Personal', s.label))
    }
  }

  triggerDownload(lines.join('\r\n'), makeExportFilename('Person', 'csv'))
}
