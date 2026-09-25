import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/app-store'

describe('pullStale store flag', () => {
  it('defaults to false and toggles via setter', () => {
    expect(useAppStore.getState().pullStale).toBe(false)
    useAppStore.getState().setPullStale(true)
    expect(useAppStore.getState().pullStale).toBe(true)
    useAppStore.getState().setPullStale(false)
    expect(useAppStore.getState().pullStale).toBe(false)
  })
})

/**
 * loading-bar-refresh-landing: the screen-load counter every useServerData fetch holds a pair on.
 * The top bar is shown while it is above zero, so a count that can go negative (an extra release)
 * would make the NEXT fetch invisible, and one that leaks upward would pin the bar on for good.
 */
describe('screenLoadCount', () => {
  it('C10: starts at 0, counts concurrent loads and returns to 0 when every one ends', () => {
    expect(useAppStore.getState().screenLoadCount).toBe(0)
    const s = () => useAppStore.getState()
    s().beginScreenLoad()
    s().beginScreenLoad()
    expect(s().screenLoadCount).toBe(2)
    s().endScreenLoad()
    expect(s().screenLoadCount).toBe(1)
    s().endScreenLoad()
    expect(s().screenLoadCount).toBe(0)
  })

  it('C4: an extra end never takes the count below 0', () => {
    useAppStore.setState({ screenLoadCount: 0 })
    useAppStore.getState().endScreenLoad()
    useAppStore.getState().endScreenLoad()
    expect(useAppStore.getState().screenLoadCount).toBe(0)
    // The next load is still counted, not absorbed by a negative balance.
    useAppStore.getState().beginScreenLoad()
    expect(useAppStore.getState().screenLoadCount).toBe(1)
    useAppStore.getState().endScreenLoad()
    expect(useAppStore.getState().screenLoadCount).toBe(0)
  })
})
