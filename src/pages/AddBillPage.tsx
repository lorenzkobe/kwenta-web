import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, LayoutList, Plus, Save, SplitSquareHorizontal, Trash2, UserPlus, Users } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  createBill,
  getBillWithDetails,
  updateBill,
  type CreateBillInput,
} from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
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
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { SplitValueRows } from '@/components/common/SplitValueRows'

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

const CURRENCIES = [
  { value: 'PHP', label: 'PHP — Philippine Peso' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'KRW', label: 'KRW — Korean Won' },
  { value: 'GBP', label: 'GBP — British Pound' },
]

export function AddBillPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const groupIdParam = searchParams.get('groupId')
  const editBillId = searchParams.get('edit')

  const { userId } = useCurrentUser()

  const [mode, setMode] = useState<BillMode>('simple')
  const [title, setTitle] = useState('')
  const [currency, setCurrency] = useState('PHP')
  const [groupId, setGroupId] = useState<string | null>(groupIdParam)
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

  const itemizedTotal = items.reduce((sum, item) => {
    const val = parseFloat(item.amount)
    return sum + (isNaN(val) ? 0 : val)
  }, 0)

  const simpleAmountNum = parseFloat(simpleAmount) || 0
  const members = groupMembers ?? []
  const isEdit = Boolean(editBillId)

  const simpleSplitsOk =
    members.length === 0 ||
    simpleSelectedUserIds.length === 0 ||
    lineSplitsValid(simpleSplitType, simpleAmountNum, simpleSelectedUserIds, simpleSplitValues)

  const itemizedLinesOk =
    members.length === 0 ||
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
    Boolean(userId) &&
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
      setCurrency(d.currency)
      setGroupId(d.group_id)
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
    if (!userId || !canSave) return
    setSaving(true)
    try {
      let input: CreateBillInput
      if (mode === 'simple') {
        input = {
          title: title.trim(),
          currency,
          groupId,
          createdBy: userId,
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
          currency,
          groupId,
          createdBy: userId,
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
        await updateBill(editBillId, userId, {
          title: input.title,
          note: input.note,
          currency: input.currency,
          items: input.items,
        })
        navigate(`/app/bills/${editBillId}`)
      } else {
        await createBill(input)
        navigate('/app/bills')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to={isEdit ? `/app/bills/${editBillId}` : '/app/bills'}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <Button
          onClick={handleSave}
          disabled={!canSave || saving || loadingEdit}
          className="rounded-full"
        >
          <Save className="size-4" />
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save bill'}
        </Button>
      </div>

      {loadingEdit && (
        <p className="rounded-2xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500">
          Loading bill…
        </p>
      )}

      {!loadingEdit && (
        <>
          <div
            className={cn(
              'rounded-3xl border border-stone-200 bg-white p-1.5 shadow-sm',
              isEdit && 'pointer-events-none opacity-60',
            )}
          >
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={isEdit}
                onClick={() => setMode('simple')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-colors',
                  mode === 'simple'
                    ? 'bg-stone-800 text-white shadow-sm'
                    : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800',
                )}
              >
                <SplitSquareHorizontal className="size-4" />
                Simple
              </button>
              <button
                type="button"
                disabled={isEdit}
                onClick={() => setMode('itemized')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-colors',
                  mode === 'itemized'
                    ? 'bg-stone-800 text-white shadow-sm'
                    : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800',
                )}
              >
                <LayoutList className="size-4" />
                Itemized
              </button>
            </div>
          </div>

          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <h1 className="text-xl font-semibold tracking-tight">
              {isEdit
                ? 'Edit bill'
                : mode === 'simple'
                  ? 'New bill'
                  : 'New itemized bill'}
            </h1>

            <div className="mt-4 space-y-3">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Title</label>
                <Input
                  type="text"
                  placeholder="e.g. Korean BBQ dinner"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Currency</label>
                  <Select
                    value={currency}
                    onValueChange={setCurrency}
                    disabled={isEdit}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Group (optional)</label>
                  <Select
                    value={groupId ?? '_none'}
                    onValueChange={(val) => setGroupId(val === '_none' ? null : val)}
                    disabled={isEdit}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">Personal (no group)</SelectItem>
                      {(groups ?? []).map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
            </div>
          </div>

          {mode === 'simple' && (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Amount &amp; split</h2>

              <div className="mt-4 space-y-3">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">Total amount</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    value={simpleAmount}
                    onChange={(e) => {
                      const v = e.target.value
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
                    className="text-lg font-semibold"
                  />
                </div>

                {groupId && members.length > 0 && (
                  <>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">Split type</label>
                      <Select
                        value={simpleSplitType}
                        onValueChange={(val) => setSimpleSplitTypeAndValues(val as SplitType)}
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
                        {members.map((member) => {
                          const isSelected = simpleSelectedUserIds.includes(member.userId)
                          return (
                            <button
                              key={member.userId}
                              type="button"
                              onClick={() => toggleSimpleUser(member.userId)}
                              className={cn(
                                'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-medium transition-colors',
                                isSelected
                                  ? 'border-transparent bg-teal-800 text-white'
                                  : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100',
                              )}
                            >
                              <Users className="size-3.5" />
                              {member.isCurrentUser ? 'You' : member.displayName}
                            </button>
                          )
                        })}
                      </div>

                      <SplitValueRows
                        splitType={simpleSplitType}
                        currency={currency}
                        selectedUserIds={simpleSelectedUserIds}
                        members={members}
                        values={simpleSplitValues}
                        pinnedUserIds={simpleSplitMeta.pinned}
                        lineAmount={simpleAmountNum}
                        onChange={onSimpleSplitInputChange}
                      />

                      {simpleSelectedUserIds.length > 0 && simpleAmountNum > 0 && (
                        <div className="rounded-2xl border border-teal-800/20 bg-teal-800/5 px-4 py-3">
                          {simpleSplitType === 'equal' ? (
                            <p className="text-sm text-stone-700">
                              <span className="font-semibold text-teal-800">
                                {formatCurrency(
                                  simpleAmountNum / simpleSelectedUserIds.length,
                                  currency,
                                )}
                              </span>{' '}
                              each across {simpleSelectedUserIds.length}{' '}
                              {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                            </p>
                          ) : (
                            <p className="text-sm text-stone-500">
                              Total:{' '}
                              <span className="font-semibold text-stone-800">
                                {formatCurrency(simpleAmountNum, currency)}
                              </span>{' '}
                              among {simpleSelectedUserIds.length}{' '}
                              {simpleSelectedUserIds.length === 1 ? 'person' : 'people'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {!groupId && (
                  <p className="text-xs text-stone-400">
                    Select a group above to split this bill among members.
                  </p>
                )}
              </div>
            </div>
          )}

          {mode === 'itemized' && (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Items</h2>
                  <p className="text-xs text-stone-500">
                    {items.filter((i) => parseFloat(i.amount) > 0).length} item
                    {items.filter((i) => parseFloat(i.amount) > 0).length !== 1 ? 's' : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  type="button"
                  onClick={() => setItems((prev) => [...prev, newItem()])}
                >
                  <Plus className="size-4" />
                  Add item
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                {items.map((item, index) => (
                  <div
                    key={item.key}
                    className="rounded-2xl border border-stone-200 bg-stone-100/60 p-4"
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-teal-800 text-[0.65rem] font-semibold text-white">
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
                          type="number"
                          placeholder="0.00"
                          className="rounded-lg sm:w-32"
                          value={item.amount}
                          min="0"
                          step="0.01"
                          onChange={(e) => {
                            const v = e.target.value
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
                        />
                      </div>
                      {items.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          type="button"
                          className="mt-1.5 rounded-full text-red-600"
                          onClick={() => removeItem(item.key)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>

                    {groupId && members.length > 0 && (
                      <div className="mt-3 border-t border-stone-200 pt-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500">
                            <UserPlus className="size-3.5" />
                            Split with
                          </div>
                          <Select
                            value={item.splitType}
                            onValueChange={(val) => onItemSplitTypeChange(item.key, val as SplitType)}
                          >
                            <SelectTrigger className="h-8 w-auto min-w-32 rounded-lg text-xs">
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
                          {members.map((member) => {
                            const isSelected = item.selectedUserIds.includes(member.userId)
                            return (
                              <button
                                key={member.userId}
                                type="button"
                                onClick={() => toggleUserForItem(item.key, member.userId)}
                                className={cn(
                                  'inline-flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                                  isSelected
                                    ? 'border-transparent bg-teal-800 text-white'
                                    : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100',
                                )}
                              >
                                <Users className="size-3" />
                                {member.isCurrentUser ? 'You' : member.displayName}
                              </button>
                            )
                          })}
                        </div>

                        <SplitValueRows
                          splitType={item.splitType}
                          currency={currency}
                          selectedUserIds={item.selectedUserIds}
                          members={members}
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

              {itemizedTotal > 0 && (
                <div className="mt-4 flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
                  <span className="text-sm font-medium text-stone-600">Running total</span>
                  <span className="text-lg font-semibold text-stone-800">
                    {formatCurrency(itemizedTotal, currency)}
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
