import { describe, expect, it } from 'vitest'
import {
  applyClearedSplitField,
  buildSplitPayload,
  equalCustomMap,
  equalPercentMap,
  lineSplitsValid,
  parseSplitNumber,
  redistributeWithPinned,
  splitTotalEvenly,
} from '@/lib/bill-split-form'

const sum = (vals: Record<string, string>) =>
  Math.round(Object.values(vals).reduce((a, b) => a + parseFloat(b), 0) * 100) / 100

describe('equalPercentMap', () => {
  it('returns {} for no users', () => {
    expect(equalPercentMap([])).toEqual({})
  })

  it('splits 100% evenly and reconciles the remainder to the last user', () => {
    const map = equalPercentMap(['a', 'b', 'c'])
    expect(sum(map)).toBe(100)
    expect(map.c).toBe('33.34')
  })

  it('gives a single user 100%', () => {
    expect(equalPercentMap(['a'])).toEqual({ a: '100' })
  })
})

describe('equalCustomMap', () => {
  it('returns {} for no users or non-positive amount', () => {
    expect(equalCustomMap([], 100)).toEqual({})
    expect(equalCustomMap(['a'], 0)).toEqual({})
  })

  it('splits the amount evenly with remainder on the first user', () => {
    const map = equalCustomMap(['a', 'b', 'c'], 10)
    expect(map.a).toBe('3.34')
    expect(map.b).toBe('3.33')
    expect(sum(map)).toBe(10)
  })
})

describe('splitTotalEvenly', () => {
  it('returns [] for non-positive count', () => {
    expect(splitTotalEvenly(10, 0)).toEqual([])
  })

  it('sums exactly to the total with the remainder last', () => {
    const parts = splitTotalEvenly(10, 3)
    expect(parts).toEqual([3.33, 3.33, 3.34])
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10)
  })

  it('handles a single part as the whole total', () => {
    expect(splitTotalEvenly(10, 1)).toEqual([10])
  })
})

describe('parseSplitNumber', () => {
  it('treats undefined/empty as 0', () => {
    expect(parseSplitNumber(undefined)).toBe(0)
    expect(parseSplitNumber('')).toBe(0)
    expect(parseSplitNumber('   ')).toBe(0)
  })

  it('parses comma decimals', () => {
    expect(parseSplitNumber('12,5')).toBe(12.5)
  })

  it('returns 0 for non-numeric input', () => {
    expect(parseSplitNumber('abc')).toBe(0)
  })
})

describe('redistributeWithPinned', () => {
  it('keeps pinned values and splits the rest evenly', () => {
    const result = redistributeWithPinned(
      ['a', 'b', 'c'],
      { a: '40', b: '0', c: '0' },
      { a: true },
      100,
    )
    expect(result.a).toBe('40')
    expect(parseFloat(result.b) + parseFloat(result.c)).toBeCloseTo(60, 10)
  })

  it('returns unchanged when all users are pinned', () => {
    const values = { a: '50', b: '50' }
    const result = redistributeWithPinned(['a', 'b'], values, { a: true, b: true }, 100)
    expect(result).toEqual(values)
  })

  it('does not redistribute when pinned exceeds the target (negative remaining)', () => {
    const values = { a: '120', b: '5' }
    const result = redistributeWithPinned(['a', 'b'], values, { a: true }, 100)
    expect(result.b).toBe('5')
  })
})

describe('applyClearedSplitField', () => {
  it('gives the whole target to the sole remaining non-empty user', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b'],
      { a: '60', b: '40' },
      {},
      'a',
      'custom',
      100,
    )
    expect(values.a).toBe('')
    expect(values.b).toBe('100')
  })

  it('resets to an equal percentage map when nothing else has a value', () => {
    const { values, pinned } = applyClearedSplitField(
      ['a', 'b'],
      { a: '100', b: '' },
      { a: true },
      'a',
      'percentage',
      100,
    )
    expect(sum(values)).toBe(100)
    expect(pinned).toEqual({})
  })

  it('resets to an equal custom map (currency) when nothing else has a value', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b'],
      { a: '50', b: '' },
      {},
      'a',
      'custom',
      80,
    )
    expect(sum(values)).toBe(80)
  })

  it('leaves other values intact when 2+ remain', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b', 'c'],
      { a: '40', b: '30', c: '30' },
      {},
      'a',
      'custom',
      100,
    )
    expect(values.a).toBe('')
    expect(values.b).toBe('30')
    expect(values.c).toBe('30')
  })

  it('no-ops on a non-positive target', () => {
    const { values } = applyClearedSplitField(['a'], { a: '5' }, {}, 'a', 'custom', 0)
    expect(values.a).toBe('')
  })
})

describe('lineSplitsValid', () => {
  it('is valid with no selected users', () => {
    expect(lineSplitsValid('custom', 100, [], {})).toBe(true)
  })

  it('equal splits are always valid', () => {
    expect(lineSplitsValid('equal', 100, ['a', 'b'], {})).toBe(true)
  })

  it('percentage must sum near 100', () => {
    expect(lineSplitsValid('percentage', 100, ['a', 'b'], { a: '50', b: '50' })).toBe(true)
    expect(lineSplitsValid('percentage', 100, ['a', 'b'], { a: '50', b: '40' })).toBe(false)
  })

  it('custom must sum near the line amount (within epsilon)', () => {
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '40' })).toBe(true)
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '39.96' })).toBe(true)
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '30' })).toBe(false)
  })

  it('quantity requires positive integers', () => {
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '1', b: '2' })).toBe(true)
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '1.5', b: '2' })).toBe(false)
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '0', b: '2' })).toBe(false)
  })
})

describe('buildSplitPayload', () => {
  it('uses splitValue 1 for equal regardless of entered values', () => {
    const payload = buildSplitPayload(['a', 'b'], 'equal', { a: '99', b: '1' })
    expect(payload).toEqual([
      { userId: 'a', splitType: 'equal', splitValue: 1 },
      { userId: 'b', splitType: 'equal', splitValue: 1 },
    ])
  })

  it('parses entered values for non-equal types', () => {
    const payload = buildSplitPayload(['a', 'b'], 'custom', { a: '60', b: '40' })
    expect(payload).toEqual([
      { userId: 'a', splitType: 'custom', splitValue: 60 },
      { userId: 'b', splitType: 'custom', splitValue: 40 },
    ])
  })
})
