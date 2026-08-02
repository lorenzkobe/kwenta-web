import { db } from '@/db/db'
import { generateId, getDeviceId, now } from '@/lib/utils'
import { resolveGroupMemberUserId } from '@/db/operations'
import { finalizeMutationSync } from '@/sync/cloud-first-mutations'
import { useAppStore } from '@/store/app-store'
import type { Profile, Settlement } from '@/types'

/**
 * One-time, non-destructive data repair for settlements. Fixes artifacts that can accumulate
 * from earlier bugs/migrations — never removes a real money movement. Balances only get MORE
 * correct. Runs client-side (respects RLS) and propagates to the cloud via normal sync.
 *
 * Three classes, mirroring the id-canonicalization migrations 043/045:
 *  - orphan: settlement references a bill/group that no longer exists (or is deleted), or a
 *    party whose profile this device can SEE is deleted (absence is never treated as proof —
 *    see `partyResolvable`)
 *  - duplicate: exact-match row (same CANONICAL parties/amount/currency/bill/group/created_at/
 *    bundle/label/method) — keep earliest
 *  - non-canonical: from/to id points at a local contact that has a linked account (or, in a
 *    group, isn't the roster id) — rewrite to the canonical id so RLS/sync/balance-match agree
 */

export interface RepairOrphan {
  id: string
  reason: 'missing_bill' | 'missing_group' | 'missing_profile'
  amount: number
  currency: string
}
export interface RepairDuplicate {
  id: string
  keptId: string
  amount: number
  currency: string
}
export interface RepairNonCanonical {
  id: string
  field: 'from_user_id' | 'to_user_id'
  from: string
  to: string
}
export interface KwentaDataRepairPlan {
  orphanSettlements: RepairOrphan[]
  duplicateSettlements: RepairDuplicate[]
  nonCanonicalSettlements: RepairNonCanonical[]
  summary: { orphans: number; duplicates: number; nonCanonical: number; total: number }
}

/** Dedup key over CANONICAL parties + every field that distinguishes a real payment. Only
 * byte-identical rows (down to created_at, bundle, note/label, and method) collapse — two
 * genuinely distinct payments differing in any of these are kept. */
function dupKey(s: Settlement, canon: { from: string; to: string }): string {
  return [
    canon.from,
    canon.to,
    s.amount,
    s.currency,
    s.bill_id ?? '',
    s.group_id ?? '',
    s.created_at,
    s.bundle_id ?? '',
    s.label ?? '',
    s.method ?? '',
  ].join('|')
}

/** Canonical party id: linked account id when the local contact is linked, then the group
 * roster id. `profilesById` is a preloaded map so this does no per-call profile query. */
async function canonicalPartyId(
  id: string,
  groupId: string | null,
  profilesById: Map<string, Profile>,
): Promise<string> {
  // Inline of resolveSettlementPartyId against the preloaded profiles map.
  const p = profilesById.get(id)
  let resolved = p && !p.is_deleted && p.linked_profile_id ? p.linked_profile_id : id
  if (groupId) resolved = await resolveGroupMemberUserId(groupId, resolved)
  return resolved
}

