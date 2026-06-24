import { describe, expect, it } from 'vitest'
import {
  allocateLumpSum,
  clampPercentageEntry,
  clampToOwed,
  owedPartiesFromBreakdown,
  redistributePercentages,
  type OwedParty,
} from '@/lib/group-payments'

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
