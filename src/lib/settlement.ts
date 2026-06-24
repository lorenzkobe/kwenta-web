import { db } from '@/db/db'
import type { Settlement } from '@/types'
import { isEffectivelyZero } from '@/lib/utils'
import {
  buildDebtGraph,
  decomposeDebtGraph,
  groupTransfersByPayer,
  type SettlementLeg,
} from '@/lib/settlement-suggestions'

export interface BalanceEntry {
  userId: string
  displayName: string
  /** Net in group: positive = should receive, negative = should pay */
  amount: number
}

export interface BundledSuggestionRecipient {
  toUserId: string
  toName: string
  amount: number
}

export interface GroupBalanceSummary {
  groupId: string
  groupName: string
  currency: string
  balances: BalanceEntry[]
  /** Positive net for you in this group: amount you should receive */
  totalToReceive: number
  /** Magnitude of negative net for you in this group: amount you should pay */
  totalToPay: number
}

export interface GroupPairwiseEntry {
  /** The other member's canonical roster user id */
  memberUserId: string
  displayName: string
  /** Net from the viewer's perspective: positive = they owe you, negative = you owe them */
  net: number
}

export interface GroupPairwiseSummary {
  groupId: string
  groupName: string
  currency: string
  /** One entry per other member (and any non-member id still present in rows). Excludes the viewer. */
  entries: GroupPairwiseEntry[]
  /** Sum of positive nets: total others owe you in this group */
  totalToReceive: number
  /** Sum of |negative nets|: total you owe others in this group */
  totalToPay: number
}

/**
 * Pairwise net balances for one viewer in a group. Computed from the shared/canonical
 * synced rows (paid_by, item_splits.user_id, settlements.from/to_user_id), so every member
 * computes identical numbers — only which row is "yours" differs. No optimization, no
 * phantom third-party transfers: each number traces to bills you actually shared with that
 * member, plus settled payments between the two of you.
 */
export async function computeGroupPairwiseBalances(
  groupId: string,
  viewerUserId: string,
): Promise<GroupPairwiseSummary | null> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return null

  const members = await db.group_members.where('group_id').equals(groupId).toArray()

  // Roster-first names (incl. soft-deleted rows) so removed members never render "Unknown".
  const nameByUser = new Map<string, string>()
  for (const m of members) {
    if (m.display_name.trim()) nameByUser.set(m.user_id, m.display_name.trim())
  }

  const bills = (await db.bills.where('group_id').equals(groupId).toArray()).filter(
    (b) => !b.is_deleted && (!b.currency || b.currency === group.currency),
  )
  const billIds = bills.map((b) => b.id)
  const items = (
    billIds.length > 0 ? await db.bill_items.where('bill_id').anyOf(billIds).toArray() : []
  ).filter((i) => !i.is_deleted)
  const itemsByBill = new Map<string, typeof items>()
  for (const it of items) {
    const arr = itemsByBill.get(it.bill_id) ?? []
    arr.push(it)
    itemsByBill.set(it.bill_id, arr)
  }
  const itemIds = items.map((i) => i.id)
  const splits = (
    itemIds.length > 0 ? await db.item_splits.where('item_id').anyOf(itemIds).toArray() : []
  ).filter((s) => !s.is_deleted)
  const splitsByItem = new Map<string, typeof splits>()
  for (const sp of splits) {
    const arr = splitsByItem.get(sp.item_id) ?? []
    arr.push(sp)
    splitsByItem.set(sp.item_id, arr)
  }

  // net[otherUserId] from the viewer's perspective.
  const net = new Map<string, number>()
  const bump = (uid: string, delta: number) => net.set(uid, (net.get(uid) ?? 0) + delta)

  for (const bill of bills) {
    const payer = bill.paid_by
    if (!payer) continue
    for (const it of itemsByBill.get(bill.id) ?? []) {
      for (const sp of splitsByItem.get(it.id) ?? []) {
        const uid = sp.user_id
        const amt = sp.computed_amount
        if (payer === viewerUserId && uid !== viewerUserId) {
          bump(uid, amt) // you paid; their share → they owe you
        } else if (uid === viewerUserId && payer !== viewerUserId) {
          bump(payer, -amt) // they paid; your share → you owe them
        }
      }
    }
  }

  const settlements = (await db.settlements.where('group_id').equals(groupId).toArray()).filter(
    (s) => !s.is_deleted && s.is_settled && (!s.currency || s.currency === group.currency),
  )
  for (const s of settlements) {
    if (s.from_user_id === viewerUserId && s.to_user_id !== viewerUserId) {
      bump(s.to_user_id, s.amount) // you paid them → you owe them less
    } else if (s.to_user_id === viewerUserId && s.from_user_id !== viewerUserId) {
      bump(s.from_user_id, -s.amount) // they paid you → they owe you less
    }
  }

  // Surface every active member (other than the viewer), even at net 0 ("settled").
  for (const m of members) {
    if (m.is_deleted || m.user_id === viewerUserId) continue
    if (!net.has(m.user_id)) net.set(m.user_id, 0)
  }

  // Profile enrichment fallback for any orphaned id not on the roster.
  for (const uid of net.keys()) {
    if (!nameByUser.has(uid)) {
      const profile = await db.profiles.get(uid)
      if (profile?.display_name?.trim()) nameByUser.set(uid, profile.display_name.trim())
    }
  }

  let totalToReceive = 0
  let totalToPay = 0
  const entries: GroupPairwiseEntry[] = []
  for (const [memberUserId, raw] of net) {
    if (memberUserId === viewerUserId) continue
    const rounded = Math.round(raw * 100) / 100
    entries.push({
      memberUserId,
      displayName: nameByUser.get(memberUserId) ?? 'Unknown',
      net: rounded,
    })
    if (rounded > 0) totalToReceive += rounded
    else if (rounded < 0) totalToPay += Math.abs(rounded)
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName))

  return {
    groupId,
    groupName: group.name,
    currency: group.currency,
    entries,
    totalToReceive: Math.round(totalToReceive * 100) / 100,
    totalToPay: Math.round(totalToPay * 100) / 100,
  }
}

