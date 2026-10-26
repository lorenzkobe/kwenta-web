import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { relevantDataVersion, useAppStore } from '@/store/app-store'
import { markReadMounted, markReadUnmounted } from '@/api/primed-reads'
import { readCache } from '@/api/cache'
import { ApiError, ServerDeclinedError } from '@/api/balances'

export type ServerDataState<T> = {
  data: T | undefined
  loading: boolean
  error: string | null
  /** True when the rendered data came from the offline cache rather than the server. */
  fromCache: boolean
  /** When the rendered data was fetched, ISO. */
  fetchedAt: string | null
  /**
   * True while a saved copy is on screen and the server answer for it is still in flight. The
   * header's loading bar and Refresh button ("Updating…") mark the revalidation itself; a screen
   * keeps `SavedCopyNotice` for the case where the FINAL answer is the saved copy
   * (`fromCache && !revalidating`), and may disable an action that must not act on the copy.
   */
  revalidating: boolean
  refresh: () => void
}

type Snapshot<T> = {
  /** The deps this snapshot answers for; a mismatch at render time means the subject changed. */
  subject: readonly unknown[]
  data: T | undefined
  loading: boolean
  error: string | null
  fromCache: boolean
  fetchedAt: string | null
  revalidating: boolean
  /** A saved copy is loaded but not shown: online, a screen shows its skeleton until the answer. */
  held: boolean
}

/** How long an opened screen shows its skeleton before falling back to its saved copy. */
export const SAVED_COPY_FALLBACK_MS = 2000

const SAVED_COPY_TOAST_ID = 'server-data-saved-copy'
const SLOW_TOAST = 'Still loading. Showing your saved copy for now.'
const FAILED_TOAST = "Couldn't load the latest data. Showing your saved copy."

// Hooks currently showing a copy because the server was slow; the shared toast stays until the
// last of them answers, so one fast screen does not dismiss it while another is still waiting.
const slowHooks = new Set<symbol>()

function releaseSlow(token: symbol): void {
  if (!slowHooks.delete(token)) return
  if (slowHooks.size === 0) toast.dismiss(SAVED_COPY_TOAST_ID)
}

function warnSavedCopy(token: symbol): void {
  slowHooks.delete(token)
  toast.warning(FAILED_TOAST, { id: SAVED_COPY_TOAST_ID })
}

const EMPTY = {
  data: undefined,
  loading: false,
  error: null,
  fromCache: false,
  fetchedAt: null,
  revalidating: false,
  held: false,
} as const

function isEmpty<T>(s: Snapshot<T>): boolean {
  return (
    s.data === undefined &&
    !s.loading &&
    s.error === null &&
    !s.fromCache &&
    s.fetchedAt === null &&
    !s.revalidating &&
    !s.held
  )
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((d, i) => Object.is(d, b[i]))
}

/**
 * The first answer for a subject: its last saved copy when one exists for THIS user, else
 * nothing. A null user must never be read as a cache key (`<prefix>null:<endpoint>`), and another
 * user's entry on the same device is never a candidate because the key is user-scoped. Online the
 * copy is held back, so the screen shows its skeleton instead of jumping from the saved numbers
 * to the fresh ones; offline it is all there is and shows at once.
 */
function initialSnapshot<T>(
  subject: readonly unknown[],
  hasFetcher: boolean,
  endpointKey: string | undefined,
  userId: string | null,
  online: boolean,
): Snapshot<T> {
  const cached =
    hasFetcher && endpointKey && typeof userId === 'string' && userId !== ''
      ? readCache<T>(endpointKey, userId)
      : null
  if (cached) {
    return {
      subject,
      data: cached.data,
      loading: true,
      error: null,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
      revalidating: true,
      held: online,
    }
  }
  return { subject, ...EMPTY, loading: hasFetcher }
}

/**
 * The server said the viewer may not have this. `fetchEndpoint` throws an `ApiError` with this
 * prefix for an authorization failure (it never serves the cache then), and `ServerDeclinedError`
 * for a refusal. Either way a saved copy must not outlive the answer: losing access must not read
 * as staleness.
 */
function isLostAccess(err: unknown): boolean {
  if (err instanceof ServerDeclinedError) return true
  return err instanceof ApiError && err.message.startsWith('You no longer have access')
}

/**
 * Load data from a server endpoint, re-fetching whenever the app's `dataVersion` changes.
 *
 * Server-backed screens cannot use `useLiveQuery`: nothing writes to Dexie, so there is no local
 * change to observe. `dataVersion` is the invalidation signal instead — bumped by the refresh
 * control, by a completed sync, and by realtime.
 *
 * `fetcher` must be stable or wrapped in `useCallback`; it is tracked by ref so a new identity
 * does not itself trigger a fetch (that is the bug pattern that tore down and recreated the
 * notifications channel on every render).
 *
 * `endpointKey` is the api cache key this hook renders (`overview`, `group:<uuid>`, …). Declaring
 * it lets a mutation ask the server to recompute exactly the endpoints that are on screen and
 * return them with the write, so the re-read that follows costs no request. Omit it and the hook
 * behaves as before — it simply fetches again. The same key also loads the saved copy from the
 * api cache: offline it is painted on the first render; online it is held back while the screen
 * shows its skeleton, and shown (with a toast) only when the server takes longer than
 * `SAVED_COPY_FALLBACK_MS` or the fetch fails. An invalidation tick refreshes in place.
 */
/**
 * What a fetcher resolves to. `unsent` marks a device-only answer (a row this device has not sent
 * yet): it is flagged `fromCache`, but it is not a failed fetch and must not say so.
 */
