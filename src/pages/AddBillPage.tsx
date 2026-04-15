import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  LayoutList,
  Plus,
  Save,
  SplitSquareHorizontal,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { db } from '@/db/db'
import {
  createBill,
  createLocalProfile,
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
import { BILL_BACK_QUERY, parseSafeAppPath, withBillBackQuery } from '@/lib/bill-navigation'
import { listCanonicalRelatedProfileIds } from '@/lib/people'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
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

function isItemizedLineComplete(
  item: ItemDraft,
  hasMemberPicker: boolean,
): boolean {
  if (!item.name.trim() || parseFloat(item.amount) <= 0) return false
  if (!hasMemberPicker) return true
  if (item.selectedUserIds.length === 0) return false
  return lineSplitsValid(
    item.splitType,
    parseFloat(item.amount) || 0,
    item.selectedUserIds,
    item.splitValues,
  )
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
  const returnBack = parseSafeAppPath(searchParams.get(BILL_BACK_QUERY))

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
  const [collapsedItemKeys, setCollapsedItemKeys] = useState<string[]>([])
  const [addPersonOpen, setAddPersonOpen] = useState(false)
  const [addPersonName, setAddPersonName] = useState('')
  const [addPersonBusy, setAddPersonBusy] = useState(false)
  const [addPersonTarget, setAddPersonTarget] = useState<'simple' | string>('simple')
  const [removeItemKey, setRemoveItemKey] = useState<string | null>(null)

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

  const personalSplitMembers = useLiveQuery(async () => {
    if (!userId) return []
    const ids = await listCanonicalRelatedProfileIds(userId)
    const out: { userId: string; displayName: string; isCurrentUser: boolean }[] = []
    out.push({
      userId,
      displayName: 'You',
      isCurrentUser: true,
    })
    for (const id of ids) {
      const p = await db.profiles.get(id)
      if (!p || p.is_deleted) continue
      out.push({
        userId: id,
        displayName: p.display_name,
        isCurrentUser: id === userId,
      })
    }
    out.sort((a, b) => {
      if (a.isCurrentUser !== b.isCurrentUser) return a.isCurrentUser ? -1 : 1
      return a.displayName.localeCompare(b.displayName)
    })
    return out
  }, [userId])

  const itemizedTotal = items.reduce((sum, item) => {
    const val = parseFloat(item.amount)
    return sum + (isNaN(val) ? 0 : val)
  }, 0)

  const simpleAmountNum = parseFloat(simpleAmount) || 0
  const groupsLoading = groups === undefined
  const groupMembersLoading = groupMembers === undefined
  const personalMembersLoading = personalSplitMembers === undefined
  const membersLoading = groupId ? groupMembersLoading : personalMembersLoading
  const members = groupId ? (groupMembers ?? []) : (personalSplitMembers ?? [])
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
    if (!editBillId || !userId) return
    let cancelled = false
    setLoadingEdit(true)
    getBillWithDetails(editBillId).then((d) => {
      if (cancelled) return
      if (!d) {
        setLoadingEdit(false)
        return
      }
      if (d.created_by !== userId) {
        setLoadingEdit(false)
        navigate(
          returnBack
            ? withBillBackQuery(`/app/bills/${editBillId}`, returnBack)
            : `/app/bills/${editBillId}`,
          { replace: true },
        )
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
  }, [editBillId, userId, navigate, returnBack])

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
      const pinned = { ...meta.pinned }
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
        const pinned = { ...meta.pinned }
        if (!adding) delete pinned[uid]
        const values = { ...meta.values }
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

  function collapseItemLine(key: string) {
    setCollapsedItemKeys((k) => (k.includes(key) ? k : [...k, key]))
  }

  function expandItemLine(key: string) {
    setCollapsedItemKeys((k) => k.filter((x) => x !== key))
  }

  function openAddPerson(target: 'simple' | string) {
    setAddPersonTarget(target)
    setAddPersonName('')
    setAddPersonOpen(true)
  }

  async function submitAddPerson() {
    if (!userId || !addPersonName.trim()) return
    setAddPersonBusy(true)
    try {
      const result = await createLocalProfile(addPersonName.trim(), userId)
      const id = result.id
      if (addPersonTarget === 'simple') {
        if (!simpleSelectedUserIds.includes(id)) {
          toggleSimpleUser(id)
        }
      } else if (!items.find((i) => i.key === addPersonTarget)?.selectedUserIds.includes(id)) {
        toggleUserForItem(addPersonTarget, id)
      }
      setAddPersonOpen(false)
      setAddPersonName('')
    } finally {
      setAddPersonBusy(false)
    }
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

  const pendingRemoveLine = removeItemKey ? items.find((i) => i.key === removeItemKey) : undefined

  function toggleUserForItem(itemKey: string, uid: string) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== itemKey) return item
        const adding = !item.selectedUserIds.includes(uid)
        const nextIds = adding
          ? [...item.selectedUserIds, uid]
          : item.selectedUserIds.filter((x) => x !== uid)
        const pinned = { ...item.pinnedSplit }
        if (!adding) delete pinned[uid]
        const values = { ...item.splitValues }
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
        const pinned = { ...item.pinnedSplit }
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
        navigate(
          returnBack
            ? withBillBackQuery(`/app/bills/${editBillId}`, returnBack)
            : `/app/bills/${editBillId}`,
        )
      } else {
        await createBill(input)
        navigate('/app/bills')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save bill right now.'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <div className="space-y-5 overscroll-y-contain pb-28 lg:pb-0">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link
            to={
              isEdit && editBillId
                ? returnBack
                  ? withBillBackQuery(`/app/bills/${editBillId}`, returnBack)
                  : `/app/bills/${editBillId}`
                : '/app/bills'
            }
          >
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <Button
          onClick={handleSave}
          disabled={!canSave || saving || loadingEdit}
          className="hidden rounded-full lg:inline-flex"
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
                    disabled={isEdit || groupsLoading}
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
                  {groupsLoading && !isEdit && (
                    <p className="text-xs text-stone-400">Loading your groups…</p>
                  )}
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
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={simpleAmount}
                    onChange={(e) => {
                      const v = normalizeAmountInput(e.target.value)
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

                {membersLoading && (
                  <div className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3">
                    <div className="h-4 w-40 animate-pulse rounded bg-stone-200" />
                  </div>
                )}

                {!membersLoading && members.length > 0 && (
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

                      {!groupId && userId && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-9 w-fit rounded-full px-2 text-teal-800"
                            onClick={() => openAddPerson('simple')}
                          >
                            <UserPlus className="size-3.5" />
                            Add person
                          </Button>
                          {addPersonOpen && addPersonTarget === 'simple' && (
                            <div className="rounded-xl border border-teal-800/20 bg-teal-800/5 p-3">
                              <p className="text-xs font-medium text-stone-700">New local contact</p>
                              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Input
                                  placeholder="Name"
                                  value={addPersonName}
                                  onChange={(e) => setAddPersonName(e.target.value)}
                                  className="rounded-lg sm:flex-1"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void submitAddPerson()
                                  }}
                                />
                                <div className="flex gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-9 rounded-lg"
                                    disabled={addPersonBusy || !addPersonName.trim()}
                                    onClick={() => void submitAddPerson()}
                                  >
                                    {addPersonBusy ? '…' : 'Add'}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 rounded-lg"
                                    onClick={() => setAddPersonOpen(false)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            </div>
                          )}
                        </>
                      )}

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

                {!groupId && !membersLoading && members.length <= 1 && (
                  <p className="text-xs text-stone-400">
                    Add people under People (or join a group) to split personal bills with others.
                  </p>
                )}
              </div>
            </div>
          )}

          {mode === 'itemized' && (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold">Items</h2>
                <p className="text-xs text-stone-500">
                  {items.filter((i) => parseFloat(i.amount) > 0).length} item
                  {items.filter((i) => parseFloat(i.amount) > 0).length !== 1 ? 's' : ''}
                </p>
              </div>

              <div className="mt-4 space-y-3">
                {items.map((item, index) => {
                  const memberPicker = members.length > 0
                  const lineComplete = isItemizedLineComplete(item, memberPicker)
                  const collapsed = collapsedItemKeys.includes(item.key) && lineComplete
                  if (collapsed) {
                    return (
                      <div
                        key={item.key}
                        className="rounded-2xl border border-stone-200 bg-stone-100/60 p-2"
                      >
                        <button
                          type="button"
                          onClick={() => expandItemLine(item.key)}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left transition-colors hover:bg-stone-100/80"
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-teal-800 text-[0.65rem] font-semibold text-white">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium text-stone-800">
                            {item.name.trim() || `Item ${index + 1}`}
                          </span>
                          <span className="shrink-0 tabular-nums text-sm font-semibold text-stone-700">
                            {formatCurrency(parseFloat(item.amount) || 0, currency)}
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-stone-400" aria-hidden />
                        </button>
                      </div>
                    )
                  }
                  return (
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
                          type="text"
                          inputMode="decimal"
                          placeholder="0.00"
                          className="rounded-lg sm:w-32"
                          value={item.amount}
                          onChange={(e) => {
                            const v = normalizeAmountInput(e.target.value)
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
                      <div className="flex shrink-0 gap-0.5">
                        {lineComplete && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            type="button"
                            className="mt-1.5 rounded-full text-stone-500"
                            onClick={() => collapseItemLine(item.key)}
                            aria-label="Collapse line"
                          >
                            <ChevronDown className="size-4" />
                          </Button>
                        )}
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
                    </div>

                    {members.length > 0 && (
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

                        {!groupId && userId && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="mt-1 h-8 w-fit rounded-full px-2 text-xs text-teal-800"
                              onClick={() => openAddPerson(item.key)}
                            >
                              <UserPlus className="size-3" />
                              Add person
                            </Button>
                            {addPersonOpen && addPersonTarget === item.key && (
                              <div className="mt-2 rounded-xl border border-teal-800/20 bg-teal-800/5 p-3">
                                <p className="text-xs font-medium text-stone-700">New local contact</p>
                                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                                  <Input
                                    placeholder="Name"
                                    value={addPersonName}
                                    onChange={(e) => setAddPersonName(e.target.value)}
                                    className="h-9 rounded-lg sm:flex-1"
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') void submitAddPerson()
                                    }}
                                  />
                                  <div className="flex gap-2">
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="h-9 rounded-lg"
                                      disabled={addPersonBusy || !addPersonName.trim()}
                                      onClick={() => void submitAddPerson()}
                                    >
                                      {addPersonBusy ? '…' : 'Add'}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-9 rounded-lg"
                                      onClick={() => setAddPersonOpen(false)}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </>
                        )}

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
                )
                })}
              </div>

              <div className="mt-4">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full rounded-xl border-dashed border-stone-300"
                  onClick={() => setItems((prev) => [...prev, newItem()])}
                >
                  <Plus className="size-4" />
                  Add item
                </Button>
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

    {!loadingEdit && (
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-50 border-t border-stone-200/90 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
        <Button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="h-11 w-full rounded-xl"
        >
          <Save className="size-4" />
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save bill'}
        </Button>
      </div>
    )}

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
