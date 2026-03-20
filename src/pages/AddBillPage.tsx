import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus, Save, Trash2, UserPlus, Users } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { createBill, type CreateBillInput } from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import type { SplitType } from '@/types'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

interface ItemDraft {
  key: string
  name: string
  amount: string
  splitType: SplitType
  selectedUserIds: string[]
}

function newItem(): ItemDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    amount: '',
    splitType: 'equal',
    selectedUserIds: [],
  }
}

export function AddBillPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const groupIdParam = searchParams.get('groupId')

  const { userId } = useCurrentUser()
  const [title, setTitle] = useState('')
  const [currency, setCurrency] = useState('PHP')
  const [groupId, setGroupId] = useState<string | null>(groupIdParam)
  const [note, setNote] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([newItem()])
  const [saving, setSaving] = useState(false)

  const groups = useLiveQuery(async () => {
    if (!userId) return []
    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    const gIds = memberships.filter((m) => !m.is_deleted).map((m) => m.group_id)
    if (gIds.length === 0) return []
    const g = await db.groups.where('id').anyOf(gIds).toArray()
    return g.filter((g) => !g.is_deleted)
  }, [userId])

  const groupMembers = useLiveQuery(async () => {
    if (!groupId) return []
    const members = await db.group_members.where('group_id').equals(groupId).toArray()
    const active = members.filter((m) => !m.is_deleted)
    const withProfiles = await Promise.all(
      active.map(async (m) => {
        const profile = await db.profiles.get(m.user_id)
        return {
          userId: m.user_id,
          displayName: profile?.display_name ?? m.display_name,
          isCurrentUser: m.user_id === userId,
        }
      }),
    )
    return withProfiles
  }, [groupId, userId])

  const totalAmount = items.reduce((sum, item) => {
    const val = parseFloat(item.amount)
    return sum + (isNaN(val) ? 0 : val)
  }, 0)

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function removeItem(key: string) {
    setItems((prev) => {
      const next = prev.filter((i) => i.key !== key)
      return next.length === 0 ? [newItem()] : next
    })
  }

  function toggleUserForItem(itemKey: string, uid: string) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== itemKey) return item
        const selected = item.selectedUserIds.includes(uid)
          ? item.selectedUserIds.filter((id) => id !== uid)
          : [...item.selectedUserIds, uid]
        return { ...item, selectedUserIds: selected }
      }),
    )
  }

  async function handleSave() {
    if (!userId || !title.trim() || items.length === 0) return

    const validItems = items.filter((i) => i.name.trim() && parseFloat(i.amount) > 0)
    if (validItems.length === 0) return

    setSaving(true)
    try {
      const input: CreateBillInput = {
        title: title.trim(),
        currency,
        groupId,
        createdBy: userId,
        note: note.trim(),
        items: validItems.map((item) => ({
          name: item.name.trim(),
          amount: parseFloat(item.amount),
          splits: item.selectedUserIds.map((uid) => ({
            userId: uid,
            splitType: item.splitType,
            splitValue: item.splitType === 'equal' ? 1 : 0,
          })),
        })),
      }

      await createBill(input)
      navigate('/app/bills')
    } finally {
      setSaving(false)
    }
  }

  const canSave = title.trim() && items.some((i) => i.name.trim() && parseFloat(i.amount) > 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/bills">
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <Button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="rounded-full"
        >
          <Save className="size-4" />
          {saving ? 'Saving…' : 'Save bill'}
        </Button>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">New bill</h1>

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Title</label>
            <Input
              type="text"
              placeholder="e.g. Korean BBQ dinner"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Currency</label>
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
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Group (optional)</label>
              <Select value={groupId ?? '_none'} onValueChange={(val) => setGroupId(val === '_none' ? null : val)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">Personal (no group)</SelectItem>
                  {(groups ?? []).map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Note (optional)</label>
            <Textarea
              placeholder="Any extra details..."
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Items</h2>
            <p className="text-xs text-slate-500">
              Total: {formatCurrency(totalAmount, currency)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => setItems((prev) => [...prev, newItem()])}
          >
            <Plus className="size-4" />
            Add item
          </Button>
        </div>

        <div className="mt-4 space-y-4">
          {items.map((item, index) => (
            <div
              key={item.key}
              className="rounded-2xl border border-slate-200 bg-slate-100/60 p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="mt-2 flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
                  {index + 1}
                </span>
                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                  <Input
                    type="text"
                    placeholder="Item name"
                    className="rounded-lg"
                    value={item.name}
                    onChange={(e) => updateItem(item.key, { name: e.target.value })}
                  />
                  <Input
                    type="number"
                    placeholder="Amount"
                    className="rounded-lg"
                    value={item.amount}
                    min="0"
                    step="0.01"
                    onChange={(e) => updateItem(item.key, { amount: e.target.value })}
                  />
                </div>
                {items.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mt-1 rounded-full text-red-600"
                    onClick={() => removeItem(item.key)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>

              {groupId && (groupMembers ?? []).length > 0 && (
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <UserPlus className="size-3.5" />
                      Split with
                    </div>
                    <Select
                      value={item.splitType}
                      onValueChange={(val) => updateItem(item.key, { splitType: val as SplitType })}
                    >
                      <SelectTrigger className="h-8 w-auto min-w-32 rounded-lg text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equal">Equal split</SelectItem>
                        <SelectItem value="percentage">By percentage</SelectItem>
                        <SelectItem value="custom">Custom amounts</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(groupMembers ?? []).map((member) => {
                      const isSelected = item.selectedUserIds.includes(member.userId)
                      return (
                        <button
                          key={member.userId}
                          onClick={() => toggleUserForItem(item.key, member.userId)}
                          className={cn(
                            'inline-flex cursor-pointer items-center gap-1 rounded-full border px-3 py-2 text-xs font-medium transition-colors',
                            isSelected
                              ? 'border-transparent bg-blue-600 text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
                          )}
                        >
                          <Users className="size-3" />
                          {member.isCurrentUser ? 'You' : member.displayName}
                        </button>
                      )
                    })}
                  </div>

                  {item.selectedUserIds.length > 0 && item.splitType === 'equal' && (
                    <p className="mt-2 text-xs text-slate-400">
                      {formatCurrency(
                        parseFloat(item.amount || '0') / item.selectedUserIds.length,
                        currency,
                      )}{' '}
                      each
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
