import { db } from '@/db/db'
import type { Bill } from '@/types'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { computeGroupBalances } from '@/lib/settlement'
import { formatCurrency } from '@/lib/utils'

const LINK_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Resolve a remote profile id for “link local contact → account”.
 * Accepts Kwenta profile UUID or the sign-in email (case-insensitive). Email must exist on this device.
 */
export async function findRemoteProfileIdForLinking(input: string): Promise<string | null> {
  const raw = input.trim()
  if (!raw) return null

  if (LINK_UUID_RE.test(raw)) {
    const p = await db.profiles.get(raw)
    if (!p || p.is_deleted || !p.email?.trim()) return null
    return p.id
  }

  const normalized = raw.toLowerCase()
  if (!normalized.includes('@')) return null

  const matches = await db.profiles
    .filter(
      (p) =>
        !p.is_deleted &&
        (p.email?.trim().toLowerCase() ?? '') === normalized &&
        Boolean(p.email?.trim()),
    )
    .toArray()

  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0].id

  const nonLocal = matches.find((p) => !p.is_local)
  return (nonLocal ?? matches[0]).id
}

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

/** Net balance per currency: positive = you should receive from them, negative = you should pay them. Bills count only when payer is you or them. */
export async function computePairwiseNet(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)

  const byCurrency = new Map<string, number>()

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()

  for (const bill of bills) {
    if (!meIds.has(bill.created_by) && !otherIds.has(bill.created_by)) continue

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const active = splits.filter((s) => !s.is_deleted)
      const mySplit = active.find((s) => meIds.has(s.user_id))
      const otherSplit = active.find((s) => otherIds.has(s.user_id))
      if (!mySplit || !otherSplit) continue

      const cur = bill.currency
      const prev = byCurrency.get(cur) ?? 0

      if (meIds.has(bill.created_by)) {
        byCurrency.set(cur, prev + otherSplit.computed_amount)
      } else {
        byCurrency.set(cur, prev - mySplit.computed_amount)
      }
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    if (!((fromMe && toOther) || (fromOther && toMe))) continue

    const cur = s.currency
    const prev = byCurrency.get(cur) ?? 0
    if (fromOther && toMe) {
      byCurrency.set(cur, prev + s.amount)
    } else if (fromMe && toOther) {
      byCurrency.set(cur, prev - s.amount)
    }
  }

  return byCurrency
}

export function formatPairwiseSummary(byCurrency: Map<string, number>): {
  lines: string[]
  primaryLabel: string
  tone: 'balanced' | 'receive' | 'pay'
} {
  const entries = [...byCurrency.entries()].filter(([, v]) => Math.abs(v) > 0.005)
  if (entries.length === 0) {
    return { lines: [], primaryLabel: 'Balanced', tone: 'balanced' }
  }

  const lines = entries.map(([cur, net]) => {
    if (net > 0) return `Receive ${formatCurrency(net, cur)} from them`
    return `Pay ${formatCurrency(Math.abs(net), cur)} to them`
  })

  const [cur0, net0] = entries[0]
  const tone = net0 > 0 ? 'receive' : 'pay'
  const primaryLabel =
    net0 > 0
      ? `Receive ${formatCurrency(net0, cur0)} from them`
      : `Pay ${formatCurrency(Math.abs(net0), cur0)} to them`

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

/**
 * IDs that refer to the same real person for matching `item_splits.user_id` / settlement parties.
 * The local contact row stays in Dexie; linking adds `linked_profile_id` and sync may rewrite split
 * rows to the remote id—queries need to accept either id without merging rows.
 */
export async function expandProfileIdsForSplitMatching(profileId: string): Promise<Set<string>> {
  const ids = new Set<string>([profileId])
  const p = await db.profiles.get(profileId)
  if (!p || p.is_deleted) return ids
  if (p.linked_profile_id) {
    ids.add(p.linked_profile_id)
    const sameRemote = await db.profiles
      .where('linked_profile_id')
      .equals(p.linked_profile_id)
      .toArray()
    for (const x of sameRemote) {
      if (!x.is_deleted) ids.add(x.id)
    }
  }
  const linkToThis = await db.profiles.where('linked_profile_id').equals(profileId).toArray()
  for (const x of linkToThis) {
    if (!x.is_deleted) ids.add(x.id)
  }
  return ids
}

/** Everyone selected on any line of the bill (active splits only). */
async function participantUnionForBill(billId: string): Promise<Set<string>> {
  const union = new Set<string>()
  const items = await db.bill_items.where('bill_id').equals(billId).toArray()
  for (const item of items) {
    if (item.is_deleted) continue
    const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
    for (const s of splits) {
      if (!s.is_deleted) union.add(s.user_id)
    }
  }
  return union
}

function profileSetTouchesBill(
  profileIds: Set<string>,
  bill: Bill,
  participantUnion: Set<string>,
): boolean {
  if ([...profileIds].some((id) => participantUnion.has(id))) return true
  return profileIds.has(bill.created_by)
}

export interface BillWithContext extends Bill {
  groupName: string | null
  creatorName: string
}

/** Bills where you and this person both belong: selected on any line and/or recorded as payer (`created_by`). They do not need to share the same line item. */
export async function listBillsInvolvingPair(meId: string, otherId: string): Promise<BillWithContext[]> {
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()
  const out: BillWithContext[] = []

  for (const bill of bills) {
    const participantUnion = await participantUnionForBill(bill.id)
    const meOnBill = profileSetTouchesBill(meIds, bill, participantUnion)
    const otherOnBill = profileSetTouchesBill(otherIds, bill, participantUnion)
    if (!meOnBill || !otherOnBill) continue

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
    const emailLower = (p.email ?? '').trim().toLowerCase()
    const matchesName = lower.includes(q)
    const matchesEmail = emailLower.length > 0 && emailLower.includes(q)
    if (!matchesName && !matchesEmail) continue

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
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)

  const all = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  const pair = all.filter((s) => {
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    return (fromMe && toOther) || (fromOther && toMe)
  })
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

export interface SharedGroupWithPersonRow {
  groupId: string
  groupName: string
  currency: string
  /** Their net in this group: + = should receive on net, − = should pay in on net. */
  theirNet: number
}

/** Groups you both belong to, with their balance in each (from group bills + settlements). */
export async function listSharedGroupsWithBalance(
  meId: string,
  personId: string,
): Promise<SharedGroupWithPersonRow[]> {
  const otherIds = await expandProfileIdsForSplitMatching(personId)
  const myMemberships = await db.group_members.where('user_id').equals(meId).toArray()
  const myGroupIds = new Set(
    myMemberships.filter((m) => !m.is_deleted).map((m) => m.group_id),
  )

  const out: SharedGroupWithPersonRow[] = []

  for (const gid of myGroupIds) {
    const members = await db.group_members.where('group_id').equals(gid).toArray()
    const active = members.filter((m) => !m.is_deleted)
    if (!active.some((m) => otherIds.has(m.user_id))) continue

    const summary = await computeGroupBalances(gid, meId)
    if (!summary) continue

    let theirNet = 0
    for (const b of summary.balances) {
      if (otherIds.has(b.userId)) {
        theirNet = b.amount
        break
      }
    }

    out.push({
      groupId: gid,
      groupName: summary.groupName,
      currency: summary.currency,
      theirNet,
    })
  }

  out.sort((a, b) => a.groupName.localeCompare(b.groupName))
  return out
}
