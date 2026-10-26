import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SAVED_COPY_FALLBACK_MS, useServerData } from '@/hooks/useServerData'
import { useAppStore } from '@/store/app-store'
import {
  clearPrimedReads,
  mountedReadSpecs,
  rememberReadSpec,
} from '@/api/primed-reads'
import { writeCache } from '@/api/cache'
import { ApiError, ServerDeclinedError } from '@/api/balances'

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

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
    useAppStore.setState({ isOnline: true })
  })
  afterEach(() => {
    useAppStore.getState().setCurrentUserId(null)
    localStorage.clear()
    clearPrimedReads()
  })

  it('C1: online, a saved copy is held back on open so the screen shows its skeleton, then the fresh answer', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    // Painting the saved copy and swapping it for the server's answer is the jump users saw.
    expect(seen.every((s) => s.data === undefined)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ loading: true, fromCache: false, error: null, fetchedAt: null })
    expect(seen.at(-1)?.revalidating).toBe(false)

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
    expect(seen.some((s) => JSON.stringify(s.data) === JSON.stringify({ owed: 900 }))).toBe(false)
  })

  it('C1: offline, the saved copy is painted on the first render and revalidated behind it', async () => {
    useAppStore.setState({ isOnline: false })
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []

    await act(async () => {
      root.render(
        <SeededProbe subject="home" endpointKey="overview" fetcher={() => fresh.promise} seen={seen} />,
      )
    })

    // Offline the copy is all there is: a skeleton would only delay it.
    expect(seen[0]).toMatchObject({ data: { owed: 900 }, fromCache: true, loading: true, error: null })
    expect(seen[0].fetchedAt).toBe(CACHED_AT)

    await act(async () => {
      fresh.resolve({ data: { owed: 900 }, fromCache: true, fetchedAt: CACHED_AT })
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, fromCache: true, loading: false })
    expect(seen.at(-1)?.revalidating).toBe(false)
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

  it("C3: a subject change holds the NEW subject's copy back online and never renders the old subject's data", async () => {
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
    expect(afterSwitch).not.toContain(JSON.stringify({ owed: 5 }))
    expect(seen.at(-1)).toMatchObject({ data: undefined, loading: true, fromCache: false })

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

    await act(async () => {
      // The exact prefix fetchEndpoint uses for an authorization failure (src/api/balances.ts).
      fresh.reject(new ApiError('You no longer have access to this group.'))
    })

    // Losing access must not read as staleness: the held copy is never shown.
    expect(seen.every((x) => JSON.stringify(x.data) !== JSON.stringify({ members: 3 }))).toBe(true)
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

/**
 * loading-bar-refresh-landing. The per-page "Updating…" chip is replaced by ONE header bar driven
 * by the store's `screenLoadCount`: every useServerData fetch that is in flight while ONLINE holds
 * exactly one begin/end pair on it. The count has to come back to 0 on every exit path — resolve,
 * reject, unmount, subject change, going offline — or the bar is stuck on for the session.
 * Offline, a fetch is only the cache answering again, so it must not light the bar at all.
 */
const loadCount = () => useAppStore.getState().screenLoadCount

function LoadProbe({
  subject,
  fetcher,
  renders,
}: {
  subject: string
  fetcher: (() => Promise<Payload>) | null
  renders?: null[]
}) {
  useServerData(fetcher, [subject])
  renders?.push(null)
  return null
}

describe('useServerData screen-load counter', () => {
  beforeEach(() => {
    useAppStore.setState({ screenLoadCount: 0, isOnline: true })
  })
  afterEach(() => {
    useAppStore.setState({ screenLoadCount: 0, isOnline: true })
  })

  it('C2: holds one load on the counter while an online fetch is in flight, released on resolve', async () => {
    const fresh = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="groups" fetcher={() => fresh.promise} />)
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      fresh.resolve(payload([{ id: 'g1' }]))
    })
    expect(loadCount()).toBe(0)
  })

  it('C4: a rejected fetch releases its load', async () => {
    const fresh = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="groups" fetcher={() => fresh.promise} />)
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      fresh.reject(new Error('Failed to fetch'))
    })
    expect(loadCount()).toBe(0)
  })

  it('C4: an access-lost rejection releases its load too', async () => {
    const fresh = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="g1" fetcher={() => fresh.promise} />)
    })
    await act(async () => {
      fresh.reject(new ApiError('You no longer have access to this group.'))
    })
    expect(loadCount()).toBe(0)
  })

  it('C4: unmounting mid-fetch releases its load, and the late answer does not touch the count', async () => {
    const fresh = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="groups" fetcher={() => fresh.promise} />)
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      root.render(null)
    })
    expect(loadCount()).toBe(0)

    await act(async () => {
      fresh.resolve(payload([]))
    })
    expect(loadCount()).toBe(0)
  })

  it('C4: a subject change mid-fetch hands the load over instead of leaking one', async () => {
    const alice = deferred<Payload>()
    const bob = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="alice" fetcher={() => alice.promise} />)
    })
    await act(async () => {
      root.render(<LoadProbe subject="bob" fetcher={() => bob.promise} />)
    })
    expect(loadCount()).toBe(1)

    // Alice's superseded answer arrives: Bob is still loading, so the bar must stay.
    await act(async () => {
      alice.resolve(payload({ owed: 1 }))
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      bob.resolve(payload({ owed: 2 }))
    })
    expect(loadCount()).toBe(0)
  })

  it('C4: an invalidation tick during a fetch still counts ONE load, not two', async () => {
    const first = deferred<Payload>()
    const second = deferred<Payload>()
    let call = 0
    const fetcher = () => (++call === 1 ? first.promise : second.promise)
    await act(async () => {
      root.render(<LoadProbe subject="groups" fetcher={fetcher} />)
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      useAppStore.getState().bumpDataVersion()
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      first.resolve(payload({ n: 1 }))
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      second.resolve(payload({ n: 2 }))
    })
    expect(loadCount()).toBe(0)
  })

  it('C5: offline, a fetch (the cache answering) never touches the counter', async () => {
    useAppStore.setState({ isOnline: false })
    const fresh = deferred<Payload>()
    let calls = 0
    await act(async () => {
      root.render(
        <LoadProbe
          subject="groups"
          fetcher={() => {
            calls++
            return fresh.promise
          }}
        />,
      )
    })
    // The fetch still runs — offline screens are served from cache through it.
    expect(calls).toBe(1)
    expect(loadCount()).toBe(0)

    await act(async () => {
      fresh.resolve({ data: [{ id: 'g1' }], fromCache: true, fetchedAt: CACHED_AT })
    })
    expect(loadCount()).toBe(0)
  })

  it('C5: going offline while a fetch is in flight releases its load', async () => {
    const pending = deferred<Payload>()
    await act(async () => {
      root.render(<LoadProbe subject="groups" fetcher={() => pending.promise} />)
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      useAppStore.getState().setOnline(false)
    })
    expect(loadCount()).toBe(0)
  })

  it('refused: a hook with no fetcher (signed out) holds nothing', async () => {
    await act(async () => {
      root.render(<LoadProbe subject="" fetcher={null} />)
    })
    expect(loadCount()).toBe(0)
  })

  it('C10: two screens loading at once hold two loads until both finish', async () => {
    const a = deferred<Payload>()
    const b = deferred<Payload>()
    await act(async () => {
      root.render(
        <>
          <LoadProbe subject="overview" fetcher={() => a.promise} />
          <LoadProbe subject="recent" fetcher={() => b.promise} />
        </>,
      )
    })
    expect(loadCount()).toBe(2)

    await act(async () => {
      a.resolve(payload({ owed: 1 }))
    })
    expect(loadCount()).toBe(1)

    await act(async () => {
      b.resolve(payload([]))
    })
    expect(loadCount()).toBe(0)
  })

  it('C11: a page using the hook does not re-render when the counter moves', async () => {
    const renders: null[] = []
    await act(async () => {
      root.render(
        <LoadProbe subject="groups" fetcher={() => Promise.resolve(payload([]))} renders={renders} />,
      )
    })
    expect(loadCount()).toBe(0)
    const settled = renders.length

    // Another screen's fetches move the counter; this page must not pay a render for it.
    await act(async () => {
      useAppStore.getState().beginScreenLoad()
      useAppStore.getState().beginScreenLoad()
    })
    await act(async () => {
      useAppStore.getState().endScreenLoad()
      useAppStore.getState().endScreenLoad()
    })
    expect(renders.length).toBe(settled)
  })
})

