import { useAppStore } from '@/store/app-store'

/**
 * The store flag (banner, sync manager, realtime, Refresh, notification flush) follows
 * `navigator.onLine`, which the write path reads directly. Browsers fire `online`/`offline` only on
 * a transition and never replay it, so a listener that was not mounted at that moment (login,
 * landing, a remount) or a resumed PWA that got no event left the flag "offline" while saves still
 * reached the cloud. Re-reading on every chance — and on any server answer — closes that.
 */
export function refreshOnlineStatus(): void {
  if (typeof navigator === 'undefined') return
  const online = navigator.onLine
  if (useAppStore.getState().isOnline !== online) useAppStore.getState().setOnline(online)
}

/** Starts following the connection; returns the cleanup. */
export function startOnlineStatusTracking(): () => void {
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') refreshOnlineStatus()
  }
  window.addEventListener('online', refreshOnlineStatus)
  window.addEventListener('offline', refreshOnlineStatus)
  window.addEventListener('pageshow', refreshOnlineStatus)
  window.addEventListener('focus', refreshOnlineStatus)
  document.addEventListener('visibilitychange', onVisibility)
  refreshOnlineStatus()
  return () => {
    window.removeEventListener('online', refreshOnlineStatus)
    window.removeEventListener('offline', refreshOnlineStatus)
    window.removeEventListener('pageshow', refreshOnlineStatus)
    window.removeEventListener('focus', refreshOnlineStatus)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