/** Read-only: analyze the user's pushable settlements and report what a repair would change. */
export async function planKwentaDataRepair(userId: string): Promise<KwentaDataRepairPlan> {
  const all = await db.settlements.filter((s) => !s.is_deleted).toArray()

  // Preload reference data once — avoids O(N) serial IndexedDB round trips (was one membership
  // query per settlement plus a bill/group/profile get per row).
  const [profilesArr, membersArr, billsArr, groupsArr] = await Promise.all([
    db.profiles.toArray(),
    db.group_members.toArray(),
    db.bills.toArray(),
    db.groups.toArray(),
  ])
  const profilesById = new Map(profilesArr.map((p) => [p.id, p]))
  const billsById = new Map(billsArr.map((b) => [b.id, b]))
  const groupsById = new Map(groupsArr.map((g) => [g.id, g]))
  const memberGroupUser = new Set<string>() // `${group_id}|${user_id}`
  for (const m of membersArr) {
    memberGroupUser.add(`${m.group_id}|${m.user_id}`)
  }

  // A settlement is "mine to repair" if I'm a party or I'm in its group.
  const isMine = (s: Settlement): boolean => {
    if (s.group_id === null) return s.from_user_id === userId || s.to_user_id === userId
    return memberGroupUser.has(`${s.group_id}|${userId}`)
  }
  const mine = all.filter(isMine)

  // A party id is condemned ONLY on positive proof that the person is gone: a profile row this
  // device can actually see, marked deleted. Absence is NOT proof — the pull-bundle privacy
  // boundary means another user's account profile is never synced here unless we linked or share
  // a group (`WHERE p.id = uid OR (p.is_local AND p.owner_id = uid)`). Treating an invisible
  // counterparty as an orphan soft-deletes a real payment and pushes that deletion cloud-wide,
  // wiping it for the other side too (the "payments disappeared after they linked back" bug).
  // Only the server (migration 047) can see every profile, so only it may judge absence.
  const partyResolvable = (id: string): boolean => {
    if (id === userId) return true
    const p = profilesById.get(id)
    if (p) return !p.is_deleted
    return true // no row here ⇒ unknown, not absent
  }

  const orphanSettlements: RepairOrphan[] = []
  const orphanIds = new Set<string>()
  for (const s of mine) {
    let reason: RepairOrphan['reason'] | null = null
    if (s.bill_id) {
      const bill = billsById.get(s.bill_id)
      if (!bill || bill.is_deleted) reason = 'missing_bill'
    }
    if (!reason && s.group_id) {
      const group = groupsById.get(s.group_id)
      if (!group || group.is_deleted) reason = 'missing_group'
    }
    if (!reason && (!partyResolvable(s.from_user_id) || !partyResolvable(s.to_user_id))) {
      reason = 'missing_profile'
    }
    if (reason) {
      orphanIds.add(s.id)
      orphanSettlements.push({ id: s.id, reason, amount: s.amount, currency: s.currency })
    }
  }

  // Canonicalize each surviving row's parties ONCE, up front, so dedup can key on canonical
  // ids. Two rows that are the same payment differing only by a stale local-vs-linked party id
  // would otherwise hash to different keys, escape dedup, then both get rewritten to identical
  // ids — leaving an exact-duplicate pair that double-counts. Canonicalize-then-dedup fixes it
  // in a single apply.
  const canonById = new Map<string, { from: string; to: string }>()
  for (const s of mine) {
    if (orphanIds.has(s.id)) continue
    canonById.set(s.id, {
      from: await canonicalPartyId(s.from_user_id, s.group_id, profilesById),
      to: await canonicalPartyId(s.to_user_id, s.group_id, profilesById),
    })
  }

  // Duplicates — earliest created_at (then id) kept; scan only non-orphans, key on canonical ids.
  const duplicateSettlements: RepairDuplicate[] = []
  const byKey = new Map<string, Settlement[]>()
  for (const s of mine) {
    if (orphanIds.has(s.id)) continue
    const k = dupKey(s, canonById.get(s.id)!)
    ;(byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s)
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    )
    const kept = sorted[0]
    for (const dup of sorted.slice(1)) {
      duplicateSettlements.push({ id: dup.id, keptId: kept.id, amount: dup.amount, currency: dup.currency })
    }
  }
  const dupIds = new Set(duplicateSettlements.map((d) => d.id))

  // Non-canonical parties — canonicalize surviving rows (incl. a kept duplicate).
  const nonCanonicalSettlements: RepairNonCanonical[] = []
  for (const s of mine) {
    if (orphanIds.has(s.id) || dupIds.has(s.id)) continue
    const canon = canonById.get(s.id)!
    if (canon.from !== s.from_user_id) {
      nonCanonicalSettlements.push({ id: s.id, field: 'from_user_id', from: s.from_user_id, to: canon.from })
    }
    if (canon.to !== s.to_user_id) {
      nonCanonicalSettlements.push({ id: s.id, field: 'to_user_id', from: s.to_user_id, to: canon.to })
    }
  }

  return {
    orphanSettlements,
    duplicateSettlements,
    nonCanonicalSettlements,
    summary: {
      orphans: orphanSettlements.length,
      duplicates: duplicateSettlements.length,
      nonCanonical: nonCanonicalSettlements.length,
      total: orphanSettlements.length + duplicateSettlements.length + nonCanonicalSettlements.length,
    },
  }
}

