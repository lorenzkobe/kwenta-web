import { useState, useEffect, useRef } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  History,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  ReceiptText,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  addGroupMember,
  addExistingGroupMember,
  createBundledGroupSettlement,
  createSettlement,
  removeGroupMember,
  deleteGroup,
  updateGroup,
  getBillWithDetails,
} from '@/db/operations'
import {
  computeGroupBalances,
  type GroupBalanceSummary,
  type SettlementHistoryItem,
} from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
import {
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type BillCategory,
} from '@/lib/bill-categories'
import { exportGroupToCSV } from '@/lib/export-csv'
import { generateGroupPDF } from '@/lib/export-pdf'
import { makeExportFilename } from '@/lib/export-utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { AddBillDialog } from '@/components/common/AddBillDialog'
import { BillDetailModal } from '@/components/common/BillDetailModal'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ExportImageDialog } from '@/components/export/ExportImageDialog'
import { GroupExportCard } from '@/components/export/GroupExportCard'
import { GroupMemberExportCard, type GroupMemberBillEntry } from '@/components/export/GroupMemberExportCard'
import { useGroupSettlementHistory } from '@/db/hooks'
import { getMemberSuggestions } from '@/lib/people'

const CURRENCY_OPTIONS = [
  ['PHP', 'PHP — Philippine Peso'],
  ['USD', 'USD — US Dollar'],
  ['EUR', 'EUR — Euro'],
  ['JPY', 'JPY — Japanese Yen'],
  ['KRW', 'KRW — Korean Won'],
  ['GBP', 'GBP — British Pound'],
] as const

type MemberRow = {
  id: string
  userId: string
  profileName: string
  isCurrentUser: boolean
}

function sheetBackdrop(onClose: () => void) {
  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      aria-hidden
    />
  )
}

