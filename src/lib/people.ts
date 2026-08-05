import { db } from '@/db/db'
import type { Bill, BillItem, ItemSplit, Profile, Settlement } from '@/types'
import { supabase } from '@/lib/supabase'
import { formatCurrency, MONEY_EPSILON } from '@/lib/utils'

/**
 * Identity and display helpers over the local mirror.
 *
 * No money is computed here any more — every balance comes from SQL (migrations 052-064) so a
 * money rule has exactly one implementation, per CLAUDE.md rule 8. What remains is name
 * resolution, profile linking, and CONTACT DISCOVERY, which stays local on purpose: a local
 * contact exists only on the device that created it, and the "who can I split with" picker has
 * to work offline because creating a bill does.
 */

/**
 * The rows contact discovery needs, loaded ONCE.
 *
 * `collectRelatedProfileIds` walks every bill and settlement to find the people you share
 * expenses with. Without a snapshot it re-queried each bill's items and splits per contact —
 * tens of thousands of IndexedDB round trips at a few hundred bills.
 */
type ContactScanSnapshot = {
  /** Every active bill, group and personal. */
  allBills: Bill[]
  /** Every active, settled settlement (any context). */
  allSettlements: Settlement[]
  /** Payer + everyone on an active split, per bill. */
  participantsByBill: Map<string, Set<string>>
  expandCache: Map<string, Set<string>>
}

async function loadContactScanSnapshot(): Promise<ContactScanSnapshot> {
  const [rawBills, rawSettlements] = await Promise.all([
    db.bills.toArray(),
    db.settlements.toArray(),
  ])
  const allBills = rawBills.filter((b) => !b.is_deleted)
  const billIds = allBills.map((b) => b.id)

  const items = (
    billIds.length > 0 ? await db.bill_items.where('bill_id').anyOf(billIds).toArray() : []
  ).filter((i) => !i.is_deleted)
  const itemIds = items.map((i) => i.id)
  const splits = (
    itemIds.length > 0 ? await db.item_splits.where('item_id').anyOf(itemIds).toArray() : []
  ).filter((s) => !s.is_deleted)

  const itemsByBill = new Map<string, BillItem[]>()
  for (const it of items) {
    const arr = itemsByBill.get(it.bill_id) ?? []
    arr.push(it)
    itemsByBill.set(it.bill_id, arr)
  }
  const splitsByItem = new Map<string, ItemSplit[]>()
  for (const sp of splits) {
    const arr = splitsByItem.get(sp.item_id) ?? []
    arr.push(sp)
    splitsByItem.set(sp.item_id, arr)
  }

  const participantsByBill = new Map<string, Set<string>>()
  for (const bill of allBills) {
    const union = new Set<string>([bill.paid_by])
    for (const it of itemsByBill.get(bill.id) ?? []) {
      for (const sp of splitsByItem.get(it.id) ?? []) union.add(sp.user_id)
    }
    participantsByBill.set(bill.id, union)
  }

  return {
    allBills,
    allSettlements: rawSettlements.filter((s) => !s.is_deleted && s.is_settled),
    participantsByBill,
    expandCache: new Map(),
  }
}

/** Memoised `expandProfileIdsForSplitMatching` for one snapshot. */
async function expandCached(
  snapshot: ContactScanSnapshot,
  profileId: string,
  viewerUserId: string,
): Promise<Set<string>> {
  const key = `${viewerUserId}|${profileId}`
  const hit = snapshot.expandCache.get(key)
  if (hit) return hit
  const ids = await expandProfileIdsForSplitMatching(profileId, viewerUserId)
  snapshot.expandCache.set(key, ids)
  return ids
}

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
export type PhonebookRow = { id: string; displayName: string; subtitle?: string }

/**
 * The contact picker's rows, resolved in bulk.
 *
 * Both the Groups "create group" sheet and the group's "manage members" sheet built this by
 * awaiting `resolveProfileDisplay` once per canonical peer, and that helper does several Dexie
 * reads of its own — so opening the picker with 80 contacts issued hundreds of sequential
 * IndexedDB reads before it could paint, twice over, from two copies of the same loop.
 *
 * The common case (a profile that is present and not deleted) is answered from one bulk read.
 * Only the rows that genuinely need the slow path — a missing profile, which may have to be
 * fetched over RPC, or a deleted one needing the shared-group fallback — fall back to
 * `resolveProfileDisplay`, so no resolution rule is duplicated here.
 */
