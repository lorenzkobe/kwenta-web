import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/app-store'
import { markReadMounted, markReadUnmounted } from '@/api/primed-reads'

export type ServerDataState<T> = {
  data: T | undefined
  loading: boolean
  error: string | null
  /** True when the rendered data came from the offline cache rather than the server. */
  fromCache: boolean
  /** When the rendered data was fetched, ISO. */
  fetchedAt: string | null
  refresh: () => void
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
 * behaves as before — it simply fetches again.
 */
export function useServerData<T>(
  fetcher: (() => Promise<{ data: T; fromCache: boolean; fetchedAt: string }>) | null,
  deps: readonly unknown[],
  endpointKey?: string,
): ServerDataState<T> {
  const dataVersion = useAppStore((s) => s.dataVersion)
  const isOnline = useAppStore((s) => s.isOnline)

  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(fetcher !== null)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [manualTick, setManualTick] = useState(0)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  // Guards a slow earlier response from overwriting a newer one.
  const runIdRef = useRef(0)

  // Separates "the subject changed" from "the same subject may have new data". `dataVersion`,
  // `manualTick` and `isOnline` are invalidation ticks: the answer they produce replaces the
  // current one, so the current one must stay on screen while it loads. `deps` identify WHOSE
  // answer this is, and a change there makes the rendered payload belong to someone else —
  // /app/people/alice → /app/people/bob reuses this hook without remounting, and without this
  // reset Bob's page renders Alice's balance under Bob's name until the fetch resolves.
  const prevDepsRef = useRef<readonly unknown[]>(deps)

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
    const prev = prevDepsRef.current
    const subjectChanged =
      prev.length !== deps.length || prev.some((d, i) => !Object.is(d, deps[i]))
    prevDepsRef.current = deps
    if (subjectChanged) {
      setData(undefined)
      setError(null)
      setFromCache(false)
      setFetchedAt(null)
    }
    if (!call) {
      // Every field describes the previous subject; leaving any of them behind lets a caller
      // render a stale error or a stale "saved copy" line against nothing.
      setData(undefined)
      setError(null)
      setFromCache(false)
      setFetchedAt(null)
      setLoading(false)
      return
    }
    const runId = ++runIdRef.current
    let cancelled = false
    setLoading(true)
    void call()
      .then((result) => {
        if (cancelled || runId !== runIdRef.current) return
        setData(result.data)
        setFromCache(result.fromCache)
        setFetchedAt(result.fetchedAt)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled || runId !== runIdRef.current) return
        setError(err instanceof Error ? err.message : 'Could not load this screen.')
      })
      .finally(() => {
        if (cancelled || runId !== runIdRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, manualTick, isOnline])

  const refresh = useCallback(() => setManualTick((n) => n + 1), [])

  return { data, loading, error, fromCache, fetchedAt, refresh }
}
