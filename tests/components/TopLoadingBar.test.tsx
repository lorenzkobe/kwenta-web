import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TopLoadingBar } from '@/components/common/TopLoadingBar'
import { useAppStore } from '@/store/app-store'

/**
 * The header's loading bar replaced the per-page "Updating…" chip, which pushed the Groups list
 * down for the length of every revalidation. It shows while a screen fetch has run for the
 * debounce delay, or while a sync is in flight; nothing is rendered otherwise.
 */

let container: HTMLDivElement
let root: Root

const bar = () => container.querySelector('[data-testid="top-loading-bar"]')

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({ screenLoadCount: 0, syncStatus: 'idle', isOnline: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState({ screenLoadCount: 0, syncStatus: 'idle' })
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('TopLoadingBar', () => {
  it('renders nothing when no screen is loading and no sync is running', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await advance(1000)
    expect(bar()).toBeNull()
  })

  it('C2: appears once a screen fetch has been in flight for 200ms', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(199)
    expect(bar()).toBeNull()
    await advance(1)
    expect(bar()).not.toBeNull()
  })

  it('C3: a fetch shorter than 200ms never shows the bar', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    let everShown = false
    await act(async () => useAppStore.getState().beginScreenLoad())
    for (let i = 0; i < 19; i++) {
      await advance(10)
      everShown ||= bar() !== null
    }
    await act(async () => useAppStore.getState().endScreenLoad())
    await advance(1000)
    everShown ||= bar() !== null
    expect(everShown).toBe(false)
  })

  it('C4: disappears as soon as the last fetch ends', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await act(async () => useAppStore.getState().beginScreenLoad())
    await advance(250)
    expect(bar()).not.toBeNull()
    await act(async () => useAppStore.getState().endScreenLoad())
    expect(bar()).toBeNull()
  })

  it('C10: stays up until BOTH of two concurrent screen loads finish', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await act(async () => {
      useAppStore.getState().beginScreenLoad()
      useAppStore.getState().beginScreenLoad()
    })
    await advance(250)
    expect(bar()).not.toBeNull()
    await act(async () => useAppStore.getState().endScreenLoad())
    await advance(1000)
    expect(bar()).not.toBeNull()
    await act(async () => useAppStore.getState().endScreenLoad())
    expect(bar()).toBeNull()
  })

  it('C2: shows while a sync is running, with no screen fetch', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await act(async () => useAppStore.getState().setSyncStatus('syncing'))
    await advance(250)
    expect(bar()).not.toBeNull()
    await act(async () => useAppStore.getState().setSyncStatus('idle'))
    expect(bar()).toBeNull()
  })

  it('refused: a sync that ended in error does not keep the bar up', async () => {
    await act(async () => root.render(<TopLoadingBar />))
    await act(async () => useAppStore.getState().setSyncStatus('error'))
    await advance(1000)
    expect(bar()).toBeNull()
  })
})
