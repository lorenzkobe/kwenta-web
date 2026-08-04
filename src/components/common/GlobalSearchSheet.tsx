import { useEffect, useRef, useState } from 'react'
import { BookUser, Layers3, ReceiptText, Search, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { searchEverything, type SearchResults } from '@/api/balances'
import { searchLocalMirror } from '@/lib/local-search'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { describeError, formatCurrency } from '@/lib/utils'

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 150

interface SearchResult {
  id: string
  label: string
  subtitle: string
  href: string
  type: 'bill' | 'group' | 'person'
}

/**
 * Search is answered by the server (migration 056), which scopes results to what the caller may
 * actually read. The local mirror can only match rows this device happens to hold, so it is the
 * FALLBACK: without it an offline user got "Search is unavailable right now." and no way to reach
 * the bill they had just entered. A mirror hit is always a row the pull bundle already delivered
 * to this user, so the fallback can only be narrower than the server's answer, never wider.
 */
async function runSearch(q: string, userId: string | null): Promise<{ results: SearchResult[]; offline: boolean }> {
  try {
    return { results: toResults(await searchEverything(q)), offline: false }
  } catch (err) {
    if (!userId) throw err
    const local = await searchLocalMirror(q, userId)
    const results = toResults(local)
    // Nothing found locally is not an answer — surface the original failure instead of an empty
    // state that reads as "no such bill".
    if (results.length === 0) throw err
    return { results, offline: true }
  }
}

function toResults({ bills, groups, profiles }: SearchResults): SearchResult[] {
  return [
    ...bills.map((b) => ({
      id: b.id,
      type: 'bill' as const,
      label: b.title,
      subtitle: formatCurrency(b.amount, b.currency),
      href: `/app/bills/${b.id}`,
    })),
    ...groups.map((g) => ({
      id: g.id,
      type: 'group' as const,
      label: g.name,
      subtitle: g.currency,
      href: `/app/groups/${g.id}`,
    })),
    ...profiles.map((p) => ({
      id: p.id,
      type: 'person' as const,
      label: p.displayName,
      subtitle: p.email,
      href: `/app/people/${p.id}`,
    })),
  ]
}

const TYPE_ICONS = {
  bill: ReceiptText,
  group: Layers3,
  person: BookUser,
} as const

const TYPE_LABELS = {
  bill: 'Bills',
  group: 'Groups',
  person: 'People',
} as const

type Answer = {
  query: string
  results: SearchResult[]
  error: string | null
  /** Answered from the local mirror because the server could not be reached. */
  offline: boolean
}

export function GlobalSearchSheet({ onClose }: { onClose: () => void }) {
  const { userId } = useCurrentUser()
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<Answer>({
    query: '',
    results: [],
    error: null,
    offline: false,
  })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // The answer carries the query it belongs to rather than being cleared imperatively: a response
  // that arrives after the user has typed on is stale, and the debounce timer cannot cancel a
  // request already in flight.
  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) return
    let superseded = false
    const timer = setTimeout(async () => {
      try {
        const { results, offline } = await runSearch(query, userId)
        if (!superseded) setAnswer({ query, results, error: null, offline })
      } catch (err) {
        if (!superseded)
          setAnswer({ query, results: [], error: describeError(err), offline: false })
      }
    }, DEBOUNCE_MS)
    return () => {
      superseded = true
      clearTimeout(timer)
    }
  }, [query, userId])

  const searched = query.length >= MIN_QUERY_LENGTH
  const answered = searched && answer.query === query
  const results = answered ? answer.results : []
  const error = answered ? answer.error : null
  const offlineResults = answered && answer.offline
  const loading = searched && !answered

  const byType = {
    bill: results.filter((r) => r.type === 'bill'),
    group: results.filter((r) => r.type === 'group'),
    person: results.filter((r) => r.type === 'person'),
  }

  const hasResults = results.length > 0

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
        <Search className="size-4 shrink-0 text-stone-400" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search bills, groups, people..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-transparent text-base outline-none placeholder:text-stone-400"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close search"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!searched && (
          <p className="mt-8 text-center text-sm text-stone-400">
            Type at least 2 characters to search
          </p>
        )}

        {error && <p className="mt-8 text-center text-sm text-red-600">{error}</p>}

        {searched && !loading && !error && !hasResults && (
          <p className="mt-8 text-center text-sm text-stone-400">No results found</p>
        )}

        {offlineResults && (
          <p
            role="status"
            className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950"
          >
            Offline — searching only what is saved on this device.
          </p>
        )}

        {searched && hasResults && (
          <div className="space-y-5">
            {(['bill', 'group', 'person'] as const).map((type) => {
              const items = byType[type]
              if (items.length === 0) return null
              const Icon = TYPE_ICONS[type]
              return (
                <div key={type}>
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400">
                    <Icon className="size-3.5" />
                    {TYPE_LABELS[type]}
                  </p>
                  <div className="space-y-1">
                    {items.map((r) => {
                      const ItemIcon = TYPE_ICONS[r.type]
                      return (
                        <Link
                          key={r.id}
                          to={r.href}
                          onClick={onClose}
                          className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-stone-100"
                        >
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-teal-800/10 text-teal-800">
                            <ItemIcon className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-stone-800">{r.label}</p>
                            {r.subtitle && (
                              <p className="truncate text-xs text-stone-400">{r.subtitle}</p>
                            )}
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
