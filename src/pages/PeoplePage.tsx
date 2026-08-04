import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { BookUser, ChevronRight, Loader2, Plus, UserPlus } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { fetchContactsWithBalances, totalsToMap, type ContactBalanceRow } from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { loadStagedContactRows } from '@/lib/staged-rows'
import { formatPairwiseSummary } from '@/lib/people'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'
import { createLocalProfile } from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function PeoplePage() {
  const { userId } = useCurrentUser()
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null)
  const [balanceFilter, setBalanceFilter] = useState<'with_balance' | 'all'>('with_balance')

  // The server returns one row per real person with their combined standing already computed.
  // This used to load every bill and settlement in the database and then recompute a pairwise
  // net per contact against that snapshot.
  const fetchContacts = useCallback(
    () => (userId ? fetchContactsWithBalances(userId) : Promise.reject(new Error('no user'))),
    [userId],
  )
  const contacts = useServerData(userId ? fetchContacts : null, [userId, fetchContacts])

  // Contacts created offline exist only here until they are pushed. The server list cannot
  // contain them, so without this a contact added offline was invisible while the Dexie duplicate
  // guard still refused to add them again — "already exists" for someone not on the screen.
  const stagedContacts = useLiveQuery(
    async () => (userId ? loadStagedContactRows(userId) : []),
    [userId],
    [] as ContactBalanceRow[],
  )

  const rows = useMemo(() => {
    if (!contacts.data) return undefined
    const confirmed = new Set(contacts.data.map((row) => row.peerId))
    const merged = [...stagedContacts.filter((c) => !confirmed.has(c.peerId)), ...contacts.data]
    const out = merged.map((row) => {
      const { lines, primaryLabel, tone } = formatPairwiseSummary(totalsToMap(row.net))
      return {
        id: row.peerId,
        displayName: row.displayName,
        subtitle: row.subtitle,
        primaryLabel,
        tone,
        lines,
      }
    })
    out.sort((a, b) => {
      const aHasBalance = a.tone !== 'balanced'
      const bHasBalance = b.tone !== 'balanced'
      if (aHasBalance !== bHasBalance) return aHasBalance ? -1 : 1
      return a.displayName.localeCompare(b.displayName)
    })
    return out
  }, [contacts.data, stagedContacts])

  useEffect(() => {
    if (!duplicateNotice) return
    const t = window.setTimeout(() => setDuplicateNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [duplicateNotice])

  async function handleAddContact() {
    if (!userId || !newName.trim() || adding) return
    setDuplicateNotice(null)
    setAdding(true)
    try {
      const result = await createLocalProfile(newName.trim(), userId)
      if (result.outcome === 'already_exists') {
        const name = newName.trim()
        setDuplicateNotice(`You already have a contact named “${name}”. Choose a different name or open them from the list below.`)
        return
      }
      setNewName('')
      setShowAdd(false)
    } catch (error) {
      // Adding a contact is now cloud-first: on rejection nothing is written anywhere, so
      // without this the form just sits there and the user cannot tell it failed.
      toast.error(
        error instanceof Error ? error.message : 'Could not add this contact right now.',
      )
    } finally {
      setAdding(false)
    }
  }

  if (!userId) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  const rowsLoading = rows === undefined
  const filteredRows = balanceFilter === 'with_balance'
    ? rows?.filter((r) => r.tone !== 'balanced')
    : rows

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="mt-1 text-sm text-stone-600">
            Phonebook, balances, and payments across all groups and personal bills
          </p>
        </div>
        <Button className="h-10 shrink-0 rounded-full px-4" onClick={() => setShowAdd(true)}>
          <UserPlus className="size-4" />
          Add
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-3xl border border-teal-800/20 bg-teal-800/5 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Add local contact</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              onClick={() => {
                setShowAdd(false)
                setDuplicateNotice(null)
              }}
            >
              ×
            </Button>
          </div>
          <p className="mt-1 text-xs text-stone-600">
            Names are unique in your phonebook. You can link a contact to an online account later from
            their page.
          </p>
          <div className="mt-4 flex gap-2">
            <Input
              placeholder="Name"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setDuplicateNotice(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddContact()}
              className="rounded-xl"
            />
            <Button className="rounded-xl" disabled={!newName.trim() || adding} onClick={handleAddContact}>
              {adding ? '…' : 'Save'}
            </Button>
          </div>
          {duplicateNotice && (
            <div
              role="status"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 shadow-sm"
            >
              {duplicateNotice}
            </div>
          )}
        </div>
      )}

      {!rowsLoading && (rows?.length ?? 0) > 0 && (
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-xs text-stone-500">Filter</span>
          <Select value={balanceFilter} onValueChange={(v) => setBalanceFilter(v as typeof balanceFilter)}>
            <SelectTrigger className="h-8 w-auto rounded-full px-3 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="with_balance">With balance</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {contacts.fromCache && contacts.data && <SavedCopyNotice fetchedAt={contacts.fetchedAt} />}

      {contacts.error && !contacts.data ? (
        // `rowsLoading` is `rows === undefined`, which a failed fetch never clears — without this
        // branch the page rendered its skeletons forever, with no message and no way to retry.
        <div
          role="alert"
          className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm"
        >
          <p className="font-medium">People unavailable</p>
          <p className="mt-1 text-xs text-amber-900/80">{contacts.error}</p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-3 rounded-full text-amber-900"
            onClick={contacts.refresh}
          >
            Try again
          </Button>
        </div>
      ) : rowsLoading && !showAdd ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={`people-skeleton-${i}`}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="h-4 w-36 animate-pulse rounded bg-stone-200" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded bg-stone-100" />
              <div className="mt-2 h-3 w-52 animate-pulse rounded bg-stone-100" />
            </div>
          ))}
        </div>
      ) : (rows?.length ?? 0) === 0 && !showAdd ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <BookUser className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No people yet</p>
            <p className="mt-1 max-w-sm text-xs text-stone-400">
              Add group members, split personal bills, or add a local contact. Everyone you share
              expenses with appears here.
            </p>
            <Button size="sm" className="mt-4 rounded-full" onClick={() => setShowAdd(true)}>
              <Plus className="size-3.5" />
              Add contact
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {(filteredRows?.length ?? 0) === 0 && balanceFilter === 'with_balance' && (
            <p className="py-6 text-center text-sm text-stone-400">No outstanding balances</p>
          )}
          {filteredRows?.map((r) => (
            <Link
              key={r.id}
              to={`/app/people/${r.id}`}
              className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-800">{r.displayName}</p>
                {r.subtitle && <p className="text-xs text-stone-500">{r.subtitle}</p>}
                <p
                  className={cn(
                    'mt-0.5 text-sm font-medium',
                    r.tone === 'balanced' && 'text-stone-500',
                    r.tone === 'receive' && 'text-emerald-600',
                    r.tone === 'pay' && 'text-amber-600',
                  )}
                >
                  {r.lines.length > 0 ? r.lines.join(' · ') : r.primaryLabel}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-stone-400" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
