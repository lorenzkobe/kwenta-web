import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { db } from '@/db/db'
import { KWENTA_LAST_CHECKED_STORAGE_KEY, KWENTA_LAST_REFRESH_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { makeProfile, resetDb } from '../helpers/db'

/**
 * An open that only asks the server "anything new?" leaves the full-refresh marker hours or days
 * old. The header reads freshness from the newer of that marker and the check marker, so a copy
 * the server just confirmed current does not read "Data may be behind".
 */

vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'ME', profile: undefined }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}))

import { RefreshButton } from '@/components/common/RefreshButton'

let container: HTMLDivElement
let root: Root
const text = () => container.textContent ?? ''
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const HOUR = 60 * 60 * 1000

async function render() {
  await act(async () => root.render(<RefreshButton showLastUpdated />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  useAppStore.setState({ screenLoadCount: 0, syncStatus: 'idle', isOnline: true, pullStale: false, syncRetryAt: null })
  await db.profiles.add(makeProfile({ id: 'ME' }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('RefreshButton freshness', () => {
  it('a recent check reads current although the full refresh is hours old', async () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, ago(5 * HOUR))
    localStorage.setItem(KWENTA_LAST_CHECKED_STORAGE_KEY, ago(1000))
    await render()
    expect(text()).not.toContain('Data may be behind')
    expect(text()).toContain('Updated just now')
  })

  it('both markers old reads behind', async () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, ago(5 * HOUR))
    localStorage.setItem(KWENTA_LAST_CHECKED_STORAGE_KEY, ago(2 * HOUR))
    await render()
    expect(text()).toContain('Data may be behind')
  })

  it('a check marker dated in the future does not read as fresh', async () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, ago(5 * HOUR))
    localStorage.setItem(KWENTA_LAST_CHECKED_STORAGE_KEY, new Date(Date.now() + HOUR).toISOString())
    await render()
    expect(text()).toContain('Data may be behind')
  })

  it('a check made while the header is on screen updates it without waiting for a tick', async () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, ago(5 * HOUR))
    await render()
    expect(text()).toContain('Data may be behind')
    await act(async () => useAppStore.getState().markServerChecked())
    expect(text()).not.toContain('Data may be behind')
    expect(text()).toContain('Updated just now')
  })
})
