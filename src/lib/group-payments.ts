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

const round2 = (n: number) => Math.round(n * 100) / 100
const capAt = (amount: number, owed: number) => Math.max(0, Math.min(round2(amount), round2(owed)))

/**
 * Allocate a lump-sum "pay into group" across the people you owe.
 * - `equal`: split `total` evenly across all owed parties.
 * - `percentage`: split `total` by the given per-person percentages.
 * - `custom`: use explicit per-person amounts; the effective total is their sum.
 * Every per-person amount is capped at what you owe that person. Any portion that
 * cannot be applied (because a party hit their cap) is reported as `unallocated`.
 */
export function allocateLumpSum(params: {
  mode: LumpSumMode
  total: number
  owed: OwedParty[]
  percentages?: Record<string, number>
  customAmounts?: Record<string, number>
}): LumpSumResult {
  const { mode, total, owed, percentages = {}, customAmounts = {} } = params

  let intended: { userId: string; amount: number }[]
  let intendedTotal: number

  if (mode === 'equal') {
    const n = owed.length
    const share = n > 0 ? round2(total / n) : 0
    intended = owed.map((p) => ({ userId: p.userId, amount: share }))
    intendedTotal = round2(total)
  } else if (mode === 'percentage') {
    intended = owed.map((p) => ({
      userId: p.userId,
      amount: round2((total * (percentages[p.userId] ?? 0)) / 100),
    }))
    intendedTotal = round2(total)
  } else {
    intended = owed.map((p) => ({ userId: p.userId, amount: round2(customAmounts[p.userId] ?? 0) }))
    intendedTotal = round2(intended.reduce((s, a) => s + a.amount, 0))
  }

  const owedById = new Map(owed.map((p) => [p.userId, p.owed]))
  const allocations: Allocation[] = []
  let allocatedTotal = 0
  for (const it of intended) {
    const capped = capAt(it.amount, owedById.get(it.userId) ?? 0)
    if (capped > 0) {
      allocations.push({ userId: it.userId, amount: capped })
      allocatedTotal = round2(allocatedTotal + capped)
    }
  }

  return {
    allocations,
    allocatedTotal,
    unallocated: round2(Math.max(0, intendedTotal - allocatedTotal)),
  }
}
