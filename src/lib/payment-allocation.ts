/**
 * Splitting one payment across the several places it settles.
 *
 * TWO policies live here, and they differ on one question — may a payment exceed what is owed?
 *
 *  - `allocateLumpSum` (a member paying into a GROUP): no. Every share is capped at what that
 *    person is owed and the rest is reported as `unallocated`, because
 *    `createBundledGroupSettlement({ enforceCap: true })` would refuse it anyway.
 *  - `allocatePersonPayment` (one person paying another across personal + shared groups): yes.
 *    Overpaying is legal and simply flips the tab — there is no credit concept — so the excess is
 *    allocated and merely reported through `overBy` for the UI to warn about.
 *
 * They are deliberately two named functions rather than one with a flag: which policy applies is
 * a property of the caller, not a runtime choice, and a flag would make the dangerous direction
 * (uncapped) reachable from the group path by a one-character mistake.
 */

export interface OwedParty {
  userId: string
  name: string
  /** What the payer currently owes this party (the per-person cap). */
  owed: number
}

export type LumpSumMode = 'equal' | 'percentage' | 'custom'

export interface Allocation {
  userId: string
  amount: number
}

export interface LumpSumResult {
  /** Per-person amounts to settle (zero amounts dropped). */
  allocations: Allocation[]
  /** Sum actually applied. */
  allocatedTotal: number
  /** Amount that could not be applied because everyone hit their cap. */
  unallocated: number
}

/** The "who this member owes" slice of a member's payment breakdown (settlement.ts). */
export interface PayerBreakdown {
  pays: { memberUserId: string; displayName: string; amount: number }[]
}

/**
 * Convert a payer's breakdown into the owed-party list the lump-sum allocator consumes.
 * `pays` already holds positive magnitudes of who the payer owes, which become each party's
 * per-person cap. A null breakdown (payer owes no one / not found) yields an empty list.
 */
export function owedPartiesFromBreakdown(breakdown: PayerBreakdown | null): OwedParty[] {
  if (!breakdown) return []
  return breakdown.pays.map((p) => ({ userId: p.memberUserId, name: p.displayName, owed: p.amount }))
}

const round2 = (n: number) => Math.round(n * 100) / 100
const safeNumber = (n: number) => (Number.isFinite(n) ? n : 0)
const capAt = (amount: number, owed: number) => Math.max(0, Math.min(round2(amount), round2(owed)))

/** Sub-cent threshold used to decide when an amount is "fully applied" / "exhausted". */
const EPSILON = 0.005

/**
 * Cap a custom amount at what the payer owes that person so a manual entry can never overpay.
 * Negatives floor at 0.
 */
export function clampToOwed(value: number, owed: number): number {
  return capAt(value, owed)
}

/**
 * Cap a single percentage entry so the locked percentages can never sum past 100.
 * `otherLockedSum` is the total of the *other* already-locked fields. Negatives floor at 0.
 */
export function clampPercentageEntry(value: number, otherLockedSum: number): number {
  return Math.max(0, Math.min(round2(value), round2(100 - otherLockedSum)))
}

/**
 * Compute every party's percentage given the user-locked entries.
 * Locked fields keep their values; the remaining percent (100 − sum of locked) is split
 * evenly across the unlocked fields, with the rounding remainder placed on the last unlocked.
 * Used to default to equal percentages (`locked = {}`) and to keep locked fields fixed while
 * the rest absorb changes.
 */
export function redistributePercentages(
  ids: string[],
  locked: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {}
  const unlocked: string[] = []
  let lockedSum = 0
  for (const id of ids) {
    if (id in locked) {
      result[id] = locked[id]
      lockedSum += locked[id]
    } else {
      unlocked.push(id)
    }
  }

  const remaining = Math.max(0, round2(100 - lockedSum))
  const n = unlocked.length
  if (n > 0) {
    const share = Math.floor((remaining / n) * 100) / 100
    let assigned = 0
    unlocked.forEach((id, i) => {
      if (i < n - 1) {
        result[id] = share
        assigned = round2(assigned + share)
      } else {
        result[id] = round2(remaining - assigned)
      }
    })
  }

  return result
}

