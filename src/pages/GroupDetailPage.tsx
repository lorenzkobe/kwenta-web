import { useState, useEffect, useRef } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  History,
  MoreVertical,
  Pencil,
  Plus,
  ReceiptText,
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
  removeGroupMember,
  deleteGroup,
  updateGroup,
} from '@/db/operations'
import {
  computeGroupBalances,
  type GroupBalanceSummary,
  type SettlementHistoryItem,
} from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
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
import { useGroupSettlementHistory } from '@/db/hooks'

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
  onClose,
  onChanged,
}: {
  groupId: string
  members: MemberRow[]
  currentUserId: string
  onClose: () => void
  onChanged: () => void
}) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  async function handleRemove(memberUserId: string) {
    setRemoving(memberUserId)
    try {
      await removeGroupMember(groupId, memberUserId, currentUserId)
      onChanged()
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-blue-600" />
            <h2 className="text-base font-semibold">Members</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-64 overflow-y-auto px-5 py-3">
          {members.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No members yet</p>
          ) : (
            <ul className="space-y-1.5">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-xl px-2 py-2"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-600/15 text-xs font-semibold text-blue-600">
                    {m.profileName.charAt(0).toUpperCase()}
                  </div>
                  <span className="flex-1 text-sm font-medium text-slate-800">
                    {m.profileName}
                    {m.isCurrentUser && (
                      <Badge className="ml-1.5 px-2.5 py-1 text-[0.65rem] leading-none">You</Badge>
                    )}
                  </span>
                  {!m.isCurrentUser && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full text-slate-400 hover:text-red-600"
                      disabled={removing === m.userId}
                      onClick={() => handleRemove(m.userId)}
                    >
                      {removing === m.userId ? (
                        <span className="size-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
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

        <div className="border-t border-slate-100 px-5 py-4">
          <p className="mb-3 text-xs font-medium text-slate-500">Add a member</p>
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
        </div>
      </div>
    </div>
  )
}

function EditGroupDialog({
  groupId,
  initialName,
  initialCurrency,
  inviteCode,
  currentUserId,
  onClose,
  onSaved,
}: {
  groupId: string
  initialName: string
  initialCurrency: string
  inviteCode: string
  currentUserId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initialName)
  const [currency, setCurrency] = useState(initialCurrency)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

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

  function handleCopyInvite() {
    navigator.clipboard.writeText(inviteCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Pencil className="size-4 text-blue-600" />
            <h2 className="text-base font-semibold">Edit group</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="edit-group-name" className="text-sm font-medium text-slate-800">
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
            <label htmlFor="edit-group-currency" className="text-sm font-medium text-slate-800">
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
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-xs font-medium text-slate-500">Invite code</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="text-sm font-semibold tracking-wide text-slate-800">{inviteCode}</code>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 rounded-lg"
                onClick={handleCopyInvite}
              >
                <Copy className="size-3" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
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
  currentUserId,
  onClose,
  onEdit,
}: {
  items: SettlementHistoryItem[]
  currentUserId: string | null | undefined
  onClose: () => void
  onEdit?: (item: SettlementHistoryItem) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative flex max-h-[min(85dvh,560px)] w-full max-w-sm flex-col animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <History className="size-4 text-blue-600" />
            <h2 className="text-base font-semibold">Payment history</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">No recorded payments yet</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-500">
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
  onClose,
}: {
  onEdit: () => void
  onMembers: () => void
  onPaymentHistory: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const itemClass =
    'flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white p-2 shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <p className="px-3 pb-2 pt-1 text-center text-xs font-medium uppercase tracking-wide text-slate-400">
          Group options
        </p>
        <button type="button" className={itemClass} onClick={onEdit}>
          <Pencil className="size-4 text-blue-600" />
          Edit group
        </button>
        <button type="button" className={itemClass} onClick={onMembers}>
          <Users className="size-4 text-blue-600" />
          Members
        </button>
        <button type="button" className={itemClass} onClick={onPaymentHistory}>
          <History className="size-4 text-blue-600" />
          Payment history
        </button>
        <button
          type="button"
          className={cn(itemClass, 'text-red-600 hover:bg-red-50')}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          Delete group
        </button>
        <Button variant="ghost" className="mt-1 w-full rounded-xl text-slate-500" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function memberBalanceLabel(amount: number, currency: string) {
  const rounded = Math.round(amount * 100) / 100
  if (Math.abs(rounded) <= 0.01) {
    return { text: 'Balanced', className: 'text-slate-400' }
  }
  if (rounded > 0) {
    return {
      text: `Collects ${formatCurrency(rounded, currency)}`,
      className: 'text-emerald-600',
    }
  }
  return {
    text: `Pays ${formatCurrency(Math.abs(rounded), currency)}`,
    className: 'text-amber-600',
  }
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
    toUserId: string
    amount: number
    fromName: string
    toName: string
  } | null>(null)
  const [deleteGroupConfirmOpen, setDeleteGroupConfirmOpen] = useState(false)

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
        return { ...bill, creatorName: creator?.display_name ?? 'Unknown' }
      }),
    )
  }, [groupId])

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
    if (!groupId || !userId) return
    await deleteGroup(groupId, userId)
    navigate('/app/groups')
  }

  function openDeleteFromMenu() {
    setShowOptionsMenu(false)
    setDeleteGroupConfirmOpen(true)
  }

  if (!group || group.is_deleted) {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/groups">
            <ArrowLeft className="size-4" />
            Back to groups
          </Link>
        </Button>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-center text-sm text-slate-500">Group not found</p>
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

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{group.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {group.currency} · {members?.length ?? 0} member{(members?.length ?? 0) !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-blue-600" />
            <h2 className="text-lg font-semibold">Members</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Net balance from shared bills: positive means others net-pay them; negative means they net-pay
            the group.
          </p>

          <ul className="mt-4 space-y-2">
            {(members ?? []).map((m) => {
              const raw = balanceByUser.get(m.userId) ?? 0
              const { text, className } = memberBalanceLabel(raw, group.currency)
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-600/15 text-sm font-semibold text-blue-600">
                      {m.profileName.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {m.profileName}
                        {m.isCurrentUser && (
                          <Badge className="ml-1.5 px-2 py-0.5 text-[0.65rem] leading-none">You</Badge>
                        )}
                      </p>
                    </div>
                  </div>
                  <p className={cn('shrink-0 text-right text-sm font-semibold', className)}>{text}</p>
                </li>
              )
            })}
          </ul>

          {balanceSummary && balanceSummary.suggestions.length > 0 && (
            <div className="mt-5 border-t border-slate-100 pt-5">
              <p className="text-xs font-medium text-slate-500">Suggested payments</p>
              <div className="mt-2 space-y-2">
                {balanceSummary.suggestions.map((s) => {
                  const key = `${s.fromUserId}-${s.toUserId}`
                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-slate-800">{s.fromName}</span>
                        <ArrowRight className="size-3.5 text-slate-400" />
                        <span className="font-medium text-slate-800">{s.toName}</span>
                        <span className="font-semibold text-blue-600">
                          {formatCurrency(s.amount, balanceSummary.currency)}
                        </span>
                      </div>
                      <Button
                        variant="success"
                        size="xs"
                        className="w-full shrink-0 rounded-lg sm:w-auto"
                        type="button"
                        onClick={() =>
                          setRecordSettlement({
                            fromUserId: s.fromUserId,
                            toUserId: s.toUserId,
                            amount: s.amount,
                            fromName: s.fromName,
                            toName: s.toName,
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

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ReceiptText className="size-4 text-blue-600" />
              <h2 className="text-lg font-semibold">Group bills</h2>
            </div>
            <Button
              size="sm"
              className="rounded-full"
              onClick={() => {
                setEditBillId(null)
                setShowAddBill(true)
              }}
            >
              <Plus className="size-3.5" />
              Add bill
            </Button>
          </div>

          {(!bills || bills.length === 0) ? (
            <div className="mt-4 flex flex-col items-center py-8 text-center">
              <p className="text-sm text-slate-400">No bills in this group yet</p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {bills.map((bill) => (
                <button
                  key={bill.id}
                  type="button"
                  onClick={() => setDetailBillId(bill.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3 text-left transition-colors hover:bg-slate-100/80"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">{bill.title}</p>
                    <p className="text-xs text-slate-400">
                      by {bill.creatorName} · {new Date(bill.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-slate-800">
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
        />
      )}

      {showEditGroup && userId && groupId && (
        <EditGroupDialog
          groupId={groupId}
          initialName={group.name}
          initialCurrency={group.currency}
          inviteCode={group.invite_code}
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
          onClose={() => setShowManage(false)}
          onChanged={refreshBalances}
        />
      )}

      {showPaymentHistory && (
        <PaymentHistoryDialog
          items={settlementHistory ?? []}
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
          toUserId={recordSettlement.toUserId}
          amount={recordSettlement.amount}
          fromName={recordSettlement.fromName}
          toName={recordSettlement.toName}
          markedBy={userId}
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
