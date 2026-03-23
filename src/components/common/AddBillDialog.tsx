import { useEffect, useRef, useState } from 'react'
import { LayoutList, Plus, Save, SplitSquareHorizontal, Trash2, UserPlus, Users, X } from 'lucide-react'
import {
  createBill,
  getBillWithDetails,
  updateBill,
  type CreateBillInput,
} from '@/db/operations'
import type { SplitType } from '@/types'
import {
  applyClearedSplitField,
  buildSplitPayload,
  equalCustomMap,
  equalPercentMap,
  lineSplitsValid,
  redistributeWithPinned,
  type PinnedSplits,
} from '@/lib/bill-split-form'
import { filterDecimalInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { SplitValueRows } from '@/components/common/SplitValueRows'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

type BillMode = 'simple' | 'itemized'

interface ItemDraft {
  key: string
  name: string
  amount: string
  splitType: SplitType
  selectedUserIds: string[]
  splitValues: Record<string, string>
  pinnedSplit: PinnedSplits
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
  editBillId?: string | null
  onClose: () => void
  onSaved: () => void
}

function newItem(): ItemDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    amount: '',
    splitType: 'equal',
    selectedUserIds: [],
    splitValues: {},
    pinnedSplit: {},
  }
}

export function AddBillDialog({
  groupId,
  groupCurrency,
  groupMembers,
  currentUserId,
  editBillId = null,
  onClose,
  onSaved,
}: AddBillDialogProps) {
  const [mode, setMode] = useState<BillMode>('simple')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)

  const [simpleAmount, setSimpleAmount] = useState('')
  const [simpleSplitType, setSimpleSplitType] = useState<SplitType>('equal')
  const [simpleSelectedUserIds, setSimpleSelectedUserIds] = useState<string[]>([])
  const [simpleSplitMeta, setSimpleSplitMeta] = useState<{
    values: Record<string, string>
    pinned: PinnedSplits
  }>({ values: {}, pinned: {} })
  const simpleSplitValues = simpleSplitMeta.values

  const [items, setItems] = useState<ItemDraft[]>([newItem()])
  const [removeItemKey, setRemoveItemKey] = useState<string | null>(null)

  const simpleAmountNum = parseFloat(simpleAmount) || 0
  const pendingRemoveLine = removeItemKey ? items.find((i) => i.key === removeItemKey) : undefined
  const itemizedTotal = items.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0)

  const simpleSplitsOk =
    groupMembers.length === 0 ||
    simpleSelectedUserIds.length === 0 ||
    lineSplitsValid(simpleSplitType, simpleAmountNum, simpleSelectedUserIds, simpleSplitValues)

  const itemizedLinesOk =
    groupMembers.length === 0 ||
    items
      .filter((i) => i.name.trim() && parseFloat(i.amount) > 0)
      .every((item) => {
        if (item.selectedUserIds.length === 0) return true
        return lineSplitsValid(
          item.splitType,
          parseFloat(item.amount) || 0,
          item.selectedUserIds,
          item.splitValues,
        )
      })

  const canSave =
    title.trim() &&
    simpleSplitsOk &&
    itemizedLinesOk &&
    (mode === 'simple'
      ? simpleAmountNum > 0
      : items.some((i) => i.name.trim() && parseFloat(i.amount) > 0))

  const selectedIdsRef = useRef(simpleSelectedUserIds)
  selectedIdsRef.current = simpleSelectedUserIds
  const simpleSplitTypeRef = useRef(simpleSplitType)
  simpleSplitTypeRef.current = simpleSplitType
  const simpleAmountStrRef = useRef(simpleAmount)
  simpleAmountStrRef.current = simpleAmount

  useEffect(() => {
    if (!editBillId) return
    let cancelled = false
    setLoadingEdit(true)
    getBillWithDetails(editBillId).then((d) => {
      if (cancelled || !d) {
        setLoadingEdit(false)
        return
      }
      setTitle(d.title)
      setNote(d.note)
      if (d.items.length === 1) {
        setMode('simple')
        const line = d.items[0]
        setSimpleAmount(String(line.amount))
        const splits = line.splits
        if (splits.length) {
          setSimpleSplitType(splits[0].split_type)
          setSimpleSelectedUserIds(splits.map((s) => s.user_id))
          setSimpleSplitMeta({
            values: Object.fromEntries(splits.map((s) => [s.user_id, String(s.split_value)])),
            pinned: {},
          })
        } else {
          setSimpleSplitType('equal')
          setSimpleSelectedUserIds([])
          setSimpleSplitMeta({ values: {}, pinned: {} })
        }
      } else {
        setMode('itemized')
        setItems(
          d.items.map((item) => ({
            key: item.id,
            name: item.name,
            amount: String(item.amount),
            splitType: item.splits[0]?.split_type ?? 'equal',
            selectedUserIds: item.splits.map((s) => s.user_id),
            splitValues: Object.fromEntries(
              item.splits.map((s) => [s.user_id, String(s.split_value)]),
            ),
            pinnedSplit: {},
          })),
        )
      }
      setLoadingEdit(false)
    })
    return () => {
      cancelled = true
    }
  }, [editBillId])

  function setSimpleSplitTypeAndValues(t: SplitType) {
    setSimpleSplitType(t)
    const ids = selectedIdsRef.current
    if (t === 'equal') {
      setSimpleSplitMeta({ values: {}, pinned: {} })
      return
    }
    if (ids.length === 0) {
      setSimpleSplitMeta({ values: {}, pinned: {} })
      return
    }
    if (t === 'percentage') {
      setSimpleSplitMeta({ values: equalPercentMap(ids), pinned: {} })
      return
    }
    const amt = parseFloat(simpleAmount) || 0
    setSimpleSplitMeta({
      values: amt > 0 ? equalCustomMap(ids, amt) : {},
      pinned: {},
    })
  }

  function onSimpleSplitInputChange(uid: string, raw: string) {
    const ids = selectedIdsRef.current
    const st = simpleSplitTypeRef.current
    const amt = parseFloat(simpleAmountStrRef.current) || 0
    setSimpleSplitMeta((meta) => {
      let pinned = { ...meta.pinned }
      if (raw.trim() === '') {
        const target = st === 'percentage' ? 100 : amt
        return applyClearedSplitField(ids, meta.values, meta.pinned, uid, st === 'percentage' ? 'percentage' : 'custom', target)
      }
      pinned[uid] = true
      const values = { ...meta.values, [uid]: raw }
      if (st === 'percentage') {
        return {
          pinned,
          values: redistributeWithPinned(ids, values, pinned, 100),
        }
      }
      if (amt <= 0) return { pinned, values }
      return {
        pinned,
        values: redistributeWithPinned(ids, values, pinned, amt),
      }
    })
  }

  function toggleSimpleUser(uid: string) {
    setSimpleSelectedUserIds((prev) => {
      const adding = !prev.includes(uid)
      const next = adding ? [...prev, uid] : prev.filter((x) => x !== uid)
      const st = simpleSplitTypeRef.current
      const amt = parseFloat(simpleAmountStrRef.current) || 0
      setSimpleSplitMeta((meta) => {
        let pinned = { ...meta.pinned }
        if (!adding) delete pinned[uid]
        let values = { ...meta.values }
        if (!adding) delete values[uid]

        if (st === 'equal') {
          return { values: {}, pinned: {} }
        }
        if (st === 'percentage') {
          if (Object.keys(pinned).length === 0) {
            return { values: equalPercentMap(next), pinned: {} }
          }
          return {
            pinned,
            values: redistributeWithPinned(next, values, pinned, 100),
          }
        }
        if (st === 'custom' && amt > 0) {
          if (Object.keys(pinned).length === 0) {
            return { values: equalCustomMap(next, amt), pinned: {} }
          }
          return {
            pinned,
            values: redistributeWithPinned(next, values, pinned, amt),
          }
        }
        return { values, pinned }
      })
      return next
    })
  }

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  }

  function commitItemLineAmount(key: string, raw: string) {
    const v = stripLeadingZerosAmount(raw)
    const amt = parseFloat(v) || 0
    setItems((prev) =>
      prev.map((i) => {
        if (i.key !== key) return i
        if (i.splitType !== 'custom' || i.selectedUserIds.length === 0 || amt <= 0) {
          return { ...i, amount: v }
        }
        if (Object.keys(i.pinnedSplit).length === 0) {
          return {
            ...i,
            amount: v,
            splitValues: equalCustomMap(i.selectedUserIds, amt),
            pinnedSplit: {},
          }
        }
        return {
          ...i,
          amount: v,
          splitValues: redistributeWithPinned(
            i.selectedUserIds,
            i.splitValues,
            i.pinnedSplit,
            amt,
          ),
        }
      }),
    )
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
        const adding = !item.selectedUserIds.includes(uid)
        const nextIds = adding
          ? [...item.selectedUserIds, uid]
          : item.selectedUserIds.filter((x) => x !== uid)
        let pinned = { ...item.pinnedSplit }
        if (!adding) delete pinned[uid]
        let values = { ...item.splitValues }
        if (!adding) delete values[uid]

        if (item.splitType === 'equal') {
          return { ...item, selectedUserIds: nextIds, splitValues: {}, pinnedSplit: {} }
        }
        if (item.splitType === 'percentage') {
          if (Object.keys(pinned).length === 0) {
            return {
              ...item,
              selectedUserIds: nextIds,
              splitValues: equalPercentMap(nextIds),
              pinnedSplit: {},
            }
          }
          return {
            ...item,
            selectedUserIds: nextIds,
            splitValues: redistributeWithPinned(nextIds, values, pinned, 100),
            pinnedSplit: pinned,
          }
        }
        const amt = parseFloat(item.amount) || 0
        if (item.splitType === 'custom' && amt > 0) {
          if (Object.keys(pinned).length === 0) {
            return {
              ...item,
              selectedUserIds: nextIds,
              splitValues: equalCustomMap(nextIds, amt),
              pinnedSplit: {},
            }
          }
          return {
            ...item,
            selectedUserIds: nextIds,
            splitValues: redistributeWithPinned(nextIds, values, pinned, amt),
            pinnedSplit: pinned,
          }
        }
        return { ...item, selectedUserIds: nextIds, splitValues: values, pinnedSplit: pinned }
      }),
    )
  }

  function onItemSplitTypeChange(itemKey: string, t: SplitType) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== itemKey) return item
        if (t === 'equal') {
          return { ...item, splitType: t, splitValues: {}, pinnedSplit: {} }
        }
        if (item.selectedUserIds.length === 0) {
          return { ...item, splitType: t, splitValues: {}, pinnedSplit: {} }
        }
        if (t === 'percentage') {
          return {
            ...item,
            splitType: t,
            splitValues: equalPercentMap(item.selectedUserIds),
            pinnedSplit: {},
          }
        }
        const amt = parseFloat(item.amount) || 0
        return {
          ...item,
          splitType: t,
          splitValues: amt > 0 ? equalCustomMap(item.selectedUserIds, amt) : {},
          pinnedSplit: {},
        }
      }),
    )
  }

  function onItemSplitValueChange(itemKey: string, uid: string, raw: string) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== itemKey) return item
        const target = item.splitType === 'percentage' ? 100 : parseFloat(item.amount) || 0
        let pinned = { ...item.pinnedSplit }
        if (raw.trim() === '') {
          const mode = item.splitType === 'percentage' ? 'percentage' : 'custom'
          const { values, pinned: nextPinned } = applyClearedSplitField(
            item.selectedUserIds,
            item.splitValues,
            item.pinnedSplit,
            uid,
            mode,
            target,
          )
          return { ...item, splitValues: values, pinnedSplit: nextPinned }
        }
        pinned[uid] = true
        const values = { ...item.splitValues, [uid]: raw }
        if (item.splitType === 'percentage') {
          return {
            ...item,
            pinnedSplit: pinned,
            splitValues: redistributeWithPinned(item.selectedUserIds, values, pinned, 100),
          }
        }
        if (target <= 0) return { ...item, pinnedSplit: pinned, splitValues: values }
        return {
          ...item,
          pinnedSplit: pinned,
          splitValues: redistributeWithPinned(item.selectedUserIds, values, pinned, target),
        }
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
          items: [
            {
              name: title.trim(),
              amount: simpleAmountNum,
              splits: buildSplitPayload(
                simpleSelectedUserIds,
                simpleSplitType,
                simpleSplitValues,
              ),
            },
          ],
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
            splits: buildSplitPayload(
              item.selectedUserIds,
              item.splitType,
              item.splitValues,
            ),
          })),
        }
      }
      if (editBillId) {
        await updateBill(editBillId, currentUserId, {
          title: input.title,
          note: input.note,
          currency: input.currency,
          items: input.items,
        })
      } else {
        await createBill(input)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const isEdit = Boolean(editBillId)

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative flex w-full max-w-lg animate-[slideUp_0.25s_ease-out] flex-col rounded-t-3xl border border-stone-200 bg-white shadow-[0_-20px_60px_rgba(28,25,23,0.15)] sm:max-h-[90vh] sm:rounded-3xl">
        <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{isEdit ? 'Edit bill' : 'Add bill'}</h2>
            <p className="text-xs text-stone-400">{groupCurrency}</p>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {loadingEdit && (
            <p className="py-6 text-center text-sm text-stone-500">Loading bill…</p>
          )}

          {!loadingEdit && (
            <>
              <div
                className={cn(
                  'rounded-2xl border border-stone-200 bg-stone-50 p-1',
                  isEdit && 'pointer-events-none opacity-60',
                )}
              >
                <div className="grid grid-cols-2 gap-1">
                  {([
                    { id: 'simple', icon: SplitSquareHorizontal, label: 'Simple' },
                    { id: 'itemized', icon: LayoutList, label: 'Itemized' },
                  ] as const).map(({ id, icon: Icon, label }) => (
                    <button
                      key={id}
                      type="button"
                      disabled={isEdit}
                      onClick={() => setMode(id)}
                      className={cn(
                        'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
                        mode === id
                          ? 'bg-stone-800 text-white shadow-sm'
                          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800',
                      )}
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Title</label>
                <Input
                  autoFocus={!isEdit}
                  type="text"
                  placeholder="e.g. Korean BBQ dinner"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Note (optional)</label>
                <Textarea
                  placeholder="Any extra details..."
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              {mode === 'simple' && (
                <div className="space-y-3 rounded-2xl border border-stone-200 bg-stone-50 p-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">Total amount</label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={simpleAmount}
                      onChange={(e) => {
                        const v = filterDecimalInput(e.target.value)
                        setSimpleAmount(v)
                        const amt = parseFloat(v) || 0
                        const ids = selectedIdsRef.current
                        if (simpleSplitType === 'custom' && ids.length > 0 && amt > 0) {
                          setSimpleSplitMeta((meta) => {
                            if (Object.keys(meta.pinned).length === 0) {
                              return { values: equalCustomMap(ids, amt), pinned: {} }
                            }
                            return {
                              pinned: meta.pinned,
                              values: redistributeWithPinned(ids, meta.values, meta.pinned, amt),
                            }
                          })
                        }
                      }}
                      onBlur={() =>
                        setSimpleAmount((prev) => {
                          const next = stripLeadingZerosAmount(prev)
                          return next === prev ? prev : next
                        })
                      }
                      className="text-lg font-semibold"
                    />
                  </div>

                  {groupMembers.length > 0 && (
                    <>
                      <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">Split type</label>
                        <Select
                          value={simpleSplitType}
                          onValueChange={(v) => setSimpleSplitTypeAndValues(v as SplitType)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="equal">Equal split</SelectItem>
                            <SelectItem value="percentage">By percentage</SelectItem>
                            <SelectItem value="custom">Custom amounts</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-stone-600">
                          <UserPlus className="size-3.5" />
                          Split with
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {groupMembers.map((m) => {
                            const selected = simpleSelectedUserIds.includes(m.userId)
                            return (
                              <button
                                key={m.userId}
                                type="button"
                                onClick={() => toggleSimpleUser(m.userId)}
                                className={cn(
                                  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-medium transition-colors',
                                  selected
                                    ? 'border-transparent bg-teal-800 text-white'
                                    : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100',
                                )}
                              >
                                <Users className="size-3.5" />
                                {m.isCurrentUser ? 'You' : m.displayName}
                              </button>
                            )
                          })}
                        </div>

                        <SplitValueRows
                          splitType={simpleSplitType}
                          currency={groupCurrency}
                          selectedUserIds={simpleSelectedUserIds}
                          members={groupMembers}
                          values={simpleSplitValues}
                          pinnedUserIds={simpleSplitMeta.pinned}
                          lineAmount={simpleAmountNum}
                          onChange={onSimpleSplitInputChange}
                        />

                        {simpleSelectedUserIds.length > 0 && simpleAmountNum > 0 && (
                          <div className="rounded-xl border border-teal-800/20 bg-teal-800/5 px-4 py-2.5">
                            {simpleSplitType === 'equal' ? (
                              <p className="text-sm text-stone-700">
                                <span className="font-semibold text-teal-800">
                                  {formatCurrency(
                                    simpleAmountNum / simpleSelectedUserIds.length,
                                    groupCurrency,
                                  )}
                                </span>{' '}
                                each · {simpleSelectedUserIds.length}{' '}
                                {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                              </p>
                            ) : (
                              <p className="text-sm text-stone-500">
                                {formatCurrency(simpleAmountNum, groupCurrency)} among{' '}
                                {simpleSelectedUserIds.length}{' '}
                                {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {mode === 'itemized' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-stone-600">Items</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      type="button"
                      onClick={() => setItems((prev) => [...prev, newItem()])}
                    >
                      <Plus className="size-3.5" />
                      Add item
                    </Button>
                  </div>

                  {items.map((item, index) => (
                    <div key={item.key} className="rounded-2xl border border-stone-200 bg-stone-50 p-3">
                      <div className="flex items-start gap-2">
                        <span className="mt-2.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-teal-800 text-[0.6rem] font-semibold text-white">
                          {index + 1}
                        </span>
                        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                          <Input
                            type="text"
                            placeholder="Item name"
                            className="flex-1 rounded-lg"
                            value={item.name}
                            onChange={(e) => updateItem(item.key, { name: e.target.value })}
                          />
                          <Input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            className="rounded-lg sm:w-28"
                            value={item.amount}
                            onChange={(e) => {
                              const v = filterDecimalInput(e.target.value)
                              const amt = parseFloat(v) || 0
                              const key = item.key
                              setItems((prev) =>
                                prev.map((i) => {
                                  if (i.key !== key) return i
                                  if (
                                    i.splitType !== 'custom' ||
                                    i.selectedUserIds.length === 0 ||
                                    amt <= 0
                                  ) {
                                    return { ...i, amount: v }
                                  }
                                  if (Object.keys(i.pinnedSplit).length === 0) {
                                    return {
                                      ...i,
                                      amount: v,
                                      splitValues: equalCustomMap(i.selectedUserIds, amt),
                                      pinnedSplit: {},
                                    }
                                  }
                                  return {
                                    ...i,
                                    amount: v,
                                    splitValues: redistributeWithPinned(
                                      i.selectedUserIds,
                                      i.splitValues,
                                      i.pinnedSplit,
                                      amt,
                                    ),
                                  }
                                }),
                              )
                            }}
                            onBlur={() => commitItemLineAmount(item.key, item.amount)}
                          />
                        </div>
                        {items.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            type="button"
                            className="mt-1.5 rounded-full text-red-600"
                            onClick={() => setRemoveItemKey(item.key)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>

                      {groupMembers.length > 0 && (
                        <div className="mt-3 border-t border-stone-200 pt-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500">
                              <UserPlus className="size-3.5" />
                              Split with
                            </div>
                            <Select
                              value={item.splitType}
                              onValueChange={(v) => onItemSplitTypeChange(item.key, v as SplitType)}
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

                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {groupMembers.map((m) => {
                              const selected = item.selectedUserIds.includes(m.userId)
                              return (
                                <button
                                  key={m.userId}
                                  type="button"
                                  onClick={() => toggleUserForItem(item.key, m.userId)}
                                  className={cn(
                                    'inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors',
                                    selected
                                      ? 'border-transparent bg-teal-800 text-white'
                                      : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100',
                                  )}
                                >
                                  <Users className="size-3" />
                                  {m.isCurrentUser ? 'You' : m.displayName}
                                </button>
                              )
                            })}
                          </div>

                          <SplitValueRows
                            splitType={item.splitType}
                            currency={groupCurrency}
                            selectedUserIds={item.selectedUserIds}
                            members={groupMembers}
                            values={item.splitValues}
                            pinnedUserIds={item.pinnedSplit}
                            lineAmount={parseFloat(item.amount) || 0}
                            onChange={(uid, raw) => onItemSplitValueChange(item.key, uid, raw)}
                          />

                          {item.selectedUserIds.length > 0 &&
                            item.splitType === 'equal' &&
                            parseFloat(item.amount) > 0 && (
                              <p className="mt-1.5 text-xs text-stone-400">
                                {formatCurrency(
                                  parseFloat(item.amount) / item.selectedUserIds.length,
                                  groupCurrency,
                                )}{' '}
                                each
                              </p>
                            )}
                        </div>
                      )}
                    </div>
                  ))}

                  {itemizedTotal > 0 && (
                    <div className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white px-4 py-3">
                      <span className="text-sm font-medium text-stone-600">Running total</span>
                      <span className="text-lg font-semibold text-stone-800">
                        {formatCurrency(itemizedTotal, groupCurrency)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-stone-100 px-5 py-4">
          <Button
            className="w-full rounded-xl"
            disabled={!canSave || saving || loadingEdit}
            onClick={handleSave}
          >
            <Save className="size-4" />
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save bill'}
          </Button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      open={removeItemKey !== null}
      onOpenChange={(open) => !open && setRemoveItemKey(null)}
      title="Remove this line?"
      description={
        pendingRemoveLine?.name.trim()
          ? `“${pendingRemoveLine.name.trim()}” will be removed from this bill.`
          : 'This line will be removed from this bill.'
      }
      confirmLabel="Remove line"
      variant="danger"
      onConfirm={() => {
        if (!removeItemKey) return
        removeItem(removeItemKey)
        setRemoveItemKey(null)
      }}
    />
    </>
  )
}
