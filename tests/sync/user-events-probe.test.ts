import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The tab-focus probe: "has anything happened to me since the cursor?" as ONE indexed
 * `LIMIT 1` read of the caller's own `kwenta_user_events`, instead of downloading the complete
 * bundle on every focus. Any doubt — an error, an unexpected shape — answers yes, which falls back
 * to the full sync the app always did.
 */
const q = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  answer: { data: [] as unknown[] | null, error: null as { message: string } | null },
  throws: false,
}))

vi.mock('@/lib/supabase', () => {
  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'order']) {
      b[m] = (...args: unknown[]) => {
        q.calls.push([m, ...args])
        return b
      }
    }
    b.limit = async (...args: unknown[]) => {
      q.calls.push(['limit', ...args])
      if (q.throws) throw new Error('offline')
      return q.answer
    }
    return b
  }
  return {
    supabase: {
      from: (table: string) => {
        q.calls.push(['from', table])
        return builder()
      },
    },
  }
})

import { newestUserEventSince } from '@/sync/sync-service'

beforeEach(() => {
  q.calls = []
  q.answer = { data: [], error: null }
  q.throws = false
})

describe('newestUserEventSince', () => {
  it('asks for one of the caller\'s own events newer than the cursor, and nothing else', async () => {
    await newestUserEventSince('ME', '2026-09-24T01:00:00+00:00')
    expect(q.calls).toEqual([
      ['from', 'kwenta_user_events'],
      ['select', 'created_at'],
      ['eq', 'user_id', 'ME'],
      ['gt', 'created_at', '2026-09-24T01:00:00+00:00'],
      ['order', 'created_at', { ascending: false }],
      ['limit', 1],
    ])
  })

  it('is not newer when there is nothing newer', async () => {
    await expect(newestUserEventSince('ME', '2026-09-24T01:00:00+00:00')).resolves.toEqual({ newer: false, newest: null })
  })

  it('reports the newest newer event\'s server timestamp', async () => {
    q.answer = { data: [{ created_at: '2026-09-24T02:00:00+00:00' }], error: null }
    await expect(newestUserEventSince('ME', '2026-09-24T01:00:00+00:00')).resolves.toEqual({
      newer: true,
      newest: '2026-09-24T02:00:00+00:00',
    })
  })

  it('fails open: an error, a throw or an unexpected shape all answer newer, with no timestamp', async () => {
    const unknown = { newer: true, newest: null }
    q.answer = { data: null, error: { message: 'boom' } }
    await expect(newestUserEventSince('ME', 'c')).resolves.toEqual(unknown)
    q.answer = { data: null, error: null }
    await expect(newestUserEventSince('ME', 'c')).resolves.toEqual(unknown)
    q.answer = { data: [{ created_at: 7 }], error: null }
    await expect(newestUserEventSince('ME', 'c')).resolves.toEqual(unknown)
    q.throws = true
    await expect(newestUserEventSince('ME', 'c')).resolves.toEqual(unknown)
  })
})
