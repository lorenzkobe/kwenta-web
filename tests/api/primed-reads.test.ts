import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import { fetchBalancesOverview, fetchGroupDetail } from '@/api/balances'
import { readCache } from '@/api/cache'
import {
  clearPrimedReads,
  markReadMounted,
  markReadUnmounted,
  mountedReadSpecs,
  primeReads,
} from '@/api/primed-reads'

/**
 * A write returns the recomputed payloads for the screens that were on display, and they are
 * served to the re-read that follows WITHOUT a request. That is the whole point: the balance a
 * mutation moves is computed in SQL and cannot be derived on the client, so before this the only
 * way to show it was a second round trip.
 *
 * What must hold, and what each of these pins:
 *   - a primed payload runs through the endpoint's normal mapper (one implementation of the shape
 *     rules, never a second copy that can drift);
 *   - it is fresh server data, not a cache hit, so no "saved copy" notice appears;
 *   - it is consumed ONCE and expires, so it can never answer a later refresh.
 */

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

const RAW_OVERVIEW = {
  personalReceive: { PHP: '25.5' },
  personalPay: {},
  combinedReceive: { PHP: '25.5' },
  combinedPay: {},
  groupReceive: {},
  groupPay: {},
}

describe('primed reads', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    clearPrimedReads()
    setOnline(true)
  })
  afterEach(() => {
    clearPrimedReads()
    vi.restoreAllMocks()
    setOnline(true)
  })

  it('serves a primed payload without calling the RPC', async () => {
    primeReads({ overview: RAW_OVERVIEW })

    const result = await fetchBalancesOverview('u1')

    expect(rpc).not.toHaveBeenCalled()
    expect(result.data.combinedReceive).toEqual({ PHP: 25.5 })
  })

  it('runs the primed payload through the endpoint mapper, not around it', async () => {
    // PostgREST serialises `numeric` as a STRING. If the priming path skipped the mapper, "25.5"
    // would reach the UI as a string and `"25.5" + 10` is "25.510" — the money bug that no type
    // annotation catches, because the value is typed `number` the whole way down.
    primeReads({ overview: RAW_OVERVIEW })

    const result = await fetchBalancesOverview('u1')

    expect(typeof result.data.combinedReceive.PHP).toBe('number')
  })

  it('reports primed data as fresh, not as a saved copy', async () => {
    // It came from the server moments ago, inside the write's own transaction — strictly newer
    // than anything a fetch started now could return. Flagging it `fromCache` would put a
    // "showing saved data" notice on the most current answer the app has ever had.
    primeReads({ overview: RAW_OVERVIEW })

    const result = await fetchBalancesOverview('u1')

    expect(result.fromCache).toBe(false)
  })

  it('writes the primed payload to the offline cache', async () => {
    primeReads({ overview: RAW_OVERVIEW })
    await fetchBalancesOverview('u1')

    expect(readCache('overview', 'u1')?.data).toMatchObject({ combinedReceive: { PHP: 25.5 } })
  })

  it('is consumed once — a second read goes to the network', async () => {
    // The prime exists to satisfy the ONE re-read that bumpDataVersion triggers. Serving it again
    // would show a later manual refresh a stale answer under a fresh timestamp.
    primeReads({ overview: RAW_OVERVIEW })
    await fetchBalancesOverview('u1')
    expect(rpc).not.toHaveBeenCalled()

    rpc.mockResolvedValue({ data: { ...RAW_OVERVIEW, combinedReceive: { PHP: '99' } }, error: null })
    const second = await fetchBalancesOverview('u1')

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(second.data.combinedReceive).toEqual({ PHP: 99 })
  })

  it('a new write discards anything the previous one left behind', async () => {
    // A leftover was already superseded by this write; serving it afterwards would be serving a
    // value the server has since changed.
    primeReads({ overview: RAW_OVERVIEW, 'group:g1': { group: { id: 'g1' } } })
    primeReads({ overview: RAW_OVERVIEW })

    rpc.mockResolvedValue({ data: null, error: null })
    const group = await fetchGroupDetail('u1', 'g1')

    expect(rpc).toHaveBeenCalledWith('kwenta_group_detail', { p_group_id: 'g1' })
    expect(group.data).toBeNull()
  })

  it('never primes a key the server declined to answer', async () => {
    // `kwenta_read` returns JSON null for a screen the caller may no longer see. Priming that
    // would render an empty screen as though it were the truth.
    primeReads({ 'group:g1': null })

    rpc.mockResolvedValue({ data: { group: { id: 'g1', name: 'Trip' } }, error: null })
    const result = await fetchGroupDetail('u1', 'g1')

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result.data?.group.name).toBe('Trip')
  })

  it('falls back to the network when the primed payload has an unexpected shape', async () => {
    // A mapper that throws must not break the screen — the endpoint is still fetchable.
    primeReads({ contacts: { not: 'an array' } })
    const { fetchContactsWithBalances } = await import('@/api/balances')

    rpc.mockResolvedValue({ data: [], error: null })
    const result = await fetchContactsWithBalances('u1')

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result.data).toEqual([])
  })
})

