import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// The button's network and Dexie edges; the state under test is the store + the load counter.
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn() }))
vi.mock('@/sync/sync-service', () => ({
  getMillisecondsSinceLastRefresh: () => 0,
  hasUnsyncedLocalDataForUser: async () => false,
  mayHaveStagedRows: async () => false,
}))
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: null, profile: undefined }) }))
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _deps: unknown, fallback?: unknown) => fallback,
}))

import { RefreshButton } from '@/components/common/RefreshButton'
import { useAppStore } from '@/store/app-store'

/**
 * The header Refresh button is the revalidation marker now that the per-page chip is gone: while a
 * screen fetch has been in flight for the debounce delay it reads "Updating…" and spins — driven
 * by the SAME debounced signal as the top bar, so the two never disagree for a frame — yet stays
 * pressable, is marked busy, and does not announce each revalidation through its live region.
 */

let container: HTMLDivElement
let root: Root

const button = () => container.querySelector('button') as HTMLButtonElement
const icon = () => button().querySelector('svg') as SVGElement
const liveText = () =>
  Array.from(container.querySelectorAll('[aria-live]'))
    .map((el) => el.textContent ?? '')
    .join('|')

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({
    screenLoadCount: 0,
    syncStatus: 'idle',
    isOnline: true,
    pullStale: false,
    syncRetryAt: null,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState({ screenLoadCount: 0, syncStatus: 'idle', isOnline: true })
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

async function render() {
  await act(async () => root.render(<RefreshButton showLastUpdated />))
}

describe('RefreshButton — updating', () => {
  it('C2: reads "Updating…" and spins while a screen fetch has been in flight for 200ms', async () => {
    await render()
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(200)

    expect(button().textContent).toContain('Updating…')
    expect(icon().getAttribute('class') ?? '').toContain('animate-spin')
    await act(async () => useAppStore.getState().endScreenLoad())
    expect(button().textContent).not.toContain('Updating…')
    expect(button().textContent).toContain('Refresh')
  })

  it('C12: before the 200ms delay the button still reads "Refresh" — same debounced signal as the bar', async () => {
    await render()
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(199)
    expect(button().textContent).not.toContain('Updating…')
    expect(icon().getAttribute('class') ?? '').not.toContain('animate-spin')
    await advance(1)
    expect(button().textContent).toContain('Updating…')
  })

  it('C3/C12: a fetch shorter than 200ms never flips the label', async () => {
    await render()
    await act(async () => useAppStore.getState().beginScreenLoad())
    let everUpdating = false
    for (let i = 0; i < 19; i++) {
      await advance(10)
      everUpdating ||= (button().textContent ?? '').includes('Updating…')
    }
    await act(async () => useAppStore.getState().endScreenLoad())
    await advance(500)
    everUpdating ||= (button().textContent ?? '').includes('Updating…')
    expect(everUpdating).toBe(false)
  })

  it('C6: updating does not disable the button', async () => {
    await render()
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(250)
    expect(button().textContent).toContain('Updating…')
    expect(button().disabled).toBe(false)
  })

  it('C13: updating sets aria-busy and is not announced through the live region', async () => {
    await render()
    expect(button().getAttribute('aria-busy')).not.toBe('true')
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(250)
    expect(button().getAttribute('aria-busy')).toBe('true')
    expect(liveText()).not.toContain('Updating')
  })

  it('C5: offline with a screen load in flight reads "Offline", not "Updating…", and stays disabled', async () => {
    useAppStore.setState({ isOnline: false, screenLoadCount: 1 })
    await render()
    await advance(1000)
    expect(button().textContent).toContain('Offline')
    expect(button().textContent).not.toContain('Updating…')
    expect(button().disabled).toBe(true)
  })

  it('C6: a running sync outranks updating ("Refreshing…", disabled)', async () => {
    useAppStore.setState({ syncStatus: 'syncing', screenLoadCount: 1 })
    await render()
    await advance(1000)
    expect(button().textContent).toContain('Refreshing…')
    expect(button().textContent).not.toContain('Updating…')
    expect(button().disabled).toBe(true)
  })
})

describe('RefreshButton — phone width', () => {
  /**
   * C7 (proxy): happy-dom has no layout, so the reported "empty space right of the label on a
   * 375px phone" is pinned by its cause — the label's reserved min-width applying below `sm`.
   * A reserved width may only apply at `sm:` and up; `min-w-0` (a flex shrink fix) is not one.
   */
  it('C7: reserves no label width below the sm breakpoint', async () => {
    await render()
    const els = [button(), ...Array.from(button().querySelectorAll('*'))]
    const unprefixedMinWidths = els
      .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
      .filter((token) => /^min-w-/.test(token) && token !== 'min-w-0')
    expect(unprefixedMinWidths).toEqual([])
  })
})
