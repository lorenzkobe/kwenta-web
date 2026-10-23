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

  it('switching back to the bill currency drops the previous rate', async () => {
    mocks.fetchExchangeRate.mockResolvedValue(live(0.0025))
    const seen: Seen[] = []
    await act(async () => root.render(<Probe from="VND" to="PHP" seen={seen} />))
    await act(async () => root.render(<Probe from="PHP" to="PHP" seen={seen} />))
    expect(seen.at(-1)).toEqual({ live: null, loading: false })
  })
})
