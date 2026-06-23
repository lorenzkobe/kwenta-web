import { db } from '@/db/db'
import type { Settlement } from '@/types'

export interface BalanceEntry {
  userId: string
  displayName: string
  /** Net in group: positive = should receive, negative = should pay */
  amount: number
}

/** One suggested transfer: payer → receiver for `amount`. */
export interface SettlementSuggestion {
  fromUserId: string
  fromName: string
  toUserId: string
  toName: string
  amount: number
}

export interface BundledSuggestionRecipient {
  toUserId: string
  toName: string
  amount: number
}

export interface BundledSettlementSuggestion {
  fromUserId: string
  fromName: string
  totalAmount: number
  recipients: BundledSuggestionRecipient[]
}

export interface GroupBalanceSummary {
  groupId: string
  groupName: string
  currency: string
  balances: BalanceEntry[]
  suggestions: SettlementSuggestion[]
  groupedSuggestions: BundledSettlementSuggestion[]
  /** Positive net for you in this group: amount you should receive */
  totalToReceive: number
  /** Magnitude of negative net for you in this group: amount you should pay */
  totalToPay: number
}

/**
 * Compute net balances for a group.
 * The bill creator paid the total; each split assigns a share to a user.
 * Net balance = (total you paid) - (your share from splits).
 * Positive = you should receive on net. Negative = you should pay on net.
 */
export async function computeGroupBalances(
  groupId: string,
  currentUserId: string,
): Promise<GroupBalanceSummary | null> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return null

  const members = await db.group_members.where('group_id').equals(groupId).toArray()
  const activeMembers = members.filter((m) => !m.is_deleted)

  const profileMap = new Map<string, string>()
  for (const m of activeMembers) {
    const profile = await db.profiles.get(m.user_id)
    profileMap.set(m.user_id, profile?.display_name ?? m.display_name)
  }

  // Identity canonicalization is intentionally NOT derived from the viewer's local
  // profiles here. `linked_profile_id` lives only on the linking user's own local
  // contacts and is never shared across the group (pull-bundle privacy boundary). A
  // viewer-local canon map would collapse a stale local-contact id onto its member id
  // ONLY for the contact's owner, so the same group would produce different balances —
  // and therefore different settlement suggestions — for different members. That cross-
  // member divergence is the bug this avoids.
  //
  // The synced rows are already canonical for everyone: `linkProfileToRemote` rewrites
  // `item_splits.user_id`, `bills.paid_by`, and `settlements.from/to_user_id` from the
  // local contact id to the remote member id and re-syncs them. By keying balances on
  // those shared rows directly, every member computes identical balances and suggestions.
  const bills = await db.bills.where('group_id').equals(groupId).toArray()
  const activeBills = bills.filter((b) => !b.is_deleted)
  const billIds = activeBills.map((bill) => bill.id)
  const allItems =
    billIds.length > 0 ? await db.bill_items.where('bill_id').anyOf(billIds).toArray() : []
  const activeItems = allItems.filter((item) => !item.is_deleted)
  const itemsByBillId = new Map<string, typeof activeItems>()
  for (const item of activeItems) {
    const rows = itemsByBillId.get(item.bill_id) ?? []
    rows.push(item)
    itemsByBillId.set(item.bill_id, rows)
  }

  const itemIds = activeItems.map((item) => item.id)
  const allSplits =
    itemIds.length > 0 ? await db.item_splits.where('item_id').anyOf(itemIds).toArray() : []
  const activeSplits = allSplits.filter((split) => !split.is_deleted)
  const splitsByItemId = new Map<string, typeof activeSplits>()
  for (const split of activeSplits) {
    const rows = splitsByItemId.get(split.item_id) ?? []
    rows.push(split)
    splitsByItemId.set(split.item_id, rows)
  }

  const netBalance = new Map<string, number>()
  for (const m of activeMembers) {
    netBalance.set(m.user_id, 0)
  }

  for (const bill of activeBills) {
    // Group balances are single-currency (the group's). Defensively skip any row that
    // somehow carries a different currency rather than summing across currencies.
    if (bill.currency && bill.currency !== group.currency) continue
    for (const item of itemsByBillId.get(bill.id) ?? []) {
      const activeSplits = splitsByItemId.get(item.id) ?? []

      if (activeSplits.length === 0) continue

      const payer = bill.paid_by
      if (!payer) continue
      const totalSplitAmount = activeSplits.reduce((sum, s) => sum + s.computed_amount, 0)

      netBalance.set(payer, (netBalance.get(payer) ?? 0) + totalSplitAmount)

      for (const split of activeSplits) {
        const uid = split.user_id
        netBalance.set(uid, (netBalance.get(uid) ?? 0) - split.computed_amount)
      }
    }
  }

  const settlements = await db.settlements.where('group_id').equals(groupId).toArray()
  const activeSettlements = settlements.filter(
    (s) => !s.is_deleted && s.is_settled && (!s.currency || s.currency === group.currency),
  )
  for (const s of activeSettlements) {
    netBalance.set(s.from_user_id, (netBalance.get(s.from_user_id) ?? 0) + s.amount)
    netBalance.set(s.to_user_id, (netBalance.get(s.to_user_id) ?? 0) - s.amount)
  }

  // Resolve display names for any userId that appeared in splits/settlements
  // but isn't an active member (e.g. deleted member, stale local contact ID)
  for (const userId of netBalance.keys()) {
    if (!profileMap.has(userId)) {
      const profile = await db.profiles.get(userId)
      if (profile?.display_name) {
        profileMap.set(userId, profile.display_name)
      } else {
        const member = members.find((m) => m.user_id === userId)
        if (member?.display_name) profileMap.set(userId, member.display_name)
      }
    }
  }

  const balances: BalanceEntry[] = []
  let totalToReceive = 0
  let totalToPay = 0

  for (const [userId, amount] of netBalance) {
    const rounded = Math.round(amount * 100) / 100
    balances.push({
      userId,
      displayName: profileMap.get(userId) ?? 'Unknown',
      amount: rounded,
    })
    if (userId === currentUserId) {
      if (rounded > 0) totalToReceive = rounded
      if (rounded < 0) totalToPay = Math.abs(rounded)
    }
  }

  const suggestions = optimizeSettlements(balances, profileMap)
  const groupedSuggestions = groupSuggestionsByPayer(suggestions, profileMap)

  return {
    groupId,
    groupName: group.name,
    currency: group.currency,
    balances,
    suggestions,
    groupedSuggestions,
    totalToReceive,
    totalToPay,
  }
}

