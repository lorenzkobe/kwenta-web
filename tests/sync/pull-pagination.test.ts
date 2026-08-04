import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { fetchAllPages, pullChanges, PULL_PAGE_SIZE } from '@/sync/sync-service'
import { resetDb } from '../helpers/db'

/**
 * PostgREST caps every response at its configured max-rows (1000 on Supabase) and reports NO error
 * when it truncates. `pullChanges` is the realtime-recovery / RPC-missing fallback, and with the
 * delta cursor gone it asks for the caller's whole history on every call — so any table past that
 * cap came back silently short while the pull still reported success and stamped the marker.
 *
 * The loop is unit-tested directly and the wiring is covered by one smaller integration case.
 * Proving the loop end-to-end needs thousands of IndexedDB writes, which is slow enough that the
 * test starts failing on timing rather than on behaviour.
 */

describe('fetchAllPages', () => {
  /** Records the ranges requested and serves them from `rows`, truncating like PostgREST. */
  function fakeQuery(rows: unknown[], calls: [number, number][] = []) {
    return {
      calls,
      build: () => ({
        range: async (from: number, to: number) => {
          calls.push([from, to])
          const end = Math.min(to, from + PULL_PAGE_SIZE - 1)
          return { data: rows.slice(from, end + 1), error: null }
        },
      }),
    }
  }

  const rows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: i + offset }))

  it('makes a single request when the first page is short', async () => {
    const q = fakeQuery(rows(3))
    expect(await fetchAllPages(q.build)).toHaveLength(3)
    expect(q.calls).toEqual([[0, PULL_PAGE_SIZE - 1]])
  })

  it('keeps paging while pages come back full', async () => {
    const q = fakeQuery(rows(PULL_PAGE_SIZE * 2 + 7))
    const out = await fetchAllPages(q.build)

    expect(out).toHaveLength(PULL_PAGE_SIZE * 2 + 7)
    expect(q.calls).toEqual([
      [0, PULL_PAGE_SIZE - 1],
      [PULL_PAGE_SIZE, PULL_PAGE_SIZE * 2 - 1],
      [PULL_PAGE_SIZE * 2, PULL_PAGE_SIZE * 3 - 1],
    ])
  })

  it('makes one extra request when the total is an exact multiple of the page size', async () => {
    // The boundary case: a full final page is indistinguishable from "there is more", so the loop
    // must ask once more and get nothing rather than stopping and silently dropping the tail.
    const q = fakeQuery(rows(PULL_PAGE_SIZE))
    expect(await fetchAllPages(q.build)).toHaveLength(PULL_PAGE_SIZE)
    expect(q.calls).toHaveLength(2)
  })

  it('returns nothing for an empty table without looping', async () => {
    const q = fakeQuery([])
    expect(await fetchAllPages(q.build)).toEqual([])
    expect(q.calls).toHaveLength(1)
  })

  it('propagates a query error instead of returning a short result', async () => {
    // Silently returning the pages fetched so far would look exactly like a small table.
    await expect(
      fetchAllPages(() => ({
        range: async () => ({ data: null, error: { message: 'boom' } }),
      })),
    ).rejects.toBeTruthy()
  })

  it('builds a fresh query per page', async () => {
    // A PostgREST builder is a one-shot thenable; reusing one instance across pages re-awaits a
    // settled request. The helper must call the factory each time.
    let built = 0
    await fetchAllPages(() => {
      built++
      return { range: async () => ({ data: [], error: null }) }
    })
    expect(built).toBe(1)

    built = 0
    const page = Array.from({ length: PULL_PAGE_SIZE }, (_, i) => ({ id: i }))
    let served = 0
    await fetchAllPages(() => {
      built++
      return { range: async () => ({ data: served++ === 0 ? page : [], error: null }) }
    })
    expect(built).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------
// Wiring: the fallback pull actually uses the paging helper.
// ---------------------------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>[]>,
  rangeCalls: [] as { source: string; from: number }[],
}))

vi.mock('@/lib/supabase', () => {
  function builder(source: string) {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'gt', 'eq', 'in', 'is', 'or', 'order']) b[m] = () => b
    b.range = async (from: number, to: number) => {
      state.rangeCalls.push({ source, from })
      const all = state.rows[source] ?? []
      const end = Math.min(to, from + 1000 - 1) // mimic PostgREST max-rows
      return { data: all.slice(from, end + 1), error: null }
    }
    return b
  }
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (fn: string) => builder(fn),
      auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
    },
  }
})

function profileRow(i: number) {
  return {
    id: `p-${String(i).padStart(5, '0')}`,
    email: `u${i}@example.com`,
    display_name: `User ${i}`,
    avatar_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    synced_at: null,
    is_deleted: false,
    device_id: '',
    is_local: true,
    linked_profile_id: null,
    owner_id: 'me',
  }
}

describe('pullChanges paging', () => {
  beforeEach(async () => {
    await resetDb()
    localStorage.clear()
    state.rows = { relevant_bill_ids_for_user: [], bills_for_sync: [] }
    state.rangeCalls = []
  })

  // Writing >1000 rows through fake-indexeddb is slow; the raised timeout is I/O volume, not a
  // hang. The paging loop itself is covered by the fast unit tests above.
  it(
    'fetches past the max-rows cap and only then marks the refresh complete',
    { timeout: 30_000 },
    async () => {
      state.rows['profiles'] = Array.from({ length: 1200 }, (_, i) => profileRow(i))

      const result = await pullChanges('me')

      expect(result.errors).toEqual([])
      // 1200, not a silently truncated 1000.
      expect(await db.profiles.count()).toBe(1200)
      // Two queries (own row + owned locals), each paged 0 then 1000.
      expect(state.rangeCalls.filter((c) => c.source === 'profiles').map((c) => c.from)).toEqual([
        0, 1000, 0, 1000,
      ])
      expect(localStorage.getItem('kwenta_last_refresh')).not.toBeNull()
    },
  )
})
