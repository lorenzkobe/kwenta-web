import { db } from '@/db/db'
import type { Bill } from '@/types'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { computeGroupBalances } from '@/lib/settlement'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'

/**
 * Fetch a profile from the server and insert it into local Dexie if missing.
 * Needed when RPC lookup finds a profile that hasn't been synced to this device.
 *
 * After sign-out / sign-in, normal sync pulls your own rows and owned local contacts, but not other
 * users' account rows (RLS). Linked contacts still need the remote row for display — this RPC is
 * allowed to return that for linking.
 */
export async function fetchRemoteProfileIntoDexie(profileId: string): Promise<void> {
  const existing = await db.profiles.get(profileId)
  if (existing) return

  const { data, error } = await supabase.rpc('kwenta_fetch_profile_for_linking', {
    p_id: profileId,
  })
  if (error || !data) {
    console.warn('[linkLookup] Failed to fetch profile for local cache:', error?.message)
    return
  }
  const row = data as Record<string, unknown>
  await db.profiles.put({ ...row, synced_at: row.updated_at } as import('@/types').Profile)
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
  const myGroupIds = new Set(memberships.filter((m) => !m.is_deleted).map((m) => m.group_id))
  if (myGroupIds.size === 0) return null

  const candidateMemberships = await db.group_members.where('user_id').equals(profileId).toArray()
  const shared = candidateMemberships.find((m) => !m.is_deleted && myGroupIds.has(m.group_id))
  if (!shared || !shared.display_name.trim()) return null

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
        displayName: linked.display_name,
        subtitle: `Linked · Saved as ${p.display_name}`,
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

/** Net balance per currency: positive = you should receive from them, negative = you should pay them. Personal bills use direct payer-split pairwise; group bills use each member's group-level net balance (same algorithm as computeGroupBalances) to derive the pairwise amount, so group settlements that consolidate multi-party debts are handled correctly. */
export async function computePairwiseNet(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)

  const byCurrency = new Map<string, number>()

  // Personal bills (group_id = null): direct payer-split pairwise approach
  const personalBills = await db.bills.filter((b) => !b.is_deleted && b.group_id === null).toArray()

  for (const bill of personalBills) {
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
      const prev = byCurrency.get(cur) ?? 0

      if (meIds.has(bill.created_by)) {
        if (!otherSplit) continue
        byCurrency.set(cur, prev + otherSplit.computed_amount)
      } else if (otherIds.has(bill.created_by)) {
        if (!mySplit) continue
        byCurrency.set(cur, prev - mySplit.computed_amount)
      }
    }
  }

  // Personal settlements only (group_id = null)
  const personalSettlements = await db.settlements
    .filter((s) => !s.is_deleted && s.is_settled && s.group_id === null)
    .toArray()
  for (const s of personalSettlements) {
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    if (!((fromMe && toOther) || (fromOther && toMe))) continue

    const cur = s.currency
    const prev = byCurrency.get(cur) ?? 0
    if (fromOther && toMe) {
      byCurrency.set(cur, prev - s.amount)
    } else if (fromMe && toOther) {
      byCurrency.set(cur, prev + s.amount)
    }
  }

  // Group bills: derive pairwise from each member's group-level net balance.
  // Group settlements consolidate multi-party debts (e.g. C pays A $80 to cover
  // both A's $30 direct share and B's $50 indirect share), so applying them at
  // the bill-level pairwise would produce wrong results. Instead, compute the
  // full group net for me and other (the same algorithm as computeGroupBalances),
  // then infer the pairwise amount from the two net balances.
  const myMemberships = await db.group_members
    .filter((m) => !m.is_deleted && meIds.has(m.user_id))
    .toArray()
  const myGroupIds = new Set(myMemberships.map((m) => m.group_id))
  const otherMemberships = await db.group_members
    .filter((m) => !m.is_deleted && otherIds.has(m.user_id))
    .toArray()
  const sharedGroupIds = [
    ...new Set(otherMemberships.map((m) => m.group_id).filter((gid) => myGroupIds.has(gid))),
  ]

  for (const groupId of sharedGroupIds) {
    const group = await db.groups.get(groupId)
    if (!group || group.is_deleted) continue

    const groupBills = await db.bills.where('group_id').equals(groupId).toArray()
    let meGroupNet = 0
    let otherGroupNet = 0

    for (const bill of groupBills) {
      if (bill.is_deleted) continue
      const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
      for (const item of items) {
        if (item.is_deleted) continue
        const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
        const active = splits.filter((s) => !s.is_deleted)
        if (active.length === 0) continue
        const totalSplit = active.reduce((sum, s) => sum + s.computed_amount, 0)

        if (meIds.has(bill.created_by)) meGroupNet += totalSplit
        if (otherIds.has(bill.created_by)) otherGroupNet += totalSplit
        for (const split of active) {
          if (meIds.has(split.user_id)) meGroupNet -= split.computed_amount
          if (otherIds.has(split.user_id)) otherGroupNet -= split.computed_amount
        }
      }
    }

    const groupSettlements = await db.settlements.where('group_id').equals(groupId).toArray()
    for (const s of groupSettlements) {
      if (s.is_deleted || !s.is_settled) continue
      if (meIds.has(s.from_user_id)) meGroupNet += s.amount
      if (meIds.has(s.to_user_id)) meGroupNet -= s.amount
      if (otherIds.has(s.from_user_id)) otherGroupNet += s.amount
      if (otherIds.has(s.to_user_id)) otherGroupNet -= s.amount
    }

    meGroupNet = Math.round(meGroupNet * 100) / 100
    otherGroupNet = Math.round(otherGroupNet * 100) / 100

    const cur = group.currency
    const prev = byCurrency.get(cur) ?? 0

    if (meGroupNet > 0.005 && otherGroupNet < -0.005) {
      // I should receive from the group, other should pay — other owes me up to min of both
      byCurrency.set(cur, prev + Math.min(meGroupNet, Math.abs(otherGroupNet)))
    } else if (meGroupNet < -0.005 && otherGroupNet > 0.005) {
      // I should pay to the group, other should receive — I owe other up to min of both
      byCurrency.set(cur, prev - Math.min(Math.abs(meGroupNet), otherGroupNet))
    }
    // Same sign or both ~0: no direct pairwise obligation between the two of us
  }

  return byCurrency
}

