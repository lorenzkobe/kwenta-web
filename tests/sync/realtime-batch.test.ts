import { describe, expect, it } from 'vitest'
import {
  eventRowVersion,
  latestEventCreatedAt,
  planRealtimeBatch,
  sameInstant,
  type UserEventRow,
} from '@/sync/realtime-batch'
import * as batchModule from '@/sync/realtime-batch'

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

/**
 * sync-realign: a realtime burst is grouped by ENTITY, and each entity costs one targeted
 * reconcile. One remote bill edit fires one event per row (the bill, each item, each split — all
 * filed under the bill, 072), which used to collapse into a full-bundle round trip. Entity kinds
 * come from `kwenta_reconcile_user_event` (028): bills, settlements, profiles, profile_peer_links,
 * and groups (a `group_members` event names its group in `payload.group_id`, 012/072). Anything a
 * targeted reconcile cannot serve — a profile-LINK payload, a DELETE, an unknown entity type —
 * marks the batch for one full sync.
 *
 * Shape tolerated: `{ groups | entities: [{ entityType|entity_type, entityId|entity_id, events }],
 * fullSync | needsFullSync | requiresFullSync }`.
 */
describe('groupByEntity', () => {
  type Grouped = { keys: string[]; eventsByKey: Record<string, string[]>; fullSync: boolean }

  function grouped(events: UserEventRow[]): Grouped {
    const fn = (batchModule as unknown as Record<string, unknown>).groupByEntity
    if (typeof fn !== 'function') throw new Error('groupByEntity is not exported from realtime-batch')
    const r = (fn as (e: UserEventRow[]) => Record<string, unknown>)(events)
    const list = (r.groups ?? r.entities) as Array<Record<string, unknown>>
    const eventsByKey: Record<string, string[]> = {}
    const keys = list.map((g) => {
      const key = `${String(g.entityType ?? g.entity_type)}:${String(g.entityId ?? g.entity_id)}`
      eventsByKey[key] = ((g.events as UserEventRow[]) ?? []).map((e) => e.id)
      return key
    })
    return { keys: [...keys].sort(), eventsByKey, fullSync: Boolean(r.fullSync ?? r.needsFullSync ?? r.requiresFullSync) }
  }

  function e(id: string, over: Partial<UserEventRow> = {}): UserEventRow {
    return {
      id,
      user_id: 'ME',
      event_type: 'bill_changed',
      entity_type: 'bills',
      entity_id: 'B1',
      op: 'UPDATE',
      payload: {},
      created_at: `2026-09-25T10:00:0${id.length % 10}.000Z`,
      ...over,
    }
  }

  const rowOf = (table: string, id: string, billId = 'B1') => ({
    bill_id: billId,
    group_id: null,
    row: { table, id, updated_at: '2026-09-25T10:00:00+00:00' },
  })

  it('C5: a bill, its item and its splits are ONE entity (items and splits are filed under the bill)', () => {
    const g = grouped([
      e('b', { payload: rowOf('bills', 'B1') }),
      e('i', { payload: rowOf('bill_items', 'I1') }),
      e('s1', { payload: rowOf('item_splits', 'S1') }),
      e('s2', { payload: rowOf('item_splits', 'S2') }),
    ])
    expect(g.keys).toEqual(['bills:B1'])
    expect(g.eventsByKey['bills:B1']).toEqual(['b', 'i', 's1', 's2'])
    expect(g.fullSync).toBe(false)
  })

  it('C6: two bills are two entities', () => {
    const g = grouped([
      e('a1', { entity_id: 'B1', payload: rowOf('bills', 'B1', 'B1') }),
      e('b1', { entity_id: 'B2', payload: rowOf('bills', 'B2', 'B2') }),
      e('a2', { entity_id: 'B1', payload: rowOf('item_splits', 'S1', 'B1') }),
    ])
    expect(g.keys).toEqual(['bills:B1', 'bills:B2'])
    expect(g.fullSync).toBe(false)
  })

  it('C6: a membership change and its group refresh are one group entity, keyed by group_id', () => {
    const g = grouped([
      e('m', { event_type: 'group_member_changed', entity_type: 'group_members', entity_id: 'GM1', payload: { group_id: 'G1' } }),
      e('g', { event_type: 'group_changed', entity_type: 'groups', entity_id: 'G1', payload: { group_id: 'G1' } }),
    ])
    expect(g.keys).toEqual(['groups:G1'])
    expect(g.fullSync).toBe(false)
  })

  it('C6: settlements, profiles and peer links are each their own entity', () => {
    const g = grouped([
      e('st', { entity_type: 'settlements', entity_id: 'ST1', payload: {} }),
      e('p', { entity_type: 'profiles', entity_id: 'P1', payload: { row: { table: 'profiles', id: 'P1', updated_at: '2026-09-25T10:00:00+00:00' } } }),
      e('pl', { entity_type: 'profile_peer_links', entity_id: 'L1', payload: {} }),
    ])
    expect(g.keys).toEqual(['profile_peer_links:L1', 'profiles:P1', 'settlements:ST1'])
    expect(g.fullSync).toBe(false)
  })

  it('C6: a profile LINK payload marks the batch for a full sync', () => {
    const g = grouped([
      e('b'),
      e('link', { entity_type: 'profiles', entity_id: 'P1', payload: { linked_profile_id: 'ACC1' } }),
    ])
    expect(g.fullSync).toBe(true)
  })

  it('C6: a DELETE marks the batch for a full sync', () => {
    expect(grouped([e('b'), e('d', { op: 'DELETE' })]).fullSync).toBe(true)
  })

  it('C6: an unknown entity type marks the batch for a full sync', () => {
    expect(grouped([e('w', { entity_type: 'widgets', entity_id: 'W1' })]).fullSync).toBe(true)
  })

  it('C6: a group_members event with no group_id cannot be located, so it marks a full sync', () => {
    expect(grouped([e('m', { entity_type: 'group_members', entity_id: 'GM1', payload: {} })]).fullSync).toBe(true)
  })

  it('an empty batch has no entities and needs no sync', () => {
    const g = grouped([])
    expect(g.keys).toEqual([])
    expect(g.fullSync).toBe(false)
  })
})