export async function loadPhonebookRows(meId: string): Promise<PhonebookRow[]> {
  const ids = await listCanonicalRelatedProfileIds(meId)
  if (ids.length === 0) return []

  const profiles = await db.profiles.bulkGet(ids)
  const byId = new Map<string, Profile>()
  for (const p of profiles) if (p) byId.set(p.id, p)

  // Linked targets are usually already in `byId`; fetch the few that are not in one more pass.
  const linkedIds = [...byId.values()]
    .map((p) => p.linked_profile_id)
    .filter((id): id is string => Boolean(id) && !byId.has(id!))
  if (linkedIds.length > 0) {
    for (const p of await db.profiles.bulkGet(linkedIds)) if (p) byId.set(p.id, p)
  }

  const rows: PhonebookRow[] = []
  for (const id of ids) {
    const p = byId.get(id)
    if (!p || p.is_deleted) {
      const resolved = await resolveProfileDisplay(id, meId)
      rows.push({ id, displayName: resolved.displayName, subtitle: resolved.subtitle })
      continue
    }
    if (p.linked_profile_id) {
      const linked = byId.get(p.linked_profile_id)
      rows.push({
        id,
        displayName: p.display_name,
        subtitle:
          linked && !linked.is_deleted
            ? `Linked · ${linked.display_name}`
            : 'Linked · Loading their profile…',
      })
      continue
    }
    rows.push({
      id,
      displayName: p.display_name,
      subtitle: p.email ? undefined : 'Local contact',
    })
  }

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return rows
}

async function pickCanonicalPeer(meId: string, clusterIds: string[]): Promise<string | null> {
  const sorted = [...clusterIds].sort()
  for (const id of sorted) {
    const p = await db.profiles.get(id)
    if (p && !p.is_deleted && p.is_local && p.owner_id === meId) return id
  }
  return sorted[0] ?? null
}

/**
 * One logical peer per person (dedupes local contact, linked remote, and manual merges).
 *
 * Grouping is done on the whole identity CLUSTER rather than by resolving each id one hop.
 * The previous shape resolved ids independently through a first-match chain that began with
 * "is this one of my own local contacts?" — which is true for BOTH sides of a manual merge, so
 * the merge rule below it never ran and one person surfaced as two peers. Balance math honours
 * the merge, so both peers reported the same amount and the Home rollup counted it twice.
 * One-hop resolution cannot fix that either: a1<->a2<->a3 would still collapse to two. Since
 * `expandProfileIdsForSplitMatching` already returns the full equivalence class, every id for
 * one person yields the same set, so its minimum is a stable key for the whole class.
 */
async function iterCanonicalPeerIds(meId: string): Promise<string[]> {
  const snap = await loadContactScanSnapshot()
  const related = await collectRelatedProfileIds(meId, snap)
  const meIds = await expandCached(snap, meId, meId)

  const byCluster = new Map<string, string[]>()
  for (const oid of related) {
    if (oid === meId || meIds.has(oid)) continue
    const cluster = await expandCached(snap, oid, meId)
    const key = [...cluster].sort()[0] ?? oid
    const arr = byCluster.get(key) ?? []
    arr.push(oid)
    byCluster.set(key, arr)
  }

  const out: string[] = []
  for (const ids of byCluster.values()) {
    const canonical = await pickCanonicalPeer(meId, ids)
    if (!canonical || meIds.has(canonical)) continue
    out.push(canonical)
  }
  return out
}