// Runs once per app session (module-scoped), so the post-sync auto-repair doesn't re-scan on
// every backup sync. A full page reload resets it, re-checking for newly-accumulated artifacts.
let autoRepairDone = false
let autoRepairInFlight = false

/**
 * Fire-and-forget auto-repair: run {@link planKwentaDataRepair} once per session after a
 * successful sync and, if it finds anything, apply it. Conservative by construction (see the
 * plan doc — never condemns a real payment) so it is safe to apply without manual review.
 *
 * Never throws: a repair failure must not break app startup or sync. Only marks itself done on
 * success, so a transient failure retries on the next session.
 */
export async function maybeAutoRepairData(userId: string): Promise<void> {
  if (autoRepairDone || autoRepairInFlight) return
  // Defense-in-depth: only repair against fully-pulled data. Orphan detection soft-deletes rows
  // whose bill/group/party isn't in Dexie, so a stale/partial pull could condemn a real row.
  // Both current callers already run post-successful-sync; this guards future callers too.
  if (useAppStore.getState().pullStale) return
  autoRepairInFlight = true
  try {
    const plan = await planKwentaDataRepair(userId)
    if (plan.summary.total > 0) {
      const res = await applyKwentaDataRepair(userId, plan)
      console.info(
        `[kwenta] auto data repair: removed ${res.softDeleted}, canonicalized ${res.rewritten}`,
      )
    }
    autoRepairDone = true
  } catch (err) {
    console.warn('[kwenta] auto data repair failed (will retry next session):', err)
  } finally {
    autoRepairInFlight = false
  }
}

/** Test-only: reset the once-per-session auto-repair guard between cases. */
export function __resetAutoRepairGuardForTests(): void {
  autoRepairDone = false
  autoRepairInFlight = false
}

/**
 * Apply a plan: soft-delete orphans/duplicates and rewrite non-canonical parties, all marked
 * unsynced so the next round trip pushes them to the cloud. Idempotent — safe to re-run.
 */
export async function applyKwentaDataRepair(
  userId: string,
  plan: KwentaDataRepairPlan,
): Promise<{ softDeleted: number; rewritten: number }> {
  const ts = now()
  let softDeleted = 0
  let rewritten = 0

  await db.transaction('rw', [db.settlements, db.activity_log], async () => {
    for (const o of [...plan.orphanSettlements, ...plan.duplicateSettlements]) {
      const row = await db.settlements.get(o.id)
      if (!row || row.is_deleted) continue
      await db.settlements.update(o.id, { is_deleted: true, updated_at: ts, synced_at: null })
      softDeleted++
    }
    // Group per-settlement so both fields are applied in one update.
    const patchById = new Map<string, Partial<Settlement>>()
    const deletedIds = new Set([
      ...plan.orphanSettlements.map((o) => o.id),
      ...plan.duplicateSettlements.map((d) => d.id),
    ])
    for (const nc of plan.nonCanonicalSettlements) {
      if (deletedIds.has(nc.id)) continue
      const patch = patchById.get(nc.id) ?? {}
      patch[nc.field] = nc.to
      patchById.set(nc.id, patch)
    }
    for (const [id, patch] of patchById) {
      const row = await db.settlements.get(id)
      if (!row || row.is_deleted) continue
      await db.settlements.update(id, { ...patch, updated_at: ts, synced_at: null })
      rewritten++
    }
    if (softDeleted + rewritten > 0) {
      await db.activity_log.add({
        // entity_id is a UUID NOT NULL column the sync push casts server-side — a non-UUID
        // literal (the old 'data-repair') aborts kwenta_sync and, staying unsynced, poisons
        // every future push. Use a fresh UUID; the description carries the human label.
        id: generateId(),
        created_at: ts,
        updated_at: ts,
        synced_at: null,
        is_deleted: false,
        device_id: getDeviceId(),
        group_id: null,
        user_id: userId,
        action: 'updated',
        entity_type: 'settlement',
        entity_id: generateId(),
        description: `Data repair: removed ${softDeleted}, canonicalized ${rewritten}`,
      })
    }
  })

  if (softDeleted + rewritten > 0) {
    await finalizeMutationSync({
      actorUserId: userId,
      operation: 'kwenta_data_repair',
      entityType: 'settlement',
      entityId: null,
      payload: { softDeleted, rewritten },
      routeHint: '/app/settings',
    })
  }

  return { softDeleted, rewritten }
}
