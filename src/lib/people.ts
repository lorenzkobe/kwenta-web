import { db } from '@/db/db'
import type { Bill } from '@/types'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { computeGroupBalances, computeGroupPairwiseNet } from '@/lib/settlement'
import { supabase } from '@/lib/supabase'
import { formatCurrency, MONEY_EPSILON } from '@/lib/utils'

/**
 * Fetch a profile from the server and insert it into local Dexie if missing.
 * Needed when RPC lookup finds a profile that hasn't been synced to this device.
 *
 * After sign-out / sign-in, normal sync pulls your own rows and owned local contacts, but not other
 * users' account rows (RLS). Linked contacts still need the remote row for display — this RPC is
 * allowed to return that for linking.
 */
/** Returns true if a row was loaded into Dexie (or was already present). */
export async function fetchRemoteProfileIntoDexie(profileId: string): Promise<boolean> {
  const existing = await db.profiles.get(profileId)
  if (existing && !existing.is_deleted) return true

  const { data, error } = await supabase.rpc('kwenta_fetch_profile_for_linking', {
    p_id: profileId,
  })
  if (error || !data) {
    console.warn('[linkLookup] Failed to fetch profile for local cache:', error?.message)
    return false
  }
  const row = data as Record<string, unknown>
  await db.profiles.put({ ...row, synced_at: row.updated_at } as import('@/types').Profile)
  return true
}

/** After pull/sync, load remote rows for any owned local contacts that reference `linked_profile_id`. */
export async function hydrateLinkedRemoteProfilesForActor(actorUserId: string): Promise<void> {
  const locals = await db.profiles
    .where('owner_id')
    .equals(actorUserId)
    .filter((p) => p.is_local && !p.is_deleted && Boolean(p.linked_profile_id))
    .toArray()
  for (const p of locals) {
    if (p.linked_profile_id) {
      await fetchRemoteProfileIntoDexie(p.linked_profile_id)
    }
  }
}

const LINK_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Resolve a remote profile id for "link local contact → account".
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

  if (matches.length > 0) {
    if (matches.length === 1) return matches[0].id
    const nonLocal = matches.find((p) => !p.is_local)
    return (nonLocal ?? matches[0]).id
  }

  const { data: rpcId, error } = await supabase.rpc('kwenta_lookup_profile_id_by_email', {
    p_email: raw,
  })
  if (error) {
    console.warn('[linkLookup] RPC error:', error.message)
    return null
  }
  if (typeof rpcId === 'string' && rpcId) {
    await fetchRemoteProfileIntoDexie(rpcId)
    return rpcId
  }

  return null
}

export interface ProfileDisplay {
  displayName: string
  subtitle?: string
}

export interface SharedGroupFallbackIdentity {
  displayName: string
  subtitle?: string
}

async function resolveSharedGroupMemberFallbackIdentity(
  viewerUserId: string,
  profileId: string,
): Promise<SharedGroupFallbackIdentity | null> {
  const memberships = await db.group_members.where('user_id').equals(viewerUserId).toArray()
  const myGroupIds = new Set(memberships.map((m) => m.group_id))
  if (myGroupIds.size === 0) return null

  const candidateMemberships = await db.group_members.where('user_id').equals(profileId).toArray()
  const shared = candidateMemberships.find((m) => myGroupIds.has(m.group_id) && m.display_name.trim())
  if (!shared) return null

  const group = await db.groups.get(shared.group_id)
  return {
    displayName: shared.display_name.trim(),
    subtitle: group && !group.is_deleted ? `Group member · ${group.name}` : 'Group member',
  }
}

export async function resolveFallbackIdentityForViewer(
  viewerUserId: string,
  profileId: string,
): Promise<SharedGroupFallbackIdentity | null> {
  return resolveSharedGroupMemberFallbackIdentity(viewerUserId, profileId)
}