/**
 * Weighted water-fill: distribute `total` across parties proportionally to their weights,
 * capping each at what they're owed and redistributing any capped overflow to the parties
 * that still have headroom. Converges in at most one pass per party. Returns raw (unrounded)
 * per-party amounts keyed by userId.
 */
function waterfill(total: number, parties: { userId: string; owed: number; weight: number }[]): Map<string, number> {
  const alloc = new Map<string, number>(parties.map((p) => [p.userId, 0]))
  let remaining = total

  for (let guard = 0; guard <= parties.length; guard++) {
    if (remaining <= EPSILON) break
    const active = parties.filter((p) => p.weight > 0 && p.owed - (alloc.get(p.userId) as number) > EPSILON)
    const totalWeight = active.reduce((s, p) => s + p.weight, 0)
    if (totalWeight <= 0) break

    let distributed = 0
    let capped = false
    for (const p of active) {
      const room = p.owed - (alloc.get(p.userId) as number)
      const share = (remaining * p.weight) / totalWeight
      const give = Math.min(share, room)
      if (give < share - EPSILON) capped = true
      alloc.set(p.userId, (alloc.get(p.userId) as number) + give)
      distributed += give
    }
    remaining -= distributed
    // Nobody hit a cap → the proportional split fit entirely; we're done.
    if (!capped || distributed <= EPSILON) break
  }

  return alloc
}

/**
 * Allocate a lump-sum "pay into group" across the people you owe.
 * - `equal`: split `total` evenly, redistributing any capped overflow so the full amount is exhausted.
 * - `percentage`: split `total` by per-person percentages, redistributing capped overflow likewise.
 * - `custom`: use explicit per-person amounts; the effective total is their sum (no redistribution).
 * Every per-person amount is capped at what you owe that person. Any portion that genuinely
 * cannot be applied (because everyone with a share hit their cap) is reported as `unallocated`.
 */
export function allocateLumpSum(params: {
  mode: LumpSumMode
  total: number
  owed: OwedParty[]
  percentages?: Record<string, number>
  customAmounts?: Record<string, number>
}): LumpSumResult {
  const { mode, total, owed, percentages = {}, customAmounts = {} } = params

  const owedById = new Map(owed.map((p) => [p.userId, p.owed]))
  let rawById: Map<string, number>
  let intendedTotal: number

  if (mode === 'custom') {
    // Explicit amounts: cap each at owed, never redistribute. The over-cap excess is the remainder.
    rawById = new Map(owed.map((p) => [p.userId, capAt(customAmounts[p.userId] ?? 0, p.owed)]))
    intendedTotal = round2(owed.reduce((s, p) => s + round2(customAmounts[p.userId] ?? 0), 0))
  } else {
    const weights = owed.map((p) => ({
      userId: p.userId,
      owed: p.owed,
      weight: mode === 'equal' ? 1 : percentages[p.userId] ?? 0,
    }))
    rawById = waterfill(round2(total), weights)
    const sumPct = mode === 'equal' ? 100 : weights.reduce((s, w) => s + w.weight, 0)
    intendedTotal = round2((total * Math.min(100, sumPct)) / 100)
  }

  const centsById = roundRawToCents(rawById, owedById)
  const allocations: Allocation[] = []
  let allocatedTotal = 0
  for (const p of owed) {
    const amount = (centsById.get(p.userId) ?? 0) / 100
    if (amount > 0) {
      allocations.push({ userId: p.userId, amount })
      allocatedTotal = round2(allocatedTotal + amount)
    }
  }

  return {
    allocations,
    allocatedTotal,
    unallocated: round2(Math.max(0, intendedTotal - allocatedTotal)),
  }
}

/**
 * Round raw (fractional) per-party amounts to whole cents using the largest-remainder method,
 * so the rounded total equals the distributed total exactly — no phantom cent from rounding two
 * half-cents up independently. The leftover cents go to the largest fractional parts that still
 * have headroom under their cap. An absent cap means uncapped (the person-payment policy).
 */