export interface MemberPaymentParty {
  /** The other member's canonical roster user id */
  memberUserId: string
  displayName: string
  /** Always positive: the magnitude of the pending balance with this member */
  amount: number
}

export interface MemberPaymentBreakdown {
  /** The member whose perspective this breakdown is taken from */
  memberUserId: string
  displayName: string
  currency: string
  /** Members this member still owes (will pay), sorted by name */
  pays: MemberPaymentParty[]
  /** Members who still owe this member (will receive from), sorted by name */
  receives: MemberPaymentParty[]
}

/**
 * Resolve who a single member pays and is paid by within a group. Reparametrizes
 * computeGroupPairwiseBalances from `memberUserId`'s perspective — the canonical synced
 * rows make this identical to what that member sees on their own device — then splits the
 * signed nets into positive-magnitude "pays" (net < 0) and "receives" (net > 0) lists.
 * Settled (net ≈ 0) relationships are omitted from both.
 */
export async function computeMemberPaymentBreakdown(
  groupId: string,
  memberUserId: string,
): Promise<MemberPaymentBreakdown | null> {
  const summary = await computeGroupPairwiseBalances(groupId, memberUserId)
  if (!summary) return null

  const member = await db.group_members
    .where('[group_id+user_id]')
    .equals([groupId, memberUserId])
    .first()
  const displayName = member?.display_name?.trim() || 'Unknown'

  const pays: MemberPaymentParty[] = []
  const receives: MemberPaymentParty[] = []
  for (const entry of summary.entries) {
    if (isEffectivelyZero(entry.net)) continue
    const party: MemberPaymentParty = {
      memberUserId: entry.memberUserId,
      displayName: entry.displayName,
      amount: Math.abs(entry.net),
    }
    if (entry.net < 0) pays.push(party)
    else receives.push(party)
  }

  return {
    memberUserId,
    displayName,
    currency: summary.currency,
    pays,
    receives,
  }
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

  return {
    groupId,
    groupName: group.name,
    currency: group.currency,
    balances,
    totalToReceive,
    totalToPay,
  }
}

export interface SuggestedPayerGroup {
  fromUserId: string
  fromName: string
  total: number
  recipients: { toUserId: string; toName: string; amount: number }[]
  legs: SettlementLeg[]
}

export interface GroupSuggestionsSummary {
  groupId: string
  groupName: string
  currency: string
  /** One entry per physical payer; empty when the group is settled. */
  payers: SuggestedPayerGroup[]
}

/**
 * Whole-group settle-up suggestions. Builds the pairwise debt graph from the canonical
 * synced rows (same source as computeGroupBalances, so every member computes identical
 * suggestions), decomposes it into the fewest physical transfers, and resolves names with
 * the group_members fallback. Each suggested transfer carries the real pairwise legs that
 * back it, so recording them keeps every balance screen consistent.
 */