/** Resolved label for UI (linked accounts show remote name). */
export async function resolveProfileDisplay(
  profileId: string,
  viewerUserId?: string,
): Promise<ProfileDisplay> {
  let p = await db.profiles.get(profileId)
  if (!p) {
    await fetchRemoteProfileIntoDexie(profileId)
    p = await db.profiles.get(profileId)
  }
  if (!p || p.is_deleted) {
    if (viewerUserId) {
      const fallback = await resolveSharedGroupMemberFallbackIdentity(viewerUserId, profileId)
      if (fallback) return fallback
    }
    return { displayName: 'Unknown' }
  }
  if (p.linked_profile_id) {
    let linked = await db.profiles.get(p.linked_profile_id)
    if (!linked) {
      await fetchRemoteProfileIntoDexie(p.linked_profile_id)
      linked = await db.profiles.get(p.linked_profile_id)
    }
    if (linked && !linked.is_deleted) {
      return {
        displayName: p.display_name,
        subtitle: `Linked · ${linked.display_name}`,
      }
    }
    return {
      displayName: p.display_name,
      subtitle: 'Linked · Loading their profile…',
    }
  }
  return {
    displayName: p.display_name,
    subtitle: p.email ? undefined : 'Local contact',
  }
}


/**
 * Pairwise net for a single bill only (payer's counterparties owe their split),
 * minus settlements tagged with `bill_id` for this bill. One currency (the bill's).
 */
export async function computePairwiseNetForBill(
  billId: string,
  meId: string,
  otherId: string,
): Promise<number> {
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return 0

  let net = 0
  const items = await db.bill_items.where('bill_id').equals(billId).toArray()
  for (const item of items) {
    if (item.is_deleted) continue
    const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
    const active = splits.filter((s) => !s.is_deleted)
    const mySplit = active.find((s) => meIds.has(s.user_id))
    const otherSplit = active.find((s) => otherIds.has(s.user_id))

    if (meIds.has(bill.paid_by)) {
      if (!otherSplit) continue
      net += otherSplit.computed_amount
    } else if (otherIds.has(bill.paid_by)) {
      if (!mySplit) continue
      net -= mySplit.computed_amount
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    if (s.bill_id !== billId) continue
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    if (!((fromMe && toOther) || (fromOther && toMe))) continue
    if (fromOther && toMe) net -= s.amount
    else if (fromMe && toOther) net += s.amount
  }

  return Math.round(net * 100) / 100
}

/** Like `computePairwiseNet` but only bills with `group_id == null` (personal). */
export async function computePairwiseNetPersonalOnly(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)

  // Debt from bills + every personal payment, as a plain signed sum
  // (+ they owe me / − I owe them). Overpayment simply flips the sign — no "credit".
  const billNet = new Map<string, number>()

  const bills = await db.bills.filter((b) => !b.is_deleted && b.group_id === null).toArray()

  for (const bill of bills) {
    const participantUnion = await participantUnionForBill(bill.id)
    const meOnBill = profileSetTouchesBill(meIds, bill, participantUnion)
    const otherOnBill = profileSetTouchesBill(otherIds, bill, participantUnion)
    if (!meOnBill || !otherOnBill) continue

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const active = splits.filter((s) => !s.is_deleted)
      const mySplit = active.find((s) => meIds.has(s.user_id))
      const otherSplit = active.find((s) => otherIds.has(s.user_id))
      const cur = bill.currency
      const prev = billNet.get(cur) ?? 0

      if (meIds.has(bill.paid_by)) {
        if (!otherSplit) continue
        billNet.set(cur, prev + otherSplit.computed_amount)
      } else if (otherIds.has(bill.paid_by)) {
        if (!mySplit) continue
        billNet.set(cur, prev - mySplit.computed_amount)
      }
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    if (s.group_id !== null) continue
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    if (!((fromMe && toOther) || (fromOther && toMe))) continue

    const cur = s.currency
    const prev = billNet.get(cur) ?? 0
    // Every personal payment moves the tab toward (and past) zero, bill-tagged or not.
    if (fromOther && toMe) billNet.set(cur, prev - s.amount)
    else if (fromMe && toOther) billNet.set(cur, prev + s.amount)
  }

  const byCurrency = new Map<string, number>()
  for (const [cur, net] of billNet) {
    byCurrency.set(cur, Math.round(net * 100) / 100)
  }

  return byCurrency
}

export interface PairwiseGroupNet {
  groupId: string
  groupName: string
  currency: string
  /** + they owe me / − I owe them, in this group. */
  net: number
}