function roundRawToCents(rawById: Map<string, number>, owedById: Map<string, number>): Map<string, number> {
  const target = Math.round([...rawById.values()].reduce((s, v) => s + v, 0) * 100)
  const entries = [...rawById.entries()]
    .filter(([, raw]) => raw > 0)
    .map(([userId, raw]) => {
      const cents = raw * 100
      const floorCents = Math.floor(cents)
      const cap = owedById.get(userId)
      return {
        userId,
        floorCents,
        frac: cents - floorCents,
        capCents: cap === undefined ? Number.POSITIVE_INFINITY : Math.round(cap * 100),
      }
    })

  const result = new Map<string, number>(entries.map((e) => [e.userId, Math.min(e.floorCents, e.capCents)]))
  let leftover = target - [...result.values()].reduce((s, v) => s + v, 0)

  // Hand out remaining cents, largest fractional part first, only where there's headroom.
  // Each cycle that gives nothing (everyone at their cap) ends the loop.
  const byFrac = [...entries].sort((a, b) => b.frac - a.frac)
  while (leftover > 0) {
    let gave = false
    for (const e of byFrac) {
      if (leftover <= 0) break
      const current = result.get(e.userId) as number
      if (current < e.capCents) {
        result.set(e.userId, current + 1)
        leftover--
        gave = true
      }
    }
    if (!gave) break
  }

  return result
}

// ---------------------------------------------------------------------------
// Person payments: one transfer split across personal + shared-group contexts.
// See the header for why this cannot share a policy with `allocateLumpSum`.
// ---------------------------------------------------------------------------

export type PersonSplitMode = 'sequential' | 'percentage' | 'custom'

/** One place a payment can settle: `'personal'` or a groupId, and what is owed there. */
export interface PaymentBucket {
  key: string
  owed: number
}

export interface PersonAllocation {
  key: string
  amount: number
}

export interface PersonPaymentResult {
  /** Per-context amounts (zero amounts dropped, so no empty settlement leg is ever written). */
  allocations: PersonAllocation[]
  /** How much of the total exceeds everything owed — the amount that will flip the tab. */
  overBy: number
  /**
   * Total minus what was actually allocated. Always 0 for `sequential`; non-zero only when the
   * caller's percentages or custom amounts do not reach the total, which the UI must block rather
   * than quietly record a smaller payment than the one that was typed.
   */
  unassigned: number
}

/**
 * Fill buckets in order, each up to what it is owed, and park any leftover on the FIRST bucket.
 * Returns whole-peso-accurate amounts keyed by bucket; buckets receiving nothing are omitted.
 */
function fillSequentially(amount: number, buckets: PaymentBucket[]): Map<string, number> {
  const out = new Map<string, number>()
  if (buckets.length === 0) return out

  let remaining = round2(amount)
  for (const b of buckets) {
    const take = Math.min(remaining, Math.max(0, round2(b.owed)))
    if (take > EPSILON) {
      out.set(b.key, round2(take))
      remaining = round2(remaining - take)
    }
  }
  if (remaining > EPSILON) {
    const first = buckets[0].key
    out.set(first, round2((out.get(first) ?? 0) + remaining))
  }
  return out
}

/**
 * Split `total` across the contexts a person owes in. Unlike the group policy, the result may
 * exceed what is owed; `overBy` reports by how much so the caller can warn that the balance flips.
 */
