import { describe, expect, it } from 'vitest'
import { latestEventCreatedAt, planRealtimeBatch, type UserEventRow } from '@/sync/realtime-batch'

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
