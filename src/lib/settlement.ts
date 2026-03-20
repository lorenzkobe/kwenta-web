import { db } from '@/db/db'

export interface BalanceEntry {
  userId: string
  displayName: string
  amount: number
}

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
  totalOwed: number
  totalOwing: number
}

/**
 * Compute net balances for a group.
 * The bill creator paid the total; each split assigns a share to a user.
 * Net balance = (total you paid) - (total you owe from splits).
 * Positive = others owe you. Negative = you owe others.
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
  let totalOwed = 0
  let totalOwing = 0

  for (const [userId, amount] of netBalance) {
    const rounded = Math.round(amount * 100) / 100
    balances.push({
      userId,
      displayName: profileMap.get(userId) ?? 'Unknown',
      amount: rounded,
    })
    if (userId === currentUserId) {
      if (rounded > 0) totalOwed = rounded
      if (rounded < 0) totalOwing = Math.abs(rounded)
    }
  }

  const suggestions = optimizeSettlements(balances, profileMap)

  return {
    groupId,
    groupName: group.name,
    currency: group.currency,
    balances,
    suggestions,
    totalOwed,
    totalOwing,
  }
}

/**
 * Greedy settlement optimization: match largest creditor with largest debtor
 * to minimize number of transactions.
 */
function optimizeSettlements(
  balances: BalanceEntry[],
  nameMap: Map<string, string>,
): SettlementSuggestion[] {
  const creditors: { userId: string; amount: number }[] = []
  const debtors: { userId: string; amount: number }[] = []

  for (const b of balances) {
    if (b.amount > 0.01) {
      creditors.push({ userId: b.userId, amount: b.amount })
    } else if (b.amount < -0.01) {
      debtors.push({ userId: b.userId, amount: Math.abs(b.amount) })
    }
  }

  creditors.sort((a, b) => b.amount - a.amount)
  debtors.sort((a, b) => b.amount - a.amount)

  const suggestions: SettlementSuggestion[] = []
  let ci = 0
  let di = 0

  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci]
    const d = debtors[di]
    const amount = Math.round(Math.min(c.amount, d.amount) * 100) / 100

    if (amount > 0) {
      suggestions.push({
        fromUserId: d.userId,
        fromName: nameMap.get(d.userId) ?? 'Unknown',
        toUserId: c.userId,
        toName: nameMap.get(c.userId) ?? 'Unknown',
        amount,
      })
    }

    c.amount -= amount
    d.amount -= amount

    if (c.amount < 0.01) ci++
    if (d.amount < 0.01) di++
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
