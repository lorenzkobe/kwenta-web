import { describe, expect, it } from 'vitest'
import {
  eventRowVersion,
  latestEventCreatedAt,
  planRealtimeBatch,
  sameInstant,
  type UserEventRow,
} from '@/sync/realtime-batch'

function ev(over: Partial<UserEventRow> & { id: string; created_at: string }): UserEventRow {
  return {
    user_id: 'U',
    event_type: 'settlement_changed',
    entity_type: 'settlements',
    entity_id: `entity-${over.id}`,
    op: 'INSERT',
    payload: { group_id: 'G' },
    ...over,
  }
}

const seenNone = () => false

describe('planRealtimeBatch', () => {
  it('returns a single fresh event and its timestamp', () => {
    const plan = planRealtimeBatch([ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' })], seenNone)
    expect(plan.fresh.map((e) => e.id)).toEqual(['a'])
    expect(plan.latestCreatedAt).toBe('2026-06-25T10:00:00.000Z')
  })

  it('keeps every fresh event in a burst and reports the latest timestamp', () => {
    // A 3-leg settle-up fanned out into 3 settlement events.
    const plan = planRealtimeBatch(
      [
        ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' }),
        ev({ id: 'c', created_at: '2026-06-25T10:00:02.000Z' }),
        ev({ id: 'b', created_at: '2026-06-25T10:00:01.000Z' }),
      ],
      seenNone,
    )
    expect(plan.fresh.map((e) => e.id)).toEqual(['a', 'c', 'b'])
    expect(plan.latestCreatedAt).toBe('2026-06-25T10:00:02.000Z')
  })

  it('excludes already-seen events from fresh but still advances the timestamp past them', () => {
    const plan = planRealtimeBatch(
      [
        ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' }),
        ev({ id: 'b', created_at: '2026-06-25T10:00:05.000Z' }),
      ],
      (id) => id === 'b',
    )
    expect(plan.fresh.map((e) => e.id)).toEqual(['a'])
    // Cursor must still pass the seen event so reconnect catch-up won't refetch it.
    expect(plan.latestCreatedAt).toBe('2026-06-25T10:00:05.000Z')
  })

  it('dedupes repeated ids within the same batch', () => {
    const plan = planRealtimeBatch(
      [
        ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' }),
        ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' }),
      ],
      seenNone,
    )
    expect(plan.fresh.map((e) => e.id)).toEqual(['a'])
  })

  it('treats a profile-link event like any other', () => {
    // It used to be flagged so the caller could clear the pull cursor and force a full pull.
    // Every pull is a full pull now, so the flag drove nothing but a metric that always read
    // false for the batch path — which always does a full pull.
    const plan = planRealtimeBatch(
      [
        ev({
          id: 'p',
          created_at: '2026-06-25T10:00:00.000Z',
          entity_type: 'profiles',
          payload: { linked_profile_id: 'remote-uuid' },
        }),
        ev({ id: 'a', created_at: '2026-06-25T10:00:01.000Z' }),
      ],
      seenNone,
    )
    expect(plan.fresh.map((e) => e.id)).toEqual(['p', 'a'])
  })

  it('returns no fresh events and a null timestamp for an empty batch', () => {
    const plan = planRealtimeBatch([], seenNone)
    expect(plan.fresh).toEqual([])
    expect(plan.latestCreatedAt).toBeNull()
  })
})

describe('latestEventCreatedAt', () => {
  // The last-seen cursor is written from this and NEVER from the device clock. A fast clock that
  // stamps its own time writes a cursor into the future; the next catch-up's
  // `.gt('created_at', cursor)` then filters out every event the server creates until real time
  // catches up, and the cursor only moves forward — so those events never arrive.
  it('returns the newest created_at regardless of arrival order', () => {
    expect(
      latestEventCreatedAt([
        ev({ id: 'a', created_at: '2026-06-25T10:00:00.000Z' }),
        ev({ id: 'c', created_at: '2026-06-25T10:00:02.000Z' }),
        ev({ id: 'b', created_at: '2026-06-25T10:00:01.000Z' }),
      ]),
    ).toBe('2026-06-25T10:00:02.000Z')
  })

  it('returns null for an empty set so the caller leaves the cursor alone', () => {
    expect(latestEventCreatedAt([])).toBeNull()
  })

  it('never invents a timestamp of its own', () => {
    // Every value it can return must have come from an event row.
    const events = [ev({ id: 'a', created_at: '2020-01-01T00:00:00.000Z' })]
    expect(latestEventCreatedAt(events)).toBe('2020-01-01T00:00:00.000Z')
  })
})

/**
 * 072: an event carries the version of the row that fired it. The client skips the reconcile when
 * it already mirrors EXACTLY that version, so both helpers below must fail closed: anything they
 * cannot read with certainty means "not mirrored", which falls back to today's reconcile.
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

describe('eventRowVersion', () => {
  const base = {
    id: 'e',
    user_id: 'U',
    event_type: 'bill_changed',
    entity_type: 'bills',
    entity_id: 'B1',
    op: 'UPDATE',
    created_at: '2026-09-24T01:00:00Z',
  }
  const row = { table: 'item_splits', id: 'S1', updated_at: '2026-09-24T01:02:03.123456+00:00' }

  it('reads the row that fired the event, keyed on row.table rather than entity_type', () => {
    expect(eventRowVersion({ ...base, payload: { bill_id: 'B1', row } })).toEqual({
      table: 'item_splits',
      id: 'S1',
      updatedAt: '2026-09-24T01:02:03.123456+00:00',
    })
  })

  it('accepts every mirrored table and nothing else', () => {
    for (const table of ['bills', 'bill_items', 'item_splits', 'settlements', 'groups', 'group_members']) {
      expect(eventRowVersion({ ...base, payload: { row: { ...row, table } } })?.table).toBe(table)
    }
    for (const table of ['profiles', 'activity_log', 'pending_mutations', '__proto__', '']) {
      expect(eventRowVersion({ ...base, payload: { row: { ...row, table } } })).toBeNull()
    }
  })

  it('is null for a pre-072 payload, a deleted row, a DELETE op, or anything malformed', () => {
    expect(eventRowVersion({ ...base, payload: { bill_id: 'B1' } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: { row: null } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: null })).toBeNull()
    expect(eventRowVersion({ ...base, payload: 'row' })).toBeNull()
    expect(eventRowVersion({ ...base, op: 'DELETE', payload: { row } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: { row: { ...row, id: 7 } } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: { row: { ...row, id: '' } } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: { row: { ...row, updated_at: null } } })).toBeNull()
    expect(eventRowVersion({ ...base, payload: { row: [row] } })).toBeNull()
  })
})