export function allocatePersonPayment(params: {
  mode: PersonSplitMode
  total: number
  buckets: PaymentBucket[]
  percentages?: Record<string, number>
  customAmounts?: Record<string, number>
}): PersonPaymentResult {
  const { mode, buckets, percentages = {}, customAmounts = {} } = params
  const total = round2(Math.max(0, safeNumber(params.total)))
  const totalOwed = round2(buckets.reduce((s, b) => s + Math.max(0, safeNumber(b.owed)), 0))
  const overBy = round2(Math.max(0, total - totalOwed))

  if (total <= EPSILON || buckets.length === 0) {
    return { allocations: [], overBy, unassigned: total }
  }

  let byKey: Map<string, number>
  if (mode === 'sequential') {
    byKey = fillSequentially(total, buckets)
  } else if (mode === 'percentage') {
    // A percentage is explicit intent, so it is NOT capped at what the bucket is owed. Largest-
    // remainder rounding keeps the parts summing to the requested share of the total exactly.
    const raw = new Map(
      buckets.map((b) => [b.key, (total * Math.max(0, safeNumber(percentages[b.key] ?? 0))) / 100]),
    )
    byKey = new Map([...roundRawToCents(raw, new Map())].map(([k, cents]) => [k, cents / 100]))
  } else {
    byKey = new Map(
      buckets.map((b) => [b.key, round2(Math.max(0, safeNumber(customAmounts[b.key] ?? 0)))]),
    )
  }

  const allocations: PersonAllocation[] = []
  let allocated = 0
  for (const b of buckets) {
    const amount = round2(byKey.get(b.key) ?? 0)
    if (amount > EPSILON) {
      allocations.push({ key: b.key, amount })
      allocated = round2(allocated + amount)
    }
  }

  return { allocations, overBy, unassigned: round2(Math.max(0, total - allocated)) }
}

/**
 * Re-spread the per-context boxes after the user edits one, so they always sum to `total`.
 *
 * The rule: **the box being edited wins, and the box touched longest ago gives way.** Editing the
 * last free box releases the oldest pin, so there is always something able to absorb the slack and
 * the user can never reach a state where the boxes disagree with the amount they typed. That is
 * what makes the typed amount authoritative — the bug this replaced let the boxes redefine it.
 *
 * `pinnedOrder` is the keys the user has typed into, oldest first; pass the value returned here
 * straight back on the next edit.
 */
export function rebalanceCustomAmounts(params: {
  total: number
  buckets: PaymentBucket[]
  pinnedOrder: string[]
  /** The amounts currently displayed, so untouched pins keep their value. */
  current: Record<string, number>
  editedKey: string
  editedValue: number
}): { amounts: Record<string, number>; pinnedOrder: string[] } {
  const { buckets, current, editedKey } = params
  const total = round2(Math.max(0, safeNumber(params.total)))
  const keys = buckets.map((b) => b.key)

  const unchanged = () => ({
    amounts: Object.fromEntries(keys.map((k) => [k, round2(Math.max(0, safeNumber(current[k] ?? 0)))])),
    pinnedOrder: params.pinnedOrder.filter((k) => keys.includes(k)),
  })
  if (!keys.includes(editedKey)) return unchanged()

  const editedValue = Math.min(total, Math.max(0, round2(safeNumber(params.editedValue))))

  // Most recently edited last. Re-adding moves an existing pin to the front of the queue.
  let pinned = params.pinnedOrder.filter((k) => keys.includes(k) && k !== editedKey)
  pinned.push(editedKey)
  // Keep at least one box free to absorb the slack (impossible with a single bucket, handled below).
  if (pinned.length === keys.length && keys.length > 1) pinned = pinned.slice(1)

  // Honour the newest pins first, squeezing older ones when there is no room left for them.
  const amounts: Record<string, number> = {}
  let budget = total
  for (const key of [...pinned].reverse()) {
    const wanted = key === editedKey ? editedValue : round2(Math.max(0, safeNumber(current[key] ?? 0)))
    const given = Math.min(wanted, budget)
    amounts[key] = round2(given)
    budget = round2(budget - given)
  }

  const free = buckets.filter((b) => !pinned.includes(b.key))
  if (free.length === 0) {
    // Single bucket: it must carry the whole amount, since there is nowhere else for it to go.
    amounts[editedKey] = total
  } else {
    const spread = fillSequentially(budget, free)
    for (const b of free) amounts[b.key] = round2(spread.get(b.key) ?? 0)
  }

  return { amounts, pinnedOrder: pinned }
}
