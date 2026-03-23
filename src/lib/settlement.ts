import { db } from '@/db/db'

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

export interface GroupBalanceSummary {
  groupId: string
  groupName: string
  currency: string
  balances: BalanceEntry[]
  suggestions: SettlementSuggestion[]
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

  const bills = await db.bills.where('group_id').equals(groupId).toArray()
  const activeBills = bills.filter((b) => !b.is_deleted)

  const netBalance = new Map<string, number>()
  for (const m of activeMembers) {
    netBalance.set(m.user_id, 0)
  }

  for (const bill of activeBills) {
    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    const activeItems = items.filter((i) => !i.is_deleted)

    for (const item of activeItems) {
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const activeSplits = splits.filter((s) => !s.is_deleted)

      if (activeSplits.length === 0) continue

      const payer = bill.created_by
      const totalSplitAmount = activeSplits.reduce((sum, s) => sum + s.computed_amount, 0)

      netBalance.set(payer, (netBalance.get(payer) ?? 0) + totalSplitAmount)

      for (const split of activeSplits) {
        netBalance.set(split.user_id, (netBalance.get(split.user_id) ?? 0) - split.computed_amount)
      }
    }
  }

  const settlements = await db.settlements.where('group_id').equals(groupId).toArray()
  const activeSettlements = settlements.filter((s) => !s.is_deleted && s.is_settled)
  for (const s of activeSettlements) {
    netBalance.set(s.from_user_id, (netBalance.get(s.from_user_id) ?? 0) + s.amount)
    netBalance.set(s.to_user_id, (netBalance.get(s.to_user_id) ?? 0) - s.amount)
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

  return {
    groupId,
    groupName: group.name,
    currency: group.currency,
    balances,
    suggestions,
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
  const receiveSide: { userId: string; amount: number }[] = []
  const paySide: { userId: string; amount: number }[] = []

  for (const b of balances) {
    if (b.amount > 0.01) {
      receiveSide.push({ userId: b.userId, amount: b.amount })
    } else if (b.amount < -0.01) {
      paySide.push({ userId: b.userId, amount: Math.abs(b.amount) })
    }
  }

  receiveSide.sort((a, b) => b.amount - a.amount)
  paySide.sort((a, b) => b.amount - a.amount)

  const suggestions: SettlementSuggestion[] = []
  let ri = 0
  let pi = 0

  while (ri < receiveSide.length && pi < paySide.length) {
    const receiver = receiveSide[ri]
    const payer = paySide[pi]
    const amount = Math.round(Math.min(receiver.amount, payer.amount) * 100) / 100

    if (amount > 0) {
      suggestions.push({
        fromUserId: payer.userId,
        fromName: nameMap.get(payer.userId) ?? 'Unknown',
        toUserId: receiver.userId,
        toName: nameMap.get(receiver.userId) ?? 'Unknown',
        amount,
      })
    }

    receiver.amount -= amount
    payer.amount -= amount

    if (receiver.amount < 0.01) ri++
    if (payer.amount < 0.01) pi++
  }

  return suggestions
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
}

export async function listSettlementHistoryForGroup(
  groupId: string,
): Promise<SettlementHistoryItem[]> {
  const settlements = await db.settlements.where('group_id').equals(groupId).toArray()
  const active = settlements.filter((s) => !s.is_deleted && s.is_settled)
  active.sort((a, b) => b.created_at.localeCompare(a.created_at))

  const items: SettlementHistoryItem[] = []
  for (const s of active) {
    const [fromP, toP] = await Promise.all([
      db.profiles.get(s.from_user_id),
      db.profiles.get(s.to_user_id),
    ])
    const billRow = s.bill_id ? await db.bills.get(s.bill_id) : null
    items.push({
      id: s.id,
      groupId: groupId,
      billId: s.bill_id ?? null,
      billTitle: billRow && !billRow.is_deleted ? billRow.title : null,
      fromUserId: s.from_user_id,
      toUserId: s.to_user_id,
      fromName: fromP?.display_name ?? 'Someone',
      toName: toP?.display_name ?? 'Someone',
      amount: s.amount,
      currency: s.currency,
      label: s.label ?? '',
      createdAt: s.created_at,
    })
  }
  return items
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
  for (const s of personal) {
    const [fromP, toP] = await Promise.all([
      db.profiles.get(s.from_user_id),
      db.profiles.get(s.to_user_id),
    ])
    const billRow = s.bill_id ? await db.bills.get(s.bill_id) : null
    out.push({
      id: s.id,
      groupId: null,
      groupName: 'Personal',
      billId: s.bill_id ?? null,
      billTitle: billRow && !billRow.is_deleted ? billRow.title : null,
      fromUserId: s.from_user_id,
      toUserId: s.to_user_id,
      fromName: fromP?.display_name ?? 'Someone',
      toName: toP?.display_name ?? 'Someone',
      amount: s.amount,
      currency: s.currency,
      label: s.label ?? '',
      createdAt: s.created_at,
    })
  }

  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}