function ManageMembersDialog({
  groupId,
  members,
  currentUserId,
  creatorUserId,
  isCreator,
  onClose,
  onChanged,
}: {
  groupId: string
  members: MemberRow[]
  currentUserId: string
  creatorUserId: string
  isCreator: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeMemberTarget, setRemoveMemberTarget] = useState<{
    userId: string
    profileName: string
  } | null>(null)
  const [suggestions, setSuggestions] = useState<
    Awaited<ReturnType<typeof getMemberSuggestions>>
  >([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const q = newName.trim()
      if (q.length < 1) {
        setSuggestions([])
        return
      }
      const s = await getMemberSuggestions(currentUserId, q)
      if (!cancelled) setSuggestions(s)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [newName, currentUserId])

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    try {
      await addGroupMember(groupId, newName.trim(), currentUserId)
      setNewName('')
      onChanged()
    } finally {
      setAdding(false)
    }
  }

  async function executeRemoveMember() {
    if (!removeMemberTarget) return
    const memberUserId = removeMemberTarget.userId
    setRemoveMemberTarget(null)
    setRemoving(memberUserId)
    try {
      await removeGroupMember(groupId, memberUserId, currentUserId)
      onChanged()
    } finally {
      setRemoving(null)
    }
  }

  async function handlePickSuggestion(profileId: string) {
    setAdding(true)
    try {
      await addExistingGroupMember(groupId, profileId, currentUserId)
      setNewName('')
      setSuggestions([])
      onChanged()
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-teal-800" />
            <h2 className="text-base font-semibold">Members</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-64 overflow-y-auto px-5 py-3">
          {members.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-400">No members yet</p>
          ) : (
            <ul className="space-y-1.5">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-xl px-2 py-2"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-800/15 text-xs font-semibold text-teal-800">
                    {m.profileName.charAt(0).toUpperCase()}
                  </div>
                  <span className="flex-1 text-sm font-medium text-stone-800">
                    {m.profileName}
                    {m.isCurrentUser && (
                      <Badge className="ml-1.5 px-2.5 py-1 text-[0.65rem] leading-none">You</Badge>
                    )}
                    {m.userId === creatorUserId && (
                      <Badge className="ml-1.5 px-2.5 py-1 text-[0.65rem] leading-none bg-amber-100 text-amber-800 border-amber-200">Owner</Badge>
                    )}
                  </span>
                  {!m.isCurrentUser && isCreator && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full text-stone-400 hover:text-red-600"
                      disabled={removing === m.userId}
                      onClick={() =>
                        setRemoveMemberTarget({ userId: m.userId, profileName: m.profileName })
                      }
                    >
                      {removing === m.userId ? (
                        <span className="size-3.5 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
                      ) : (
                        <UserMinus className="size-3.5" />
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {isCreator && <div className="border-t border-stone-100 px-5 py-4">
          <p className="mb-3 text-xs font-medium text-stone-500">Add a member</p>
          {suggestions.filter((s) => !members.some((m) => m.userId === s.id)).length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {suggestions
                .filter((s) => !members.some((m) => m.userId === s.id))
                .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={adding}
                  onClick={() => void handlePickSuggestion(s.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    s.kind === 'local'
                      ? 'border-teal-800/25 bg-teal-800/8 text-teal-900 hover:bg-teal-800/10'
                      : 'border-stone-200 bg-stone-100 text-stone-700 hover:bg-stone-200',
                  )}
                >
                  {s.displayName}
                  <span className="ml-1 text-[0.65rem] opacity-70">
                    {s.kind === 'local' ? 'Saved' : 'Group'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              type="text"
              placeholder="Member name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 rounded-lg"
            />
            <Button
              size="sm"
              className="rounded-lg"
              disabled={!newName.trim() || adding}
              onClick={handleAdd}
            >
              <UserPlus className="size-3.5" />
              {adding ? '…' : 'Add'}
            </Button>
          </div>
          <p className="mt-2 text-[0.65rem] text-stone-400">
            New names are saved to your phonebook (unique per name). Tap a suggestion to add someone
            you already know.
          </p>
        </div>}
      </div>
    </div>

    <ConfirmDialog
      open={removeMemberTarget !== null}
      onOpenChange={(open) => !open && setRemoveMemberTarget(null)}
      title="Remove from group?"
      description={
        removeMemberTarget
          ? `${removeMemberTarget.profileName} will be removed from this group. Their splits on group bills will be cleared or adjusted.`
          : 'This member will be removed from the group.'
      }
      confirmLabel="Remove member"
      variant="danger"
      onConfirm={executeRemoveMember}
    />
    </>
  )
}

function EditGroupDialog({
  groupId,
  initialName,
  initialCurrency,
  currentUserId,
  onClose,
  onSaved,
}: {
  groupId: string
  initialName: string
  initialCurrency: string
  currentUserId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initialName)
  const [currency, setCurrency] = useState(initialCurrency)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await updateGroup(groupId, { name: name.trim(), currency }, currentUserId)
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Pencil className="size-4 text-teal-800" />
            <h2 className="text-base font-semibold">Edit group</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="edit-group-name" className="text-sm font-medium text-stone-800">
              Group name
            </label>
            <Input
              id="edit-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="edit-group-currency" className="text-sm font-medium text-stone-800">
              Currency
            </label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="edit-group-currency" className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCY_OPTIONS.map(([code, label]) => (
                  <SelectItem key={code} value={code}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full rounded-xl" disabled={!name.trim() || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PaymentHistoryDialog({
  items,
  loading = false,
  currentUserId,
  onClose,
  onEdit,
}: {
  items: SettlementHistoryItem[]
  loading?: boolean
  currentUserId: string | null | undefined
  onClose: () => void
  onEdit?: (item: SettlementHistoryItem) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative flex max-h-[min(85dvh,560px)] w-full max-w-sm flex-col animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <History className="size-4 text-teal-800" />
            <h2 className="text-base font-semibold">Payment history</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-teal-800" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-stone-400">No recorded payments yet</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-stone-500">
                Payments recorded with Pay are already reflected in member balances.
              </p>
              <SettlementHistoryList
                items={items}
                currentUserId={currentUserId}
                onEdit={onEdit}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function GroupOptionsMenu({
  onEdit,
  onMembers,
  onPaymentHistory,
  onDelete,
  canManageGroup,
  onClose,
}: {
  onEdit: () => void
  onMembers: () => void
  onPaymentHistory: () => void
  onDelete: () => void
  canManageGroup: boolean
  onClose: () => void
}) {
  const itemClass =
    'flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-2 shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <p className="px-3 pb-2 pt-1 text-center text-xs font-medium uppercase tracking-wide text-stone-400">
          Group options
        </p>
        <button type="button" className={itemClass} onClick={onPaymentHistory}>
          <History className="size-4 text-teal-800" />
          Payment history
        </button>
        <button type="button" className={itemClass} onClick={onMembers}>
          <Users className="size-4 text-teal-800" />
          Members
        </button>
        {canManageGroup && (
          <button type="button" className={itemClass} onClick={onEdit}>
            <Pencil className="size-4 text-teal-800" />
            Edit group
          </button>
        )}
        {canManageGroup && (
          <button
            type="button"
            className={cn(itemClass, 'text-red-600 hover:bg-red-50')}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
            Delete group
          </button>
        )}
        <Button variant="ghost" className="mt-1 w-full rounded-xl text-stone-500" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const { userId } = useCurrentUser()

  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [showEditGroup, setShowEditGroup] = useState(false)
  const [showManage, setShowManage] = useState(false)
  const [showPaymentHistory, setShowPaymentHistory] = useState(false)
  const [showAddBill, setShowAddBill] = useState(false)
  const [detailBillId, setDetailBillId] = useState<string | null>(null)
  const [editBillId, setEditBillId] = useState<string | null>(null)
  const [balanceSummary, setBalanceSummary] = useState<GroupBalanceSummary | null>(null)
  const [editingSettlement, setEditingSettlement] = useState<SettlementHistoryItem | null>(null)
  const [recordSettlement, setRecordSettlement] = useState<{
    fromUserId: string
    totalAmount: number
    fromName: string
    recipients: { toUserId: string; toName: string; amount: number }[]
  } | null>(null)
  const [deleteGroupConfirmOpen, setDeleteGroupConfirmOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMember, setExportMember] = useState<{
    userId: string
    profileName: string
    netBalance: number
    bills: GroupMemberBillEntry[]
  } | null>(null)

  async function handleMemberShare(member: { userId: string; profileName: string }) {
    if (!group) return
    const net = Math.round((balanceByUser.get(member.userId) ?? 0) * 100) / 100
    const memberBills: GroupMemberBillEntry[] = []
    for (const bill of bills ?? []) {
      const details = await getBillWithDetails(bill.id)
      if (!details) continue
      let share = 0
      for (const item of details.items) {
        for (const split of item.splits) {
          if (split.user_id === member.userId) share += split.computed_amount
        }
      }
      if (share > 0.005) {
        memberBills.push({
          id: bill.id,
          title: bill.title,
          note: details.note ?? null,
          currency: bill.currency,
          memberShare: Math.round(share * 100) / 100,
        })
      }
    }
    setExportMember({ userId: member.userId, profileName: member.profileName, netBalance: net, bills: memberBills })
  }

  const settlementHistory = useGroupSettlementHistory(groupId)

  const group = useLiveQuery(
    () => (groupId ? db.groups.get(groupId) : undefined),
    [groupId],
  )

  const members = useLiveQuery(async () => {
    if (!groupId) return []
    const all = await db.group_members.where('group_id').equals(groupId).toArray()
    const active = all.filter((m) => !m.is_deleted)
    active.sort((a, b) => {
      const aMe = a.user_id === userId
      const bMe = b.user_id === userId
      if (aMe !== bMe) return aMe ? -1 : 1
      return a.joined_at.localeCompare(b.joined_at)
    })
    return Promise.all(
      active.map(async (m) => {
        const profile = await db.profiles.get(m.user_id)
        return {
          id: m.id,
          userId: m.user_id,
          profileName: profile?.display_name ?? m.display_name,
          isCurrentUser: m.user_id === userId,
        }
      }),
    )
  }, [groupId, userId])

  const bills = useLiveQuery(async () => {
    if (!groupId) return []
    const all = await db.bills.where('group_id').equals(groupId).toArray()
    const active = all.filter((b) => !b.is_deleted)
    active.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return Promise.all(
      active.map(async (bill) => {
        const creator = await db.profiles.get(bill.created_by)
        let creatorName = creator?.display_name
        if (!creatorName) {
          const member = await db.group_members
            .where('[group_id+user_id]')
            .equals([groupId, bill.created_by])
            .first()
          creatorName = member?.display_name
        }
        return { ...bill, creatorName: creatorName ?? 'Unknown' }
      }),
    )
  }, [groupId])

  const membershipLoaded = Array.isArray(members)
  const groupLoading = group === undefined
  const membersLoading = members === undefined
  const billsLoading = bills === undefined
  const currentUserHasActiveMembership = Boolean(
    userId && (members ?? []).some((m) => m.userId === userId),
  )
  const isGroupCreator = Boolean(userId && group && group.created_by === userId)

  async function refreshBalances() {
    if (!groupId || !userId) return
    const updated = await computeGroupBalances(groupId, userId)
    setBalanceSummary(updated)
  }

  useEffect(() => {
    refreshBalances()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, userId, bills, members])

  async function executeDeleteGroup() {
    if (!groupId || !userId || !isGroupCreator) return
    await deleteGroup(groupId, userId)
    navigate('/app/groups')
  }

  function openDeleteFromMenu() {
    if (!isGroupCreator) return
    setShowOptionsMenu(false)
    setDeleteGroupConfirmOpen(true)
  }

  if (groupLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (!group || group.is_deleted || (userId && membershipLoaded && !currentUserHasActiveMembership)) {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/groups">
            <ArrowLeft className="size-4" />
            Back to groups
          </Link>
        </Button>
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-center text-sm text-stone-500">Group not found</p>
        </div>
      </div>
    )
  }

  const balanceByUser = new Map<string, number>()
  if (balanceSummary) {
    for (const b of balanceSummary.balances) {
      balanceByUser.set(b.userId, b.amount)
    }
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-2">
          <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
            <Link to="/app/groups">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-full"
              aria-label="Share group summary"
              onClick={() => setExportOpen(true)}
            >
              <Share2 className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-full"
              aria-label="Group options"
              onClick={() => setShowOptionsMenu(true)}
            >
              <MoreVertical className="size-4" />
            </Button>
          </div>
        </div>

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{group.name}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {group.currency} ·{' '}
            {membersLoading
              ? 'Loading members…'
              : `${members?.length ?? 0} member${(members?.length ?? 0) !== 1 ? 's' : ''}`}
          </p>
        </div>

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-teal-800" />
            <h2 className="text-lg font-semibold">Members</h2>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            Net in this group: positive = should receive, negative = should pay, 0 = even.
          </p>

          <ul className="mt-4 space-y-2">
            {membersLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <li
                  key={`member-skeleton-${i}`}
                  className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                >
                  <div className="h-4 w-36 animate-pulse rounded bg-stone-200" />
                </li>
              ))}
            {!membersLoading && (members ?? []).map((m) => {
              const raw = balanceByUser.get(m.userId) ?? 0
              const rounded = Math.round(raw * 100) / 100
              const amount = Math.abs(rounded) <= 0.01 ? 0 : rounded
              const amountClass =
                amount === 0
                  ? 'text-stone-500'
                  : amount > 0
                    ? 'text-emerald-600'
                    : 'text-amber-600'
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-teal-800/15 text-sm font-semibold text-teal-800">
                      {m.profileName.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">
                        {m.profileName}
                        {m.isCurrentUser && (
                          <Badge className="ml-1.5 px-2 py-0.5 text-[0.65rem] leading-none">You</Badge>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <p className={cn('text-right text-sm font-semibold tabular-nums', amountClass)}>
                      {formatCurrency(amount, group.currency)}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full text-stone-400 hover:text-stone-600"
                      aria-label={`Share ${m.profileName}'s share`}
                      onClick={() => void handleMemberShare(m)}
                    >
                      <Share2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>

          {balanceSummary && balanceSummary.groupedSuggestions.length > 0 && (
            <div className="mt-5 border-t border-stone-100 pt-5">
              <p className="text-xs font-medium text-stone-500">Suggested payments</p>
              <div className="mt-2 space-y-2">
                {balanceSummary.groupedSuggestions.map((suggestion) => {
                  const key = `${suggestion.fromUserId}-${suggestion.recipients.map((r) => r.toUserId).join('-')}`
                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-stone-800">{suggestion.fromName}</span>
                          <ArrowRight className="size-3.5 text-stone-400" />
                          <span className="font-medium text-stone-800">
                            {suggestion.recipients.length === 1
                              ? suggestion.recipients[0].toName
                              : `${suggestion.recipients.length} people`}
                          </span>
                          <span className="font-semibold text-teal-800">
                            {formatCurrency(suggestion.totalAmount, balanceSummary.currency)}
                          </span>
                        </div>
                        {suggestion.recipients.length > 1 && (
                          <div className="space-y-0.5 pl-0.5">
                            {suggestion.recipients.map((recipient) => (
                              <p key={recipient.toUserId} className="text-xs text-stone-500">
                                • {recipient.toName} {formatCurrency(recipient.amount, balanceSummary.currency)}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="success"
                        size="xs"
                        className="w-full shrink-0 rounded-lg sm:w-auto"
                        type="button"
                        onClick={() =>
                          setRecordSettlement({
                            fromUserId: suggestion.fromUserId,
                            totalAmount: suggestion.totalAmount,
                            fromName: suggestion.fromName,
                            recipients: suggestion.recipients,
                          })
                        }
                      >
                        <Check className="size-3" />
                        Pay
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ReceiptText className="size-4 text-teal-800" />
              <h2 className="text-lg font-semibold">Group bills</h2>
            </div>
            <Button
              size="sm"
              className="h-10 rounded-full px-4"
              onClick={() => {
                setEditBillId(null)
                setShowAddBill(true)
              }}
            >
              <Plus className="size-3.5" />
              Add bill
            </Button>
          </div>

          {billsLoading ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={`group-bill-skeleton-${i}`}
                  className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                >
                  <div className="h-4 w-44 animate-pulse rounded bg-stone-200" />
                  <div className="mt-2 h-3 w-28 animate-pulse rounded bg-stone-100" />
                </div>
              ))}
            </div>
          ) : (!bills || bills.length === 0) ? (
            <div className="mt-4 flex flex-col items-center py-8 text-center">
              <p className="text-sm text-stone-400">No bills in this group yet</p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {bills.map((bill) => (
                <button
                  key={bill.id}
                  type="button"
                  onClick={() => setDetailBillId(bill.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 text-left transition-colors hover:bg-stone-100/80"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-medium text-stone-800">{bill.title}</p>
                      {bill.category && CATEGORY_LABELS[bill.category as BillCategory] && (
                        <span
                          className={cn(
                            'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.6rem] font-medium',
                            CATEGORY_COLORS[bill.category as BillCategory],
                          )}
                        >
                          {(() => { const Icon = CATEGORY_ICONS[bill.category as BillCategory]; return <Icon className="size-2.5" /> })()}
                          {CATEGORY_LABELS[bill.category as BillCategory]}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-400">
                      by {bill.creatorName} · {new Date(bill.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-stone-800">
                    {formatCurrency(bill.total_amount, bill.currency)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {showOptionsMenu && (
        <GroupOptionsMenu
          onClose={() => setShowOptionsMenu(false)}
          onEdit={() => {
            setShowOptionsMenu(false)
            setShowEditGroup(true)
          }}
          onMembers={() => {
            setShowOptionsMenu(false)
            setShowManage(true)
          }}
          onPaymentHistory={() => {
            setShowOptionsMenu(false)
            setShowPaymentHistory(true)
          }}
          onDelete={openDeleteFromMenu}
          canManageGroup={isGroupCreator}
        />
      )}

      {showEditGroup && userId && groupId && isGroupCreator && (
        <EditGroupDialog
          groupId={groupId}
          initialName={group.name}
          initialCurrency={group.currency}
          currentUserId={userId}
          onClose={() => setShowEditGroup(false)}
          onSaved={refreshBalances}
        />
      )}

      {showManage && userId && groupId && (
        <ManageMembersDialog
          groupId={groupId}
          members={members ?? []}
          currentUserId={userId}
          creatorUserId={group?.created_by ?? ''}
          isCreator={isGroupCreator}
          onClose={() => setShowManage(false)}
          onChanged={refreshBalances}
        />
      )}

      {showPaymentHistory && (
        <PaymentHistoryDialog
          items={settlementHistory ?? []}
          loading={settlementHistory === undefined}
          currentUserId={userId}
          onClose={() => setShowPaymentHistory(false)}
          onEdit={(item) => setEditingSettlement(item)}
        />
      )}

      {editingSettlement && (
        <EditSettlementDialog
          item={editingSettlement}
          onClose={() => setEditingSettlement(null)}
          onSaved={() => {
            void refreshBalances()
          }}
        />
      )}

      {recordSettlement && groupId && userId && group && (
        <RecordSettlementDialog
          open
          onOpenChange={(o) => {
            if (!o) setRecordSettlement(null)
          }}
          groupId={groupId}
          currency={group.currency}
          fromUserId={recordSettlement.fromUserId}
          toUserId={recordSettlement.recipients[0]?.toUserId ?? recordSettlement.fromUserId}
          defaultAmount={recordSettlement.totalAmount}
          fromName={recordSettlement.fromName}
          toName={
            recordSettlement.recipients.length === 1
              ? recordSettlement.recipients[0].toName
              : `${recordSettlement.recipients.length} people`
          }
          markedBy={userId}
          helperLines={recordSettlement.recipients.map(
            (recipient) => `${recipient.toName}: ${formatCurrency(recipient.amount, group.currency)}`,
          )}
          onSubmit={async ({ label }) => {
            if (recordSettlement.recipients.length <= 1) {
              const recipient = recordSettlement.recipients[0]
              if (!recipient) return
              await createSettlement(
                groupId,
                recordSettlement.fromUserId,
                recipient.toUserId,
                recipient.amount,
                group.currency,
                userId,
                label,
                null,
              )
              return
            }
            await createBundledGroupSettlement({
              groupId,
              fromUserId: recordSettlement.fromUserId,
              recipients: recordSettlement.recipients,
              currency: group.currency,
              markedBy: userId,
              label,
            })
          }}
          confirmLabel="Record payment"
          onRecorded={() => void refreshBalances()}
        />
      )}

      <ConfirmDialog
        open={deleteGroupConfirmOpen}
        onOpenChange={setDeleteGroupConfirmOpen}
        title="Delete this group?"
        description="This will remove the group and related bills from this device. This cannot be undone here."
        confirmLabel="Delete group"
        variant="danger"
        onConfirm={executeDeleteGroup}
      />

      {exportOpen && balanceSummary && (
        <ExportImageDialog
          filename={makeExportFilename(group.name, 'png').replace('.png', '')}
          onExportPDF={userId ? () => generateGroupPDF(group.id, userId) : undefined}
          onExportCSV={userId ? () => exportGroupToCSV(group.id, userId) : undefined}
          onClose={() => setExportOpen(false)}
        >
          <GroupExportCard
            groupName={group.name}
            currency={group.currency}
            members={(members ?? []).map((m) => ({
              userId: m.userId,
              profileName: m.profileName,
            }))}
            balanceSummary={balanceSummary}
            bills={(bills ?? []).map((b) => ({
              id: b.id,
              title: b.title,
              note: (b as { note?: string | null }).note ?? null,
              total_amount: b.total_amount,
              currency: b.currency,
              created_at: b.created_at,
              creatorName: b.creatorName,
            }))}
          />
        </ExportImageDialog>
      )}

      {exportMember && group && (
        <ExportImageDialog
          filename={makeExportFilename(`${group.name} ${exportMember.profileName}`, 'png').replace('.png', '')}
          onClose={() => setExportMember(null)}
        >
          <GroupMemberExportCard
            groupName={group.name}
            memberName={exportMember.profileName}
            currency={group.currency}
            netBalance={exportMember.netBalance}
            bills={exportMember.bills}
          />
        </ExportImageDialog>
      )}

      {detailBillId && userId && (
        <BillDetailModal
          billId={detailBillId}
          currentUserId={userId}
          onClose={() => setDetailBillId(null)}
          onUpdated={refreshBalances}
          onEdit={(id) => {
            setDetailBillId(null)
            setEditBillId(id)
            setShowAddBill(true)
          }}
        />
      )}

      {showAddBill && userId && groupId && group && (
        <AddBillDialog
          groupId={groupId}
          groupCurrency={group.currency}
          groupMembers={(members ?? []).map((m) => ({
            userId: m.userId,
            displayName: m.profileName,
            isCurrentUser: m.isCurrentUser,
          }))}
          currentUserId={userId}
          editBillId={editBillId}
          onClose={() => {
            setShowAddBill(false)
            setEditBillId(null)
          }}
          onSaved={refreshBalances}
        />
      )}
    </>
  )
}
