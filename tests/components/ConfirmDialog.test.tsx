import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

/**
 * perf-pass-1, C17. While `onConfirm` is pending the confirm button used to read a bare "…",
 * which told the user nothing about what was happening (and on a slow write looked frozen). It
 * now says what it is doing — `pendingLabel`, defaulting to the confirm label plus an ellipsis
 * (U+2026) — and shows a spinner.
 *
 * Driven with React's own `act` + `react-dom/client`, like `tests/components/SplitPersonSelector.test.tsx`.
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type Props = Parameters<typeof ConfirmDialog>[0]

async function render(over: Partial<Props>) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Delete this bill?',
    description: 'This removes it for everyone on the bill.',
    onConfirm: vi.fn(),
    ...over,
  }
  await act(async () => root.render(<ConfirmDialog {...props} />))
  return props
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')]
}

/** The confirm button is the one that is not "Cancel". */
function confirmButton(): HTMLButtonElement {
  const btn = buttons().find((b) => b.textContent?.trim() !== 'Cancel')
  if (!btn) throw new Error('confirm button not rendered')
  return btn
}

function cancelButton(): HTMLButtonElement {
  const btn = buttons().find((b) => b.textContent?.trim() === 'Cancel')
  if (!btn) throw new Error('cancel button not rendered')
  return btn
}

describe('ConfirmDialog pending state', () => {
  it('C17: shows the confirm label and no spinner before it is pressed', async () => {
    await render({ confirmLabel: 'Delete bill', variant: 'danger' })

    expect(confirmButton().textContent?.trim()).toBe('Delete bill')
    expect(confirmButton().querySelector('svg')).toBeNull()
    expect(confirmButton().disabled).toBe(false)
  })

  it('C17: while pending, shows the default pending label (confirm label + ellipsis) and a spinner', async () => {
    const pending = deferred()
    const props = await render({
      confirmLabel: 'Delete bill',
      variant: 'danger',
      onConfirm: () => pending.promise,
    })

    await act(async () => confirmButton().click())

    expect(confirmButton().textContent?.trim()).toBe('Delete bill…')
    expect(confirmButton().querySelector('svg')).not.toBeNull()
    // Neither button can fire a second action while the first is in flight.
    expect(confirmButton().disabled).toBe(true)
    expect(cancelButton().disabled).toBe(true)
    expect(props.onOpenChange).not.toHaveBeenCalled()

    await act(async () => pending.resolve())

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('C17: while pending, shows an explicit pendingLabel instead of the default', async () => {
    const pending = deferred()
    await render({
      confirmLabel: 'Remove member',
      pendingLabel: 'Removing…',
      onConfirm: () => pending.promise,
    } as Partial<Props>)

    await act(async () => confirmButton().click())

    expect(confirmButton().textContent?.trim()).toBe('Removing…')
    expect(confirmButton().querySelector('svg')).not.toBeNull()

    await act(async () => pending.resolve())
  })

  it('C17: with no confirmLabel the default pending label is "Confirm…"', async () => {
    const pending = deferred()
    await render({ onConfirm: () => pending.promise })

    expect(confirmButton().textContent?.trim()).toBe('Confirm')
    await act(async () => confirmButton().click())
    expect(confirmButton().textContent?.trim()).toBe('Confirm…')

    await act(async () => pending.resolve())
  })

  it('C17: a second press while pending does not call onConfirm again', async () => {
    const pending = deferred()
    const onConfirm = vi.fn(() => pending.promise)
    await render({ confirmLabel: 'Delete bill', onConfirm })

    await act(async () => confirmButton().click())
    await act(async () => confirmButton().click())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve())
  })

  it('C17: a synchronous onConfirm closes the dialog and never sticks on the pending label', async () => {
    const props = await render({ confirmLabel: 'Leave group', onConfirm: vi.fn() })

    await act(async () => confirmButton().click())

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(confirmButton().textContent?.trim()).toBe('Leave group')
    expect(confirmButton().querySelector('svg')).toBeNull()
  })
})
