import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { relevantDataVersion, useAppStore } from '@/store/app-store'
import { useServerData } from '@/hooks/useServerData'
import { clearPrimedReads } from '@/api/primed-reads'

/**
 * Scoped refresh (C27, C28): a write may bump `dataVersion` while naming families it cannot have
 * changed. Each family's skipped bumps are COUNTED and subtracted, so a screen watches
 * `dataVersion - skippedBumps[family]`. Arithmetic rather than a "last bump skipped me" flag: two
 * bumps coalesced into one render must still refetch if either of them was meant for the screen.
 */

function reset() {
  useAppStore.setState({ dataVersion: 0, skippedBumps: {} })
}

describe('relevantDataVersion', () => {
  beforeEach(reset)

  it('C27: starts at the raw dataVersion with no skips recorded', () => {
    expect(useAppStore.getState().skippedBumps).toEqual({})
    expect(relevantDataVersion(useAppStore.getState(), 'bill-payments:B1')).toBe(0)
  })

  it('C24/C27: a skipped bump moves every family except the skipped ones', () => {
    useAppStore.getState().bumpDataVersion(['bill-payments', 'person-payments'])
    const s = useAppStore.getState()
    expect(s.dataVersion).toBe(1)
    expect(s.skippedBumps['bill-payments']).toBe(1)
    expect(relevantDataVersion(s, 'bill-payments:B1')).toBe(0)
    expect(relevantDataVersion(s, 'person-payments:P1')).toBe(0)
    expect(relevantDataVersion(s, 'group:G1')).toBe(1)
    expect(relevantDataVersion(s, 'group-payments:G1')).toBe(1)
    expect(relevantDataVersion(s, 'overview')).toBe(1)
  })

  it('C27: a skipped bump followed by a full bump still moves the skipped family by one', () => {
    useAppStore.getState().bumpDataVersion(['bill-payments'])
    useAppStore.getState().bumpDataVersion()
    const s = useAppStore.getState()
    expect(s.dataVersion).toBe(2)
    expect(relevantDataVersion(s, 'bill-payments:B1')).toBe(1)
    expect(relevantDataVersion(s, 'group:G1')).toBe(2)
  })

  it('C27: the family is the key prefix before the first colon, never a substring match', () => {
    useAppStore.getState().bumpDataVersion(['group'])
    const s = useAppStore.getState()
    expect(relevantDataVersion(s, 'group:G1')).toBe(0)
    expect(relevantDataVersion(s, 'group-payments:G1')).toBe(1)
    expect(relevantDataVersion(s, 'group-spending:G1')).toBe(1)
  })

  it('C28: with no key it is the raw dataVersion', () => {
    useAppStore.getState().bumpDataVersion(['bill-payments'])
    expect(relevantDataVersion(useAppStore.getState())).toBe(1)
  })

  it('C28: a plain bump (realtime, sync, refresh) moves every family', () => {
    useAppStore.getState().bumpDataVersion()
    const s = useAppStore.getState()
    for (const key of ['bill-payments:B', 'group-payments:G', 'person-payments:P', 'group-spending:G', 'group:G', 'personal-bills-page:mine:all::date_desc']) {
      expect(relevantDataVersion(s, key)).toBe(1)
    }
    expect(s.skippedBumps).toEqual({})
  })

  it('C28: an empty skip list is a plain bump', () => {
    useAppStore.getState().bumpDataVersion([])
    expect(relevantDataVersion(useAppStore.getState(), 'bill-payments:B')).toBe(1)
  })
})

let container: HTMLDivElement
let root: Root

function Probe({ endpointKey, calls }: { endpointKey: string; calls: string[] }) {
  useServerData(
    async () => {
      calls.push(endpointKey)
      return { data: endpointKey, fromCache: false, fetchedAt: '2026-10-25T00:00:00Z' }
    },
    ['subject'],
    endpointKey,
  )
  return null
}

describe('useServerData follows its family\'s relevant version', () => {
  beforeEach(() => {
    reset()
    clearPrimedReads()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('C24/C27: a skipped bump does not refetch the skipped screen; others refetch', async () => {
    const calls: string[] = []
    await act(async () => {
      root.render(
        <>
          <Probe endpointKey="bill-payments:B1" calls={calls} />
          <Probe endpointKey="group:G1" calls={calls} />
        </>,
      )
    })
    expect(calls.filter((k) => k === 'bill-payments:B1')).toHaveLength(1)
    expect(calls.filter((k) => k === 'group:G1')).toHaveLength(1)

    await act(async () => useAppStore.getState().bumpDataVersion(['bill-payments']))
    expect(calls.filter((k) => k === 'bill-payments:B1')).toHaveLength(1)
    expect(calls.filter((k) => k === 'group:G1')).toHaveLength(2)
  })

  it('C27: a skipped and a full bump in the same tick still refetch the skipped screen once', async () => {
    const calls: string[] = []
    await act(async () => {
      root.render(<Probe endpointKey="bill-payments:B1" calls={calls} />)
    })
    expect(calls).toHaveLength(1)

    await act(async () => {
      useAppStore.getState().bumpDataVersion(['bill-payments'])
      useAppStore.getState().bumpDataVersion()
    })
    expect(calls).toHaveLength(2)
  })

  it('C28: a plain bump refetches every screen', async () => {
    const calls: string[] = []
    await act(async () => {
      root.render(
        <>
          <Probe endpointKey="bill-payments:B1" calls={calls} />
          <Probe endpointKey="group-spending:G1" calls={calls} />
        </>,
      )
    })
    await act(async () => useAppStore.getState().bumpDataVersion())
    expect(calls.filter((k) => k === 'bill-payments:B1')).toHaveLength(2)
    expect(calls.filter((k) => k === 'group-spending:G1')).toHaveLength(2)
  })
})
