import { db } from '@/db/db'
import type { Bill } from '@/types'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { formatCurrency } from '@/lib/utils'

export interface ProfileDisplay {
  displayName: string
  subtitle?: string
}

/** Resolved label for UI (linked accounts show remote name). */
export async function resolveProfileDisplay(profileId: string): Promise<ProfileDisplay> {
  const p = await db.profiles.get(profileId)
  if (!p || p.is_deleted) return { displayName: 'Unknown' }
  if (p.linked_profile_id) {
    const linked = await db.profiles.get(p.linked_profile_id)
    if (linked && !linked.is_deleted) {
      return {
        displayName: linked.display_name,
        subtitle: `Linked · Saved as ${p.display_name}`,
      }
    }
  }
  return {
    displayName: p.display_name,
    subtitle: p.email ? undefined : 'Local contact',
  }
}

/** Net balance per currency: positive = other owes you, negative = you owe other. Bills count only when payer is you or them. */
export async function computePairwiseNet(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const byCurrency = new Map<string, number>()

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()

  for (const bill of bills) {
    if (bill.created_by !== meId && bill.created_by !== otherId) continue

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const active = splits.filter((s) => !s.is_deleted)
      const mySplit = active.find((s) => s.user_id === meId)
      const otherSplit = active.find((s) => s.user_id === otherId)
      if (!mySplit || !otherSplit) continue

      const cur = bill.currency
      const prev = byCurrency.get(cur) ?? 0

      if (bill.created_by === meId) {
        byCurrency.set(cur, prev + otherSplit.computed_amount)
      } else {
        byCurrency.set(cur, prev - mySplit.computed_amount)
      }
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    const meInvolved = s.from_user_id === meId || s.to_user_id === meId
    const otherInvolved = s.from_user_id === otherId || s.to_user_id === otherId
    if (!meInvolved || !otherInvolved) continue

    const cur = s.currency
    const prev = byCurrency.get(cur) ?? 0
    if (s.from_user_id === otherId && s.to_user_id === meId) {
      byCurrency.set(cur, prev + s.amount)
    } else if (s.from_user_id === meId && s.to_user_id === otherId) {
      byCurrency.set(cur, prev - s.amount)
    }
  }

  return byCurrency
}

export function formatPairwiseSummary(byCurrency: Map<string, number>): {
  lines: string[]
  primaryLabel: string
  tone: 'balanced' | 'collect' | 'pay'
} {
  const entries = [...byCurrency.entries()].filter(([, v]) => Math.abs(v) > 0.005)
  if (entries.length === 0) {
    return { lines: [], primaryLabel: 'Balanced', tone: 'balanced' }
  }

  const lines = entries.map(([cur, net]) => {
    if (net > 0) return `They owe you ${formatCurrency(net, cur)}`
    return `You owe them ${formatCurrency(Math.abs(net), cur)}`
  })

  const [cur0, net0] = entries[0]
  const tone = net0 > 0 ? 'collect' : 'pay'
  const primaryLabel =
    net0 > 0
      ? `They owe you ${formatCurrency(net0, cur0)}`
      : `You owe them ${formatCurrency(Math.abs(net0), cur0)}`

  return { lines, primaryLabel, tone }
}

/** Profile ids you share expenses with (groups, bills, settlements). */
export async function collectRelatedProfileIds(meId: string): Promise<Set<string>> {
  const ids = new Set<string>()

  const memberships = await db.group_members.where('user_id').equals(meId).toArray()
  const myGroupIds = new Set(
    memberships.filter((m) => !m.is_deleted).map((m) => m.group_id),
  )

  const ownedLocals = await db.profiles.where('owner_id').equals(meId).toArray()
  for (const p of ownedLocals) {
    if (!p.is_deleted) ids.add(p.id)
  }

  for (const gid of myGroupIds) {
    const members = await db.group_members.where('group_id').equals(gid).toArray()
    for (const m of members) {
      if (!m.is_deleted && m.user_id !== meId) ids.add(m.user_id)
    }
  }

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()
  for (const bill of bills) {
    if (bill.group_id && !myGroupIds.has(bill.group_id)) continue

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    let iParticipate = false
    const participantIds = new Set<string>()
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      for (const s of splits) {
        if (s.is_deleted) continue
        participantIds.add(s.user_id)
        if (s.user_id === meId) iParticipate = true
      }
    }
    if (!iParticipate) continue
    for (const uid of participantIds) {
      if (uid !== meId) ids.add(uid)
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    if (s.from_user_id === meId || s.to_user_id === meId) {
      if (s.from_user_id !== meId) ids.add(s.from_user_id)
      if (s.to_user_id !== meId) ids.add(s.to_user_id)
    }
  }

  return ids
}

