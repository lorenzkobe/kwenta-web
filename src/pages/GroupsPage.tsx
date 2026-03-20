import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Layers3, Plus, Users, X } from 'lucide-react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useGroups } from '@/db/hooks'
import { createGroup } from '@/db/operations'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

export function GroupsPage() {
  const { userId } = useCurrentUser()
  const groups = useGroups(userId ?? undefined)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('PHP')
  const [creating, setCreating] = useState(false)

  const groupsWithMemberCount = useLiveQuery(async () => {
    if (!groups || groups.length === 0) return []
    return Promise.all(
      groups.map(async (g) => {
        const members = await db.group_members.where('group_id').equals(g.id).toArray()
        const active = members.filter((m) => !m.is_deleted)
        return { ...g, memberCount: active.length }
      }),
    )
  }, [groups])

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
            {groupsWithMemberCount?.length ?? 0} group{(groupsWithMemberCount?.length ?? 0) !== 1 ? 's' : ''}
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
            <Input
              type="text"
              placeholder="Group name (e.g. Baguio Food Trip)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
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

      {(!groupsWithMemberCount || groupsWithMemberCount.length === 0) ? (
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
          {groupsWithMemberCount.map((group) => (
            <Link
              key={group.id}
              to={`/app/groups/${group.id}`}
              className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-blue-600/15 text-blue-600">
                  <Users className="size-5" />
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{group.name}</p>
                  <p className="text-xs text-slate-500">
                    {group.memberCount} member{group.memberCount !== 1 ? 's' : ''} · {group.currency}
                  </p>
                </div>
              </div>
              <ChevronRight className="size-4 text-slate-400" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
