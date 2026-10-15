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
 * When the server last confirmed this device's mirror current WITHOUT a full refresh: an open whose
 * probe found no newer event, or a realtime catch-up that drained cleanly. Display/scheduling only,
 * stamped from the device clock like the refresh marker; it never filters a query.
 */
export const KWENTA_LAST_CHECKED_STORAGE_KEY = 'kwenta_last_checked'

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

function readParsable(key: string): string | null {
  try {
    const value = localStorage.getItem(key)
    return value && !Number.isNaN(Date.parse(value)) ? value : null
  } catch {
    return null
  }
}

/**
 * The newer of the full-refresh and check markers: when the server last vouched for this copy. A
 * check dated in the future (the clock moved back) is ignored: it would otherwise win over every
 * later full refresh until a catch-up happened to restamp it.
 */
export function readLastUpToDateAt(): string | null {
  if (typeof localStorage === 'undefined') return null
  const refreshed = readLastRefreshAt()
  const checked = readParsable(KWENTA_LAST_CHECKED_STORAGE_KEY)
  if (!checked || Date.parse(checked) > Date.now()) return refreshed
  if (!refreshed || Number.isNaN(Date.parse(refreshed))) return checked
  return Date.parse(checked) > Date.parse(refreshed) ? checked : refreshed
}

export function writeLastCheckedAt(at: string): void {
  try {
    localStorage.setItem(KWENTA_LAST_CHECKED_STORAGE_KEY, at)
  } catch {
    // Display only: the next check stamps it again.
  }
}

/**
 * Per-user key of the realtime cursor: the newest `kwenta_user_events.created_at` this device has
 * drained. Only ever written from SERVER timestamps (CLAUDE.md rule 7) — a device-clock value in
 * the future would hide every event until real time caught up, and the tab-focus probe
 * (`sync-manager`) asks the server for events newer than this.
 */
export function realtimeCursorKey(userId: string): string {
  return `kwenta_last_seen_user_event:${userId}`
}

/** The realtime cursor, or null when there is none (or storage cannot be read). */
export function readRealtimeCursor(userId: string): string | null {
  try {
    return localStorage.getItem(realtimeCursorKey(userId)) || null
  } catch {
    return null
  }
}

/** Moves the realtime cursor to a SERVER timestamp, never backwards. */
export function advanceRealtimeCursor(userId: string, serverCreatedAt: string | null): void {
  if (!serverCreatedAt) return
  const current = readRealtimeCursor(userId)
  if (current && Date.parse(serverCreatedAt) <= Date.parse(current)) return
  try {
    localStorage.setItem(realtimeCursorKey(userId), serverCreatedAt)
  } catch {
    // An unwritable cursor stays where it was; the next catch-up re-reads from there.
  }
}
