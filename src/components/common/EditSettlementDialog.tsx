import { useState, useEffect } from 'react'
import { Trash2, X } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { updateSettlement, deleteSettlement } from '@/db/operations'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

export function EditSettlementDialog({
  item,
  onClose,
  onSaved,
}: {
  item: SettlementHistoryItem
  onClose: () => void
  onSaved: () => void
}) {
  const { userId } = useCurrentUser()
  const [fromId, setFromId] = useState(item.fromUserId)
  const [toId, setToId] = useState(item.toUserId)
  const [amountStr, setAmountStr] = useState(() => String(item.amount))
  const [label, setLabel] = useState(item.label ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)

  useEffect(() => {
    setFromId(item.fromUserId)
    setToId(item.toUserId)
    setAmountStr(String(item.amount))
    setLabel(item.label ?? '')
  }, [item])

  const members = useLiveQuery(async () => {
    if (item.groupId == null) {
      const [fromP, toP] = await Promise.all([
        db.profiles.get(item.fromUserId),
        db.profiles.get(item.toUserId),
      ])
      return [
        { userId: item.fromUserId, name: fromP?.display_name ?? '?' },
        { userId: item.toUserId, name: toP?.display_name ?? '?' },
      ]
    }
    const all = await db.group_members.where('group_id').equals(item.groupId).toArray()
    const active = all.filter((m) => !m.is_deleted)
    return Promise.all(
      active.map(async (m) => {
        const p = await db.profiles.get(m.user_id)
        return { userId: m.user_id, name: p?.display_name ?? m.display_name }
      }),
    )
  }, [item.groupId, item.fromUserId, item.toUserId])

  async function handleSave() {
    if (!userId) return
    const amount = parseFloat(amountStr.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return
    if (fromId === toId) return
    setSaving(true)
    try {
      await updateSettlement(
        item.id,
        {
          fromUserId: fromId,
          toUserId: toId,
          amount,
          currency: item.currency,
          label: label.trim(),
        },
        userId,
      )
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function executeRemove() {
    if (!userId) return
    setDeleting(true)
    try {
      await deleteSettlement(item.id, userId)
      onSaved()
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  const invalidAmount =
    !amountStr.trim() ||
    !Number.isFinite(parseFloat(amountStr.replace(',', '.'))) ||
    parseFloat(amountStr.replace(',', '.')) <= 0
  const sameParty = fromId === toId

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold">Edit payment</h2>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-800">Paid by</span>
            <Select value={fromId} onValueChange={setFromId}>
              <SelectTrigger className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(members ?? []).map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-800">Received by</span>
            <Select value={toId} onValueChange={setToId}>
              <SelectTrigger className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(members ?? []).map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="edit-settlement-amount" className="text-sm font-medium text-slate-800">
              Amount ({item.currency})
            </label>
            <Input
              id="edit-settlement-amount"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="rounded-lg"
            />
            {sameParty && (
              <p className="text-xs text-amber-600">Payer and recipient must be different.</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="edit-settlement-label" className="text-sm font-medium text-slate-800">
              Label <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <Input
              id="edit-settlement-label"
              type="text"
              placeholder="e.g. Cash, dinner"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              className="rounded-lg"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              variant="outline"
              className="order-2 w-full rounded-xl border-red-200 text-red-600 hover:bg-red-50 sm:order-1 sm:w-auto"
              type="button"
              onClick={() => setRemoveConfirmOpen(true)}
              disabled={deleting || saving}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
            <Button
              className="order-1 w-full rounded-xl sm:order-2 sm:min-w-32"
              onClick={handleSave}
              disabled={!userId || saving || deleting || invalidAmount || sameParty || !members?.length}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      open={removeConfirmOpen}
      onOpenChange={setRemoveConfirmOpen}
      title="Remove this payment?"
      description="Balances will update to match. You can record a new payment if needed."
      confirmLabel="Remove"
      variant="danger"
      onConfirm={executeRemove}
    />
    </>
  )
}