/** Related people de-duplicated across local and linked account IDs. */
export async function listCanonicalRelatedProfileIds(meId: string): Promise<string[]> {
  return iterCanonicalPeerIds(meId)
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
async function collectRelatedProfileIds(
  meId: string,
  snap: ContactScanSnapshot,
): Promise<Set<string>> {
  const ids = new Set<string>()
  // DISPLAY/DEDUP: meIds here filters out the viewer's own ids from the contact list, not used for money math.
  const meIds = await expandCached(snap, meId, meId)

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

  for (const bill of snap.allBills) {
    if (bill.group_id && !myGroupIds.has(bill.group_id)) continue
    if (!bill.group_id && !meIds.has(bill.created_by)) continue

    // The participant set already covers the payer plus everyone on an active split, which is
    // exactly what both the participation test and the id collection below need.
    const union = snap.participantsByBill.get(bill.id) ?? new Set<string>()
    let iParticipate = meIds.has(bill.paid_by)
    if (!iParticipate) {
      for (const uid of union) {
        if (meIds.has(uid)) {
          iParticipate = true
          break
        }
      }
    }
    if (!iParticipate) continue

    // Include payer (created_by) even when not on any line — otherwise the other party's
    // personal balances omit the person who paid.
    for (const uid of union) {
      if (!meIds.has(uid)) ids.add(uid)
    }
  }

  for (const s of snap.allSettlements) {
    const involvesMe = meIds.has(s.from_user_id) || meIds.has(s.to_user_id)
    if (!involvesMe) continue
    if (!meIds.has(s.from_user_id)) ids.add(s.from_user_id)
    if (!meIds.has(s.to_user_id)) ids.add(s.to_user_id)
  }

  return ids
}

/** Undirected adjacency of one viewer's manual "same person" merges. */
async function loadPeerLinkAdjacency(viewerUserId: string): Promise<Map<string, Set<string>>> {
  const links = await db.profile_peer_links
    .where('owner_user_id')
    .equals(viewerUserId)
    .filter((l) => !l.is_deleted)
    .toArray()
  const adj = new Map<string, Set<string>>()
  for (const l of links) {
    if (!adj.has(l.anchor_profile_id)) adj.set(l.anchor_profile_id, new Set())
    if (!adj.has(l.peer_profile_id)) adj.set(l.peer_profile_id, new Set())
    adj.get(l.anchor_profile_id)!.add(l.peer_profile_id)
    adj.get(l.peer_profile_id)!.add(l.anchor_profile_id)
  }
  return adj
}

/**
 * IDs that refer to the same real person for matching `item_splits.user_id` / settlement parties.
 * The local contact row stays in Dexie; linking adds `linked_profile_id` and sync may rewrite split
 * rows to the remote id—queries need to accept either id without merging rows.
 * When `viewerUserId` is set, manual peer links (`profile_peer_links`) owned by that user are edges
 * too.
 *
 * Both edge kinds are closed over TOGETHER, so this is the connected component of `profileId` and
 * is identical from every member. Walking profile links from the anchor only and peer links from
 * everywhere made the answer depend on where you started: a contact merged to an account reached
 * the account but never the account's OTHER linked contacts, while the account reached all of
 * them. `iterCanonicalPeerIds` keys a person by the minimum of this set, so two ids for one human
 * yielded two keys and the People page listed them as two rows.
 * SQL twin: `kwenta_expand_identity` (052, closed in `067`) — the two must agree.
 */
export async function expandProfileIdsForSplitMatching(
  profileId: string,
  viewerUserId?: string,
): Promise<Set<string>> {
  const peerAdj = viewerUserId ? await loadPeerLinkAdjacency(viewerUserId) : null
  const ids = new Set<string>([profileId])
  const queue = [profileId]
  const add = (next: string | null | undefined) => {
    if (!next || ids.has(next)) return
    ids.add(next)
    queue.push(next)
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!
    // An edge is gated on the row HOLDING `linked_profile_id` being live, so a soft-deleted
    // contact drops out from both ends instead of only from the reverse arm. Siblings need no
    // arm of their own: two contacts on one account are two reverse edges from that account.
    const p = await db.profiles.get(cur)
    if (p && !p.is_deleted) add(p.linked_profile_id)
    const linkToThis = await db.profiles.where('linked_profile_id').equals(cur).toArray()
    for (const x of linkToThis) {
      if (!x.is_deleted) add(x.id)
    }
    for (const n of peerAdj?.get(cur) ?? []) add(n)
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