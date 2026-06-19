import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { clearKwentaLocalData, KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { makeProfile, resetDb } from '../helpers/db'

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
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
    localStorage.setItem(KWENTA_LAST_PULL_STORAGE_KEY, '2026-01-01T00:00:00Z')
    localStorage.setItem('kwenta_account_banner_dismissed', '1')
    localStorage.setItem('kwenta_notification_outbox_v1', '[]')

    await clearKwentaLocalData()

    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBeNull()
    expect(localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)).toBeNull()
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
})