export interface PairwiseNetBreakdown {
  /** Personal-only net (non-group bills + personal payments), per currency. */
  personal: Map<string, number>
  /** One entry per shared group with a non-zero pairwise net. */
  groups: PairwiseGroupNet[]
  /** personal + Σ groups, per currency — equals `computePairwiseNetAllContexts`. */
  total: Map<string, number>
}

/**
 * Per-context decomposition of the full pairwise standing with a person: the personal
 * net plus their net in every shared group (including 3+ member groups the headline
 * `computePairwiseNet` drops). `total` is a plain signed sum of the parts, so the Person
 * page hero, its "Right now" drill-down, exports, and the People list all share one source.
 */
export async function computePairwiseNetBreakdown(
  meId: string,
  otherId: string,
): Promise<PairwiseNetBreakdown> {
  const personal = await computePairwiseNetPersonalOnly(meId, otherId)
  const total = new Map<string, number>(personal)
  const groups: PairwiseGroupNet[] = []

  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)

  const myMemberships = await db.group_members.where('user_id').anyOf([...meIds]).toArray()
  const myGroupIds = [...new Set(myMemberships.filter((m) => !m.is_deleted).map((m) => m.group_id))]

  for (const gid of myGroupIds) {
    const group = await db.groups.get(gid)
    if (!group || group.is_deleted) continue
    // Resolve the other person to their roster id in this group (handles linked contacts).
    const members = await db.group_members.where('group_id').equals(gid).toArray()
    const otherMember = members.find((m) => !m.is_deleted && otherIds.has(m.user_id))
    if (!otherMember) continue
    const net = await computeGroupPairwiseNet(gid, meId, otherMember.user_id)
    if (Math.abs(net) <= MONEY_EPSILON) continue
    const cur = group.currency
    groups.push({
      groupId: gid,
      groupName: group.name,
      currency: cur,
      net: Math.round(net * 100) / 100,
    })
    total.set(cur, Math.round(((total.get(cur) ?? 0) + net) * 100) / 100)
  }

  return { personal, groups, total }
}

/**
 * Full pairwise standing with a person across every context — personal bills/payments
 * plus their net in every shared group. This is what the People list and Person page
 * headline show: "even" here means even everywhere.
 */
export async function computePairwiseNetAllContexts(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const { total } = await computePairwiseNetBreakdown(meId, otherId)
  return total
}

/** One logical peer per person (dedupes local contact + linked remote). */
async function iterCanonicalPeerIds(meId: string): Promise<string[]> {
  const related = await collectRelatedProfileIds(meId)
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const seenPeer = new Set<string>()
  const out: string[] = []
  for (const oid of related) {
    if (oid === meId || meIds.has(oid)) continue
    let canonical = oid
    const p = await db.profiles.get(oid)
    if (p && !p.is_deleted && p.is_local && p.owner_id === meId) {
      canonical = p.id
    } else {
      const localLinked = await db.profiles
        .where('owner_id')
        .equals(meId)
        .filter((x) => !x.is_deleted && x.is_local && x.linked_profile_id === oid)
        .first()
      if (localLinked) {
        canonical = localLinked.id
      } else {
        const peerAsPeer = await db.profile_peer_links
          .where('owner_user_id')
          .equals(meId)
          .filter((l) => !l.is_deleted && l.peer_profile_id === oid)
          .first()
        if (peerAsPeer) {
          canonical = peerAsPeer.anchor_profile_id
        } else if (p?.linked_profile_id) {
          canonical = p.linked_profile_id
        }
      }
    }
    if (meIds.has(canonical)) continue
    if (seenPeer.has(canonical)) continue
    seenPeer.add(canonical)
    out.push(canonical)
  }
  return out
}

/** Related people de-duplicated across local and linked account IDs. */
export async function listCanonicalRelatedProfileIds(meId: string): Promise<string[]> {
  return iterCanonicalPeerIds(meId)
}

