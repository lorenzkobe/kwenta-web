import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useServerData } from '@/hooks/useServerData'
import { useAppStore } from '@/store/app-store'
import {
  clearPrimedReads,
  mountedReadSpecs,
  rememberReadSpec,
} from '@/api/primed-reads'
import { writeCache } from '@/api/cache'
import { ApiError, ServerDeclinedError } from '@/api/balances'

/**
 * The one hook test in the suite, because the defect it pins is not expressible as a pure
 * function: `useServerData` kept the PREVIOUS subject's payload when its deps changed, and every
 * page's loading guard is `loading && !data` — so tapping from /app/people/alice to
 * /app/people/bob rendered Alice's balance under Bob's name until the fetch resolved. On a money
 * screen that is a wrong number attributed to the wrong person.
 *
 * Driven with React's own `act` + `react-dom/client` rather than a testing library, so it adds no
 * dependency.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

type Observed = { data: unknown; loading: boolean; error: string | null; fromCache: boolean }

/** Renders the hook and records what each render saw, so we can inspect the INTERMEDIATE states. */
function Probe({
  subject,
  fetcher,
  seen,
}: {
  subject: string
  fetcher: (() => Promise<{ data: unknown; fromCache: boolean; fetchedAt: string }>) | null
  seen: Observed[]
}) {
  const state = useServerData(fetcher, [subject])
  seen.push({
    data: state.data,
    loading: state.loading,
    error: state.error,
    fromCache: state.fromCache,
  })
  return null
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const payload = (data: unknown) => ({ data, fromCache: false, fetchedAt: '2026-08-04T00:00:00Z' })

describe('useServerData', () => {
  it('drops the previous subject’s data the moment the subject changes', async () => {
    const alice = deferred<ReturnType<typeof payload>>()
    const bob = deferred<ReturnType<typeof payload>>()
    const seen: Observed[] = []

    await act(async () => {
      root.render(<Probe subject="alice" fetcher={() => alice.promise} seen={seen} />)
    })
    await act(async () => {
      alice.resolve(payload({ owed: 1200 }))
    })
    expect(seen.at(-1)?.data).toEqual({ owed: 1200 })

    // Same route element, new param — no remount.
    await act(async () => {
      root.render(<Probe subject="bob" fetcher={() => bob.promise} seen={seen} />)
    })

    // THE regression: while Bob's request is in flight nothing may still be Alice's number.
    expect(seen.at(-1)?.data).toBeUndefined()
    expect(seen.at(-1)?.loading).toBe(true)

    await act(async () => {
      bob.resolve(payload({ owed: 5 }))
    })
    expect(seen.at(-1)?.data).toEqual({ owed: 5 })
  })

  it('keeps the current data across an invalidation tick, so a refresh does not blank the screen', async () => {
    const seen: Observed[] = []
    let call = 0
    const fetcher = () => Promise.resolve(payload({ n: ++call }))

    await act(async () => {
      root.render(<Probe subject="alice" fetcher={fetcher} seen={seen} />)
    })
    expect(seen.at(-1)?.data).toEqual({ n: 1 })

    const before = seen.length
    await act(async () => {
      useAppStore.getState().bumpDataVersion()
    })

    // Same subject: the new answer REPLACES the current one, so the current one stays visible
    // while it loads. Blanking here would flicker every screen after every mutation.
    expect(seen.slice(before).every((s) => s.data !== undefined)).toBe(true)
    expect(seen.at(-1)?.data).toEqual({ n: 2 })
  })

  it('clears a previous subject’s error instead of showing it under the new one', async () => {
    const seen: Observed[] = []

    await act(async () => {
      root.render(
        <Probe subject="alice" fetcher={() => Promise.reject(new Error('boom'))} seen={seen} />,
      )
    })
    expect(seen.at(-1)?.error).toBe('boom')

    const bob = deferred<ReturnType<typeof payload>>()
    await act(async () => {
      root.render(<Probe subject="bob" fetcher={() => bob.promise} seen={seen} />)
    })

    // MemberBalancesDialog computes `loading` as `!ready && error === null`, so a surviving error
    // left the next member's dialog showing the previous member's failure with no spinner.
    expect(seen.at(-1)?.error).toBeNull()
    expect(seen.at(-1)?.loading).toBe(true)

    await act(async () => {
      bob.resolve(payload({ ok: true }))
    })
    expect(seen.at(-1)?.error).toBeNull()
  })

  /**
   * The no-user case, exactly as the pages write it:
   * `useServerData(userId ? load : null, [userId, load])`. The fetcher is tracked by ref on
   * purpose (a new identity must not itself trigger a fetch), so this branch is only reachable
   * when the deps change too — which is what every caller does, because the fetcher is a
   * `useCallback` over the same values.
   */
  it('clears every field, not just data, when the subject goes away', async () => {
    const seen: Observed[] = []

    await act(async () => {
      root.render(
        <Probe
          subject="alice"
          fetcher={() => Promise.resolve({ data: { v: 1 }, fromCache: true, fetchedAt: 'x' })}
          seen={seen}
        />,
      )
    })
    expect(seen.at(-1)?.fromCache).toBe(true)

    // Same component instance — rendering a different component type would remount the hook and
    // reset its state for free, which would make this pass without the fix.
    await act(async () => {
      root.render(<Probe subject="" fetcher={null} seen={seen} />)
    })

    // `fromCache` drives a "showing saved data" line; leaving it set describes nothing at all.
    expect(seen.at(-1)).toMatchObject({ data: undefined, error: null, fromCache: false })
  })
})

/**
 * Declaring which endpoint a screen renders is what lets a mutation ask the server to recompute
 * exactly those and hand them back with the write. The registration has to track MOUNTING, not
 * fetching: a key left behind by a closed screen makes every later write pay for a payload nobody
 * is looking at, and a key that never registers costs a whole extra round trip after every save.
 */
function KeyedProbe({ endpointKey }: { endpointKey?: string }) {
  useServerData(() => Promise.resolve({ data: 1, fromCache: false, fetchedAt: 'x' }), [endpointKey], endpointKey)
  return null
}

describe('useServerData endpoint registration', () => {
  beforeEach(() => clearPrimedReads())
  afterEach(() => clearPrimedReads())

  it('registers its endpoint while mounted and releases it on unmount', async () => {
    rememberReadSpec({ key: 'overview', fn: 'kwenta_balances_overview' })

    await act(async () => {
      root.render(<KeyedProbe endpointKey="overview" />)
    })
    expect(mountedReadSpecs().map((s) => s.key)).toEqual(['overview'])

    await act(async () => {
      root.render(<KeyedProbe endpointKey={undefined} />)
    })
    expect(mountedReadSpecs()).toEqual([])
  })

  it('follows the subject when the same screen moves to another entity', async () => {
    // /app/people/alice → /app/people/bob reuses this hook without remounting. Holding on to
    // alice's key would make the next write recompute a person the user has navigated away from.
    rememberReadSpec({ key: 'person:alice', fn: 'kwenta_person_summary', argName: 'p_person_id', id: 'alice' })
    rememberReadSpec({ key: 'person:bob', fn: 'kwenta_person_summary', argName: 'p_person_id', id: 'bob' })

    await act(async () => {
      root.render(<KeyedProbe endpointKey="person:alice" />)
    })
    expect(mountedReadSpecs().map((s) => s.key)).toEqual(['person:alice'])

    await act(async () => {
      root.render(<KeyedProbe endpointKey="person:bob" />)
    })
    expect(mountedReadSpecs().map((s) => s.key)).toEqual(['person:bob'])
  })

  it('registers nothing when the caller declares no endpoint', async () => {
    await act(async () => {
      root.render(<KeyedProbe endpointKey={undefined} />)
    })
    expect(mountedReadSpecs()).toEqual([])
  })
})

/**
 * Stale-while-revalidate (perf-pass-1, cases C1-C6). A screen that has been opened before paints
 * its last-known answer from the api cache on the FIRST render and revalidates behind it, instead
 * of blanking to a spinner on every navigation. The seed is the same `readCache` entry that
 * `fetchEndpoint` writes (`kwenta_api_cache_v1:<userId>:<endpoint>`), scoped to the signed-in user.
 *
 * Two things the seed must never do: show one user's cached money to another user on the same
 * device (C6), and keep showing a copy after the server says the viewer lost access to it (C4).
 */
type SeededObserved = Observed & { revalidating: unknown; fetchedAt: string | null }

type Payload = { data: unknown; fromCache: boolean; fetchedAt: string }

function SeededProbe({
  subject,
  endpointKey,
  fetcher,
  seen,
}: {
  subject: string
  endpointKey: string
  fetcher: () => Promise<Payload>
  seen: SeededObserved[]
}) {
  const state = useServerData(fetcher, [subject], endpointKey)
  seen.push({
    data: state.data,
    loading: state.loading,
    error: state.error,
    fromCache: state.fromCache,
    fetchedAt: state.fetchedAt,
    revalidating: (state as unknown as { revalidating: unknown }).revalidating,
  })
  return null
}

const CACHED_AT = '2026-09-01T08:00:00.000Z'
const FRESH_AT = '2026-09-23T09:30:00.000Z'

describe('useServerData cache seed (stale-while-revalidate)', () => {
  beforeEach(() => {
    localStorage.clear()
    clearPrimedReads()
    useAppStore.getState().setCurrentUserId('u1')
  })
  afterEach(() => {
    useAppStore.getState().setCurrentUserId(null)
    localStorage.clear()
    clearPrimedReads()
  })

  it('C1: renders the cached copy on the first render, then replaces it with the fetch result', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    // The very first render already has the saved answer: no blank frame.
    expect(seen[0]).toMatchObject({
      data: { owed: 900 },
      revalidating: true,
      fromCache: true,
      loading: true,
      error: null,
    })
    // Derived: the "saved copy" line needs the cached fetch time, not null.
    expect(seen[0].fetchedAt).toBe(CACHED_AT)
    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, revalidating: true })

    await act(async () => {
      fresh.resolve({ data: { owed: 1250 }, fromCache: false, fetchedAt: FRESH_AT })
    })

    expect(seen.at(-1)).toMatchObject({
      data: { owed: 1250 },
      revalidating: false,
      fromCache: false,
      loading: false,
      error: null,
    })
    expect(seen.at(-1)?.fetchedAt).toBe(FRESH_AT)
  })

  it('C2: with no cached copy it starts empty and loading, not revalidating', async () => {
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    expect(seen[0]).toMatchObject({ data: undefined, loading: true, fromCache: false, error: null })
    expect(seen[0].revalidating).toBe(false)

    await act(async () => {
      fresh.resolve({ data: { owed: 7 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 7 }, loading: false, revalidating: false })
  })

  it("C3: a subject change seeds the NEW subject's cache and never renders the old subject's data", async () => {
    writeCache('person:alice', 'u1', { owed: 1200 }, CACHED_AT)
    writeCache('person:bob', 'u1', { owed: 5 }, CACHED_AT)
    const bobFresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe
          subject="alice"
          endpointKey="person:alice"
          fetcher={() => Promise.resolve({ data: { owed: 1300 }, fromCache: false, fetchedAt: FRESH_AT })}
          seen={seen}
        />,
      )
    })
    expect(seen.at(-1)?.data).toEqual({ owed: 1300 })

    const before = seen.length
    // Same component instance, new param: the /app/people/alice -> /bob navigation.
    await act(async () => {
      root.render(
        <SeededProbe subject="bob" endpointKey="person:bob" fetcher={() => bobFresh.promise} seen={seen} />,
      )
    })

    const afterSwitch = seen.slice(before).map((s) => JSON.stringify(s.data))
    expect(afterSwitch).not.toContain(JSON.stringify({ owed: 1300 }))
    expect(afterSwitch).not.toContain(JSON.stringify({ owed: 1200 }))
    expect(seen.at(-1)).toMatchObject({ data: { owed: 5 }, revalidating: true, fromCache: true })

    await act(async () => {
      bobFresh.resolve({ data: { owed: 6 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 6 }, revalidating: false, fromCache: false })
  })

  it('C3: a subject change to an uncached subject shows nothing, not the previous subject', async () => {
    writeCache('person:alice', 'u1', { owed: 1200 }, CACHED_AT)
    const bobFresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe
          subject="alice"
          endpointKey="person:alice"
          fetcher={() => Promise.resolve({ data: { owed: 1300 }, fromCache: false, fetchedAt: FRESH_AT })}
          seen={seen}
        />,
      )
    })

    const before = seen.length
    await act(async () => {
      root.render(
        <SeededProbe subject="bob" endpointKey="person:bob" fetcher={() => bobFresh.promise} seen={seen} />,
      )
    })

    expect(seen.slice(before).every((s) => s.data === undefined)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ data: undefined, loading: true, fromCache: false })
    expect(seen.at(-1)?.revalidating).toBe(false)
  })

  it('C4: an access-lost ApiError during revalidation clears the seeded copy and sets the error', async () => {
    writeCache('group:g1', 'u1', { members: 3 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="g1" endpointKey="group:g1" fetcher={() => fresh.promise} seen={seen} />,
      )
    })
    expect(seen[0].data).toEqual({ members: 3 })

    await act(async () => {
      // The exact prefix fetchEndpoint uses for an authorization failure (src/api/balances.ts).
      fresh.reject(new ApiError('You no longer have access to this group.'))
    })

    // Losing access must not read as staleness: the saved copy goes away with it.
    expect(seen.at(-1)).toMatchObject({
      data: undefined,
      error: 'You no longer have access to this group.',
      loading: false,
      fromCache: false,
    })
    expect(seen.at(-1)?.revalidating).toBe(false)
  })

  it('C4: a ServerDeclinedError during revalidation clears the seeded copy and sets the error', async () => {
    writeCache('group-breakdown:g1:m1', 'u1', { pays: [] }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe
          subject="g1:m1"
          endpointKey="group-breakdown:g1:m1"
          fetcher={() => fresh.promise}
          seen={seen}
        />,
      )
    })
    expect(seen[0].data).toEqual({ pays: [] })

    await act(async () => {
      fresh.reject(new ServerDeclinedError('Kwenta could not confirm the balances in this group.'))
    })

    expect(seen.at(-1)).toMatchObject({
      data: undefined,
      error: 'Kwenta could not confirm the balances in this group.',
      loading: false,
      fromCache: false,
    })
    expect(seen.at(-1)?.revalidating).toBe(false)
  })

  it('C5: a transport failure during revalidation keeps the seeded copy, flagged as cached', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    await act(async () => {
      fresh.reject(new Error('Failed to fetch'))
    })

    expect(seen.at(-1)).toMatchObject({
      data: { owed: 900 },
      fromCache: true,
      loading: false,
      error: 'Failed to fetch',
    })
    expect(seen.at(-1)?.revalidating).toBe(false)
    expect(seen.at(-1)?.fetchedAt).toBe(CACHED_AT)
  })

  it("C6: another user's cached entry for the same endpoint is never seeded", async () => {
    writeCache('overview', 'u2', { owed: 99999 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    expect(seen.every((s) => s.data === undefined)).toBe(true)
    expect(seen[0]).toMatchObject({ loading: true, fromCache: false })
    expect(seen[0].revalidating).toBe(false)

    await act(async () => {
      fresh.resolve({ data: { owed: 1 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(seen.at(-1)?.data).toEqual({ owed: 1 })
  })

  it('C6: with no signed-in user nothing is seeded, even under a literal "null" user key', async () => {
    useAppStore.getState().setCurrentUserId(null)
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    // A null user must not be coerced into `kwenta_api_cache_v1:null:overview`.
    localStorage.setItem(
      'kwenta_api_cache_v1:null:overview',
      JSON.stringify({ data: { owed: 31337 }, fetchedAt: CACHED_AT }),
    )
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    expect(seen.every((s) => s.data === undefined)).toBe(true)
    expect(seen[0].revalidating).toBe(false)
  })
})
