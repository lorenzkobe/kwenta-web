import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Layers3, Plus, Users, X } from 'lucide-react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { createGroup } from '@/db/operations'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { computeAllGroupBalances, type GroupBalanceSummary } from '@/lib/settlement'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

function myBalanceLine(summary: GroupBalanceSummary) {
  const { totalOwed, totalOwing, currency } = summary
  if (totalOwed < 0.01 && totalOwing < 0.01) {
    return { text: 'Balanced', className: 'text-slate-500' }
  }
  if (totalOwed >= 0.01) {
    return {
      text: `Collect ${formatCurrency(totalOwed, currency)}`,
      className: 'text-emerald-600',
    }
  }
  return {
    text: `Pay ${formatCurrency(totalOwing, currency)}`,
    className: 'text-amber-600',
  }
}

export function GroupsPage() {
  const { userId } = useCurrentUser()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('PHP')
  const [creating, setCreating] = useState(false)

  const groupsWithBalances = useLiveQuery(async () => {
    if (!userId) return []
    const summaries = await computeAllGroupBalances(userId)
    const rows: Array<{
      id: string
      name: string
      currency: string
      memberCount: number
      summary: GroupBalanceSummary
    }> = []
    for (const s of summaries) {
      const g = await db.groups.get(s.groupId)
      if (!g || g.is_deleted) continue
      const members = await db.group_members.where('group_id').equals(g.id).toArray()
      const memberCount = members.filter((m) => !m.is_deleted).length
      rows.push({ id: g.id, name: g.name, currency: g.currency, memberCount, summary: s })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }, [userId])

  async function handleCreate() {
    if (!userId || !name.trim()) return
    setCreating(true)
    try {
      await createGroup(name.trim(), currency, userId)
      setName('')
      setShowCreate(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="mt-1 text-sm text-slate-600">
            {groupsWithBalances?.length ?? 0} group{(groupsWithBalances?.length ?? 0) !== 1 ? 's' : ''}
          </p>
        </div>
        <Button className="rounded-full" onClick={() => setShowCreate(true)}>
          <Plus className="size-4" />
          New group
        </Button>
      </div>

      {showCreate && (
        <div className="rounded-3xl border border-blue-600/20 bg-blue-600/5 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Create group</h2>
            <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={() => setShowCreate(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="new-group-name" className="text-sm font-medium text-slate-800">
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
              <label htmlFor="new-group-currency" className="text-sm font-medium text-slate-800">
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

      {(!groupsWithBalances || groupsWithBalances.length === 0) ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-slate-100 p-4">
              <Layers3 className="size-6 text-slate-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-slate-500">No groups yet</p>
            <p className="mt-1 text-xs text-slate-400">
              Create a group to start splitting expenses with others
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {groupsWithBalances.map((group) => {
            const { text, className } = myBalanceLine(group.summary)
            return (
            <Link
              key={group.id}
              to={`/app/groups/${group.id}`}
              className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:bg-slate-50"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-600/15 text-blue-600">
                  <Users className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">{group.name}</p>
                  <p className="text-xs text-slate-500">
                    {group.memberCount} member{group.memberCount !== 1 ? 's' : ''} · {group.currency}
                  </p>
                  <p className={cn('mt-0.5 text-xs font-semibold', className)}>{text}</p>
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-slate-400" />
            </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
