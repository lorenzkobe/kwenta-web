import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { clearKwentaLocalData, KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import {
  KWENTA_LAST_REFRESH_STORAGE_KEY,
  KWENTA_LEGACY_LAST_PULL_STORAGE_KEY,
} from '@/lib/kwenta-storage-keys'
import { maybeAutoRepairData } from '@/lib/kwenta-data-repair'
import { useAppStore } from '@/store/app-store'
import { makeProfile, resetDb } from '../helpers/db'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: { orphans: 0, duplicates: 0, canonicalized: 0, total: 0 }, error: null })),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

vi.mock('@/sync/sync-service', () => ({
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] as string[] })),
}))

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  mocks.rpc.mockClear()
})

describe('clearKwentaLocalData', () => {
  it('wipes Dexie rows but leaves the DB usable', async () => {
    await db.profiles.add(makeProfile({ id: 'A' }))
    expect(await db.profiles.count()).toBe(1)

    await clearKwentaLocalData()

    // DB is re-opened empty, so reads succeed and return nothing.
    expect(await db.profiles.count()).toBe(0)
  })

  it('removes Kwenta-specific localStorage keys', async () => {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, 'user-1')
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, '2026-01-01T00:00:00Z')
    // Legacy cursor from the incremental-pull era: must not survive an account switch on a
    // shared device, or the next user inherits a "we are hydrated" marker.
    localStorage.setItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY, '2026-01-01T00:00:00Z')
    localStorage.setItem('kwenta_account_banner_dismissed', '1')
    localStorage.setItem('kwenta_notification_outbox_v1', '[]')

    await clearKwentaLocalData()

    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBeNull()
    expect(localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('kwenta_account_banner_dismissed')).toBeNull()
    expect(localStorage.getItem('kwenta_notification_outbox_v1')).toBeNull()
  })

  it('removes every per-user unread-count cache', async () => {
    localStorage.setItem('kwenta_notifications_unread:user-1', '3')
    localStorage.setItem('kwenta_notifications_unread:user-2', '5')
    localStorage.setItem('unrelated_key', 'keep-me')

    await clearKwentaLocalData()

    expect(localStorage.getItem('kwenta_notifications_unread:user-1')).toBeNull()
    expect(localStorage.getItem('kwenta_notifications_unread:user-2')).toBeNull()
    expect(localStorage.getItem('unrelated_key')).toBe('keep-me')
  })

  it('resets initial cloud hydration to pending', async () => {
    useAppStore.getState().setInitialCloudHydration('ready')
    await clearKwentaLocalData()
    expect(useAppStore.getState().initialCloudHydration).toBe('pending')
  })

  it('releases the once-per-session auto-repair guard for the next account', async () => {
    // The guard is module state, so it outlives the account that set it. Without clearing it, a
    // second account signing in on the same tab (no page reload) is refused its own repair for
    // the rest of the session and keeps whatever wrong balances the artifacts cause.
    await maybeAutoRepairData('user-1')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)

    await maybeAutoRepairData('user-1') // same session: guard holds
    expect(mocks.rpc).toHaveBeenCalledTimes(1)

    await clearKwentaLocalData()

    await maybeAutoRepairData('user-2')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
})
