/**
 * Marker for the last SUCCESSFUL full cloud refresh; cleared on sign-out.
 *
 * Display/scheduling only — it records that we hold a complete snapshot as of that moment. It is
 * NOT a pull cursor: pulls always request the full bundle (`PULL_SINCE_EPOCH` in sync-service),
 * so a wrong or skewed value here can never cause a row to be missed. The previous design asked
 * the server for `updated_at > <this value>`, which permanently skipped rows on clock skew and
 * made server-side changes undeliverable.
 */
export const KWENTA_LAST_REFRESH_STORAGE_KEY = 'kwenta_last_refresh'

/**
 * Legacy cursor key (`kwenta_last_pull`) from the incremental-pull era. Read once so an existing
 * install counts as already-hydrated instead of re-gating the shell, then removed.
 */
export const KWENTA_LEGACY_LAST_PULL_STORAGE_KEY = 'kwenta_last_pull'

/**
 * Value of the refresh marker, migrating the legacy cursor key on first read. Returns null when
 * this device has never completed a full refresh.
 */
export function readLastRefreshAt(): string | null {
  if (typeof localStorage === 'undefined') return null
  let current: string | null = null
  let legacy: string | null = null
  try {
    current = localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)
    if (current) return current
    legacy = localStorage.getItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)
  } catch {
    return null
  }
  if (!legacy) return null
  // This read has a write in it (the one-time key migration), and it runs at module scope while
  // the app store is constructed. On a device where reads succeed but writes throw — Safari
  // private browsing, exhausted quota, storage partitioned after an upgrade — an unguarded
  // setItem here escapes during import of @/store/app-store and the app renders a blank screen
  // instead of degrading. Failing to migrate the key costs nothing: the value is returned either
  // way, and the migration retries on the next read.
  try {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, legacy)
    localStorage.removeItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)
  } catch {
    /* best effort */
  }
  return legacy
}
