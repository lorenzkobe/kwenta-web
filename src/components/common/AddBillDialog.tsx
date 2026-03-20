import { useState } from 'react'
import { LayoutList, Plus, Save, SplitSquareHorizontal, Trash2, UserPlus, Users, X } from 'lucide-react'
import { createBill, type CreateBillInput } from '@/db/operations'
import type { SplitType } from '@/types'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

type BillMode = 'simple' | 'itemized'

interface ItemDraft {
  key: string
  name: string
  amount: string
  splitType: SplitType
  selectedUserIds: string[]
}

interface MemberOption {
  userId: string
  displayName: string
  isCurrentUser: boolean
}

interface AddBillDialogProps {
  groupId: string
  groupCurrency: string
  groupMembers: MemberOption[]
  currentUserId: string
  onClose: () => void
  onSaved: () => void
}

function newItem(): ItemDraft {
  return { key: crypto.randomUUID(), name: '', amount: '', splitType: 'equal', selectedUserIds: [] }
}

export function AddBillDialog({
  groupId,
  groupCurrency,
  groupMembers,
  currentUserId,
  onClose,
  onSaved,
}: AddBillDialogProps) {
  const [mode, setMode] = useState<BillMode>('simple')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Simple mode
  const [simpleAmount, setSimpleAmount] = useState('')
  const [simpleSplitType, setSimpleSplitType] = useState<SplitType>('equal')
  const [simpleSelectedUserIds, setSimpleSelectedUserIds] = useState<string[]>([])

  // Itemized mode
  const [items, setItems] = useState<ItemDraft[]>([newItem()])

  const simpleAmountNum = parseFloat(simpleAmount) || 0
  const itemizedTotal = items.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0)

  const canSave = title.trim() && (
    mode === 'simple'
      ? simpleAmountNum > 0
      : items.some((i) => i.name.trim() && parseFloat(i.amount) > 0)
  )

  function toggleSimpleUser(uid: string) {
    setSimpleSelectedUserIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    )
  }

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)))
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
    if (!canSave) return
    setSaving(true)
    try {
      let input: CreateBillInput
      if (mode === 'simple') {
        input = {
          title: title.trim(),
          currency: groupCurrency,
          groupId,
          createdBy: currentUserId,
          note: note.trim(),
          items: [{
            name: title.trim(),
            amount: simpleAmountNum,
            splits: simpleSelectedUserIds.map((uid) => ({
              userId: uid,
              splitType: simpleSplitType,
              splitValue: simpleSplitType === 'equal' ? 1 : 0,
            })),
          }],
        }
      } else {
        const validItems = items.filter((i) => i.name.trim() && parseFloat(i.amount) > 0)
        input = {
          title: title.trim(),
          currency: groupCurrency,
          groupId,
          createdBy: currentUserId,
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
      }
      await createBill(input)
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet — slides up on mobile, centered on desktop */}
      <div className="relative flex w-full max-w-lg animate-[slideUp_0.25s_ease-out] flex-col rounded-t-3xl border border-slate-200 bg-white shadow-[0_-20px_60px_rgba(15,23,42,0.15)] sm:max-h-[90vh] sm:rounded-3xl">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Add bill</h2>
            <p className="text-xs text-slate-400">{groupCurrency}</p>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">

          {/* Mode toggle */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-1">
            <div className="grid grid-cols-2 gap-1">
              {([
                { id: 'simple', icon: SplitSquareHorizontal, label: 'Simple' },
                { id: 'itemized', icon: LayoutList, label: 'Itemized' },
              ] as const).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
                    mode === id
                      ? 'bg-slate-800 text-white shadow-sm'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Title</label>
            <Input
              autoFocus
              type="text"
              placeholder="e.g. Korean BBQ dinner"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Note */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Note (optional)</label>
            <Textarea
              placeholder="Any extra details..."
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {/* Simple mode */}
          {mode === 'simple' && (
            <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Total amount</label>
                <Input
                  type="number"
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  value={simpleAmount}
                  onChange={(e) => setSimpleAmount(e.target.value)}
                  className="text-lg font-semibold"
                />
              </div>

              {groupMembers.length > 0 && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Split type</label>
                    <Select value={simpleSplitType} onValueChange={(v) => setSimpleSplitType(v as SplitType)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equal">Equal split</SelectItem>
                        <SelectItem value="percentage">By percentage</SelectItem>
                        <SelectItem value="custom">Custom amounts</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-slate-600">
                      <UserPlus className="size-3.5" />
                      Split with
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {groupMembers.map((m) => {
                        const selected = simpleSelectedUserIds.includes(m.userId)
                        return (
                          <button
                            key={m.userId}
                            onClick={() => toggleSimpleUser(m.userId)}
                            className={cn(
                              'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-medium transition-colors',
                              selected
                                ? 'border-transparent bg-blue-600 text-white'
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
                            )}
                          >
                            <Users className="size-3.5" />
                            {m.isCurrentUser ? 'You' : m.displayName}
                          </button>
                        )
                      })}
                    </div>

                    {simpleSelectedUserIds.length > 0 && simpleAmountNum > 0 && (
                      <div className="rounded-xl border border-blue-600/20 bg-blue-600/5 px-4 py-2.5">
                        {simpleSplitType === 'equal' ? (
                          <p className="text-sm text-slate-700">
                            <span className="font-semibold text-blue-600">
                              {formatCurrency(simpleAmountNum / simpleSelectedUserIds.length, groupCurrency)}
                            </span>
                            {' '}each · {simpleSelectedUserIds.length} {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                          </p>
                        ) : (
                          <p className="text-sm text-slate-500">
                            {formatCurrency(simpleAmountNum, groupCurrency)} split among {simpleSelectedUserIds.length} {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Itemized mode */}
          {mode === 'itemized' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-600">Items</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setItems((prev) => [...prev, newItem()])}
                >
                  <Plus className="size-3.5" />
                  Add item
                </Button>
              </div>

              {items.map((item, index) => (
                <div key={item.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-2.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[0.6rem] font-semibold text-white">
                      {index + 1}
                    </span>
                    <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                      <Input
                        type="text"
                        placeholder="Item name"
                        className="rounded-lg flex-1"
                        value={item.name}
                        onChange={(e) => updateItem(item.key, { name: e.target.value })}
                      />
                      <Input
                        type="number"
                        placeholder="0.00"
                        className="rounded-lg sm:w-28"
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
                        className="mt-1.5 rounded-full text-red-600"
                        onClick={() => removeItem(item.key)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>

                  {groupMembers.length > 0 && (
                    <div className="mt-3 border-t border-slate-200 pt-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                          <UserPlus className="size-3.5" />
                          Split with
                        </div>
                        <Select
                          value={item.splitType}
                          onValueChange={(v) => updateItem(item.key, { splitType: v as SplitType })}
                        >
                          <SelectTrigger className="h-7 w-auto min-w-28 rounded-lg text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="equal">Equal</SelectItem>
                            <SelectItem value="percentage">Percentage</SelectItem>
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {groupMembers.map((m) => {
                          const selected = item.selectedUserIds.includes(m.userId)
                          return (
                            <button
                              key={m.userId}
                              onClick={() => toggleUserForItem(item.key, m.userId)}
                              className={cn(
                                'inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors',
                                selected
                                  ? 'border-transparent bg-blue-600 text-white'
                                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100',
                              )}
                            >
                              <Users className="size-3" />
                              {m.isCurrentUser ? 'You' : m.displayName}
                            </button>
                          )
                        })}
                      </div>

                      {item.selectedUserIds.length > 0 && item.splitType === 'equal' && parseFloat(item.amount) > 0 && (
                        <p className="mt-1.5 text-xs text-slate-400">
                          {formatCurrency(parseFloat(item.amount) / item.selectedUserIds.length, groupCurrency)} each
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Running total */}
              {itemizedTotal > 0 && (
                <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <span className="text-sm font-medium text-slate-600">Running total</span>
                  <span className="text-lg font-semibold text-slate-800">
                    {formatCurrency(itemizedTotal, groupCurrency)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-slate-100 px-5 py-4">
          <Button
            className="w-full rounded-xl"
            disabled={!canSave || saving}
            onClick={handleSave}
          >
            <Save className="size-4" />
            {saving ? 'Saving…' : 'Save bill'}
          </Button>
        </div>
      </div>
    </div>
  )
}
