import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'

export const KWENTA_LOCAL_USER_KEY = 'kwenta_local_user_id'

const EXTRA_KEYS = [
  'kwenta_account_banner_dismissed',
  // Notification outbox (queued rows reference the now-wiped local DB; must not
  // survive an account switch on a shared device).
  'kwenta_notification_outbox_v1',
] as const

// Per-user unread-count caches: kwenta_notifications_unread:<userId>
const UNREAD_CACHE_PREFIX = 'kwenta_notifications_unread:'

/** Wipes IndexedDB and Kwenta-specific localStorage keys (after sign-out). */
export async function clearKwentaLocalData(): Promise<void> {
  await db.delete()
  // Re-open a fresh empty DB so post-sign-out hooks don't hit DatabaseClosedError.
  await db.open().catch(() => {
    /* best effort; next DB access will retry open */
  })
  localStorage.removeItem(KWENTA_LOCAL_USER_KEY)
  localStorage.removeItem(KWENTA_LAST_PULL_STORAGE_KEY)
  useAppStore.getState().setInitialCloudHydration('pending')
  for (const k of EXTRA_KEYS) {
    localStorage.removeItem(k)
  }
  // Remove every per-user unread cache so stale counts don't leak to the next account.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key && key.startsWith(UNREAD_CACHE_PREFIX)) {
      localStorage.removeItem(key)
    }
  }
}
