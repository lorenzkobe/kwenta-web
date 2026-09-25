import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SCREEN_LOADING_DELAY_MS, useScreenLoading } from '@/hooks/useScreenLoading'
import { useAppStore } from '@/store/app-store'

/**
 * The ONE signal the header's loading bar and the Refresh button's "Updating…" both read: the
 * screen-load counter, debounced so that a fetch shorter than the delay never flashes anything,
 * and dropped immediately when the last fetch ends so nothing lingers after the data is in.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({ screenLoadCount: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState({ screenLoadCount: 0 })
  vi.useRealTimers()
})

function Probe({ seen }: { seen: boolean[] }) {
  seen.push(useScreenLoading())
  return null
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

async function begin() {
  await act(async () => useAppStore.getState().beginScreenLoad())
}

async function end() {
  await act(async () => useAppStore.getState().endScreenLoad())
}

describe('useScreenLoading', () => {
  // The requirement names the number: shown only after 200ms of continuous load.
  it('C3: the delay is 200ms', () => {
    expect(SCREEN_LOADING_DELAY_MS).toBe(200)
  })

  it('is false with nothing loading', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await advance(1000)
    expect(seen.every((v) => v === false)).toBe(true)
  })

  it('C2: turns true once a load has lasted the full delay', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await begin()
    await advance(199)
    expect(seen.at(-1)).toBe(false)
    await advance(1)
    expect(seen.at(-1)).toBe(true)
  })

  it('C3: a load that ends before the delay never reports true (no flash)', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await begin()
    await advance(150)
    await end()
    await advance(1000)
    expect(seen).not.toContain(true)
  })

  it('C3: the delay needs CONTINUOUS load — a gap restarts it', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await begin()
    await advance(150)
    await end()
    await begin()
    // 250ms after the first begin, but only 100ms into the second continuous stretch.
    await advance(100)
    expect(seen).not.toContain(true)
    await advance(100)
    expect(seen.at(-1)).toBe(true)
  })

  it('C4: drops to false immediately when the count reaches 0, with no trailing delay', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await begin()
    await advance(300)
    expect(seen.at(-1)).toBe(true)
    await end()
    // No timer advance: the very render that sees 0 must already be false.
    expect(seen.at(-1)).toBe(false)
  })

  it('C10: stays true while one of two concurrent loads is still running', async () => {
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    await begin()
    await begin()
    await advance(250)
    expect(seen.at(-1)).toBe(true)
    await end()
    await advance(1000)
    expect(seen.at(-1)).toBe(true)
    await end()
    expect(seen.at(-1)).toBe(false)
  })

  it('C3: a count already above 0 at mount still waits the full delay', async () => {
    useAppStore.setState({ screenLoadCount: 1 })
    const seen: boolean[] = []
    await act(async () => root.render(<Probe seen={seen} />))
    expect(seen.at(-1)).toBe(false)
    await advance(199)
    expect(seen.at(-1)).toBe(false)
    await advance(1)
    expect(seen.at(-1)).toBe(true)
  })
})