/**
 * Pairwise net for a single bill only (same line rules as `computePairwiseNet`),
 * minus settlements tagged with `bill_id` for this bill. One currency (the bill's).
 */
export async function computePairwiseNetForBill(
  billId: string,
  meId: string,
  otherId: string,
): Promise<number> {
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)
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

    if (meIds.has(bill.created_by)) {
      if (!otherSplit) continue
      net += otherSplit.computed_amount
    } else if (otherIds.has(bill.created_by)) {
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

export interface PersonalBillAllocationSlice {
  billId: string
  billTitle: string
  amount: number
  currency: string
  createdAt: string
}

export interface PersonalBillAllocationPlan {
  allocatableTotal: number
  appliedAmount: number
  remainderAmount: number
  affectedBillCount: number
  slices: PersonalBillAllocationSlice[]
}

type PersonalDirectionContext = {
  meId: string
  otherId: string
  fromUserId: string
  toUserId: string
}

function resolvePersonalDirection(ctx: PersonalDirectionContext): 'other_to_me' | 'me_to_other' | null {
  const otherToMe = ctx.fromUserId === ctx.otherId && ctx.toUserId === ctx.meId
  if (otherToMe) return 'other_to_me'
  const meToOther = ctx.fromUserId === ctx.meId && ctx.toUserId === ctx.otherId
  if (meToOther) return 'me_to_other'
  return null
}

async function listEligiblePersonalBillBalances(params: {
  meId: string
  otherId: string
  currency: string
  direction: 'other_to_me' | 'me_to_other'
}): Promise<PersonalBillAllocationSlice[]> {
  const bills = await listBillsInvolvingPair(params.meId, params.otherId)
  const personal = bills
    .filter((b) => b.group_id === null && b.currency === params.currency)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  const out: PersonalBillAllocationSlice[] = []
  for (const bill of personal) {
    const net = await computePairwiseNetForBill(bill.id, params.meId, params.otherId)
    let due = 0
    if (params.direction === 'other_to_me' && net > 0.005) {
      due = net
    } else if (params.direction === 'me_to_other' && net < -0.005) {
      due = Math.abs(net)
    }
    if (due <= 0.005) continue
    out.push({
      billId: bill.id,
      billTitle: bill.title,
      amount: Math.round(due * 100) / 100,
      currency: bill.currency,
      createdAt: bill.created_at,
    })
  }
  return out
}

export async function buildPersonalBillAllocationPlan(params: {
  meId: string
  otherId: string
  fromUserId: string
  toUserId: string
  currency: string
  amountToApply: number
}): Promise<PersonalBillAllocationPlan> {
  const amountToApply = Math.max(0, params.amountToApply)
  const direction = resolvePersonalDirection({
    meId: params.meId,
    otherId: params.otherId,
    fromUserId: params.fromUserId,
    toUserId: params.toUserId,
  })
  if (!direction) {
    return {
      allocatableTotal: 0,
      appliedAmount: 0,
      remainderAmount: Math.round(amountToApply * 100) / 100,
      affectedBillCount: 0,
      slices: [],
    }
  }

  const eligible = await listEligiblePersonalBillBalances({
    meId: params.meId,
    otherId: params.otherId,
    currency: params.currency,
    direction,
  })

  const allocatableTotalRaw = eligible.reduce((sum, row) => sum + row.amount, 0)
  const allocatableTotal = Math.round(allocatableTotalRaw * 100) / 100

  let remaining = amountToApply
  const slices: PersonalBillAllocationSlice[] = []
  for (const row of eligible) {
    if (remaining <= 0.005) break
    const applied = Math.min(remaining, row.amount)
    if (applied <= 0.005) continue
    slices.push({ ...row, amount: Math.round(applied * 100) / 100 })
    remaining -= applied
  }

  const appliedAmount = Math.round((amountToApply - Math.max(remaining, 0)) * 100) / 100
  const remainderAmount = Math.round(Math.max(remaining, 0) * 100) / 100
  return {
    allocatableTotal,
    appliedAmount,
    remainderAmount,
    affectedBillCount: slices.length,
    slices,
  }
}

export async function computeAvailableGeneralCredit(params: {
  meId: string
  otherId: string
  fromUserId: string
  toUserId: string
  currency: string
}): Promise<number> {
  const fromIds = await expandProfileIdsForSplitMatching(params.fromUserId)
  const toIds = await expandProfileIdsForSplitMatching(params.toUserId)
  const all = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  let total = 0
  for (const s of all) {
    if (s.group_id !== null || s.bill_id !== null) continue
    if (s.currency !== params.currency) continue
    if (!fromIds.has(s.from_user_id) || !toIds.has(s.to_user_id)) continue
    total += s.amount
  }
  return Math.round(total * 100) / 100
}

export interface ManualGeneralCreditApplyPlan extends PersonalBillAllocationPlan {
  fromUserId: string
  toUserId: string
  availableGeneralCredit: number
}

export async function buildManualGeneralCreditApplyPlan(params: {
  meId: string
  otherId: string
  currency: string
}): Promise<ManualGeneralCreditApplyPlan | null> {
  const receiveDirectionCredit = await computeAvailableGeneralCredit({
    meId: params.meId,
    otherId: params.otherId,
    fromUserId: params.otherId,
    toUserId: params.meId,
    currency: params.currency,
  })
  const receiveDirectionPlan = await buildPersonalBillAllocationPlan({
    meId: params.meId,
    otherId: params.otherId,
    fromUserId: params.otherId,
    toUserId: params.meId,
    currency: params.currency,
    amountToApply: receiveDirectionCredit,
  })

  const payDirectionCredit = await computeAvailableGeneralCredit({
    meId: params.meId,
    otherId: params.otherId,
    fromUserId: params.meId,
    toUserId: params.otherId,
    currency: params.currency,
  })
  const payDirectionPlan = await buildPersonalBillAllocationPlan({
    meId: params.meId,
    otherId: params.otherId,
    fromUserId: params.meId,
    toUserId: params.otherId,
    currency: params.currency,
    amountToApply: payDirectionCredit,
  })

  const receiveApplied = receiveDirectionPlan.appliedAmount
  const payApplied = payDirectionPlan.appliedAmount
  if (receiveApplied <= 0.005 && payApplied <= 0.005) return null

  if (receiveApplied >= payApplied) {
    return {
      ...receiveDirectionPlan,
      fromUserId: params.otherId,
      toUserId: params.meId,
      availableGeneralCredit: receiveDirectionCredit,
    }
  }
  return {
    ...payDirectionPlan,
    fromUserId: params.meId,
    toUserId: params.otherId,
    availableGeneralCredit: payDirectionCredit,
  }
}

/** Like `computePairwiseNet` but only bills with `group_id == null` (personal). */
export async function computePairwiseNetPersonalOnly(
  meId: string,
  otherId: string,
): Promise<Map<string, number>> {
  const meIds = await expandProfileIdsForSplitMatching(meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId)

  const byCurrency = new Map<string, number>()

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
      const prev = byCurrency.get(cur) ?? 0

      if (meIds.has(bill.created_by)) {
        if (!otherSplit) continue
        byCurrency.set(cur, prev + otherSplit.computed_amount)
      } else if (otherIds.has(bill.created_by)) {
        if (!mySplit) continue
        byCurrency.set(cur, prev - mySplit.computed_amount)
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
    const prev = byCurrency.get(cur) ?? 0
    if (fromOther && toMe) {
      byCurrency.set(cur, prev - s.amount)
    } else if (fromMe && toOther) {
      byCurrency.set(cur, prev + s.amount)
    }
  }

  return byCurrency
}

/** One logical peer per person (dedupes local contact + linked remote). */
async function iterCanonicalPeerIds(meId: string): Promise<string[]> {
  const related = await collectRelatedProfileIds(meId)
  const meIds = await expandProfileIdsForSplitMatching(meId)
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
      } else if (p?.linked_profile_id) {
        canonical = p.linked_profile_id
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
      if (v > 0.005) {
        toReceiveByCurrency.set(cur, (toReceiveByCurrency.get(cur) ?? 0) + v)
      } else if (v < -0.005) {
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
    const has = [...m.values()].some((v) => Math.abs(v) > 0.005)
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
  const meIds = await expandProfileIdsForSplitMatching(meId)

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

    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    let iParticipate = meIds.has(bill.created_by)
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

/** Payer plus everyone on a line split (active splits only). Payer may not appear on splits if they fronted the whole bill. */
export async function participantUnionForBill(billId: string): Promise<Set<string>> {
  const bill = await db.bills.get(billId)
  const union = new Set<string>()
  if (bill && !bill.is_deleted) {
    union.add(bill.created_by)
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
      settlementIds: [s.id],
      bundleId: s.bundle_id ?? null,
      isBundled: false,
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
      recipients: [
        {
          toUserId: s.to_user_id,
          toName: toP?.display_name ?? 'Someone',
          amount: s.amount,
        },
      ],
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
