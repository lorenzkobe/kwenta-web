import { db } from '@/db/db'
import {
  computeCombinedNetRollup,
  computePairwiseNetBreakdown,
  computePersonalNetRollup,
  listCanonicalRelatedProfileIds,
  loadBalanceSnapshot,
  resolveProfileDisplay,
} from '@/lib/people'

/**
 * A dump of every balance number this device currently shows, for verifying that a refactor
 * changed none of them.
 *
 * The unit tests cover the balance rules against seeded fixtures, but they cannot cover YOUR
 * data — the linked contacts, part-settled groups and multi-currency history that only exist in
 * a real account. Take a snapshot before a change and another after, diff them, and any
 * difference is a regression rather than an improvement.
 *
 * Usage from the browser console on any /app page:
 *
 *   const { captureBalanceParitySnapshot } = await import('/src/lib/balance-parity-snapshot.ts')
 *   copy(await captureBalanceParitySnapshot('<your-user-id>'))
 *
 * Then paste each run into a file and `diff` them. Read-only — it writes nothing.
 */

export type BalanceParityRow = {
  otherId: string
  displayName: string
  /** Personal-only net, per currency. */
  personal: Record<string, number>
  /** Per shared group with a non-zero net. */
  groups: { groupId: string; groupName: string; currency: string; net: number }[]
  /** personal + groups, per currency — what the People list and Person page show. */
  total: Record<string, number>
}

export type BalanceParitySnapshot = {
  userId: string
  /** Row counts, so a diff shows whether the underlying data also changed. */
  counts: Record<string, number>
  personalRollup: { toReceive: Record<string, number>; toPay: Record<string, number> }
  combinedRollup: { toReceive: Record<string, number>; toPay: Record<string, number> }
  contacts: BalanceParityRow[]
}

function mapToObject(m: Map<string, number>): Record<string, number> {
  // Sorted so two runs serialise identically and the diff shows real changes only.
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export async function captureBalanceParitySnapshot(
  userId: string,
): Promise<BalanceParitySnapshot> {
  const snapshot = await loadBalanceSnapshot()
  const peers = await listCanonicalRelatedProfileIds(userId, snapshot)

  const contacts: BalanceParityRow[] = []
  for (const otherId of peers) {
    const breakdown = await computePairwiseNetBreakdown(userId, otherId, snapshot)
    const display = await resolveProfileDisplay(otherId, userId)
    contacts.push({
      otherId,
      displayName: display.displayName,
      personal: mapToObject(breakdown.personal),
      groups: [...breakdown.groups].sort((a, b) => a.groupId.localeCompare(b.groupId)),
      total: mapToObject(breakdown.total),
    })
  }
  contacts.sort((a, b) => a.otherId.localeCompare(b.otherId))

  const [personal, combined] = await Promise.all([
    computePersonalNetRollup(userId, snapshot),
    computeCombinedNetRollup(userId, snapshot),
  ])

  const [profiles, groups, bills, items, splits, settlements] = await Promise.all([
    db.profiles.count(),
    db.groups.count(),
    db.bills.count(),
    db.bill_items.count(),
    db.item_splits.count(),
    db.settlements.count(),
  ])

  return {
    userId,
    counts: { profiles, groups, bills, items, splits, settlements },
    personalRollup: {
      toReceive: mapToObject(personal.toReceiveByCurrency),
      toPay: mapToObject(personal.toPayByCurrency),
    },
    combinedRollup: {
      toReceive: mapToObject(combined.toReceiveByCurrency),
      toPay: mapToObject(combined.toPayByCurrency),
    },
    contacts,
  }
}

/** Stable JSON for diffing two runs. */
export async function captureBalanceParityJson(userId: string): Promise<string> {
  return JSON.stringify(await captureBalanceParitySnapshot(userId), null, 2)
}
