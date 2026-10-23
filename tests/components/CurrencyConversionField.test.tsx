import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({
  rate: { live: null, loading: false } as {
    live: { rate: number; fetchedAt: string; fromCache: boolean } | null
    loading: boolean
  },
}))
vi.mock('@/hooks/useExchangeRate', () => ({ useExchangeRate: () => mocks.rate }))

import {
  CurrencyConversionField,
  OriginalAmountLine,
  PaidInSummary,
  type ConversionValue,
} from '@/components/common/CurrencyConversionField'

/**
 * The control both bill forms share. The rate is shown the way people say it ("1 PHP = 405.87
 * VND") but stored as balance-currency units per paid-in unit, so what is typed must round-trip
 * through the inversion, and only the user's own typing marks the rate manual.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.rate = { live: null, loading: false }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const LIVE = { rate: 1 / 405.868219, fetchedAt: '2026-10-23T00:00:00.000Z', fromCache: false }

function Harness({
  initial,
  total = 500000,
  saved = null,
  onValue,
}: {
  initial: ConversionValue
  total?: number
  saved?: (ConversionValue & { rate: number }) | null
  onValue?: (v: ConversionValue) => void
}) {
  const [value, setValue] = useState(initial)
  onValue?.(value)
  return (
    <CurrencyConversionField
      targetCurrency="PHP"
      value={value}
      onChange={setValue}
      total={total}
      saved={saved}
    />
  )
}

function rateInput(): HTMLInputElement | null {
  return container.querySelector('input[inputmode="decimal"]')
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
}

describe('CurrencyConversionField', () => {
  it('C23: shows only the Paid in picker when the bill is paid in its own currency', async () => {
    await act(async () =>
      root.render(<Harness initial={{ currency: 'PHP', rate: null, source: 'online' }} />),
    )
    expect(container.textContent).toContain('Paid in')
    expect(rateInput()).toBeNull()
  })

  it('C23: prefills the live rate as online and shows it in the natural direction with a preview', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: null, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    expect(latest).toEqual({ currency: 'VND', rate: LIVE.rate, source: 'online' })
    expect(rateInput()!.value).toBe('405.868')
    expect(container.textContent).toContain('1 PHP =')
    expect(container.textContent).toContain('VND')
    expect(container.textContent).toContain('≈')
    expect(container.textContent).toContain('1,231.93')
  })

  it('C26: typing a rate stores the inverse and marks the source manual', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: null, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    await type(rateInput()!, '400')
    expect(latest!.source).toBe('manual')
    expect(latest!.rate).toBeCloseTo(1 / 400, 12)
    expect(rateInput()!.value).toBe('400')
  })

  it('C26: clearing the field leaves no rate, keeps it manual, and does not re-prefill', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: null, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    await type(rateInput()!, '')
    expect(latest).toEqual({ currency: 'VND', rate: null, source: 'manual' })
    expect(rateInput()!.value).toBe('')
  })

  it('C25: a differing live rate offers "Use this", which sets it as online; otherwise the rate is kept', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness
          initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }}
          saved={{ currency: 'VND', rate: 0.0025, source: 'manual' }}
          onValue={(v) => (latest = v)}
        />,
      ),
    )
    expect(container.textContent).toContain('Saved rate')
    expect(container.textContent).toContain('Today: 1 PHP = 405.87 VND')
    expect(latest).toEqual({ currency: 'VND', rate: 0.0025, source: 'manual' })

    await act(async () => button('Use this')!.click())
    expect(latest).toEqual({ currency: 'VND', rate: LIVE.rate, source: 'online' })
    expect(rateInput()!.value).toBe('405.868')
    expect(button('Use this')).toBeUndefined()
    expect(container.textContent).not.toContain('Saved rate')
  })

  it('shows no "Use this" when the current rate already is today\'s', async () => {
    mocks.rate = { live: LIVE, loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: LIVE.rate, source: 'online' }} />),
    )
    expect(button('Use this')).toBeUndefined()
  })

  it('C21: offline (no live rate) says so and leaves the field typeable', async () => {
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: null, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    expect(container.textContent).toContain("Today's rate isn't available")
    expect(container.textContent).toContain('Enter an exchange rate to save')
    await type(rateInput()!, '0.0025')
    // With no rate to orient by the field reads "1 VND = [ ] PHP", so the typed value is the rate.
    expect(latest).toEqual({ currency: 'VND', rate: 0.0025, source: 'manual' })
    expect(container.textContent).not.toContain('Enter an exchange rate to save')
  })

  it('shows the fetching note while the rate loads', async () => {
    mocks.rate = { live: null, loading: true }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: null, source: 'online' }} />),
    )
    expect(container.textContent).toContain("Fetching today's rate")
    expect(container.textContent).not.toContain('Enter an exchange rate to save')
  })

  it('C27: the rate row and Use this button are finger-sized and nothing forces a horizontal scroll', async () => {
    mocks.rate = { live: LIVE, loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }} />),
    )
    expect(rateInput()!.className).toContain('min-w-0')
    expect(button('Use this')!.className).toContain('h-11')
  })
})

async function pickCurrency(code: string) {
  const trigger = container.querySelector('button[role="combobox"]') as HTMLButtonElement
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) =>
    o.textContent?.startsWith(code),
  ) as HTMLElement
  expect(option, `option ${code}`).toBeDefined()
  await act(async () => {
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('CurrencyConversionField picker', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView ??= () => {}
    Element.prototype.hasPointerCapture ??= () => false
    Element.prototype.releasePointerCapture ??= () => {}
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  it('C23: picking a foreign currency resets the rate, then prefills today\'s as online', async () => {
    mocks.rate = { live: LIVE, loading: false }
    const seen: ConversionValue[] = []
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'PHP', rate: null, source: 'online' }} onValue={(v) => seen.push(v)} />,
      ),
    )
    expect(rateInput()).toBeNull()

    await pickCurrency('VND')
    expect(seen).toContainEqual({ currency: 'VND', rate: null, source: 'online' })
    expect(seen.at(-1)).toEqual({ currency: 'VND', rate: LIVE.rate, source: 'online' })
    expect(rateInput()!.value).toBe('405.868')
  })

  it('an edit never drifts the rate: switching away and back to the saved paid-in currency restores it', async () => {
    mocks.rate = { live: LIVE, loading: false }
    const seen: ConversionValue[] = []
    await act(async () =>
      root.render(
        <Harness
          initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }}
          saved={{ currency: 'VND', rate: 0.0025, source: 'manual' }}
          onValue={(v) => seen.push(v)}
        />,
      ),
    )
    await pickCurrency('THB')
    expect(seen.at(-1)!.currency).toBe('THB')
    expect(seen.at(-1)!.rate).toBe(LIVE.rate)

    await pickCurrency('VND')
    expect(seen.at(-1)).toEqual({ currency: 'VND', rate: 0.0025, source: 'manual' })
    expect(container.textContent).toContain('Saved rate')
  })

  it('C23: picking the bill currency again clears the conversion and hides the rate', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }} onValue={(v) => (latest = v)} />,
      ),
    )
    expect(rateInput()).not.toBeNull()

    await pickCurrency('PHP')
    expect(latest).toEqual({ currency: 'PHP', rate: null, source: 'online' })
    expect(rateInput()).toBeNull()
  })
})

describe('CurrencyConversionField rate sanity', () => {
  const at = (hoursAgo: number, fromCache: boolean) => ({
    rate: LIVE.rate,
    fetchedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    fromCache,
  })

  it('shows how old a cached rate is in the Today hint, and nothing for a fresh one', async () => {
    mocks.rate = { live: at(3, true), loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }} />),
    )
    expect(container.textContent).toContain('Rate from 3 h ago')

    mocks.rate = { live: at(50, true), loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }} />),
    )
    expect(container.textContent).toContain('Rate from 2 days ago')

    mocks.rate = { live: at(0, false), loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: 0.0025, source: 'manual' }} />),
    )
    expect(container.textContent).not.toContain('Rate from')
  })

  it('shows the age of a cached rate even when it is the rate in use (prefill from a 2-day-old cache)', async () => {
    mocks.rate = { live: at(50, true), loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: null, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    expect(latest).toEqual({ currency: 'VND', rate: LIVE.rate, source: 'online' })
    expect(button('Use this')).toBeUndefined()
    expect(container.textContent).toContain('Rate from 2 days ago')

    mocks.rate = { live: at(0, false), loading: false }
    await act(async () =>
      root.render(<Harness initial={{ currency: 'VND', rate: LIVE.rate, source: 'online' }} />),
    )
    expect(container.textContent).not.toContain('Rate from')
  })

  it('warns, without blocking, when the rate is more than 5x off today\'s in either direction', async () => {
    mocks.rate = { live: LIVE, loading: false }
    let latest: ConversionValue | undefined
    await act(async () =>
      root.render(
        <Harness initial={{ currency: 'VND', rate: LIVE.rate, source: 'online' }} onValue={(v) => (latest = v)} />,
      ),
    )
    expect(container.textContent).not.toContain('far from today')

    // "1 PHP = [405.87] VND" typed the wrong way round: 1 VND = 405.87 PHP.
    await type(rateInput()!, '0.002')
    expect(latest!.rate).toBeCloseTo(500, 6)
    expect(container.textContent).toContain("This is far from today's rate — check the direction.")
    expect(latest!.rate).toBeGreaterThan(0)

    await type(rateInput()!, '3000')
    expect(container.textContent).toContain('far from today')

    await type(rateInput()!, '420')
    expect(container.textContent).not.toContain('far from today')
  })
})

describe('OriginalAmountLine', () => {
  it('C18: shows the original amount of a converted bill', async () => {
    await act(async () => root.render(<OriginalAmountLine currency="VND" amount={500000} />))
    expect(container.textContent).toContain('500,000')
  })

  it('C18: renders nothing for a plain bill', async () => {
    await act(async () => root.render(<OriginalAmountLine currency={null} amount={null} />))
    expect(container.textContent).toBe('')
  })

  it('C18: renders nothing for a value that is not a currency code (it would throw in the formatter)', async () => {
    await act(async () => root.render(<OriginalAmountLine currency="vnd!" amount={500000} />))
    expect(container.textContent).toBe('')
  })
})

describe('PaidInSummary', () => {
  it('C17: reads "Paid in ... 1 PHP = 405.87 VND (locked)" for a converted bill', async () => {
    await act(async () =>
      root.render(
        <PaidInSummary
          balanceCurrency="PHP"
          originalCurrency="VND"
          originalTotal={500000}
          exchangeRate={1 / 405.868219}
        />,
      ),
    )
    expect(container.textContent).toContain('Paid in')
    expect(container.textContent).toContain('500,000')
    expect(container.textContent).toContain('1 PHP = 405.87 VND (locked)')
  })

  it('renders nothing for a plain bill or an invalid rate', async () => {
    await act(async () =>
      root.render(
        <PaidInSummary balanceCurrency="PHP" originalCurrency={null} originalTotal={null} exchangeRate={null} />,
      ),
    )
    expect(container.textContent).toBe('')
    await act(async () =>
      root.render(
        <PaidInSummary balanceCurrency="PHP" originalCurrency="VND" originalTotal={5} exchangeRate={0} />,
      ),
    )
    expect(container.textContent).toBe('')
  })
})
