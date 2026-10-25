import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useOnlineStatusTracking } from '@/hooks/useOnlineStatusTracking'
import { refreshOnlineStatus } from '@/lib/online-status'
import { useAppStore } from '@/store/app-store'

/**
 * The banner, sync, realtime and Refresh all read the store flag, while saves read
 * `navigator.onLine`. The flag used to change only on an `online`/`offline` event heard while the
 * app shell was mounted, so a transition on /login (or a resume that fires no event) left it
 * "offline" for good: banner up, sync and realtime off, while saves still reached the cloud.
 */

let container: HTMLDivElement
let root: Root

function setNavigatorOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

function Probe() {
  useOnlineStatusTracking()
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setNavigatorOnline(true)
  useAppStore.setState({ isOnline: true })
})

describe('useOnlineStatusTracking', () => {
  it('C1: a flag left false while the device came back online is corrected on mount', async () => {
    useAppStore.setState({ isOnline: false })
    setNavigatorOnline(true)

    await act(async () => root.render(<Probe />))

    expect(useAppStore.getState().isOnline).toBe(true)
  })

  it.each([
    ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
    ['focus', () => window.dispatchEvent(new Event('focus'))],
  ])('C2: a %s with the device online corrects a stuck flag (a resume that fires no online event)', async (_name, fire) => {
    setNavigatorOnline(true)
    await act(async () => root.render(<Probe />))
    useAppStore.setState({ isOnline: false })

    await act(async () => fire())

    expect(useAppStore.getState().isOnline).toBe(true)
  })

  it('C3: an offline event, or a re-read that finds the device offline, sets the flag false', async () => {
    await act(async () => root.render(<Probe />))

    setNavigatorOnline(false)
    await act(async () => window.dispatchEvent(new Event('offline')))
    expect(useAppStore.getState().isOnline).toBe(false)

    setNavigatorOnline(true)
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(useAppStore.getState().isOnline).toBe(true)

    setNavigatorOnline(false)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(useAppStore.getState().isOnline).toBe(false)
  })

  it('C4: a re-read that finds nothing changed writes nothing to the store', async () => {
    setNavigatorOnline(true)
    await act(async () => root.render(<Probe />))
    let writes = 0
    const unsubscribe = useAppStore.subscribe(() => writes++)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      refreshOnlineStatus()
    })
    unsubscribe()

    expect(writes).toBe(0)
  })

  it('C5: after unmount nothing is listening any more', async () => {
    await act(async () => root.render(<Probe />))
    await act(async () => root.unmount())
    root = createRoot(container)
    useAppStore.setState({ isOnline: false })

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(useAppStore.getState().isOnline).toBe(false)
  })
})
