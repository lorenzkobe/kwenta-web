import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { clearApiCache } from '@/api/cache'
import { clearPrimedReads } from '@/api/primed-reads'
import { resetAutoRepairGuard } from '@/lib/kwenta-data-repair'
import {
  KWENTA_LAST_REFRESH_STORAGE_KEY,
  KWENTA_LEGACY_LAST_PULL_STORAGE_KEY,
} from '@/lib/kwenta-storage-keys'

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
  localStorage.removeItem(KWENTA_LAST_REFRESH_STORAGE_KEY)
  // Legacy cursor from the incremental-pull era; drop it too so an account switch on an
  // upgraded device cannot inherit the previous user's marker.
  localStorage.removeItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)
  useAppStore.getState().setInitialCloudHydration('pending')
  // Cached RPC responses hold balances and contact names. Leaving them would show the previous
  // account's money to whoever signs in next on this device.
  clearApiCache()
  // Same reason, in memory: a payload a write primed is the previous account's data too, and the
  // mounted-endpoint registry describes screens that belong to a session which has just ended.
  clearPrimedReads()
  // Module state, not storage — it outlives the account that set it. Without this the next
  // account to sign in on this tab (no page reload) is refused its own once-per-session repair.
  resetAutoRepairGuard()
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