/**
 * Greedy settlement optimization: match who should pay with who should receive
 * to minimize number of suggested transfers.
 */
function optimizeSettlements(
  balances: BalanceEntry[],
  nameMap: Map<string, string>,
): SettlementSuggestion[] {
  // Work in integer cents so min()/subtraction are exact: the previous float version
  // could leave sub-cent residuals that prevented the suggestions from fully settling.
  const receiveSide: { userId: string; cents: number }[] = []
  const paySide: { userId: string; cents: number }[] = []

  for (const b of balances) {
    const cents = Math.round(b.amount * 100)
    if (cents > 0) {
      receiveSide.push({ userId: b.userId, cents })
    } else if (cents < 0) {
      paySide.push({ userId: b.userId, cents: -cents })
    }
  }

  receiveSide.sort((a, b) => b.cents - a.cents)
  paySide.sort((a, b) => b.cents - a.cents)

  const suggestions: SettlementSuggestion[] = []
  let ri = 0
  let pi = 0

  while (ri < receiveSide.length && pi < paySide.length) {
    const receiver = receiveSide[ri]
    const payer = paySide[pi]
    const cents = Math.min(receiver.cents, payer.cents)

    if (cents > 0) {
      suggestions.push({
        fromUserId: payer.userId,
        fromName: nameMap.get(payer.userId) ?? 'Unknown',
        toUserId: receiver.userId,
        toName: nameMap.get(receiver.userId) ?? 'Unknown',
        amount: cents / 100,
      })
    }

    receiver.cents -= cents
    payer.cents -= cents

    if (receiver.cents === 0) ri++
    if (payer.cents === 0) pi++
  }

  return suggestions
}