describe('mounted read registry', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    clearPrimedReads()
    setOnline(true)
  })
  afterEach(() => clearPrimedReads())

  it('reports the spec for a mounted endpoint that has been fetched', async () => {
    rpc.mockResolvedValue({ data: RAW_OVERVIEW, error: null })
    await fetchBalancesOverview('u1')
    markReadMounted('overview')

    expect(mountedReadSpecs()).toEqual([{ key: 'overview', fn: 'kwenta_balances_overview' }])
  })

  it('reports nothing for an endpoint that is mounted but never fetched', async () => {
    // Without a fetch there is no RPC spec to send, and guessing one would mean a second
    // key → RPC table to keep in step with the SQL.
    markReadMounted('overview')
    expect(mountedReadSpecs()).toEqual([])
  })

  it('drops an endpoint once it unmounts', async () => {
    // A key left behind by an unmounted screen would make every later write pay to recompute a
    // payload nobody is looking at.
    rpc.mockResolvedValue({ data: RAW_OVERVIEW, error: null })
    await fetchBalancesOverview('u1')
    markReadMounted('overview')
    markReadUnmounted('overview')

    expect(mountedReadSpecs()).toEqual([])
  })

  it('keeps an endpoint two components share until the last one unmounts', async () => {
    rpc.mockResolvedValue({ data: RAW_OVERVIEW, error: null })
    await fetchBalancesOverview('u1')
    markReadMounted('overview')
    markReadMounted('overview')
    markReadUnmounted('overview')

    expect(mountedReadSpecs()).toHaveLength(1)

    markReadUnmounted('overview')
    expect(mountedReadSpecs()).toEqual([])
  })

  it('carries the id for a per-entity endpoint', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await fetchGroupDetail('u1', 'g1')
    markReadMounted('group:g1')

    expect(mountedReadSpecs()).toContainEqual({
      key: 'group:g1',
      fn: 'kwenta_group_detail',
      argName: 'p_group_id',
      id: 'g1',
    })
  })

  it('excludes an endpoint kwenta_read cannot recompute', async () => {
    // `kwenta_group_member_breakdown` takes two ids, is outside the server whitelist, and backs
    // the pre-write guards — it must always be asked live.
    const { fetchGroupMemberBreakdown } = await import('@/api/balances')
    rpc.mockResolvedValue({
      data: { memberUserId: 'm1', displayName: 'M', currency: 'PHP', pays: [], receives: [] },
      error: null,
    })
    await fetchGroupMemberBreakdown('u1', 'g1', 'm1')
    markReadMounted('group-breakdown:g1:m1')

    expect(mountedReadSpecs()).toEqual([])
  })
})

describe('spec registry bounds', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    clearPrimedReads()
    setOnline(true)
  })
  afterEach(() => clearPrimedReads())

  it('does not grow without bound as the user opens rows', async () => {
    // Per-entity keys mint a new spec for every bill/group/person opened, so an unbounded map
    // would grow for the life of the tab.
    rpc.mockResolvedValue({ data: null, error: null })
    for (let i = 0; i < 200; i++) await fetchGroupDetail('u1', `g${i}`)

    markReadMounted('group:g199')
    expect(mountedReadSpecs()).toHaveLength(1)

    // An evicted key simply is not offered to the next write; it fetches normally.
    markReadMounted('group:g0')
    expect(mountedReadSpecs().map((s) => s.key)).toEqual(['group:g199'])
  })

  it('never evicts an endpoint that is on screen', async () => {
    // The mounted set is the only thing a write asks for; evicting it would silently cost a round
    // trip after every save on a long-lived screen.
    rpc.mockResolvedValue({ data: null, error: null })
    await fetchGroupDetail('u1', 'pinned')
    markReadMounted('group:pinned')

    for (let i = 0; i < 200; i++) await fetchGroupDetail('u1', `g${i}`)

    expect(mountedReadSpecs().map((s) => s.key)).toEqual(['group:pinned'])
  })
})
