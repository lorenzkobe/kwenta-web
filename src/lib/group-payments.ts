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
 * have headroom under what's owed.
 */
function roundRawToCents(rawById: Map<string, number>, owedById: Map<string, number>): Map<string, number> {
  const target = Math.round([...rawById.values()].reduce((s, v) => s + v, 0) * 100)
  const entries = [...rawById.entries()]
    .filter(([, raw]) => raw > 0)
    .map(([userId, raw]) => {
      const cents = raw * 100
      const floorCents = Math.floor(cents)
      return { userId, floorCents, frac: cents - floorCents, capCents: Math.round((owedById.get(userId) ?? 0) * 100) }
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