function groupSuggestionsByPayer(
  suggestions: SettlementSuggestion[],
  nameMap: Map<string, string>,
): BundledSettlementSuggestion[] {
  const grouped = new Map<string, BundledSettlementSuggestion>()
  for (const s of suggestions) {
    const existing = grouped.get(s.fromUserId)
    if (!existing) {
      grouped.set(s.fromUserId, {
        fromUserId: s.fromUserId,
        fromName: nameMap.get(s.fromUserId) ?? s.fromName,
        totalAmount: s.amount,
        recipients: [{ toUserId: s.toUserId, toName: s.toName, amount: s.amount }],
      })
      continue
    }
    existing.totalAmount = Math.round((existing.totalAmount + s.amount) * 100) / 100
    existing.recipients.push({ toUserId: s.toUserId, toName: s.toName, amount: s.amount })
  }
  for (const value of grouped.values()) {
    value.recipients.sort((a, b) => b.amount - a.amount)
  }
  return [...grouped.values()].sort((a, b) => b.totalAmount - a.totalAmount)
}

export async function computeAllGroupBalances(
  userId: string,
): Promise<GroupBalanceSummary[]> {
  const memberships = await db.group_members.where('user_id').equals(userId).toArray()
  const activeMemberships = memberships.filter((m) => !m.is_deleted)

  const summaries: GroupBalanceSummary[] = []
  for (const m of activeMemberships) {
    const summary = await computeGroupBalances(m.group_id, userId)
    if (summary) summaries.push(summary)
  }

  return summaries
}

/** Recorded cash/settle events for display (already applied in balance math). */
export interface SettlementHistoryItem {
  id: string
  settlementIds: string[]
  bundleId: string | null
  isBundled: boolean
  /** Null for personal (non-group) payments */
  groupId: string | null
  /** Set when listing across groups (e.g. home / balances). */
  groupName?: string
  /** When set, payment was attributed to this bill */
  billId?: string | null
  billTitle?: string | null
  fromUserId: string
  toUserId: string
  fromName: string
  toName: string
  amount: number
  currency: string
  /** Optional note (e.g. "Cash", "Dinner") — scoped to the group but shown in global lists too */
  label: string
  createdAt: string
  recipients: BundledSuggestionRecipient[]
  /** The user who pressed "Pay" — may differ from fromUserId when someone records on behalf of another */
  recordedByUserId: string | null
  recordedByName: string | null
}

type ActiveSettlementRow = Settlement

