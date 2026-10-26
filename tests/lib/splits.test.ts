import { describe, expect, it } from 'vitest'
import { computeSplits, type SplitInput } from '@/lib/splits'

const sumAmounts = (rows: { computedAmount: number }[]) =>
  Math.round(rows.reduce((sum, r) => sum + r.computedAmount, 0) * 100) / 100

describe('computeSplits', () => {
  it('returns an empty array when there are no splits', () => {
    expect(computeSplits(100, [])).toEqual([])
  })

  describe('equal', () => {
    const make = (ids: string[]): SplitInput[] =>
      ids.map((userId) => ({ userId, splitType: 'equal', splitValue: 0 }))

    it('divides evenly when amount splits cleanly', () => {
      const result = computeSplits(90, make(['a', 'b', 'c']))
      expect(result).toEqual([
        { userId: 'a', computedAmount: 30 },
        { userId: 'b', computedAmount: 30 },
        { userId: 'c', computedAmount: 30 },
      ])
    })

    it('puts the rounding remainder on the first split and still sums to the total', () => {
      const result = computeSplits(10, make(['a', 'b', 'c']))
      expect(result[0].computedAmount).toBe(3.34)
      expect(result[1].computedAmount).toBe(3.33)
      expect(result[2].computedAmount).toBe(3.33)
      expect(sumAmounts(result)).toBe(10)
    })
  })

  describe('percentage', () => {
    it('allocates by percentage of the amount', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'percentage', splitValue: 25 },
        { userId: 'b', splitType: 'percentage', splitValue: 75 },
      ]
      expect(computeSplits(200, splits)).toEqual([
        { userId: 'a', computedAmount: 50 },
        { userId: 'b', computedAmount: 150 },
      ])
    })

    it('rounds each share to two decimal places', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'percentage', splitValue: 33.33 },
      ]
      expect(computeSplits(100, splits)[0].computedAmount).toBe(33.33)
    })
  })

  describe('quantity', () => {
    it('multiplies quantity by the unit price', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'quantity', splitValue: 2 },
        { userId: 'b', splitType: 'quantity', splitValue: 3 },
      ]
      expect(computeSplits(10, splits)).toEqual([
        { userId: 'a', computedAmount: 20 },
        { userId: 'b', computedAmount: 30 },
      ])
    })
  })

  describe('custom', () => {
    it('uses explicit amounts when they already cover the total', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 60 },
        { userId: 'b', splitType: 'custom', splitValue: 40 },
      ]
      expect(computeSplits(100, splits)).toEqual([
        { userId: 'a', computedAmount: 60 },
        { userId: 'b', computedAmount: 40 },
      ])
    })

    it('distributes the remainder across unassigned (zero-value) splits', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 40 },
        { userId: 'b', splitType: 'custom', splitValue: 0 },
        { userId: 'c', splitType: 'custom', splitValue: 0 },
      ]
      const result = computeSplits(100, splits)
      expect(result[0].computedAmount).toBe(40)
      expect(result[1].computedAmount).toBe(30)
      expect(result[2].computedAmount).toBe(30)
      expect(sumAmounts(result)).toBe(100)
    })

    it('keeps explicit amounts when they cover the total exactly and leave nothing to distribute', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 50 },
        { userId: 'b', splitType: 'custom', splitValue: 0 },
      ]
      expect(computeSplits(50, splits)).toEqual([
        { userId: 'a', computedAmount: 50 },
        { userId: 'b', computedAmount: 0 },
      ])
    })

    // This used to keep 60 on a 50 bill as typed; the user decided an overflow is refused instead.
    it('refuses shares that add up to more than the item total', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 60 },
        { userId: 'b', splitType: 'custom', splitValue: 0 },
      ]
      expect(() => computeSplits(50, splits)).toThrow('Custom shares add up to more than the item total.')
    })

    it('refuses an overflow of a single cent', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 50 },
        { userId: 'b', splitType: 'custom', splitValue: 50.01 },
      ]
      expect(() => computeSplits(100, splits)).toThrow('Custom shares add up to more than the item total.')
    })

    it('does not refuse a float sum that is exactly the total in cents', () => {
      const splits: SplitInput[] = [
        { userId: 'a', splitType: 'custom', splitValue: 33.33 },
        { userId: 'b', splitType: 'custom', splitValue: 33.33 },
        { userId: 'c', splitType: 'custom', splitValue: 33.34 },
      ]
      expect(sumAmounts(computeSplits(100, splits))).toBe(100)
    })
  })
})
