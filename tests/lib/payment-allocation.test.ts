import { describe, expect, it } from 'vitest'
import {
  allocateLumpSum,
  allocatePersonPayment,
  clampPercentageEntry,
  clampToOwed,
  owedPartiesFromBreakdown,
  rebalanceCustomAmounts,
  redistributePercentages,
  type OwedParty,
  type PaymentBucket,
} from '@/lib/payment-allocation'

const owed: OwedParty[] = [
  { userId: 'maria', name: 'Maria', owed: 500 },
  { userId: 'ana', name: 'Ana', owed: 300 },
]

describe('allocateLumpSum', () => {
  it('equal: splits evenly when under everyone\'s cap', () => {
    const r = allocateLumpSum({ mode: 'equal', total: 600, owed })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(300)
    expect(byId.ana).toBe(300)
    expect(r.unallocated).toBe(0)
  })

  it('equal: caps per person and reports the unallocatable remainder', () => {
    // 1000 / 2 = 500 each, but Ana only owes 300 → 200 cannot be applied.
    const r = allocateLumpSum({ mode: 'equal', total: 1000, owed })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(byId.ana).toBe(300)
    expect(r.allocatedTotal).toBe(800)
    expect(r.unallocated).toBe(200)
  })

  it('percentage: allocates by ratio, capped, remainder reported', () => {
    const r = allocateLumpSum({
      mode: 'percentage',
      total: 600,
      owed,
      percentages: { maria: 50, ana: 50 },
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(300)
    expect(byId.ana).toBe(300)
    expect(r.unallocated).toBe(0)
  })

  it('custom: uses explicit amounts, total is their sum, caps at owed', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0, // ignored in custom mode
      owed,
      customAmounts: { maria: 500, ana: 100 },
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(byId.ana).toBe(100)
    expect(r.allocatedTotal).toBe(600)
    expect(r.unallocated).toBe(0)
  })

  it('custom: caps an over-cap entry and counts the excess as unallocated', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0,
      owed,
      customAmounts: { maria: 700, ana: 0 }, // 700 > 500 owed
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(r.unallocated).toBe(200)
  })

  it('drops zero allocations', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0,
      owed,
      customAmounts: { maria: 100, ana: 0 },
    })
    expect(r.allocations.map((a) => a.userId)).toEqual(['maria'])
  })
})