async function buildSettlementHistoryItem(
  rows: ActiveSettlementRow[],
  groupId: string | null,
  groupName?: string,
): Promise<SettlementHistoryItem | null> {
  const activeRows = rows.filter((s) => !s.is_deleted && s.is_settled)
  if (activeRows.length === 0) return null

  const sortedRows = [...activeRows].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const primary = sortedRows[0]

  // A settlement's participants may be local contacts owned by another user, so
  // their profile row is never synced into this viewer's Dexie (pull-bundle
  // privacy scoping). group_members.display_name IS synced to every member, so
  // fall back to it before showing the generic "Someone". Use the settlement's
  // own group_id so this works even when callers pass groupId = null (e.g. bill
  // history). Mirrors the name resolution in computeGroupBalances.
  const effectiveGroupId = groupId ?? primary.group_id
  const memberNames = new Map<string, string>()
  if (effectiveGroupId) {
    const members = await db.group_members.where('group_id').equals(effectiveGroupId).toArray()
    for (const m of members) {
      if (m.display_name.trim()) memberNames.set(m.user_id, m.display_name.trim())
    }
  }
  const resolveName = async (userId: string): Promise<string | null> => {
    const profile = await db.profiles.get(userId)
    if (profile?.display_name?.trim()) return profile.display_name.trim()
    return memberNames.get(userId) ?? null
  }

  const fromName = await resolveName(primary.from_user_id)

  const recipientMap = new Map<string, BundledSuggestionRecipient>()
  for (const row of sortedRows) {
    const existing = recipientMap.get(row.to_user_id)
    if (existing) {
      existing.amount = Math.round((existing.amount + row.amount) * 100) / 100
      continue
    }
    recipientMap.set(row.to_user_id, {
      toUserId: row.to_user_id,
      toName: (await resolveName(row.to_user_id)) ?? 'Someone',
      amount: row.amount,
    })
  }

  const recipients = [...recipientMap.values()].sort((a, b) => b.amount - a.amount)
  const billId = sortedRows.every((row) => row.bill_id === primary.bill_id) ? primary.bill_id : null
  const billRow = billId ? await db.bills.get(billId) : null
  const label = sortedRows.find((row) => row.label.trim() !== '')?.label ?? primary.label ?? ''
  const isBundled = Boolean(primary.bundle_id) && recipients.length > 1
  const activityEntityId = primary.bundle_id ?? primary.id
  const activityEntry = await db.activity_log
    .where('entity_id').equals(activityEntityId)
    .filter((a) => !a.is_deleted && a.entity_type === 'settlement' && a.action === 'settled')
    .first()
  const recordedByUserId = activityEntry?.user_id ?? null
  const recordedByName = recordedByUserId ? await resolveName(recordedByUserId) : null

  return {
    id: isBundled ? (primary.bundle_id ?? primary.id) : primary.id,
    settlementIds: sortedRows.map((row) => row.id),
    bundleId: isBundled ? (primary.bundle_id ?? null) : null,
    isBundled,
    groupId,
    groupName,
    billId: billId ?? null,
    billTitle: billRow && !billRow.is_deleted ? billRow.title : null,
    fromUserId: primary.from_user_id,
    toUserId: recipients[0]?.toUserId ?? primary.to_user_id,
    fromName: fromName ?? 'Someone',
    toName: recipients[0]?.toName ?? 'Someone',
    amount: Math.round(recipients.reduce((sum, recipient) => sum + recipient.amount, 0) * 100) / 100,
    currency: primary.currency,
    label,
    createdAt: primary.created_at,
    recipients,
    recordedByUserId,
    recordedByName,
  }
}

async function buildHistoryItemsFromRows(
  rows: ActiveSettlementRow[],
  groupId: string | null,
  groupName?: string,
): Promise<SettlementHistoryItem[]> {
  const groups = new Map<string, ActiveSettlementRow[]>()
  for (const row of rows) {
    const key = row.bundle_id ?? row.id
    const existing = groups.get(key) ?? []
    existing.push(row)
    groups.set(key, existing)
  }

  const items: SettlementHistoryItem[] = []
  for (const groupedRows of groups.values()) {
    const item = await buildSettlementHistoryItem(groupedRows, groupId, groupName)
    if (item) items.push(item)
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}

export async function listSettlementHistoryForBill(
  billId: string,
): Promise<SettlementHistoryItem[]> {
  const rows = await db.settlements
    .where('bill_id')
    .equals(billId)
    .filter((s) => !s.is_deleted && s.is_settled)
    .toArray()
  return buildHistoryItemsFromRows(rows, null)
}

export async function listSettlementHistoryForGroup(
  groupId: string,
): Promise<SettlementHistoryItem[]> {
  const settlements = await db.settlements.where('group_id').equals(groupId).toArray()
  const active = settlements
    .filter((s) => !s.is_deleted && s.is_settled)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  return buildHistoryItemsFromRows(active, groupId)
}

/** All recorded settlements in groups the user belongs to (newest first). */
export async function listSettlementHistoryForUser(
  userId: string,
): Promise<SettlementHistoryItem[]> {
  const memberships = await db.group_members.where('user_id').equals(userId).toArray()
  const groupIds = [...new Set(memberships.filter((m) => !m.is_deleted).map((m) => m.group_id))]

  const out: SettlementHistoryItem[] = []
  for (const gid of groupIds) {
    const group = await db.groups.get(gid)
    if (!group || group.is_deleted) continue
    const rows = await listSettlementHistoryForGroup(gid)
    for (const r of rows) {
      out.push({ ...r, groupName: group.name })
    }
  }

  const allSettlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  const personal = allSettlements.filter(
    (s) =>
      s.group_id === null &&
      (s.from_user_id === userId || s.to_user_id === userId),
  )
  const personalItems = await buildHistoryItemsFromRows(personal, null, 'Personal')
  out.push(...personalItems)

  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}