export async function computeGroupSuggestions(
  groupId: string,
): Promise<GroupSuggestionsSummary | null> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return null

  const members = await db.group_members.where('group_id').equals(groupId).toArray()
  const nameByUser = new Map<string, string>()
  for (const m of members) {
    if (m.display_name.trim()) nameByUser.set(m.user_id, m.display_name.trim())
  }

  const bills = (await db.bills.where('group_id').equals(groupId).toArray()).filter(
    (b) => !b.is_deleted && (!b.currency || b.currency === group.currency),
  )
  const billIds = bills.map((b) => b.id)
  const items = (
    billIds.length > 0 ? await db.bill_items.where('bill_id').anyOf(billIds).toArray() : []
  ).filter((i) => !i.is_deleted)
  const itemsByBill = new Map<string, typeof items>()
  for (const it of items) {
    const arr = itemsByBill.get(it.bill_id) ?? []
    arr.push(it)
    itemsByBill.set(it.bill_id, arr)
  }
  const itemIds = items.map((i) => i.id)
  const splits = (
    itemIds.length > 0 ? await db.item_splits.where('item_id').anyOf(itemIds).toArray() : []
  ).filter((s) => !s.is_deleted)
  const splitsByItem = new Map<string, typeof splits>()
  for (const sp of splits) {
    const arr = splitsByItem.get(sp.item_id) ?? []
    arr.push(sp)
    splitsByItem.set(sp.item_id, arr)
  }

  // Raw directed debts: a split assigns a share the splitter owes the bill's payer.
  const rawDebts: { from: string; to: string; amount: number }[] = []
  for (const bill of bills) {
    const payer = bill.paid_by
    if (!payer) continue
    for (const it of itemsByBill.get(bill.id) ?? []) {
      for (const sp of splitsByItem.get(it.id) ?? []) {
        if (sp.user_id === payer) continue
        rawDebts.push({ from: sp.user_id, to: payer, amount: sp.computed_amount })
      }
    }
  }

  // Settled payments reduce the payer→recipient debt (reverse-direction debt cancels it).
  const settlements = (await db.settlements.where('group_id').equals(groupId).toArray()).filter(
    (s) => !s.is_deleted && s.is_settled && (!s.currency || s.currency === group.currency),
  )
  for (const s of settlements) {
    rawDebts.push({ from: s.to_user_id, to: s.from_user_id, amount: s.amount })
  }

  const transfers = decomposeDebtGraph(buildDebtGraph(rawDebts))
  const grouped = groupTransfersByPayer(transfers)

  // Resolve any id missing from the roster via profiles (orphaned/stale ids).
  const idsToName = new Set<string>()
  for (const g of grouped) {
    idsToName.add(g.fromUserId)
    for (const r of g.recipients) idsToName.add(r.toUserId)
  }
  for (const id of idsToName) {
    if (!nameByUser.has(id)) {
      const profile = await db.profiles.get(id)
      if (profile?.display_name?.trim()) nameByUser.set(id, profile.display_name.trim())
    }
  }
  const nameOf = (id: string) => nameByUser.get(id) ?? 'Unknown'

  const payers: SuggestedPayerGroup[] = grouped
    .map((g) => ({
      fromUserId: g.fromUserId,
      fromName: nameOf(g.fromUserId),
      total: g.total,
      recipients: g.recipients.map((r) => ({
        toUserId: r.toUserId,
        toName: nameOf(r.toUserId),
        amount: r.amount,
      })),
      legs: g.legs,
    }))
    .sort((a, b) => a.fromName.localeCompare(b.fromName))

  return { groupId, groupName: group.name, currency: group.currency, payers }
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

export async function computeAllGroupPairwiseBalances(
  userId: string,
): Promise<GroupPairwiseSummary[]> {
  const memberships = await db.group_members.where('user_id').equals(userId).toArray()
  const activeMemberships = memberships.filter((m) => !m.is_deleted)
  const summaries: GroupPairwiseSummary[] = []
  for (const m of activeMemberships) {
    const summary = await computeGroupPairwiseBalances(m.group_id, userId)
    if (summary) summaries.push(summary)
  }
  return summaries
}

/** Viewer-perspective pairwise net between two members in a group (+ = other owes me). */
export async function computeGroupPairwiseNet(
  groupId: string,
  meId: string,
  otherId: string,
): Promise<number> {
  const summary = await computeGroupPairwiseBalances(groupId, meId)
  if (!summary) return 0
  return summary.entries.find((e) => e.memberUserId === otherId)?.net ?? 0
}

/**
 * The most `from` can pay `to` in this group right now: exactly what `from` owes `to`.
 * Returns 0 when there is no debt (you cannot pay down a debt you do not have).
 */
export async function owedInGroup(
  groupId: string,
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  const net = await computeGroupPairwiseNet(groupId, fromUserId, toUserId)
  return net < 0 ? Math.round(-net * 100) / 100 : 0
}
