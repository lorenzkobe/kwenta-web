import { describe, expect, it } from 'vitest'
import { compareInstants, sameInstant } from '@/lib/instant'

/**
 * 072: an event carries the version of the row that fired it. The client skips the reconcile when
 * it already mirrors EXACTLY that version, so `sameInstant` must fail closed: anything it cannot
 * read with certainty means "not mirrored", which falls back to today's reconcile.
 */
describe('sameInstant', () => {
  it('matches the same instant across the formats Postgres and JS produce', () => {
    expect(sameInstant('2026-09-24T01:02:03.123456+00:00', '2026-09-24T01:02:03.123456Z')).toBe(true)
    expect(sameInstant('2026-09-24T01:02:03.123+00:00', '2026-09-24T01:02:03.123Z')).toBe(true)
    expect(sameInstant('2026-09-24T01:02:03.120+00:00', '2026-09-24T01:02:03.12Z')).toBe(true)
    expect(sameInstant('2026-09-24T09:02:03.5+08:00', '2026-09-24T01:02:03.500Z')).toBe(true)
    expect(sameInstant('2026-09-24T01:02:03+00:00', '2026-09-24T01:02:03.000Z')).toBe(true)
  })

  it('tells apart two versions one microsecond apart (Date.parse would not)', () => {
    expect(sameInstant('2026-09-24T01:02:03.123456+00:00', '2026-09-24T01:02:03.123457+00:00')).toBe(false)
    expect(sameInstant('2026-09-24T01:02:03.123+00:00', '2026-09-24T01:02:03.123001+00:00')).toBe(false)
  })

  it('is false for anything unparseable or missing', () => {
    expect(sameInstant('not a date', 'not a date')).toBe(false)
    expect(sameInstant('', '')).toBe(false)
    expect(sameInstant(undefined as unknown as string, '2026-09-24T01:02:03Z')).toBe(false)
  })
})

describe('compareInstants', () => {
  it('orders by instant across fraction lengths and offsets', () => {
    expect(compareInstants('2026-09-24T01:02:03.5Z', '2026-09-24T01:02:03.500000Z')).toBe(0)
    expect(compareInstants('2026-09-24T01:02:03.5Z', '2026-09-24T01:02:03.51Z')).toBeLessThan(0)
    expect(compareInstants('2026-09-24T09:02:03+08:00', '2026-09-24T01:02:04Z')).toBeLessThan(0)
    expect(compareInstants('2026-09-24T01:02:04Z', '2026-09-24T09:02:03+08:00')).toBeGreaterThan(0)
    expect(compareInstants('2026-09-25T00:00:00Z', '2026-09-24T23:59:59.999999Z')).toBeGreaterThan(0)
  })

  it('puts a whole-second timestamp before the same second with sub-millisecond digits (string compare does not)', () => {
    expect(compareInstants('2026-01-01T10:00:00+00:00', '2026-01-01T10:00:00.0001+00:00')).toBeLessThan(0)
    expect(compareInstants('2026-01-01T10:00:00.0001+00:00', '2026-01-01T10:00:00+00:00')).toBeGreaterThan(0)
  })

  it('tells apart two timestamps one microsecond apart inside one millisecond', () => {
    expect(compareInstants('2026-09-24T01:02:03.123456+00:00', '2026-09-24T01:02:03.123457+00:00')).toBeLessThan(0)
    expect(compareInstants('2026-09-24T01:02:03.123457Z', '2026-09-24T01:02:03.123456Z')).toBeGreaterThan(0)
  })

  it('is consistent with sameInstant', () => {
    expect(compareInstants('2026-09-24T09:02:03.5+08:00', '2026-09-24T01:02:03.500Z')).toBe(0)
  })

  it('sorts unparseable values after parseable ones and equal to each other', () => {
    expect(compareInstants('not a date', '2026-09-24T01:02:03Z')).toBeGreaterThan(0)
    expect(compareInstants('2026-09-24T01:02:03Z', '')).toBeLessThan(0)
    expect(compareInstants('not a date', 'also not')).toBe(0)
    expect(compareInstants(undefined as unknown as string, '2026-09-24T01:02:03Z')).toBeGreaterThan(0)
  })
})