/** Aggregate personal-only pairwise nets (non-group bills + personal settlements) across contacts. */
export async function computePersonalNetRollup(meId: string): Promise<{
  toReceiveByCurrency: Map<string, number>
  toPayByCurrency: Map<string, number>
}> {
  const peers = await iterCanonicalPeerIds(meId)
  const toReceiveByCurrency = new Map<string, number>()
  const toPayByCurrency = new Map<string, number>()

  for (const oid of peers) {
    const m = await computePairwiseNetPersonalOnly(meId, oid)
    for (const [cur, v] of m) {
      if (v > MONEY_EPSILON) {
        toReceiveByCurrency.set(cur, (toReceiveByCurrency.get(cur) ?? 0) + v)
      } else if (v < -MONEY_EPSILON) {
        toPayByCurrency.set(cur, (toPayByCurrency.get(cur) ?? 0) + Math.abs(v))
      }
    }
  }

  return { toReceiveByCurrency, toPayByCurrency }
}

/**
 * Aggregate COMBINED (personal + every shared group) pairwise nets across all contacts,
 * netting per person before bucketing so the Home rollup matches the person pages.
 */
export async function computeCombinedNetRollup(meId: string): Promise<{
  toReceiveByCurrency: Map<string, number>
  toPayByCurrency: Map<string, number>
}> {
  const peers = await iterCanonicalPeerIds(meId)
  const toReceiveByCurrency = new Map<string, number>()
  const toPayByCurrency = new Map<string, number>()

  for (const oid of peers) {
    const m = await computePairwiseNetAllContexts(meId, oid)
    for (const [cur, v] of m) {
      if (v > MONEY_EPSILON) {
        toReceiveByCurrency.set(cur, (toReceiveByCurrency.get(cur) ?? 0) + v)
      } else if (v < -MONEY_EPSILON) {
        toPayByCurrency.set(cur, (toPayByCurrency.get(cur) ?? 0) + Math.abs(v))
      }
    }
  }

  return { toReceiveByCurrency, toPayByCurrency }
}

/** Per-contact personal nets for Balances UI (non-zero only). */
export async function getPersonalBalanceContactRows(meId: string): Promise<
  { otherId: string; displayName: string; netByCurrency: Map<string, number> }[]
> {
  const peers = await iterCanonicalPeerIds(meId)
  const rows: { otherId: string; displayName: string; netByCurrency: Map<string, number> }[] = []
  for (const oid of peers) {
    const m = await computePairwiseNetPersonalOnly(meId, oid)
    const has = [...m.values()].some((v) => Math.abs(v) > MONEY_EPSILON)
    if (!has) continue
    const disp = await resolveProfileDisplay(oid, meId)
    rows.push({ otherId: oid, displayName: disp.displayName, netByCurrency: m })
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return rows
}

export function formatPairwiseSummary(byCurrency: Map<string, number>): {
  lines: string[]
  primaryLabel: string
  tone: 'balanced' | 'receive' | 'pay'
} {
  const entries = [...byCurrency.entries()].filter(([, v]) => Math.abs(v) > MONEY_EPSILON)
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
  // DISPLAY/DEDUP: meIds here filters out the viewer's own ids from the contact list, not used for money math.
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)

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
      if (!m.is_deleted && !meIds.has(m.user_id)) ids.add(m.user_id)
    }
  }

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()
  for (const bill of bills) {
    if (bill.group_id && !myGroupIds.has(bill.group_id)) continue
    if (!bill.group_id && !meIds.has(bill.created_by)) continue

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    let iParticipate = meIds.has(bill.paid_by)
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      for (const s of splits) {
        if (s.is_deleted) continue
        if (meIds.has(s.user_id)) iParticipate = true
      }
    }
    if (!iParticipate) continue

    // Include payer (created_by) even when not on any line — otherwise the other party's
    // personal balances omit the person who paid.
    const union = await participantUnionForBill(bill.id)
    for (const uid of union) {
      if (!meIds.has(uid)) ids.add(uid)
    }
  }

  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    const involvesMe = meIds.has(s.from_user_id) || meIds.has(s.to_user_id)
    if (!involvesMe) continue
    if (!meIds.has(s.from_user_id)) ids.add(s.from_user_id)
    if (!meIds.has(s.to_user_id)) ids.add(s.to_user_id)
  }

  return ids
}

