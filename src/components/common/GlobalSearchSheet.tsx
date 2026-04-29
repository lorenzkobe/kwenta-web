import { useEffect, useRef, useState } from 'react'
import { BookUser, Layers3, ReceiptText, Search, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { db } from '@/db/db'
import { formatCurrency } from '@/lib/utils'

interface SearchResult {
  id: string
  label: string
  subtitle: string
  href: string
  type: 'bill' | 'group' | 'person'
}

async function runSearch(q: string): Promise<SearchResult[]> {
  const lower = q.toLowerCase()
  const results: SearchResult[] = []

  const bills = await db.bills
    .filter((b) => !b.is_deleted && b.title.toLowerCase().includes(lower))
    .limit(5)
    .toArray()
  for (const b of bills) {
    results.push({
      id: b.id,
      type: 'bill',
      label: b.title,
      subtitle: formatCurrency(b.total_amount, b.currency),
      href: `/app/bills/${b.id}`,
    })
  }

  const groups = await db.groups
    .filter((g) => !g.is_deleted && g.name.toLowerCase().includes(lower))
    .limit(5)
    .toArray()
  for (const g of groups) {
    results.push({
      id: g.id,
      type: 'group',
      label: g.name,
      subtitle: g.currency,
      href: `/app/groups/${g.id}`,
    })
  }

  const people = await db.profiles
    .filter((p) => !p.is_deleted && p.display_name.toLowerCase().includes(lower))
    .limit(5)
    .toArray()
  for (const p of people) {
    results.push({
      id: p.id,
      type: 'person',
      label: p.display_name,
      subtitle: p.email ?? '',
      href: `/app/people/${p.id}`,
    })
  }

  return results
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

export function GlobalSearchSheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.length < 2) {
      setResults([])
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      const found = await runSearch(query)
      setResults(found)
      setLoading(false)
    }, 150)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const byType = {
    bill: results.filter((r) => r.type === 'bill'),
    group: results.filter((r) => r.type === 'group'),
    person: results.filter((r) => r.type === 'person'),
  }

  const hasResults = results.length > 0
  const searched = query.length >= 2

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

        {searched && !loading && !hasResults && (
          <p className="mt-8 text-center text-sm text-stone-400">No results found</p>
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