export type ServerDataAnswer<T> = { data: T; fromCache: boolean; fetchedAt: string; unsent?: boolean }

export function useServerData<T>(
  fetcher: (() => Promise<ServerDataAnswer<T>>) | null,
  deps: readonly unknown[],
  endpointKey?: string,
): ServerDataState<T> {
  const dataVersion = useAppStore((s) => relevantDataVersion(s, endpointKey))
  const isOnline = useAppStore((s) => s.isOnline)
  const currentUserId = useAppStore((s) => s.currentUserId)

  const [state, setState] = useState<Snapshot<T>>(() =>
    initialSnapshot<T>(deps, fetcher !== null, endpointKey, currentUserId, isOnline),
  )
  const [manualTick, setManualTick] = useState(0)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // Guards a slow earlier response from overwriting a newer one.
  const runIdRef = useRef(0)
  const [slowToken] = useState(() => Symbol('server-data'))

  // Separates "the subject changed" from "the same subject may have new data". `dataVersion`,
  // `manualTick` and `isOnline` are invalidation ticks: the answer they produce replaces the
  // current one, so the current one must stay on screen while it loads. `deps` identify WHOSE
  // answer this is, and a change there makes the rendered payload belong to someone else —
  // /app/people/alice → /app/people/bob reuses this hook without remounting, and without this
  // reset Bob's page renders Alice's balance under Bob's name until the fetch resolves.
  //
  // Done during RENDER, not in the effect: an effect runs after the commit, so the frame that
  // switched subjects would already have painted the previous subject's payload.
  let view = state
  if (!sameDeps(state.subject, deps)) {
    view = initialSnapshot<T>(deps, fetcher !== null, endpointKey, currentUserId, isOnline)
    setState(view)
  }
  const viewRef = useRef(view)
  viewRef.current = view

  // Registered only while this screen is actually rendering the endpoint. A write asks for the
  // registered set, so a key left behind by an unmounted screen would make every mutation pay to
  // recompute a payload nobody is looking at.
  useEffect(() => {
    if (!endpointKey) return
    markReadMounted(endpointKey)
    return () => markReadUnmounted(endpointKey)
  }, [endpointKey])

  useEffect(() => {
    const call = fetcherRef.current
    if (!call) {
      // Every field describes the previous subject; leaving any of them behind lets a caller
      // render a stale error or a stale "saved copy" line against nothing.
      setState((s) => (isEmpty(s) ? s : { ...s, ...EMPTY }))
      return
    }
    const runId = ++runIdRef.current
    let cancelled = false
    // A tick over a saved copy is a revalidation too; offline it is only the cache answering
    // again, so the "saved copy" line stays up instead of flickering to "Updating…".
    setState((s) => ({
      ...s,
      loading: true,
      revalidating: s.revalidating || (isOnline && s.fromCache && s.data !== undefined),
      held: s.held && isOnline,
    }))
    // Two-argument `then`: a throw from the toast after an answer must not be read as a failed
    // fetch, which would discard the answer that just arrived.
    void call().then(
      (result) => {
        if (cancelled || runId !== runIdRef.current) return
        setState((s) => ({
          ...s,
          data: result.data,
          fromCache: result.fromCache,
          fetchedAt: result.fetchedAt,
          error: null,
          loading: false,
          revalidating: false,
          held: false,
        }))
        // Online, a cached answer means the request failed and fetchEndpoint fell back to the copy.
        if (isOnline && result.fromCache && !result.unsent) warnSavedCopy(slowToken)
        else releaseSlow(slowToken)
      },
      (err: unknown) => {
        if (cancelled || runId !== runIdRef.current) return
        const message = err instanceof Error ? err.message : 'Could not load this screen.'
        const lostAccess = isLostAccess(err)
        setState((s) => {
          if (lostAccess) return { ...s, ...EMPTY, error: message }
          return { ...s, error: message, loading: false, revalidating: false, held: false }
        })
        if (!lostAccess && isOnline && viewRef.current.data !== undefined) warnSavedCopy(slowToken)
        else releaseSlow(slowToken)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, manualTick, isOnline])

  // One begin/end pair per in-flight online fetch, keyed on the boolean so a subject change or an
  // invalidation tick mid-fetch keeps the pair it already holds. Offline a fetch is only the cache
  // answering again, which is not an update the header should announce.
  const holdsScreenLoad = view.loading && isOnline

  // Keyed on the subject too, so switching to another held subject restarts the wait for it.
  const held = view.held
  const heldSubject = view.subject
  useEffect(() => {
    if (!held) return
    const id = window.setTimeout(() => {
      setState((s) => (s.held ? { ...s, held: false } : s))
      slowHooks.add(slowToken)
      toast.info(SLOW_TOAST, { id: SAVED_COPY_TOAST_ID })
    }, SAVED_COPY_FALLBACK_MS)
    return () => window.clearTimeout(id)
  }, [held, heldSubject, slowToken])

  useEffect(() => () => releaseSlow(slowToken), [slowToken])

  useEffect(() => {
    if (!holdsScreenLoad) return
    const { beginScreenLoad, endScreenLoad } = useAppStore.getState()
    beginScreenLoad()
    return endScreenLoad
  }, [holdsScreenLoad])

  const refresh = useCallback(() => setManualTick((n) => n + 1), [])

  if (view.held) {
    return { data: undefined, loading: view.loading, error: view.error, fromCache: false, fetchedAt: null, revalidating: false, refresh }
  }
  return {
    data: view.data,
    loading: view.loading,
    error: view.error,
    fromCache: view.fromCache,
    fetchedAt: view.fetchedAt,
    revalidating: view.revalidating,
    refresh,
  }
}
