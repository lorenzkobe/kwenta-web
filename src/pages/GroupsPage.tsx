import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ChevronRight, Layers3, Plus, Users, X } from 'lucide-react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { addExistingGroupMember, createGroup } from '@/db/operations'
import { fetchGroupsWithBalances, type GroupBalanceRow } from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'
import { loadPhonebookRows } from '@/lib/people'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { MemberMultiPicker } from '@/components/common/MemberMultiPicker'

type GroupFilter = 'all' | 'has_balance' | 'balanced'
type GroupSort = 'name_asc' | 'name_desc' | 'updated_desc' | 'updated_asc'

function myBalanceLine(group: GroupBalanceRow) {
  const { totalToReceive, totalToPay, currency } = group
  const hasReceive = totalToReceive >= 0.01
  const hasPay = totalToPay >= 0.01
  if (!hasReceive && !hasPay) {
    return { text: 'Balanced', className: 'text-stone-500' }
  }
  if (hasReceive && hasPay) {
    return {
      text: `Owed ${formatCurrency(totalToReceive, currency)} · You owe ${formatCurrency(totalToPay, currency)}`,
      className: 'text-stone-700',
    }
  }
  if (hasReceive) {
    return {
      text: `Receive ${formatCurrency(totalToReceive, currency)}`,
      className: 'text-emerald-600',
    }
  }
  return {
    text: `Pay ${formatCurrency(totalToPay, currency)}`,
    className: 'text-amber-600',
  }
}

