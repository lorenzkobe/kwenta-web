import { describe, expect, it } from 'vitest'
import { planRealtimeBatch, type UserEventRow } from '@/sync/realtime-batch'

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
    expect(plan.hasProfileLink).toBe(false)
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

  it('flags a profile-link event so the caller can force a full pull', () => {
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
    expect(plan.hasProfileLink).toBe(true)
  })

  it('returns no fresh events and a null timestamp for an empty batch', () => {
    const plan = planRealtimeBatch([], seenNone)
    expect(plan.fresh).toEqual([])
    expect(plan.latestCreatedAt).toBeNull()
    expect(plan.hasProfileLink).toBe(false)
  })
})