export interface BillWithContext extends Bill {
  groupName: string | null
  creatorName: string
}

export async function listBillsInvolvingPair(meId: string, otherId: string): Promise<BillWithContext[]> {
  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()
  const out: BillWithContext[] = []

  for (const bill of bills) {
    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    let both = false
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const active = splits.filter((s) => !s.is_deleted)
      const uids = new Set(active.map((s) => s.user_id))
      if (uids.has(meId) && uids.has(otherId)) {
        both = true
        break
      }
    }
    if (!both) continue

    const creator = await db.profiles.get(bill.created_by)
    let groupName: string | null = null
    if (bill.group_id) {
      const g = await db.groups.get(bill.group_id)
      if (g && !g.is_deleted) groupName = g.name
    }

    out.push({
      ...bill,
      groupName,
      creatorName: creator?.display_name ?? 'Unknown',
    })
  }

  out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return out
}

export interface MemberSuggestion {
  id: string
  displayName: string
  kind: 'local' | 'online'
}

/** Names matching query from your local contacts and people in your groups (online). */
export async function getMemberSuggestions(
  currentUserId: string,
  query: string,
  limit = 12,
): Promise<MemberSuggestion[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 1) return []

  const memberships = await db.group_members.where('user_id').equals(currentUserId).toArray()
  const myGroupIds = new Set(
    memberships.filter((m) => !m.is_deleted).map((m) => m.group_id),
  )
  const onlineInGroups = new Set<string>()
  for (const gid of myGroupIds) {
    const members = await db.group_members.where('group_id').equals(gid).toArray()
    for (const m of members) {
      if (!m.is_deleted && m.user_id !== currentUserId) onlineInGroups.add(m.user_id)
    }
  }

  const all = await db.profiles.filter((p) => !p.is_deleted).toArray()
  const scored: { id: string; displayName: string; kind: 'local' | 'online'; score: number }[] = []

  for (const p of all) {
    if (p.id === currentUserId) continue
    const name = p.display_name.trim()
    const lower = name.toLowerCase()
    if (!lower.includes(q)) continue

    const isMine = p.owner_id === currentUserId
    const inMyGroups = onlineInGroups.has(p.id)
    if (!isMine && !inMyGroups) continue

    const kind: 'local' | 'online' = isMine ? 'local' : 'online'
    let score = 0
    if (lower.startsWith(q)) score += 10
    if (isMine) score += 5
    if (inMyGroups) score += 3
    scored.push({ id: p.id, displayName: name, kind, score })
  }

  scored.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
  return scored.slice(0, limit).map(({ id, displayName, kind }) => ({ id, displayName, kind }))
}

export async function listPairwiseSettlementsBetween(
  meId: string,
  otherId: string,
): Promise<SettlementHistoryItem[]> {
  const all = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  const pair = all.filter(
    (s) =>
      (s.from_user_id === meId && s.to_user_id === otherId) ||
      (s.from_user_id === otherId && s.to_user_id === meId),
  )
  const items: SettlementHistoryItem[] = []
  for (const s of pair) {
    let groupName: string | undefined
    if (s.group_id) {
      const g = await db.groups.get(s.group_id)
      groupName = g?.name ?? 'Group'
    } else {
      groupName = 'Personal'
    }
    const [fromP, toP] = await Promise.all([
      db.profiles.get(s.from_user_id),
      db.profiles.get(s.to_user_id),
    ])
    items.push({
      id: s.id,
      groupId: s.group_id,
      groupName,
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
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}
