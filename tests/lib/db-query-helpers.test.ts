import { describe, expect, it } from 'vitest'
import { activeOnly, mapById, uniqueStrings } from '@/lib/db-query-helpers'

describe('activeOnly', () => {
  it('filters out soft-deleted rows', () => {
    const rows = [
      { id: 'a', is_deleted: false },
      { id: 'b', is_deleted: true },
      { id: 'c', is_deleted: false },
    ]
    expect(activeOnly(rows).map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('returns an empty array when all are deleted', () => {
    expect(activeOnly([{ id: 'a', is_deleted: true }])).toEqual([])
  })
})

describe('mapById', () => {
  it('keys rows by id', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]
    const map = mapById(rows)
    expect(map.get('a')).toEqual({ id: 'a', n: 1 })
    expect(map.size).toBe(2)
  })

  it('keeps the last row when ids collide', () => {
    const map = mapById([
      { id: 'a', n: 1 },
      { id: 'a', n: 2 },
    ])
    expect(map.get('a')?.n).toBe(2)
  })
})

describe('uniqueStrings', () => {
  it('dedupes and drops falsy values', () => {
    expect(uniqueStrings(['a', 'a', '', null, undefined, 'b'])).toEqual(['a', 'b'])
  })

  it('returns an empty array for no values', () => {
    expect(uniqueStrings([])).toEqual([])
  })

  it('preserves first-seen order', () => {
    expect(uniqueStrings(['c', 'a', 'c', 'b'])).toEqual(['c', 'a', 'b'])
  })
})
