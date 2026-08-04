/**
 * Offline fallback for global search.
 *
 * Search is answered by `kwenta_search` (migration 056), which scopes results to what the caller
 * may read. When that call cannot be made the sheet used to render "Search is unavailable right
 * now." and nothing else — in an app that advertises full offline use, and where search is how you
 * navigate to a bill you just entered.
 *
 * Scoping is safe by construction: the mirror only ever holds rows the pull bundle delivered to
 * THIS user, so matching against it cannot widen visibility. It can only be narrower than the
 * server's answer, which is why it is a fallback and never the primary path.
 */
import { db } from '@/db/db'
import type { SearchResults } from '@/api/balances'

const MAX_PER_KIND = 10

function matches(haystack: string | null | undefined, needle: string): boolean {
  return typeof haystack === 'string' && haystack.toLowerCase().includes(needle)
}

export async function searchLocalMirror(query: string, userId: string): Promise<SearchResults> {
  const needle = query.trim().toLowerCase()
  if (!needle) return { bills: [], groups: [], profiles: [] }

  const [bills, groups, profiles] = await Promise.all([
    db.bills.toArray(),
    db.groups.toArray(),
    db.profiles.toArray(),
  ])

  return {
    bills: bills
      .filter((b) => !b.is_deleted && matches(b.title, needle))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, MAX_PER_KIND)
      .map((b) => ({
        id: b.id,
        title: b.title,
        amount: b.total_amount,
        currency: b.currency,
        groupId: b.group_id,
      })),
    groups: groups
      .filter((g) => !g.is_deleted && matches(g.name, needle))
      .slice(0, MAX_PER_KIND)
      .map((g) => ({ id: g.id, name: g.name, currency: g.currency })),
    profiles: profiles
      .filter(
        (p) =>
          !p.is_deleted &&
          p.id !== userId &&
          (matches(p.display_name, needle) || matches(p.email, needle)),
      )
      .slice(0, MAX_PER_KIND)
      .map((p) => ({ id: p.id, displayName: p.display_name, email: p.email ?? '' })),
  }
}
