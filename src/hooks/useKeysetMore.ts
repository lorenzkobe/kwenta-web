import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export type KeysetPage<Row> = { rows: Row[]; matching: number }

type Options<Row, Cursor> = {
  userId: string | null
  /** Identifies the list (its filters and sort). Rows loaded for another key are never shown. */
  listKey: string
  /** The list's first page, from an ordinary cached read. Must keep its identity between renders. */
  page: KeysetPage<Row> | undefined
  /** True while `page` is a saved copy: a copy is never the base for a reload. */
  pageFromCache: boolean
  pageSize: number
  /** The most rows one `fetchAfter` call may be asked for. */
  maxPerCall: number
  cursorOf: (row: Row) => Cursor
  /** The rows strictly after `after` in the list's order. Read through a ref, so it may change identity. */
  fetchAfter: (after: Cursor, limit: number) => Promise<KeysetPage<Row>>
  errorMessage: string
}

/** Rows loaded past the first page by "Show more", for the list identified by `key`. */
type MoreRows<Row> = { key: string; rows: Row[]; matching: number }

/**
 * "Show more" over a keyset-paged list: the first page is the caller's cached read, this hook owns
 * the rows loaded after it.
 *
 * "Show more" asks only for the rows after the last one held, so nothing already loaded is
 * downloaded again and a row added meanwhile cannot shift onto two pages.
 */
export function useKeysetMore<Row, Cursor>({
  userId,
  listKey,
  page,
  pageFromCache,
  pageSize,
  maxPerCall,
  cursorOf,
  fetchAfter,
  errorMessage,
}: Options<Row, Cursor>) {
  const [more, setMore] = useState<MoreRows<Row> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloading, setReloading] = useState(false)
  // Bumped whenever the loaded list is replaced or reset, so a slower answer for the old list
  // is dropped instead of being appended to the new one.
  const generation = useRef(0)
  // A "Show more" tap whose answer arrives after the list was refreshed is asked again from the new
  // last row instead of being lost. Each tap has its own token, so a late answer from an older tap
  // can never re-issue a newer one; a filter, sort or tab change cancels the re-issue outright.
  const tapSeq = useRef(0)
  const pendingTap = useRef<number | null>(null)
  const retapWanted = useRef(false)
  const [retapAsk, setRetapAsk] = useState(0)
  // The state drives the button; the ref is the guard, so a tap and a re-issue in the same tick cannot both fetch.
  const loadingMoreRef = useRef(false)
  const fetchAfterRef = useRef(fetchAfter)
  fetchAfterRef.current = fetchAfter
  const listKeyRef = useRef(listKey)
  listKeyRef.current = listKey

  // A different list owns none of the rows, taps or re-issues of the old one, whether or not the
  // caller remembers to reset(). Declared first so it runs before the reload below reads the count.
  const seenKey = useRef(listKey)
  useEffect(() => {
    if (seenKey.current === listKey) return
    seenKey.current = listKey
    reset()
  }, [listKey])

  const extraRows = more && more.key === listKey ? more.rows : []
  const extraCount = useRef(0)
  useEffect(() => {
    extraCount.current = extraRows.length
  })

  // A fresh first page (a write, a sync, Refresh) means the rows loaded past it may be stale:
  // reload exactly that many, in one call or successive ones of at most `maxPerCall`, and replace
  // them. They stay on screen meanwhile — the list never snaps back to the first page.
  //
  // A fresh first page always supersedes a "Show more" still in flight (its rows were fetched
  // against the old list), and "Show more" is off while this reload runs, so the two can never
  // write the list in an order that resurrects a deleted row or drops appended rows.
  useEffect(() => {
    if (!userId || !page || pageFromCache) {
      setReloading(false)
      return
    }
    const mine = ++generation.current
    const held = extraCount.current
    if (held === 0) {
      setReloading(false)
      return
    }
    setReloading(true)
    let cancelled = false
    void (async () => {
      try {
        const rows: Row[] = []
        let last = page.rows[page.rows.length - 1]
        let matching = page.matching
        while (last && rows.length < held) {
          const res = await fetchAfterRef.current(cursorOf(last), Math.min(held - rows.length, maxPerCall))
          if (cancelled || mine !== generation.current) return
          if (res.rows.length === 0) break
          rows.push(...res.rows)
          last = rows[rows.length - 1]
          matching = res.matching
        }
        setMore({ key: listKey, rows, matching })
      } catch {
        // The rows already on screen stay; the next bump reloads them.
      } finally {
        if (mine === generation.current) setReloading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // cursorOf and maxPerCall are constants of the caller; fetchAfter is read through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageFromCache, userId, listKey])

  const rows = [...(page?.rows ?? []), ...extraRows]
  const matching = extraRows.length > 0 && more ? more.matching : (page?.matching ?? 0)
  const remaining = page ? matching - rows.length : 0

  function reset() {
    generation.current++
    pendingTap.current = null
    retapWanted.current = false
    loadingMoreRef.current = false
    setMore(null)
    setLoadingMore(false)
    setReloading(false)
  }

  async function showMore() {
    const last = rows[rows.length - 1]
    if (!userId || !last || loadingMoreRef.current || reloading) return
    const mine = generation.current
    const tapKey = listKey
    const token = ++tapSeq.current
    pendingTap.current = token
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await fetchAfterRef.current(cursorOf(last), pageSize)
      if (listKeyRef.current !== tapKey) {
        // The list changed under the tap: nothing of this answer belongs to the new one.
        if (pendingTap.current === token) pendingTap.current = null
        return
      }
      if (mine !== generation.current) {
        if (pendingTap.current === token) {
          retapWanted.current = true
          setRetapAsk((n) => n + 1)
        }
        return
      }
      pendingTap.current = null
      setMore({
        key: listKey,
        rows: [...extraRows, ...res.rows],
        // A page with nothing in it means the rest is gone; stop offering a button that does nothing.
        matching: res.rows.length > 0 ? res.matching : rows.length,
      })
    } catch (error) {
      if (pendingTap.current === token) pendingTap.current = null
      if (listKeyRef.current === tapKey) toast.error(error instanceof Error ? error.message : errorMessage)
    } finally {
      // Only the latest tap clears it: a stale answer must not unlock the button over a newer request.
      if (tapSeq.current === token && loadingMoreRef.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }

  const showMoreRef = useRef(showMore)
  showMoreRef.current = showMore
  useEffect(() => {
    if (!retapWanted.current || reloading || loadingMoreRef.current) return
    retapWanted.current = false
    pendingTap.current = null
    if (remaining > 0) void showMoreRef.current()
  }, [retapAsk, reloading, remaining])

  return { rows, remaining, loadingMore, reloading, showMore: () => void showMore(), reset }
}