/**
 * IDs that refer to the same real person for matching `item_splits.user_id` / settlement parties.
 * The local contact row stays in Dexie; linking adds `linked_profile_id` and sync may rewrite split
 * rows to the remote id—queries need to accept either id without merging rows.
 * When `viewerUserId` is set, also unions manual peer links (`profile_peer_links`) owned by that user.
 */
async function unionPeerLinkClusterForViewer(ids: Set<string>, viewerUserId: string): Promise<void> {
  const links = await db.profile_peer_links
    .where('owner_user_id')
    .equals(viewerUserId)
    .filter((l) => !l.is_deleted)
    .toArray()
  if (links.length === 0) return
  const adj = new Map<string, Set<string>>()
  for (const l of links) {
    if (!adj.has(l.anchor_profile_id)) adj.set(l.anchor_profile_id, new Set())
    if (!adj.has(l.peer_profile_id)) adj.set(l.peer_profile_id, new Set())
    adj.get(l.anchor_profile_id)!.add(l.peer_profile_id)
    adj.get(l.peer_profile_id)!.add(l.anchor_profile_id)
  }
  const queue = [...ids]
  let i = 0
  while (i < queue.length) {
    const cur = queue[i++]!
    const neighbors = adj.get(cur)
    if (!neighbors) continue
    for (const n of neighbors) {
      if (!ids.has(n)) {
        ids.add(n)
        queue.push(n)
      }
    }
  }
}

/** All profile ids that represent the same person as this anchor for the viewer (account link + peer links). */
export async function expandAnchorProfileIds(anchorId: string, viewerUserId: string): Promise<Set<string>> {
  return expandProfileIdsForSplitMatching(anchorId, viewerUserId)
}

export async function expandProfileIdsForSplitMatching(
  profileId: string,
  viewerUserId?: string,
): Promise<Set<string>> {
  const ids = new Set<string>([profileId])
  const p = await db.profiles.get(profileId)
  if (!p || p.is_deleted) {
    if (viewerUserId) await unionPeerLinkClusterForViewer(ids, viewerUserId)
    return ids
  }
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
  if (viewerUserId) {
    await unionPeerLinkClusterForViewer(ids, viewerUserId)
  }
  return ids
}

