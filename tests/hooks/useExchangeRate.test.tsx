import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({ fetchExchangeRate: vi.fn() }))
vi.mock('@/lib/exchange-rates', () => ({ fetchExchangeRate: mocks.fetchExchangeRate }))

import { useExchangeRate } from '@/hooks/useExchangeRate'

/**
 * The rate prefill is a convenience: one request per currency pair, nothing for a bill in its own
 * currency, and a slow answer for the PREVIOUS pair must never land on the current one.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.fetchExchangeRate.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

type Seen = { live: { rate: number } | null; loading: boolean }

function Probe({ from, to, seen }: { from: string; to: string; seen: Seen[] }) {
  const { live, loading } = useExchangeRate(from, to)
  seen.push({ live, loading })
  return null
}

type RefreshSeen = ReturnType<typeof useExchangeRate>

function RefreshProbe({ from, to, seen }: { from: string; to: string; seen: RefreshSeen[] }) {
  seen.push(useExchangeRate(from, to))
  return null
}

const live = (rate: number) => ({ rate, fetchedAt: '2026-10-23T00:00:00.000Z', fromCache: false })

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useExchangeRate', () => {
  it('does not fetch, and is not loading, when the pair is the same currency', async () => {
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="PHP" to="PHP" seen={seen} />))
    expect(mocks.fetchExchangeRate).not.toHaveBeenCalled()
    expect(seen.at(-1)).toEqual({ live: null, loading: false })
  })

  it('fetches once for a pair and reports loading, then the rate', async () => {
    const pending = deferred<ReturnType<typeof live>>()
    mocks.fetchExchangeRate.mockReturnValue(pending.promise)
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toEqual({ live: null, loading: true })

    await act(async () => pending.resolve(live(0.00246385)))
    expect(seen.at(-1)).toEqual({ live: live(0.00246385), loading: false })
    expect(mocks.fetchExchangeRate).toHaveBeenCalledTimes(1)
    expect(mocks.fetchExchangeRate).toHaveBeenCalledWith('VND', 'PHP')
  })

  it('re-rendering with the same pair does not fetch again', async () => {
    mocks.fetchExchangeRate.mockResolvedValue(live(0.0025))
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    expect(mocks.fetchExchangeRate).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale answer after the pair changed', async () => {
    const first = deferred<ReturnType<typeof live>>()
    const second = deferred<ReturnType<typeof live>>()
    mocks.fetchExchangeRate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    await act(async () => root.render(<Probe from="THB" to="PHP" seen={seen} />))

    await act(async () => first.resolve(live(0.0025)))
    expect(seen.at(-1)).toEqual({ live: null, loading: true })

    await act(async () => second.resolve(live(1.6)))
    expect(seen.at(-1)).toEqual({ live: live(1.6), loading: false })
  })

  it('a failed fetch (null) leaves live null and stops loading', async () => {
    mocks.fetchExchangeRate.mockResolvedValue(null)
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toEqual({ live: null, loading: false })
  })

  it('refresh force-fetches the current pair, keeping the shown rate while it runs', async () => {
    const pending = deferred<ReturnType<typeof live>>()
    mocks.fetchExchangeRate.mockResolvedValueOnce(live(0.0025)).mockReturnValueOnce(pending.promise)
    const seen: RefreshSeen[] = []
    await act(async () => root.render(<RefreshProbe from="VND" to="PHP" seen={seen} />))

    await act(async () => seen.at(-1)!.refresh())
    expect(mocks.fetchExchangeRate).toHaveBeenLastCalledWith('VND', 'PHP', { force: true })
    expect(seen.at(-1)).toMatchObject({ live: live(0.0025), loading: false, refreshing: true })

    await act(async () => pending.resolve(live(0.0026)))
    expect(seen.at(-1)).toMatchObject({ live: live(0.0026), refreshing: false, refreshFailed: false })
  })

  it('a second refresh while one is in flight starts no second fetch', async () => {
    const pending = deferred<ReturnType<typeof live>>()
    mocks.fetchExchangeRate.mockResolvedValueOnce(live(0.0025)).mockReturnValueOnce(pending.promise)
    const seen: RefreshSeen[] = []
    await act(async () => root.render(<RefreshProbe from="VND" to="PHP" seen={seen} />))

    await act(async () => seen.at(-1)!.refresh())
    await act(async () => seen.at(-1)!.refresh())
    expect(mocks.fetchExchangeRate).toHaveBeenCalledTimes(2)

    // Two taps in one tick, before a re-render: the same closure is called twice.
    const stale = seen.at(-1)!.refresh
    await act(async () => {
      stale()
      stale()
    })
    expect(mocks.fetchExchangeRate).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve(live(0.0026)))
  })

  for (const [label, answer] of [
    ['null', null],
    ['a cached rate', { rate: 0.0025, fetchedAt: '2026-10-22T00:00:00.000Z', fromCache: true }],
  ] as const) {
    it(`a refresh answered with ${label} keeps a rate and reports the failure`, async () => {
      mocks.fetchExchangeRate.mockResolvedValueOnce(live(0.0025)).mockResolvedValueOnce(answer)
      const seen: RefreshSeen[] = []
      await act(async () => root.render(<RefreshProbe from="VND" to="PHP" seen={seen} />))

      await act(async () => seen.at(-1)!.refresh())
      expect(seen.at(-1)!.live?.rate).toBe(0.0025)
      expect(seen.at(-1)).toMatchObject({ refreshing: false, refreshFailed: true })
    })
  }

  it('a refresh answer for a pair no longer shown is ignored', async () => {
    const refreshed = deferred<ReturnType<typeof live>>()
    mocks.fetchExchangeRate
      .mockResolvedValueOnce(live(0.0025))
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce(live(1.6))
    const seen: RefreshSeen[] = []
    await act(async () => root.render(<RefreshProbe from="VND" to="PHP" seen={seen} />))
    await act(async () => seen.at(-1)!.refresh())
    await act(async () => root.render(<RefreshProbe from="THB" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toMatchObject({ live: live(1.6), refreshing: false })

    await act(async () => refreshed.resolve(live(0.0026)))
    expect(seen.at(-1)).toMatchObject({ live: live(1.6), refreshing: false, refreshFailed: false })
  })

  it('a refresh failure is per pair: a pair change or a later successful refresh clears it', async () => {
    mocks.fetchExchangeRate
      .mockResolvedValueOnce(live(0.0025))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(live(0.0026))
      .mockResolvedValueOnce(live(1.6))
    const seen: RefreshSeen[] = []
    await act(async () => root.render(<RefreshProbe from="VND" to="PHP" seen={seen} />))
    await act(async () => seen.at(-1)!.refresh())
    expect(seen.at(-1)!.refreshFailed).toBe(true)

    await act(async () => seen.at(-1)!.refresh())
    expect(seen.at(-1)).toMatchObject({ live: live(0.0026), refreshFailed: false })

    mocks.fetchExchangeRate.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(live(1.6))
    await act(async () => seen.at(-1)!.refresh())
    expect(seen.at(-1)!.refreshFailed).toBe(true)
    await act(async () => root.render(<RefreshProbe from="THB" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toMatchObject({ live: live(1.6), refreshFailed: false, refreshing: false })
  })

  it('switching back to the bill currency drops the previous rate', async () => {
    mocks.fetchExchangeRate.mockResolvedValue(live(0.0025))
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    await act(async () => root.render(<Probe from="PHP" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toEqual({ live: null, loading: false })
  })
})
