import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useServerData } from '@/hooks/useServerData'
import { useAppStore } from '@/store/app-store'

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