/** Payer plus everyone on a line split (active splits only). Payer may not appear on splits if they fronted the whole bill. */
export async function participantUnionForBill(billId: string): Promise<Set<string>> {
  const bill = await db.bills.get(billId)
  const union = new Set<string>()
  if (bill && !bill.is_deleted) {
    union.add(bill.paid_by)
  }
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

/**
 * Collapse participant ids that refer to the same real person into one representative id.
 * A linked local contact and its remote account can both end up in a single bill's participant
 * set (push rewrites splits/paid_by to the remote id asynchronously, leaving the local copy mixed).
 * Prefers an owned local contact as the representative so the viewer's saved name is shown.
 */
export async function dedupeParticipantIds(
  ids: Iterable<string>,
  viewerUserId: string,
): Promise<string[]> {
  const input = [...new Set(ids)]
  const assigned = new Set<string>()
  const reps: string[] = []
  for (const id of input) {
    if (assigned.has(id)) continue
    // DISPLAY/DEDUP: cluster groups ids that represent the same person for UI deduplication, not for money math.
    const cluster = await expandProfileIdsForSplitMatching(id, viewerUserId)
    const members = input.filter((x) => cluster.has(x))
    for (const m of members) assigned.add(m)
    let rep = id
    for (const m of members) {
      const p = await db.profiles.get(m)
      if (p && !p.is_deleted && p.is_local && p.owner_id === viewerUserId) {
        rep = m
        break
      }
    }
    reps.push(rep)
  }
  return reps
}

function profileSetTouchesBill(
  profileIds: Set<string>,
  bill: Bill,
  participantUnion: Set<string>,
): boolean {
  if ([...profileIds].some((id) => participantUnion.has(id))) return true
  return profileIds.has(bill.paid_by)
}

export interface BillWithContext extends Bill {
  groupName: string | null
  payorName: string
}

/** Bills where you and this person both belong: selected on any line and/or recorded as payer (`paid_by`). They do not need to share the same line item. */
export async function listBillsInvolvingPair(meId: string, otherId: string): Promise<BillWithContext[]> {
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)

  const bills = await db.bills.filter((b) => !b.is_deleted).toArray()
  const out: BillWithContext[] = []

  for (const bill of bills) {
    const participantUnion = await participantUnionForBill(bill.id)
    const meOnBill = profileSetTouchesBill(meIds, bill, participantUnion)
    const otherOnBill = profileSetTouchesBill(otherIds, bill, participantUnion)
    if (!meOnBill || !otherOnBill) continue

    const payor = await db.profiles.get(bill.paid_by)
    let payorName = payor?.display_name
    if (!payorName && bill.group_id) {
      const member = await db.group_members
        .where('[group_id+user_id]')
        .equals([bill.group_id, bill.paid_by])
        .first()
      payorName = member?.display_name
    }
    let groupName: string | null = null
    if (bill.group_id) {
      const g = await db.groups.get(bill.group_id)
      if (g && !g.is_deleted) groupName = g.name
    }

    out.push({
      ...bill,
      groupName,
      payorName: payorName ?? 'Unknown',
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
    const localName = p.display_name.trim()
    const localLower = localName.toLowerCase()
    const emailLower = (p.email ?? '').trim().toLowerCase()

    let linkedName: string | undefined
    if (p.linked_profile_id) {
      const linked = await db.profiles.get(p.linked_profile_id)
      if (linked && !linked.is_deleted) linkedName = linked.display_name.trim()
    }

    const linkedLower = linkedName?.toLowerCase() ?? ''
    const matchesLocal = localLower.includes(q)
    const matchesLinked = linkedLower.length > 0 && linkedLower.includes(q)
    const matchesEmail = emailLower.length > 0 && emailLower.includes(q)
    if (!matchesLocal && !matchesLinked && !matchesEmail) continue

    const isMine = p.owner_id === currentUserId
    const inMyGroups = onlineInGroups.has(p.id)
    if (!isMine && !inMyGroups) continue

    const displayName = linkedName ? `${linkedName} (${localName})` : localName
    const kind: 'local' | 'online' = isMine ? 'local' : 'online'
    let score = 0
    if (localLower.startsWith(q) || linkedLower.startsWith(q)) score += 10
    if (isMine) score += 5
    if (inMyGroups) score += 3
    scored.push({ id: p.id, displayName, kind, score })
  }

  scored.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
  return scored.slice(0, limit).map(({ id, displayName, kind }) => ({ id, displayName, kind }))
}

export async function listPairwiseSettlementsBetween(
  meId: string,
  otherId: string,
): Promise<SettlementHistoryItem[]> {
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)

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
    // Local contacts owned by another user aren't synced into this viewer's
    // profiles table; fall back to the synced group_members.display_name so the
    // payment history shows a real name instead of "Someone".
    const resolveName = async (userId: string): Promise<string> => {
      const profile = await db.profiles.get(userId)
      if (profile?.display_name?.trim()) return profile.display_name.trim()
      if (s.group_id) {
        const member = await db.group_members
          .where('[group_id+user_id]')
          .equals([s.group_id, userId])
          .first()
        if (member?.display_name?.trim()) return member.display_name.trim()
      }
      return 'Someone'
    }
    const [fromName, toName] = await Promise.all([
      resolveName(s.from_user_id),
      resolveName(s.to_user_id),
    ])
    items.push({
      id: s.id,
      settlementIds: [s.id],
      bundleId: s.bundle_id ?? null,
      isBundled: false,
      groupId: s.group_id,
      groupName,
      fromUserId: s.from_user_id,
      toUserId: s.to_user_id,
      fromName,
      toName,
      amount: s.amount,
      currency: s.currency,
      label: s.label ?? '',
      createdAt: s.created_at,
      recipients: [
        {
          toUserId: s.to_user_id,
          toName,
          amount: s.amount,
        },
      ],
      legs: [
        {
          fromUserId: s.from_user_id,
          fromName,
          toUserId: s.to_user_id,
          toName,
          amount: s.amount,
        },
      ],
      recordedByUserId: null,
      recordedByName: null,
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
  const otherIds = await expandProfileIdsForSplitMatching(personId, meId)
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
        theirNet += b.amount
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