/**
 * skeleton-on-fetch. Online, a screen opened over a saved copy shows its skeleton instead of the
 * copy, so the answer appears once rather than jumping from the saved numbers to the fresh ones.
 * A slow server must not leave the skeleton up indefinitely: after SAVED_COPY_FALLBACK_MS the copy
 * is shown, with a toast saying so, and a failed fetch says so too.
 */
describe('useServerData saved-copy fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    clearPrimedReads()
    useAppStore.getState().setCurrentUserId('u1')
    useAppStore.setState({ isOnline: true, screenLoadCount: 0 })
    toastMock.info.mockClear()
    toastMock.warning.mockClear()
    toastMock.dismiss.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    useAppStore.getState().setCurrentUserId(null)
    useAppStore.setState({ isOnline: true, screenLoadCount: 0 })
    localStorage.clear()
    clearPrimedReads()
  })

  function renderOverview(fetcher: () => Promise<Payload>, seen: SeededObserved[]) {
    return act(async () => {
      root.render(<SeededProbe subject="home" endpointKey="overview" fetcher={fetcher} seen={seen} />)
    })
  }

  it('C2: a server slower than the fallback reveals the saved copy with a toast, then the fresh answer replaces it', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []
    await renderOverview(() => fresh.promise, seen)

    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS - 1)
    })
    expect(seen.at(-1)?.data).toBeUndefined()
    expect(toastMock.info).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    // Still updating: the header bar carries that, so the copy is revalidating, not a final answer.
    expect(seen.at(-1)).toMatchObject({
      data: { owed: 900 },
      fromCache: true,
      revalidating: true,
      loading: true,
      fetchedAt: CACHED_AT,
    })
    expect(toastMock.info).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().screenLoadCount).toBe(1)

    await act(async () => {
      fresh.resolve({ data: { owed: 1250 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 1250 }, fromCache: false, revalidating: false })
    expect(toastMock.dismiss).toHaveBeenCalledWith(toastMock.info.mock.calls[0][1].id)
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('C3: an answer just before the fallback never shows the saved copy or a toast', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []
    await renderOverview(() => fresh.promise, seen)

    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS - 1)
      fresh.resolve({ data: { owed: 1250 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS * 2)
    })

    expect(seen.some((s) => JSON.stringify(s.data) === JSON.stringify({ owed: 900 }))).toBe(false)
    expect(seen.at(-1)?.data).toEqual({ owed: 1250 })
    expect(toastMock.info).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('C4: a fetch that falls back to the saved copy while online shows it with a warning toast', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []
    await renderOverview(() => fresh.promise, seen)

    await act(async () => {
      fresh.resolve({ data: { owed: 900 }, fromCache: true, fetchedAt: CACHED_AT })
    })

    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, fromCache: true, revalidating: false, loading: false })
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning.mock.calls[0][0]).toMatch(/saved copy/i)
  })

  it('C4: an unsent (device-only) answer is not a failed fetch and raises no toast', async () => {
    const seen: SeededObserved[] = []
    await renderOverview(
      () => Promise.resolve({ data: { title: 'Lunch' }, fromCache: true, fetchedAt: CACHED_AT, unsent: true }),
      seen,
    )
    expect(seen.at(-1)).toMatchObject({ data: { title: 'Lunch' }, fromCache: true })
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('C4: a rejected fetch with a held copy reveals it, keeps the error and warns', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []
    await renderOverview(() => fresh.promise, seen)

    await act(async () => {
      fresh.reject(new Error('Failed to fetch'))
    })

    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, fromCache: true, error: 'Failed to fetch' })
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
  })

  it('C4: a refresh in place that ends on the saved copy warns too', async () => {
    let call = 0
    const fetcher = () =>
      Promise.resolve(
        ++call === 1
          ? { data: { owed: 1 }, fromCache: false, fetchedAt: FRESH_AT }
          : { data: { owed: 1 }, fromCache: true, fetchedAt: FRESH_AT },
      )
    const seen: SeededObserved[] = []
    await renderOverview(fetcher, seen)
    expect(toastMock.warning).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.getState().bumpDataVersion()
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 1 }, fromCache: true })
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
  })

  it('C5: access lost while the copy is held never shows the copy and never claims a saved copy', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const fresh = deferred<Payload>()
    const seen: SeededObserved[] = []
    await renderOverview(() => fresh.promise, seen)

    await act(async () => {
      fresh.reject(new ApiError('You no longer have access to this group.'))
    })
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS * 2)
    })

    expect(seen.every((s) => s.data === undefined)).toBe(true)
    expect(seen.at(-1)?.error).toBe('You no longer have access to this group.')
    expect(toastMock.info).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('C5: offline with no fetch failure shows no toast', async () => {
    useAppStore.setState({ isOnline: false })
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const seen: SeededObserved[] = []
    await renderOverview(() => Promise.resolve({ data: { owed: 900 }, fromCache: true, fetchedAt: CACHED_AT }), seen)
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS * 2)
    })

    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, fromCache: true })
    expect(toastMock.info).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('C7: going offline while the copy is held reveals it at once', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const seen: SeededObserved[] = []
    await renderOverview(() => new Promise<Payload>(() => {}), seen)
    expect(seen.at(-1)?.data).toBeUndefined()

    await act(async () => {
      useAppStore.getState().setOnline(false)
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 900 }, fromCache: true })
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('C9: a refresh in place keeps the fresh answer on screen while it loads, past the fallback too', async () => {
    let call = 0
    const second = deferred<Payload>()
    const fetcher = () =>
      ++call === 1 ? Promise.resolve({ data: { owed: 1 }, fromCache: false, fetchedAt: FRESH_AT }) : second.promise
    const seen: SeededObserved[] = []
    await renderOverview(fetcher, seen)
    const before = seen.length

    await act(async () => {
      useAppStore.getState().bumpDataVersion()
    })
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS * 2)
    })
    expect(seen.slice(before).every((s) => JSON.stringify(s.data) === JSON.stringify({ owed: 1 }))).toBe(true)
    expect(toastMock.info).not.toHaveBeenCalled()

    await act(async () => {
      second.resolve({ data: { owed: 2 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(seen.at(-1)?.data).toEqual({ owed: 2 })
  })

  it('C10: several slow screens share one toast, dismissed only when the last of them answers', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    writeCache('recent-bills', 'u1', [{ id: 'b1' }], CACHED_AT)
    const a = deferred<Payload>()
    const b = deferred<Payload>()
    const seenA: SeededObserved[] = []
    const seenB: SeededObserved[] = []
    await act(async () => {
      root.render(
        <>
          <SeededProbe subject="home" endpointKey="overview" fetcher={() => a.promise} seen={seenA} />
          <SeededProbe subject="home" endpointKey="recent-bills" fetcher={() => b.promise} seen={seenB} />
        </>,
      )
    })
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS)
    })
    const ids = new Set(toastMock.info.mock.calls.map((c) => c[1].id))
    expect(ids.size).toBe(1)

    await act(async () => {
      a.resolve({ data: { owed: 1 }, fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(toastMock.dismiss).not.toHaveBeenCalled()

    await act(async () => {
      b.resolve({ data: [], fromCache: false, fetchedAt: FRESH_AT })
    })
    expect(toastMock.dismiss).toHaveBeenCalledTimes(1)
  })

  it('C10: two failing screens use one toast id', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    writeCache('recent-bills', 'u1', [{ id: 'b1' }], CACHED_AT)
    await act(async () => {
      root.render(
        <>
          <SeededProbe subject="home" endpointKey="overview" fetcher={() => Promise.reject(new Error('Failed to fetch'))} seen={[]} />
          <SeededProbe subject="home" endpointKey="recent-bills" fetcher={() => Promise.reject(new Error('Failed to fetch'))} seen={[]} />
        </>,
      )
    })
    const ids = new Set(toastMock.warning.mock.calls.map((c) => c[1].id))
    expect(toastMock.warning).toHaveBeenCalled()
    expect(ids.size).toBe(1)
  })

  it('C11: unmounting while held cancels the fallback: no late reveal, no toast', async () => {
    writeCache('overview', 'u1', { owed: 900 }, CACHED_AT)
    const seen: SeededObserved[] = []
    await renderOverview(() => new Promise<Payload>(() => {}), seen)
    await act(async () => {
      root.render(null)
    })
    const after = seen.length
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS * 2)
    })
    expect(seen.length).toBe(after)
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('C8: a subject change while held restarts the fallback for the new subject', async () => {
    writeCache('person:alice', 'u1', { owed: 1200 }, CACHED_AT)
    writeCache('person:bob', 'u1', { owed: 5 }, CACHED_AT)
    const seen: SeededObserved[] = []
    const never = () => new Promise<Payload>(() => {})
    await act(async () => {
      root.render(<SeededProbe subject="alice" endpointKey="person:alice" fetcher={never} seen={seen} />)
    })
    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS - 500)
    })
    await act(async () => {
      root.render(<SeededProbe subject="bob" endpointKey="person:bob" fetcher={never} seen={seen} />)
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(seen.at(-1)?.data).toBeUndefined()
    expect(seen.some((s) => JSON.stringify(s.data) === JSON.stringify({ owed: 1200 }))).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS)
    })
    expect(seen.at(-1)).toMatchObject({ data: { owed: 5 }, fromCache: true })
  })
})
