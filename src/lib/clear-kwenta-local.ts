import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { clearApiCache } from '@/api/cache'
import { clearPrimedReads } from '@/api/primed-reads'
import { resetAutoRepairGuard } from '@/lib/kwenta-data-repair'
import {
  KWENTA_LAST_REFRESH_STORAGE_KEY,
  KWENTA_LEGACY_LAST_PULL_STORAGE_KEY,
  realtimeCursorKey,
} from '@/lib/kwenta-storage-keys'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import { cancelScheduledDrainRetry } from '@/sync/write-queue'

export const KWENTA_LOCAL_USER_KEY = 'kwenta_local_user_id'

const EXTRA_KEYS = [
  'kwenta_account_banner_dismissed',
  // Notification outbox (queued rows reference the now-wiped local DB; must not
  // survive an account switch on a shared device).
  'kwenta_notification_outbox_v1',
] as const

// Per-user keys, removed for EVERY user: unread-count caches, realtime cursors (a stale one makes
// the next account's probe compare against someone else's server timestamp) and auto-repair stamps.
const PER_USER_PREFIXES = [
  'kwenta_notifications_unread:',
  realtimeCursorKey(''),
  'kwenta_auto_repair_at:',
] as const

/** Wipes IndexedDB and Kwenta-specific localStorage keys (after sign-out). */
export async function clearKwentaLocalData(): Promise<void> {
  // First, before anything is deleted: a response of the ending session that resolves from here on
  // must not write into the mirror the next account will use.
  bumpSessionEpoch()
  // The queue's retry timer belongs to the ending session (its callback also checks the epoch, so
  // this only stops a timer that would do nothing).
  cancelScheduledDrainRetry()
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
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key && PER_USER_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      localStorage.removeItem(key)
    }
  }
}
