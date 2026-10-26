import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ChangeEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MoneyInput } from '@/components/common/MoneyInput'

/**
 * Every money field shows its currency before the number, so a user typing into a VND bill
 * sees ₫ while typing rather than only in the formatted summary afterwards.
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

const input = () => container.querySelector('input') as HTMLInputElement
const prefix = () => container.querySelector('[data-slot="currency-prefix"]')

async function typeInto(el: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('MoneyInput', () => {
  it('shows the currency symbol before the value and forwards typing', async () => {
    const onChange = vi.fn((e: ChangeEvent<HTMLInputElement>) => e.target.value)
    await act(async () => root.render(<MoneyInput currency="VND" value="" onChange={onChange} placeholder="0.00" />))

    expect(prefix()?.textContent).toBe('₫')
    expect(prefix()?.getAttribute('aria-hidden')).toBe('true')
    await typeInto(input(), '42000')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.results[0].value).toBe('42000')
  })

  it('pads the field further for a three-letter symbol than for a one-character one', async () => {
    await act(async () => root.render(<MoneyInput currency="PHP" value="1" onChange={() => {}} />))
    const narrow = parseFloat(input().style.paddingLeft)
    await act(async () => root.render(<MoneyInput currency="SGD" value="1" onChange={() => {}} />))
    expect(prefix()?.textContent).toBe('SGD')
    expect(parseFloat(input().style.paddingLeft)).toBeGreaterThan(narrow)
  })

  it('puts layout classes on the wrapper and field classes on the input', async () => {
    await act(async () =>
      root.render(
        <MoneyInput currency="PHP" value="" onChange={() => {}} className="w-24" inputClassName="h-8 text-right" />,
      ),
    )
    expect(container.firstElementChild!.className).toContain('w-24')
    expect(input().className).toContain('h-8')
    expect(input().className).toContain('text-right')
    expect(input().getAttribute('inputmode')).toBe('decimal')
  })

  it('tells screen readers the currency, keeping any description the caller passed', async () => {
    await act(async () =>
      root.render(
        <>
          <p id="hint">Must total the bill</p>
          <MoneyInput currency="VND" value="" onChange={() => {}} aria-describedby="hint" />
        </>,
      ),
    )
    const ids = (input().getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids).toContain('hint')
    const described = ids.map((id) => document.getElementById(id)?.textContent)
    expect(described).toContain('Amount in VND')
  })

  it('adds no id to the input and lets a tap on the symbol reach the field', async () => {
    await act(async () => root.render(<MoneyInput currency="PHP" value="" onChange={() => {}} />))
    expect(input().hasAttribute('id')).toBe(false)
    expect(prefix()!.className).toContain('pointer-events-none')
  })
})