describe('allocateLumpSum redistribution (exhaust the full amount)', () => {
  // Maria is owed less than Ana, so an even split overflows Maria's cap.
  const owedSmallFirst: OwedParty[] = [
    { userId: 'maria', name: 'Maria', owed: 100 },
    { userId: 'ana', name: 'Ana', owed: 500 },
  ]

  it('equal: redistributes a capped person\'s overflow to those with remaining capacity', () => {
    // 400 / 2 = 200 each, but Maria only owes 100 → the extra 100 goes to Ana.
    const r = allocateLumpSum({ mode: 'equal', total: 400, owed: owedSmallFirst })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(100)
    expect(byId.ana).toBe(300)
    expect(r.allocatedTotal).toBe(400)
    expect(r.unallocated).toBe(0)
  })

  it('percentage: redistributes a capped person\'s overflow to those with capacity', () => {
    // 50/50 of 400 = 200 each; Maria caps at 100, the 100 overflow shifts to Ana.
    const r = allocateLumpSum({
      mode: 'percentage',
      total: 400,
      owed: owedSmallFirst,
      percentages: { maria: 50, ana: 50 },
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(100)
    expect(byId.ana).toBe(300)
    expect(r.unallocated).toBe(0)
  })

  it('equal: distributes rounding cents so the applied total never exceeds the amount entered', () => {
    // Real case: an even leftover lands on a half-cent for two people. Rounding each up
    // independently would invent a phantom cent (2000.01); largest-remainder rounding must not.
    const owedManyDecimals: OwedParty[] = [
      { userId: 'jello', name: 'Jello', owed: 5.72 },
      { userId: 'kobz', name: 'Kobz', owed: 270.12 },
      { userId: 'lady', name: 'Lady', owed: 858.21 },
      { userId: 'trisha', name: 'Trisha', owed: 173.57 },
      { userId: 'yumi', name: 'Yumi', owed: 1933.36 },
    ]
    const r = allocateLumpSum({ mode: 'equal', total: 2000, owed: owedManyDecimals })
    const sum = r.allocations.reduce((s, a) => s + a.amount, 0)
    expect(Math.round(sum * 100) / 100).toBe(2000)
    expect(r.allocatedTotal).toBe(2000)
    expect(r.unallocated).toBe(0)
    // No one is paid more than they're owed.
    const owedById = Object.fromEntries(owedManyDecimals.map((p) => [p.userId, p.owed]))
    for (const a of r.allocations) expect(a.amount).toBeLessThanOrEqual(owedById[a.userId])
  })

  it('equal: still reports a true remainder when the amount exceeds everyone\'s combined cap', () => {
    const r = allocateLumpSum({
      mode: 'equal',
      total: 1000,
      owed: [
        { userId: 'maria', name: 'Maria', owed: 500 },
        { userId: 'ana', name: 'Ana', owed: 300 },
      ],
    })
    expect(r.allocatedTotal).toBe(800)
    expect(r.unallocated).toBe(200)
  })
})

describe('redistributePercentages', () => {
  it('with nothing locked, splits 100% equally and puts the rounding remainder on the last', () => {
    expect(redistributePercentages(['a', 'b', 'c'], {})).toEqual({ a: 33.33, b: 33.33, c: 33.34 })
  })

  it('splits two parties evenly', () => {
    expect(redistributePercentages(['a', 'b'], {})).toEqual({ a: 50, b: 50 })
  })

  it('keeps one locked field and divides the remaining percent among the unlocked', () => {
    expect(redistributePercentages(['a', 'b', 'c'], { a: 50 })).toEqual({ a: 50, b: 25, c: 25 })
  })

  it('keeps several locked fields; the remaining percent fills the last unlocked', () => {
    expect(redistributePercentages(['a', 'b', 'c'], { a: 50, b: 30 })).toEqual({ a: 50, b: 30, c: 20 })
  })

  it('gives unlocked fields 0 when the locked fields already reach 100', () => {
    expect(redistributePercentages(['a', 'b'], { a: 100 })).toEqual({ a: 100, b: 0 })
  })
})

describe('clampPercentageEntry', () => {
  it('caps an entry so the locked total cannot exceed 100', () => {
    expect(clampPercentageEntry(80, 50)).toBe(50)
  })

  it('passes through an entry that still fits under 100', () => {
    expect(clampPercentageEntry(30, 50)).toBe(30)
  })

  it('floors negatives at 0', () => {
    expect(clampPercentageEntry(-5, 0)).toBe(0)
  })
})

describe('clampToOwed', () => {
  it('caps an amount at what is owed so it cannot overpay', () => {
    expect(clampToOwed(700, 500)).toBe(500)
  })

  it('passes through an amount under the cap', () => {
    expect(clampToOwed(100, 500)).toBe(100)
  })

  it('floors negatives at 0', () => {
    expect(clampToOwed(-5, 500)).toBe(0)
  })
})

describe('owedPartiesFromBreakdown', () => {
  it('maps a payer breakdown\'s "pays" list into owed parties', () => {
    const result = owedPartiesFromBreakdown({
      pays: [
        { memberUserId: 'maria', displayName: 'Maria', amount: 500 },
        { memberUserId: 'ana', displayName: 'Ana', amount: 300 },
      ],
    })
    expect(result).toEqual([
      { userId: 'maria', name: 'Maria', owed: 500 },
      { userId: 'ana', name: 'Ana', owed: 300 },
    ])
  })

  it('returns an empty list when the breakdown is null (payer owes no one)', () => {
    expect(owedPartiesFromBreakdown(null)).toEqual([])
  })

  it('returns an empty list when the pays list is empty', () => {
    expect(owedPartiesFromBreakdown({ pays: [] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The PERSON payment policy. Deliberately different from `allocateLumpSum` above: a person
// payment MAY exceed what is owed, because an overpayment flips the tab (there is no credit
// concept), whereas a group payment is capped and the excess is refused.
// ---------------------------------------------------------------------------

const buckets: PaymentBucket[] = [
  { key: 'personal', owed: 3000 },
  { key: 'beach', owed: 4000 },
]

const amountsOf = (r: { allocations: { key: string; amount: number }[] }) =>
  Object.fromEntries(r.allocations.map((a) => [a.key, a.amount]))

describe('allocatePersonPayment — sequential', () => {
  it('clears the first bucket fully before the next receives anything', () => {
    const r = allocatePersonPayment({ mode: 'sequential', total: 4000, buckets })
    expect(amountsOf(r)).toEqual({ personal: 3000, beach: 1000 })
    expect(r.overBy).toBe(0)
    expect(r.unassigned).toBe(0)
  })

  it('leaves later buckets untouched when the first absorbs everything', () => {
    const r = allocatePersonPayment({ mode: 'sequential', total: 1200, buckets })
    expect(amountsOf(r)).toEqual({ personal: 1200 })
  })

  it('exactly clears every bucket', () => {
    const r = allocatePersonPayment({ mode: 'sequential', total: 7000, buckets })
    expect(amountsOf(r)).toEqual({ personal: 3000, beach: 4000 })
    expect(r.overBy).toBe(0)
  })

  it('parks the excess on the FIRST bucket and reports overBy', () => {
    const r = allocatePersonPayment({ mode: 'sequential', total: 8000, buckets })
    expect(amountsOf(r)).toEqual({ personal: 4000, beach: 4000 })
    expect(r.overBy).toBe(1000)
    // Still records exactly what was typed — that is the whole point.
    expect(r.allocations.reduce((s, a) => s + a.amount, 0)).toBe(8000)
  })

  it('puts everything on the only bucket', () => {
    const r = allocatePersonPayment({
      mode: 'sequential',
      total: 250,
      buckets: [{ key: 'personal', owed: 100 }],
    })
    expect(amountsOf(r)).toEqual({ personal: 250 })
    expect(r.overBy).toBe(150)
  })

  it('allocates nothing for a zero or negative total', () => {
    expect(allocatePersonPayment({ mode: 'sequential', total: 0, buckets }).allocations).toEqual([])
    expect(allocatePersonPayment({ mode: 'sequential', total: -5, buckets }).allocations).toEqual([])
  })

  it('allocates nothing when there are no buckets, and reports the whole amount as over', () => {
    const r = allocatePersonPayment({ mode: 'sequential', total: 500, buckets: [] })
    expect(r.allocations).toEqual([])
    expect(r.overBy).toBe(500)
  })

  it('drops a bucket that rounds to zero rather than writing an empty leg', () => {
    const r = allocatePersonPayment({
      mode: 'sequential',
      total: 100,
      buckets: [{ key: 'personal', owed: 100 }, { key: 'beach', owed: 50 }],
    })
    expect(r.allocations.map((a) => a.key)).toEqual(['personal'])
  })
})

describe('allocatePersonPayment — percentage', () => {
  it('splits by the given percentages', () => {
    const r = allocatePersonPayment({
      mode: 'percentage',
      total: 4000,
      buckets,
      percentages: { personal: 25, beach: 75 },
    })
    expect(amountsOf(r)).toEqual({ personal: 1000, beach: 3000 })
    expect(r.unassigned).toBe(0)
  })

  it('sums to the total to the cent when the split does not divide evenly', () => {
    const three: PaymentBucket[] = [
      { key: 'a', owed: 100 },
      { key: 'b', owed: 100 },
      { key: 'c', owed: 100 },
    ]
    const r = allocatePersonPayment({
      mode: 'percentage',
      total: 100,
      buckets: three,
      // 33.33 / 33.33 / 33.34 is what the UI's redistribute produces.
      percentages: { a: 33.33, b: 33.33, c: 33.34 },
    })
    expect(r.allocations.reduce((s, a) => s + a.amount, 0)).toBe(100)
    expect(r.unassigned).toBe(0)
  })

  it('honours a percentage that overshoots what that bucket is owed', () => {
    // A percentage is explicit intent, so it is NOT capped — but the excess is reported.
    const r = allocatePersonPayment({
      mode: 'percentage',
      total: 8000,
      buckets,
      percentages: { personal: 50, beach: 50 },
    })
    expect(amountsOf(r)).toEqual({ personal: 4000, beach: 4000 })
    expect(r.overBy).toBe(1000)
  })

  it('reports the shortfall rather than silently recording less than the total', () => {
    const r = allocatePersonPayment({
      mode: 'percentage',
      total: 4000,
      buckets,
      percentages: { personal: 25, beach: 25 },
    })
    expect(r.allocations.reduce((s, a) => s + a.amount, 0)).toBe(2000)
    expect(r.unassigned).toBe(2000)
  })

  it('allocates nothing when every percentage is zero', () => {
    const r = allocatePersonPayment({
      mode: 'percentage',
      total: 4000,
      buckets,
      percentages: { personal: 0, beach: 0 },
    })
    expect(r.allocations).toEqual([])
    expect(r.unassigned).toBe(4000)
  })
})

describe('allocatePersonPayment — custom', () => {
  it('uses the explicit amounts as given', () => {
    const r = allocatePersonPayment({
      mode: 'custom',
      total: 4000,
      buckets,
      customAmounts: { personal: 500, beach: 3500 },
    })
    expect(amountsOf(r)).toEqual({ personal: 500, beach: 3500 })
    expect(r.unassigned).toBe(0)
  })

  it('reports a shortfall when the amounts do not reach the total', () => {
    const r = allocatePersonPayment({
      mode: 'custom',
      total: 4000,
      buckets,
      customAmounts: { personal: 500, beach: 500 },
    })
    expect(r.unassigned).toBe(3000)
  })

  it('ignores negative and missing entries', () => {
    const r = allocatePersonPayment({
      mode: 'custom',
      total: 4000,
      buckets,
      customAmounts: { personal: -100 },
    })
    expect(r.allocations).toEqual([])
  })
})

describe('rebalanceCustomAmounts', () => {
  const rebalance = (
    editedKey: string,
    editedValue: number,
    state: { amounts: Record<string, number>; pinnedOrder: string[] },
    bucketList: PaymentBucket[] = buckets,
  ) =>
    rebalanceCustomAmounts({
      total: 4000,
      buckets: bucketList,
      pinnedOrder: state.pinnedOrder,
      current: state.amounts,
      editedKey,
      editedValue,
    })

  const empty = { amounts: {}, pinnedOrder: [] as string[] }

  it('adjusts the other box so the pair always sums to the total', () => {
    const first = rebalance('personal', 1000, empty)
    expect(first.amounts).toEqual({ personal: 1000, beach: 3000 })
  })

  it('lets the box being edited win — the other one gives way', () => {
    // The exact sequence a user performs: type into one box, then the other.
    const first = rebalance('personal', 1000, empty)
    const second = rebalance('beach', 3500, first)
    expect(second.amounts).toEqual({ personal: 500, beach: 3500 })
  })

  it('never deadlocks when every box has been edited', () => {
    let state = rebalance('personal', 1000, empty)
    for (const [key, value] of [['beach', 2000], ['personal', 3000], ['beach', 100]] as const) {
      state = rebalance(key, value, state)
      const sum = Object.values(state.amounts).reduce((s, v) => s + v, 0)
      expect(sum).toBe(4000)
    }
    expect(state.amounts.beach).toBe(100)
  })

  it('clamps an entry above the total', () => {
    const r = rebalance('personal', 99999, empty)
    expect(r.amounts).toEqual({ personal: 4000, beach: 0 })
  })

  it('clamps a negative entry to zero', () => {
    const r = rebalance('personal', -500, empty)
    expect(r.amounts).toEqual({ personal: 0, beach: 4000 })
  })

  it('treats a non-numeric entry as zero', () => {
    const r = rebalance('personal', Number.NaN, empty)
    expect(r.amounts).toEqual({ personal: 0, beach: 4000 })
  })

  it('squeezes older pins when the newest entry leaves them no room', () => {
    const three: PaymentBucket[] = [
      { key: 'a', owed: 4000 },
      { key: 'b', owed: 4000 },
      { key: 'c', owed: 4000 },
    ]
    let state = rebalance('a', 3000, { amounts: {}, pinnedOrder: [] }, three)
    state = rebalance('b', 3000, state, three)
    // `b` was typed last, so it keeps 3000; `a` is squeezed to what is left.
    expect(state.amounts.b).toBe(3000)
    expect(Object.values(state.amounts).reduce((s, v) => s + v, 0)).toBe(4000)
  })

  it('gives the whole total to a single bucket regardless of what is typed', () => {
    const r = rebalance('personal', 10, { amounts: {}, pinnedOrder: [] }, [
      { key: 'personal', owed: 3000 },
    ])
    expect(r.amounts).toEqual({ personal: 4000 })
  })

  it('ignores an edit to a key that is not a bucket', () => {
    const r = rebalance('ghost', 100, { amounts: { personal: 1000, beach: 3000 }, pinnedOrder: ['personal'] })
    expect(r.amounts).toEqual({ personal: 1000, beach: 3000 })
    expect(r.pinnedOrder).toEqual(['personal'])
  })
})
