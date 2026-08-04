import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import {
  ApiError,
  fetchBalancesOverview,
  fetchBillDetail,
  fetchContactsWithBalances,
  fetchGroupDetail,
  fetchGroupMemberBreakdown,
  fetchGroupsWithBalances,
  fetchPersonalBills,
  fetchPersonStatement,
  fetchPersonSummary,
  fetchRecentBills,
  loadGroupMemberBreakdownFresh,
  searchEverything,
  ServerDeclinedError,
  totalsToMap,
} from '@/api/balances'
import { readCache, writeCache } from '@/api/cache'

/** happy-dom reports navigator.onLine as true; these flip it for the offline paths. */
function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

describe('balance API wrappers', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    setOnline(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setOnline(true)
  })

  describe('numeric coercion', () => {
    // PostgREST serialises Postgres `numeric` as a STRING. Passing that through unconverted
    // yields "50" where a number is expected, and `"50" + 30` is "5030" — a money bug that no
    // type annotation catches, because the value is typed `number` all the way down.
    it('coerces string numerics into numbers', async () => {
      rpc.mockResolvedValue({
        data: {
          personalReceive: { PHP: '50.25' },
          personalPay: {},
          combinedReceive: { PHP: 20 },
          combinedPay: {},
          groupReceive: { PHP: '30' },
          groupPay: { USD: '40.5' },
        },
        error: null,
      })

      const { data } = await fetchBalancesOverview('u1')
      expect(data.personalReceive.PHP).toBe(50.25)
      expect(data.groupReceive.PHP).toBe(30)
      expect(data.groupPay.USD).toBe(40.5)
      expect(typeof data.personalReceive.PHP).toBe('number')
    })

    it('drops values that are not finite numbers rather than rendering NaN', async () => {
      rpc.mockResolvedValue({
        data: {
          personalReceive: { PHP: 'not-a-number', USD: null, EUR: 12 },
          personalPay: {},
          combinedReceive: {},
          combinedPay: {},
          groupReceive: {},
          groupPay: {},
        },
        error: null,
      })

      const { data } = await fetchBalancesOverview('u1')
      expect(data.personalReceive).toEqual({ EUR: 12 })
    })

    it('survives a missing bucket entirely (an older server without 058)', async () => {
      rpc.mockResolvedValue({
        data: { personalReceive: { PHP: 10 }, personalPay: {}, combinedReceive: {}, combinedPay: {} },
        error: null,
      })

      const { data } = await fetchBalancesOverview('u1')
      expect(data.groupReceive).toEqual({})
      expect(data.groupPay).toEqual({})
      expect(data.personalReceive.PHP).toBe(10)
    })
  })

  describe('fetchRecentBills', () => {
    it('maps rows and normalises a null group name to undefined', async () => {
      rpc.mockResolvedValue({
        data: [
          { id: 'b1', title: 'Dinner', amount: '30.5', currency: 'PHP', createdAt: 'T1', groupName: null },
          { id: 'b2', title: 'Taxi', amount: 12, currency: 'PHP', createdAt: 'T2', groupName: 'Squad' },
        ],
        error: null,
      })

      const { data } = await fetchRecentBills('u1', 5)
      expect(rpc).toHaveBeenCalledWith('kwenta_recent_bills', { p_limit: 5 })
      expect(data[0]).toEqual({
        id: 'b1',
        title: 'Dinner',
        amount: 30.5,
        currency: 'PHP',
        createdAt: 'T1',
        groupName: undefined,
      })
      expect(data[1].groupName).toBe('Squad')
    })

    it('rejects a non-array response instead of rendering a broken list', async () => {
      rpc.mockResolvedValue({ data: { oops: true }, error: null })
      await expect(fetchRecentBills('u1')).rejects.toBeInstanceOf(ApiError)
    })
  })

  describe('fetchContactsWithBalances', () => {
    it('defaults a missing display name to Unknown and blanks an empty subtitle', async () => {
      rpc.mockResolvedValue({
        data: [{ peerId: 'p1', net: { PHP: '5' } }, { peerId: 'p2', displayName: 'Bo', subtitle: '' }],
        error: null,
      })

      const { data } = await fetchContactsWithBalances('u1')
      expect(data[0].displayName).toBe('Unknown')
      expect(data[0].net.PHP).toBe(5)
      expect(data[1].subtitle).toBeUndefined()
    })
  })

  describe('fetchPersonSummary', () => {
    it('caches per person, so two people never share one entry', async () => {
      rpc.mockResolvedValue({ data: { personal: { PHP: 10 }, groups: [], total: { PHP: 10 } }, error: null })
      await fetchPersonSummary('u1', 'alice')

      expect(readCache('person:alice', 'u1')).not.toBeNull()
      expect(readCache('person:bob', 'u1')).toBeNull()
    })

    it('coerces group leg numerics', async () => {
      rpc.mockResolvedValue({
        data: {
          personal: {},
          groups: [{ groupId: 'g1', groupName: 'Flat', currency: 'PHP', net: '-30', theirNet: '60' }],
          total: { PHP: '-30' },
        },
        error: null,
      })

      const { data } = await fetchPersonSummary('u1', 'alice')
      expect(data.groups[0].net).toBe(-30)
      // `theirNet` is the group-POOL net, a different quantity from the pairwise `net` — the
      // export card asks the pool question. See migration 063.
      expect(data.groups[0].theirNet).toBe(60)
      expect(data.total.PHP).toBe(-30)
    })
  })

  describe('fetchGroupsWithBalances', () => {
    it('coerces the balance numerics and keeps the row shape', async () => {
      rpc.mockResolvedValue({
        data: [
          {
            groupId: 'g1',
            name: 'Trip',
            currency: 'PHP',
            memberCount: 3,
            updatedAt: 'T1',
            totalToReceive: '200',
            totalToPay: '0',
          },
        ],
        error: null,
      })

      const { data } = await fetchGroupsWithBalances('u1')
      expect(data[0].totalToReceive).toBe(200)
      expect(data[0].totalToPay).toBe(0)
      expect(data[0].memberCount).toBe(3)
    })

    it('rejects a non-array response', async () => {
      rpc.mockResolvedValue({ data: null, error: null })
      await expect(fetchGroupsWithBalances('u1')).rejects.toBeInstanceOf(ApiError)
    })
  })

  describe('fetchPersonalBills', () => {
    it('maps both buckets with their participants', async () => {
      rpc.mockResolvedValue({
        data: {
          mine: [
            {
              id: 'b1',
              title: 'Dinner',
              currency: 'PHP',
              totalAmount: '100',
              createdAt: 'T2',
              createdBy: 'u1',
              payorName: 'Alice',
              itemCount: 2,
              settled: false,
              category: 'food',
              participants: [{ id: 'u1', label: 'You' }, { id: 'c1', label: 'Bobby' }],
            },
          ],
          shared: [],
        },
        error: null,
      })

      const { data } = await fetchPersonalBills('u1')
      expect(data.mine[0].totalAmount).toBe(100)
      expect(data.mine[0].participants).toEqual([
        { id: 'u1', label: 'You' },
        { id: 'c1', label: 'Bobby' },
      ])
      expect(data.mine[0].settled).toBe(false)
      expect(data.shared).toEqual([])
    })

    // `settled` drives a badge and a filter; anything other than a literal true must not read as
    // settled, or an unpaid bill hides behind the "settled" filter.
    it('treats a non-boolean settled value as not settled', async () => {
      rpc.mockResolvedValue({
        data: { mine: [{ id: 'b1', settled: 'true' }], shared: [] },
        error: null,
      })
      const { data } = await fetchPersonalBills('u1')
      expect(data.mine[0].settled).toBe(false)
    })

    it('defaults missing buckets and a missing participants array', async () => {
      rpc.mockResolvedValue({ data: { mine: [{ id: 'b1' }] }, error: null })
      const { data } = await fetchPersonalBills('u1')
      expect(data.shared).toEqual([])
      expect(data.mine[0].participants).toEqual([])
      expect(data.mine[0].payorName).toBe('Someone')
      expect(data.mine[0].category).toBeNull()
    })
  })

  describe('fetchBillDetail', () => {
    it('maps the bill, its items, splits and counterparties', async () => {
      rpc.mockResolvedValue({
        data: {
          bill: {
            id: 'b1',
            title: 'Dinner',
            note: '',
            currency: 'PHP',
            totalAmount: '100',
            createdAt: 'T1',
            createdBy: 'u1',
            paidBy: 'u1',
            groupId: null,
            category: null,
            creatorName: 'Alice',
            payorName: 'Alice',
          },
          groupName: null,
          items: [
            {
              id: 'i1',
              name: 'Dinner',
              amount: '100',
              splits: [
                {
                  id: 's1',
                  userId: 'u2',
                  displayName: 'Bob',
                  splitType: 'equal',
                  splitValue: '1',
                  computedAmount: '50',
                },
              ],
            },
          ],
          mySplitTotal: '50',
          pairs: [{ otherId: 'u2', displayName: 'Bob', net: '50', squareOverall: false }],
        },
        error: null,
      })

      const { data } = await fetchBillDetail('u1', 'b1')
      expect(data?.bill.totalAmount).toBe(100)
      expect(data?.items[0].splits[0].computedAmount).toBe(50)
      expect(data?.mySplitTotal).toBe(50)
      expect(data?.pairs[0].net).toBe(50)
      expect(data?.pairs[0].squareOverall).toBe(false)
    })

    // The server returns null for a bill you cannot read; that must stay null and not become an
    // empty bill object, which the page would render as a real (blank) bill.
    it('passes an unreadable bill through as null', async () => {
      rpc.mockResolvedValue({ data: null, error: null })
      const { data } = await fetchBillDetail('u1', 'b1')
      expect(data).toBeNull()
    })

    // A group bill reports no personal share. Coercing that null to 0 would render
    // "Your split: ₱0.00" on every group bill.
    it('keeps a null mySplitTotal null rather than coercing it to zero', async () => {
      rpc.mockResolvedValue({
        data: { bill: { id: 'b1' }, groupName: 'Squad', items: [], mySplitTotal: null, pairs: [] },
        error: null,
      })
      const { data } = await fetchBillDetail('u1', 'b1')
      expect(data?.mySplitTotal).toBeNull()
      expect(data?.groupName).toBe('Squad')
    })

    it('caches per bill', async () => {
      rpc.mockResolvedValue({ data: { bill: { id: 'b1' }, items: [], pairs: [] }, error: null })
      await fetchBillDetail('u1', 'b1')
      expect(readCache('bill:b1', 'u1')).not.toBeNull()
      expect(readCache('bill:b2', 'u1')).toBeNull()
    })
  })

  describe('fetchGroupDetail', () => {
    it('maps every section and coerces the numerics', async () => {
      rpc.mockResolvedValue({
        data: {
          group: { id: 'g1', name: 'Trip', currency: 'PHP', createdBy: 'u1', inviteCode: 'abc', updatedAt: 'T1' },
          members: [{ id: 'm1', userId: 'u1', profileName: 'Alice', isCurrentUser: true }],
          bills: [{ id: 'b1', title: 'Hotel', totalAmount: '300', paidBy: 'u1', payorName: 'Alice' }],
          pairwise: [{ memberUserId: 'u2', displayName: 'Bob', net: '50' }],
          totalToReceive: '50',
          totalToPay: '0',
          memberBalances: [{ userId: 'u2', displayName: 'Bob', amount: '-50' }],
          rawDebts: [{ from: 'u2', to: 'u1', amount: '50' }],
        },
        error: null,
      })

      const { data } = await fetchGroupDetail('u1', 'g1')
      expect(data?.group.name).toBe('Trip')
      expect(data?.bills[0].totalAmount).toBe(300)
      expect(data?.pairwise[0].net).toBe(50)
      expect(data?.totalToReceive).toBe(50)
      expect(data?.memberBalances[0].amount).toBe(-50)
      expect(data?.rawDebts[0].amount).toBe(50)
      expect(data?.members[0].isCurrentUser).toBe(true)
    })

    // The server returns null for "deleted, or you are not a member". Turning that into an empty
    // group object would render a real-looking group the user has no access to.
    it('passes an inaccessible group through as null', async () => {
      rpc.mockResolvedValue({ data: null, error: null })
      const { data } = await fetchGroupDetail('u1', 'g1')
      expect(data).toBeNull()
    })

    it('defaults every missing section to an empty list', async () => {
      rpc.mockResolvedValue({ data: { group: { id: 'g1' } }, error: null })
      const { data } = await fetchGroupDetail('u1', 'g1')
      expect(data?.members).toEqual([])
      expect(data?.bills).toEqual([])
      expect(data?.rawDebts).toEqual([])
      expect(data?.totalToReceive).toBe(0)
    })

    it('caches per group', async () => {
      rpc.mockResolvedValue({ data: { group: { id: 'g1' } }, error: null })
      await fetchGroupDetail('u1', 'g1')
      expect(readCache('group:g1', 'u1')).not.toBeNull()
      expect(readCache('group:g2', 'u1')).toBeNull()
    })
  })

  describe('fetchPersonStatement', () => {
    it('maps events and coerces the deltas', async () => {
      rpc.mockResolvedValue({
        data: [
          {
            id: 'b1',
            type: 'personal_bill',
            createdAt: 'T1',
            currency: 'PHP',
            groupId: null,
            bundleId: null,
            contextLabel: 'Personal',
            title: 'Dinner',
            rawAmount: '50',
            delta: '50',
          },
        ],
        error: null,
      })

      const { data } = await fetchPersonStatement('u1', 'alice')
      expect(data[0].delta).toBe(50)
      expect(data[0].rawAmount).toBe(50)
      expect(data[0].groupId).toBeNull()
    })

    // An unrecognised type would otherwise reach the running-balance pass and be rendered with
    // the wrong note ("you owe them" vs "you paid them").
    it('falls back to personal_bill for an unknown event type', async () => {
      rpc.mockResolvedValue({ data: [{ id: 'x', type: 'weird', delta: 1 }], error: null })
      const { data } = await fetchPersonStatement('u1', 'alice')
      expect(data[0].type).toBe('personal_bill')
    })

    it('rejects a non-array response', async () => {
      rpc.mockResolvedValue({ data: { nope: true }, error: null })
      await expect(fetchPersonStatement('u1', 'alice')).rejects.toBeInstanceOf(ApiError)
    })

    it('caches per person', async () => {
      rpc.mockResolvedValue({ data: [], error: null })
      await fetchPersonStatement('u1', 'alice')
      expect(readCache('statement:alice', 'u1')).not.toBeNull()
      expect(readCache('statement:bob', 'u1')).toBeNull()
    })
  })

  describe('searchEverything', () => {
    it('maps all three result kinds', async () => {
      rpc.mockResolvedValue({
        data: {
          bills: [{ id: 'b1', title: 'Dinner', amount: '100', currency: 'PHP', groupId: null }],
          groups: [{ id: 'g1', name: 'Trip', currency: 'PHP' }],
          profiles: [{ id: 'p1', displayName: 'Bob', email: 'bob@example.com' }],
        },
        error: null,
      })

      const out = await searchEverything('din')
      expect(rpc).toHaveBeenCalledWith('kwenta_search', { p_query: 'din' })
      expect(out.bills[0].amount).toBe(100)
      expect(out.groups[0].name).toBe('Trip')
      expect(out.profiles[0].displayName).toBe('Bob')
    })

    // Search is deliberately uncached: a stale answer to a fresh query is worse than none.
    it('throws rather than serving a cached answer', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
      await expect(searchEverything('x')).rejects.toBeInstanceOf(ApiError)
    })

    it('defaults every missing section to empty', async () => {
      rpc.mockResolvedValue({ data: {}, error: null })
      const out = await searchEverything('x')
      expect(out).toEqual({ bills: [], groups: [], profiles: [] })
    })
  })

  describe('cache fallback', () => {
    it('serves the last good copy when the call fails, flagged as cached', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          personalReceive: { PHP: 10 },
          personalPay: {},
          combinedReceive: {},
          combinedPay: {},
          groupReceive: {},
          groupPay: {},
        },
        error: null,
      })
      const first = await fetchBalancesOverview('u1')
      expect(first.fromCache).toBe(false)

      rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
      const second = await fetchBalancesOverview('u1')
      expect(second.fromCache).toBe(true)
      expect(second.data.personalReceive.PHP).toBe(10)
      expect(second.fetchedAt).toBe(first.fetchedAt)
    })

    it('throws when the call fails and nothing was ever cached', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
      // The screen must be able to tell "unavailable" from "zero" — see the HomePage alert.
      await expect(fetchBalancesOverview('u1')).rejects.toBeInstanceOf(ApiError)
    })

    it('offline: reads the cache without touching the network', async () => {
      writeCache('overview', 'u1', { personalReceive: { PHP: 7 } }, '2026-08-04T00:00:00.000Z')
      setOnline(false)

      const result = await fetchBalancesOverview('u1')
      expect(rpc).not.toHaveBeenCalled()
      expect(result.fromCache).toBe(true)
      expect(result.fetchedAt).toBe('2026-08-04T00:00:00.000Z')
    })

    it('offline with no cache reports that rather than pretending the balance is zero', async () => {
      setOnline(false)
      await expect(fetchBalancesOverview('u1')).rejects.toBeInstanceOf(ApiError)
      expect(rpc).not.toHaveBeenCalled()
    })

    it('does not serve another user’s cached balances', async () => {
      writeCache('overview', 'u1', { personalReceive: { PHP: 999 } }, '2026-08-04T00:00:00.000Z')
      setOnline(false)
      await expect(fetchBalancesOverview('u2')).rejects.toBeInstanceOf(ApiError)
    })
  })

  /**
   * `kwenta_group_member_breakdown` RETURNs NULL when the caller is not an active member of the
   * group, or cannot see it. That is a REFUSAL, and three call sites read it as "owes nobody":
   * the member dialog claimed "all settled up", the payment dialog rendered a loaded form for a
   * payer who owed no one, and `removeGroupMember` skipped its balance guard entirely.
   */
  describe('a NULL group breakdown is a refusal, not an empty answer', () => {
    it('throws ServerDeclinedError instead of resolving to null', async () => {
      rpc.mockResolvedValue({ data: null, error: null })
      await expect(fetchGroupMemberBreakdown('u1', 'g1', 'm1')).rejects.toBeInstanceOf(
        ServerDeclinedError,
      )
    })

    it('throws from the uncached guard loader too', async () => {
      rpc.mockResolvedValue({ data: null, error: null })
      await expect(loadGroupMemberBreakdownFresh('g1', 'm1')).rejects.toBeInstanceOf(
        ServerDeclinedError,
      )
    })

    // A refusal is the server's ANSWER. Falling back to the cache would answer a question the
    // server just declined to answer, which is how the refusal became "settled up" again.
    it('does not fall back to a cached copy', async () => {
      writeCache(
        'group-breakdown:g1:m1',
        'u1',
        { memberUserId: 'm1', displayName: 'M', currency: 'PHP', pays: [], receives: [] },
        '2026-08-04T00:00:00.000Z',
      )
      rpc.mockResolvedValue({ data: null, error: null })
      await expect(fetchGroupMemberBreakdown('u1', 'g1', 'm1')).rejects.toBeInstanceOf(
        ServerDeclinedError,
      )
    })
  })

  /**
   * The cache exists so a screen still renders when the NETWORK is unavailable. Serving it after
   * an authorization failure means a user removed from a group, or whose session ended, keeps
   * reading balances and counterparty names they are no longer entitled to — behind a "saved
   * copy" note that reads as staleness, not as a loss of access.
   */
  describe('authorization failures are not network failures', () => {
    it.each([
      ['insufficient_privilege', { code: '42501', message: 'permission denied for table bills' }],
      ['an expired JWT', { code: 'PGRST301', message: 'JWT expired' }],
      ['an unauthenticated call', { message: 'not authenticated' }],
    ])('refuses to serve the cache after %s', async (_label, error) => {
      writeCache('overview', 'u1', { personalReceive: { PHP: 999 } }, '2026-08-04T00:00:00.000Z')
      rpc.mockResolvedValue({ data: null, error })

      await expect(fetchBalancesOverview('u1')).rejects.toThrow(/no longer have access/i)
    })

    it('still serves the cache for an ordinary transport failure', async () => {
      writeCache('overview', 'u1', { personalReceive: { PHP: 12 } }, '2026-08-04T00:00:00.000Z')
      rpc.mockResolvedValue({ data: null, error: { message: 'network request failed' } })

      const result = await fetchBalancesOverview('u1')
      expect(result.fromCache).toBe(true)
      expect(result.data.personalReceive).toEqual({ PHP: 12 })
    })
  })

  /**
   * The cache key is an internal identifier and these messages are rendered verbatim inside
   * user-facing alerts, so interpolating it showed people raw UUIDs as an explanation.
   */
  describe('error messages', () => {
    it('names the thing in human terms and never leaks the cache key', async () => {
      setOnline(false)
      const err = await fetchPersonStatement('u1', '0f3a1c8e-2b41-4c77-9a11-8d2f7b3e5c19').catch(
        (e: unknown) => e as Error,
      )
      expect(err.message).toContain('this statement')
      expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
      expect(err.message).not.toContain('statement:')
    })
  })

  describe('totalsToMap', () => {
    it('converts to the Map the display helpers take', () => {
      expect([...totalsToMap({ PHP: 10, USD: -2 })]).toEqual([
        ['PHP', 10],
        ['USD', -2],
      ])
    })
  })
})