export function GroupsPage() {
  const { userId } = useCurrentUser()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('PHP')
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<GroupFilter>('all')
  const [sort, setSort] = useState<GroupSort>('name_asc')
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [phonebook, setPhonebook] = useState<
    { id: string; displayName: string; subtitle?: string }[]
  >([])

  useEffect(() => {
    if (!userId || !showCreate) return
    let cancelled = false
    async function run() {
      const rows = await loadPhonebookRows(userId!)
      if (!cancelled) setPhonebook(rows)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [userId, showCreate])

  // One call returns every group with the viewer's own standing already summed. This used to
  // recompute each group's whole pairwise ledger locally, then re-query its roster per group.
  const loadGroups = useCallback(
    () => (userId ? fetchGroupsWithBalances(userId) : Promise.reject(new Error('no user'))),
    [userId],
  )
  const groupsQuery = useServerData(userId ? loadGroups : null, [userId, loadGroups], 'groups')
  const groupsWithBalances = groupsQuery.data

  const groups = useMemo(() => {
    const list = groupsWithBalances ?? []
    let out = list
    if (filter === 'has_balance') {
      out = out.filter((g) => g.totalToReceive >= 0.01 || g.totalToPay >= 0.01)
    }
    if (filter === 'balanced') {
      out = out.filter((g) => g.totalToReceive < 0.01 && g.totalToPay < 0.01)
    }
    const copy = [...out]
    copy.sort((a, b) => {
      switch (sort) {
        case 'name_asc':
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        case 'name_desc':
          return b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
        case 'updated_desc':
          return b.updatedAt.localeCompare(a.updatedAt)
        case 'updated_asc':
          return a.updatedAt.localeCompare(b.updatedAt)
        default:
          return 0
      }
    })
    return copy
  }, [groupsWithBalances, filter, sort])
  const groupsLoading = !userId || (groupsQuery.loading && !groupsQuery.data)

  async function handleCreate() {
    if (!userId || !name.trim() || creating) return
    setCreating(true)
    try {
      const groupId = await createGroup(name.trim(), currency, userId)
      for (const memberId of selectedMemberIds) {
        await addExistingGroupMember(groupId, memberId, userId)
      }
      setName('')
      setSelectedMemberIds([])
      setShowCreate(false)
    } catch (error) {
      // Creating a group is now cloud-first: on rejection nothing is written anywhere, so
      // without this the dialog just sits there and the user cannot tell it failed.
      toast.error(
        error instanceof Error ? error.message : 'Could not create this group right now.',
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="mt-1 text-sm text-stone-600">
            {groupsLoading
              ? 'Loading groups…'
              : `${groupsWithBalances?.length ?? 0} group${(groupsWithBalances?.length ?? 0) !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Button className="h-10 rounded-full" onClick={() => setShowCreate(true)}>
          <Plus className="size-4" />
          New group
        </Button>
      </div>

      {groupsWithBalances && groupsWithBalances.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-500">Filter</span>
            <Select value={filter} onValueChange={(v) => setFilter(v as GroupFilter)}>
              <SelectTrigger className="h-8 rounded-full px-3 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has_balance">Has balance</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-500">Sort</span>
            <Select value={sort} onValueChange={(v) => setSort(v as GroupSort)}>
              <SelectTrigger className="h-8 rounded-full px-3 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name_asc">Name · A → Z</SelectItem>
                <SelectItem value="name_desc">Name · Z → A</SelectItem>
                <SelectItem value="updated_desc">Updated · Newest first</SelectItem>
                <SelectItem value="updated_asc">Updated · Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="rounded-3xl border border-teal-800/20 bg-teal-800/5 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Create group</h2>
            <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={() => setShowCreate(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="new-group-name" className="text-sm font-medium text-stone-800">
                Group name
              </label>
              <Input
                id="new-group-name"
                type="text"
                placeholder="e.g. Baguio Food Trip"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="new-group-currency" className="text-sm font-medium text-stone-800">
                Currency
              </label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="new-group-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PHP">PHP — Philippine Peso</SelectItem>
                  <SelectItem value="USD">USD — US Dollar</SelectItem>
                  <SelectItem value="EUR">EUR — Euro</SelectItem>
                  <SelectItem value="JPY">JPY — Japanese Yen</SelectItem>
                  <SelectItem value="KRW">KRW — Korean Won</SelectItem>
                  <SelectItem value="GBP">GBP — British Pound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-stone-800">
                Add members (optional)
              </label>
              <MemberMultiPicker
                people={phonebook}
                selectedIds={selectedMemberIds}
                onChange={setSelectedMemberIds}
                placeholder={
                  phonebook.length === 0 ? 'No people in your phonebook yet' : 'Select people…'
                }
                emptyMessage="No matches in your phonebook"
                disabled={creating || phonebook.length === 0}
              />
              <p className="text-[0.65rem] text-stone-400">
                Only people already in your phonebook can be added. Create new contacts from the People page.
              </p>
            </div>
            <Button
              className="w-full rounded-xl"
              onClick={handleCreate}
              disabled={!name.trim() || creating}
            >
              {creating ? 'Creating…' : 'Create group'}
            </Button>
          </div>
        </div>
      )}

      {groupsQuery.fromCache && groupsQuery.data && (
        <SavedCopyNotice fetchedAt={groupsQuery.fetchedAt} />
      )}

      {groupsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={`group-skeleton-${i}`}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="h-4 w-44 animate-pulse rounded bg-stone-200" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded bg-stone-100" />
              <div className="mt-2 h-3 w-36 animate-pulse rounded bg-stone-100" />
            </div>
          ))}
        </div>
      ) : groupsQuery.error && !groupsQuery.data ? (
        // "No groups yet" and "we could not reach the server" must not render the same.
        <div
          role="alert"
          className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm"
        >
          <p className="font-medium">Groups unavailable</p>
          <p className="mt-1 text-xs text-amber-900/80">{groupsQuery.error}</p>
          <Button size="sm" variant="ghost" className="mt-3 rounded-full text-amber-900" onClick={groupsQuery.refresh}>
            Try again
          </Button>
        </div>
      ) : (!groupsWithBalances || groupsWithBalances.length === 0) ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <Layers3 className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No groups yet</p>
            <p className="mt-1 text-xs text-stone-400">
              Create a group to start splitting expenses with others
            </p>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
          No groups match this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const { text, className } = myBalanceLine(group)
            return (
            <Link
              key={group.groupId}
              to={`/app/groups/${group.groupId}`}
              className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-teal-800/15 text-teal-800">
                  <Users className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-stone-800">{group.name}</p>
                  <p className="text-xs text-stone-500">
                    {group.memberCount} member{group.memberCount !== 1 ? 's' : ''} · {group.currency}
                  </p>
                  <p className={cn('mt-0.5 text-xs font-semibold', className)}>{text}</p>
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-stone-400" />
            </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
