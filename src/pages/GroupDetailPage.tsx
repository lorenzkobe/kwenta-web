import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ArrowLeft,
  Check,
  History,
  Loader2,
  MoreVertical,
  Pencil,
  PieChart,
  Plus,
  ReceiptText,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchGroupDetail,
  fetchGroupSettlementHistory,
  fetchGroupSpending,
  type SettlementHistoryItem,
} from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import {
  addExistingGroupMember,
  createSettlement,
  removeGroupMember,
  deleteGroup,
  updateGroup,
  getBillWithDetails,
  mergeProfileIdentity,
} from '@/db/operations'
import {
  findDuplicateIdentityCandidates,
  type DuplicateIdentityCandidate,
} from '@/lib/duplicate-identity'
import {
  type GroupBalanceSummary,
  type GroupPairwiseSummary,
  type GroupSuggestionsSummary,
  type SuggestedPayerGroup,
} from '@/lib/settlement'
import { buildSuggestedPayers } from '@/lib/settlement-suggestions'
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
import { makeExportFilename, memberShareNetFromViewerNet } from '@/lib/export-utils'
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
import { loadPhonebookRows } from '@/lib/people'
import { MemberMultiPicker } from '@/components/common/MemberMultiPicker'
import { PayIntoGroupDialog } from '@/components/common/PayIntoGroupDialog'
import { GroupSettleUpDialog } from '@/components/common/GroupSettleUpDialog'
import { MemberBalancesDialog } from '@/components/common/MemberBalancesDialog'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'

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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeMemberTarget, setRemoveMemberTarget] = useState<{
    userId: string
    profileName: string
  } | null>(null)
  const [phonebook, setPhonebook] = useState<
    { id: string; displayName: string; subtitle?: string }[]
  >([])
  const [keyboardInset, setKeyboardInset] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return
    const vv = window.visualViewport
    const update = () => {
      const inset = window.innerHeight - vv.height - vv.offsetTop
      setKeyboardInset(inset > 0 ? inset : 0)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      const rows = await loadPhonebookRows(currentUserId)
      if (!cancelled) setPhonebook(rows)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [currentUserId])

  const existingMemberIds = new Set(members.map((m) => m.userId))
  const pickablePeople = phonebook.filter((p) => !existingMemberIds.has(p.id))

  async function handleAddSelected() {
    if (selectedIds.length === 0) return
    setAdding(true)
    try {
      for (const id of selectedIds) {
        await addExistingGroupMember(groupId, id, currentUserId)
      }
      setSelectedIds([])
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add the selected member(s) right now.')
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
      toast.success('Member removed')
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove this member right now.')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      style={{ paddingBottom: `calc(1rem + ${keyboardInset}px)` }}
    >
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
          <p className="mb-3 text-xs font-medium text-stone-500">Add members from your phonebook</p>
          <MemberMultiPicker
            people={pickablePeople}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
            placeholder={
              pickablePeople.length === 0 ? 'No people available to add' : 'Select people…'
            }
            emptyMessage="No matches in your phonebook"
            disabled={adding || pickablePeople.length === 0}
          />
          <Button
            size="sm"
            className="mt-3 w-full rounded-lg"
            disabled={selectedIds.length === 0 || adding}
            onClick={handleAddSelected}
          >
            <UserPlus className="size-3.5" />
            {adding
              ? 'Adding…'
              : selectedIds.length > 0
                ? `Add ${selectedIds.length} member${selectedIds.length === 1 ? '' : 's'}`
                : 'Add members'}
          </Button>
          <p className="mt-2 text-[0.65rem] text-stone-400">
            Only people already in your phonebook can be added. Create new contacts from the People page.
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

function PaymentHistoryTotals({
  items,
  currentUserId,
}: {
  items: SettlementHistoryItem[]
  currentUserId: string | null | undefined
}) {
  // Sum total amount paid by each payer, keyed by user + currency.
  const totals = new Map<string, { userId: string; name: string; currency: string; amount: number }>()
  for (const item of items) {
    const key = `${item.fromUserId}::${item.currency}`
    const existing = totals.get(key)
    if (existing) {
      existing.amount += item.amount
    } else {
      totals.set(key, {
        userId: item.fromUserId,
        name: item.fromName,
        currency: item.currency,
        amount: item.amount,
      })
    }
  }
  const rows = Array.from(totals.values()).sort((a, b) => b.amount - a.amount)
  if (rows.length === 0) return null

  return (
    <div className="mb-4 rounded-2xl border border-stone-200 bg-stone-100/60 px-4 py-3">
      <p className="mb-2 text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">
        Total paid
      </p>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={`${row.userId}::${row.currency}`}
            className="flex items-center justify-between text-sm"
          >
            <span className="font-medium text-stone-700">
              {currentUserId && row.userId === currentUserId ? 'You' : row.name}
            </span>
            <span className="font-semibold text-emerald-700">
              {formatCurrency(row.amount, row.currency)}
            </span>
          </li>
        ))}
      </ul>
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
              <PaymentHistoryTotals items={items} currentUserId={currentUserId} />
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

const SPENDING_COLORS = [
  '#0d9488', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444',
  '#10b981', '#f97316', '#ec4899', '#06b6d4', '#84cc16',
]

function buildPiePaths(slices: { value: number; color: string }[], total: number) {
  const cx = 100, cy = 100, r = 88
  const { paths } = slices.reduce<{ paths: { i: number; d: string; color: string }[]; angle: number }>(
    ({ paths, angle }, slice, i) => {
      const sweep = (slice.value / total) * 2 * Math.PI
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const nextAngle = angle + sweep
      const x2 = cx + r * Math.cos(nextAngle)
      const y2 = cy + r * Math.sin(nextAngle)
      const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`
      return { paths: [...paths, { i, d, color: slice.color }], angle: nextAngle }
    },
    { paths: [], angle: -Math.PI / 2 }
  )
  return paths
}

function SpendingPie({ slices }: { slices: { value: number; color: string }[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total === 0) return null
  const paths = buildPiePaths(slices, total)
  return (
    <svg viewBox="0 0 200 200" className="w-44 h-44">
      {paths.map(({ i, d, color }) => (
        <path key={i} d={d} fill={color} stroke="white" strokeWidth="1.5" />
      ))}
    </svg>
  )
}

/**
 * Gross consumption per member — what each person's shares add up to, regardless of who fronted
 * the money. Payments do not touch it, so this is not a balance.
 *
 * The numbers come from `kwenta_group_spending` (migration 064). The version this replaced walked
 * every bill, item and split in the browser AND summed every currency in the group into one
 * figure that it then labelled with the group's currency; the endpoint drops off-currency rows
 * like every other group aggregate.
 */
function TotalSpendingDialog({
  groupId,
  currency,
  currentUserId,
  onClose,
}: {
  groupId: string
  currency: string
  currentUserId: string
  onClose: () => void
}) {
  const load = useCallback(() => fetchGroupSpending(currentUserId, groupId), [currentUserId, groupId])
  const spending = useServerData(load, [currentUserId, groupId], `group-spending:${groupId}`)

  const rows = (spending.data?.rows ?? []).map((r, i) => ({
    userId: r.userId,
    name: r.displayName,
    amount: r.amount,
    color: SPENDING_COLORS[i % SPENDING_COLORS.length],
  }))
  const loading = spending.loading && !spending.data
  const total = rows.reduce((s, r) => s + r.amount, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <p className="pb-4 text-center text-xs font-medium uppercase tracking-wide text-stone-400">
          Total Spending
        </p>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-teal-800" />
          </div>
        ) : spending.error && !spending.data ? (
          <p className="py-8 text-center text-sm text-red-600">{spending.error}</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-stone-400">No bills yet</p>
        ) : (
          <>
            <div className="flex justify-center pb-4">
              <SpendingPie slices={rows.map((r) => ({ value: r.amount, color: r.color }))} />
            </div>
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.userId} className="flex items-center gap-3">
                  <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                  <span className="flex-1 truncate text-sm font-medium text-stone-800">{r.name}</span>
                  <span className="text-xs text-stone-500">
                    {total > 0 ? Math.round((r.amount / total) * 100) : 0}%
                  </span>
                  <span className="text-sm font-semibold text-stone-800 tabular-nums">
                    {formatCurrency(r.amount, currency)}
                  </span>
                </div>
              ))}
              <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3">
                <span className="text-sm font-semibold text-stone-500">Total</span>
                <span className="text-sm font-bold text-stone-800 tabular-nums">
                  {formatCurrency(total, currency)}
                </span>
              </div>
            </div>
          </>
        )}
        <Button variant="ghost" className="mt-4 w-full rounded-xl text-stone-500" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

function GroupOptionsMenu({
  onEdit,
  onMembers,
  onPaymentHistory,
  onTotalSpending,
  onDelete,
  canManageGroup,
  onClose,
}: {
  onEdit: () => void
  onMembers: () => void
  onPaymentHistory: () => void
  onTotalSpending: () => void
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
        <button type="button" className={itemClass} onClick={onTotalSpending}>
          <PieChart className="size-4 text-teal-800" />
          Total spending
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
  const [dupCandidates, setDupCandidates] = useState<DuplicateIdentityCandidate[]>([])
  const [dismissedDupKeys, setDismissedDupKeys] = useState<Set<string>>(new Set())
  const [mergeTarget, setMergeTarget] = useState<DuplicateIdentityCandidate | null>(null)
  const [editingSettlement, setEditingSettlement] = useState<SettlementHistoryItem | null>(null)
  const [payIntoGroupOpen, setPayIntoGroupOpen] = useState(false)
  const [settleUpPayer, setSettleUpPayer] = useState<SuggestedPayerGroup | null>(null)
  const [payPerson, setPayPerson] = useState<{ memberUserId: string; name: string; owed: number } | null>(null)
  const [viewMember, setViewMember] = useState<{ userId: string; name: string; isCurrentUser: boolean } | null>(null)
  const [deleteGroupConfirmOpen, setDeleteGroupConfirmOpen] = useState(false)
  const [showTotalSpending, setShowTotalSpending] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [billPayorFilter, setBillPayorFilter] = useState<string | null>(null)
  const [billsShown, setBillsShown] = useState(10)
  const [exportMember, setExportMember] = useState<{
    userId: string
    profileName: string
    netBalance: number
    bills: GroupMemberBillEntry[]
  } | null>(null)

  async function handleMemberShare(member: { userId: string; profileName: string }) {
    if (!group) return
    // balanceByUser is viewer-perspective (positive = they owe you). The member
    // share card is framed from the member's own side (positive = they receive),
    // so flip the sign before handing it to the export card.
    const viewerNet = Math.round((balanceByUser.get(member.userId) ?? 0) * 100) / 100
    const net = memberShareNetFromViewerNet(viewerNet)
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

  const loadPayments = useCallback(
    () =>
      userId && groupId
        ? fetchGroupSettlementHistory(userId, groupId)
        : Promise.reject(new Error('no user')),
    [userId, groupId],
  )
  const payments = useServerData(
    userId && groupId ? loadPayments : null,
    [userId, groupId],
    groupId ? `group-payments:${groupId}` : undefined,
  )
  const settlementHistory = payments.loading && !payments.data ? undefined : (payments.data ?? [])

  // The whole screen in one call: group, roster, bills with payer names, the viewer's pairwise
  // standing, every member's net against the POOL, and the directed debt graph. This replaced
  // four Dexie queries plus a recompute of the entire group ledger three separate ways.
  const loadDetail = useCallback(
    () => (userId && groupId ? fetchGroupDetail(userId, groupId) : Promise.reject(new Error('no user'))),
    [userId, groupId],
  )
  const detail = useServerData(
    userId && groupId ? loadDetail : null,
    [userId, groupId, loadDetail],
    groupId ? `group:${groupId}` : undefined,
  )

  const group = useMemo(() => {
    const g = detail.data?.group
    if (!g) return null
    return { id: g.id, name: g.name, currency: g.currency, created_by: g.createdBy, is_deleted: false }
  }, [detail.data])

  const members = useMemo(() => detail.data?.members, [detail.data])
  const bills = useMemo(
    () =>
      detail.data?.bills.map((b) => ({
        id: b.id,
        title: b.title,
        note: b.note,
        currency: b.currency,
        total_amount: b.totalAmount,
        created_at: b.createdAt,
        created_by: b.createdBy,
        paid_by: b.paidBy,
        group_id: b.groupId,
        category: b.category,
        payorName: b.payorName,
      })),
    [detail.data],
  )

  const balanceSummary = useMemo<GroupPairwiseSummary | null>(() => {
    const d = detail.data
    if (!d) return null
    return {
      groupId: d.group.id,
      groupName: d.group.name,
      currency: d.group.currency,
      entries: d.pairwise,
      totalToReceive: d.totalToReceive,
      totalToPay: d.totalToPay,
    }
  }, [detail.data])

  const exportBalanceSummary = useMemo<GroupBalanceSummary | null>(() => {
    const d = detail.data
    if (!d) return null
    return {
      groupId: d.group.id,
      groupName: d.group.name,
      currency: d.group.currency,
      balances: d.memberBalances,
      totalToReceive: d.totalToReceive,
      totalToPay: d.totalToPay,
    }
  }, [detail.data])

  // The decomposition stays here on purpose: it is a pure transform of a bounded input and it
  // has Vitest coverage (CLAUDE.md rule 8). Porting it to SQL would mean two greedy algorithms
  // that can disagree by a transfer, and therefore two different "who pays whom" screens.
  const suggestions = useMemo<GroupSuggestionsSummary | null>(() => {
    const d = detail.data
    if (!d) return null
    const nameOf = (id: string) =>
      d.memberBalances.find((m) => m.userId === id)?.displayName ??
      d.members.find((m) => m.userId === id)?.profileName ??
      'Unknown'
    const payers = buildSuggestedPayers(d.rawDebts, nameOf)
    return { groupId: d.group.id, groupName: d.group.name, currency: d.group.currency, payers }
  }, [detail.data])

  const membershipLoaded = Array.isArray(members)
  const groupLoading = !userId || (detail.loading && !detail.data)
  const membersLoading = members === undefined
  const billsLoading = bills === undefined
  const currentUserHasActiveMembership = Boolean(
    userId && (members ?? []).some((m) => m.userId === userId),
  )
  const isGroupCreator = Boolean(userId && group && group.created_by === userId)

  async function refreshDupCandidates() {
    if (!groupId || !userId) {
      setDupCandidates([])
      return
    }
    setDupCandidates(await findDuplicateIdentityCandidates(groupId, userId))
  }

  // Keyed on the roster's CONTENT, never on `members` itself: that array is memoised on
  // `detail.data`, so it gets a fresh identity from every fetch. Depending on the identity — and
  // calling `detail.refresh()` from inside the effect, which `useServerData` already does on
  // mount — made the effect re-trigger the fetch that re-triggered the effect, refetching
  // `kwenta_group_detail` for as long as the page stayed open.
  const rosterKey = useMemo(() => (members ?? []).map((m) => m.userId).join(','), [members])

  useEffect(() => {
    void refreshDupCandidates()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, userId, rosterKey])

  const dupKey = (c: DuplicateIdentityCandidate) => `${c.localId}->${c.targetId}`
  const visibleDupCandidates = dupCandidates.filter((c) => !dismissedDupKeys.has(dupKey(c)))

  async function confirmMerge() {
    if (!mergeTarget || !userId) return
    await mergeProfileIdentity(mergeTarget.localId, mergeTarget.targetId, userId)
    setMergeTarget(null)
    await refreshDupCandidates()
    detail.refresh()
  }

  async function executeDeleteGroup() {
    if (!groupId || !userId || !isGroupCreator) return
    try {
      await deleteGroup(groupId, userId)
      navigate('/app/groups')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete this group right now.')
    }
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
        {detail.error ? (
          // The server returns null for "deleted, or you are not a member" — both are genuinely
          // "not found" to this user. A failed REQUEST is neither, and must not claim to be.
          <div
            role="alert"
            className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm"
          >
            <p className="font-medium">Could not load this group</p>
            <p className="mt-1 text-xs text-amber-900/80">{detail.error}</p>
            <Button size="sm" variant="ghost" className="mt-3 rounded-full text-amber-900" onClick={detail.refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-center text-sm text-stone-500">Group not found</p>
          </div>
        )}
      </div>
    )
  }

  const balanceByUser = new Map<string, number>()
  for (const e of balanceSummary?.entries ?? []) {
    balanceByUser.set(e.memberUserId, e.net)
  }

  const filteredBills = billPayorFilter && bills
    ? bills.filter((b) => b.paid_by === billPayorFilter)
    : (bills ?? [])
  const billFilterName = billPayorFilter
    ? (members?.find((m) => m.userId === billPayorFilter)?.profileName ?? 'this person')
    : null

  return (
    <>
      <div className="space-y-5">
        {detail.fromCache && detail.data && <SavedCopyNotice fetchedAt={detail.fetchedAt} />}
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
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{group.name}</h1>
              <p className="mt-1 text-sm text-stone-500">
                {group.currency} ·{' '}
                {membersLoading
                  ? 'Loading members…'
                  : `${members?.length ?? 0} member${(members?.length ?? 0) !== 1 ? 's' : ''}`}
              </p>
            </div>
            <Button
              size="sm"
              className="h-10 shrink-0 rounded-full px-4"
              onClick={() => {
                setEditBillId(null)
                setShowAddBill(true)
              }}
            >
              <Plus className="size-3.5" />
              Add bill
            </Button>
          </div>
        </div>

        {visibleDupCandidates.map((c) => (
          <div
            key={dupKey(c)}
            className="rounded-3xl border border-amber-200 bg-amber-50 p-5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <UserPlus className="mt-0.5 size-5 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-amber-900">Possible duplicate contact</h2>
                <p className="mt-1 text-sm text-amber-800">
                  Your contact “{c.localName}” looks like the same person as the group member “
                  {c.targetName}”. Merging fixes balances and settlement suggestions for everyone.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setMergeTarget(c)}>
                    Merge contacts
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDismissedDupKeys((prev) => new Set(prev).add(dupKey(c)))
                    }
                  >
                    Not now
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))}

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-teal-800" />
            <h2 className="text-lg font-semibold">Members</h2>
          </div>

          <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2.5 rounded-lg text-left transition-colors hover:opacity-80"
                    aria-label={`View ${m.profileName}'s balances`}
                    onClick={() =>
                      setViewMember({
                        userId: m.userId,
                        name: m.profileName,
                        isCurrentUser: m.isCurrentUser,
                      })
                    }
                  >
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
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-right">
                      <p className={cn('text-sm font-semibold tabular-nums', amountClass)}>
                        {formatCurrency(Math.abs(amount), group.currency)}
                      </p>
                      <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">
                        {amount === 0 ? 'Settled' : amount > 0 ? 'owes you' : 'you owe'}
                      </p>
                    </div>
                    {!m.isCurrentUser && amount < 0 && (
                      <Button
                        variant="success"
                        size="xs"
                        className="rounded-lg"
                        type="button"
                        onClick={() =>
                          setPayPerson({
                            memberUserId: m.userId,
                            name: m.profileName,
                            owed: Math.abs(amount),
                          })
                        }
                      >
                        <Check className="size-3" />
                        Pay
                      </Button>
                    )}
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

          <div className="mt-5 border-t border-stone-100 pt-5">
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="w-full rounded-xl"
              onClick={() => setPayIntoGroupOpen(true)}
            >
              Pay into group
            </Button>
          </div>
        </div>

        {suggestions && suggestions.payers.length > 0 && (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Settle up</h2>
            <p className="mt-1 text-xs text-stone-500">
              Fewest payments to clear everyone in this group.
            </p>
            <div className="mt-4 space-y-2">
              {suggestions.payers.map((payer) => (
                <div
                  key={payer.fromUserId}
                  className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-stone-800">
                      {payer.fromName} pays{' '}
                      <span className="font-semibold text-teal-800">
                        {formatCurrency(payer.total, suggestions.currency)}
                      </span>
                    </p>
                    <p className="text-xs text-stone-500">
                      {payer.recipients
                        .map((r) => `${r.toName} ${formatCurrency(r.amount, suggestions.currency)}`)
                        .join(', ')}
                    </p>
                  </div>
                  <Button
                    variant="success"
                    size="xs"
                    className="w-full shrink-0 rounded-lg sm:w-auto"
                    onClick={() => setSettleUpPayer(payer)}
                  >
                    Settle
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-teal-800" />
            <h2 className="text-lg font-semibold">Group bills</h2>
          </div>

          {!billsLoading && bills && bills.length > 0 && members && members.length > 1 && (() => {
            const payorIds = new Set(bills.map((b) => b.paid_by))
            const payorMembers = members.filter((m) => payorIds.has(m.userId))
            if (payorMembers.length <= 1) return null
            return (
              <div className="mt-4 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => { setBillPayorFilter(null); setBillsShown(10) }}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    billPayorFilter === null
                      ? 'bg-teal-800 text-white'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200',
                  )}
                >
                  All
                </button>
                {payorMembers.map((m) => (
                  <button
                    key={m.userId}
                    type="button"
                    onClick={() => { setBillPayorFilter(billPayorFilter === m.userId ? null : m.userId); setBillsShown(10) }}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      billPayorFilter === m.userId
                        ? 'bg-teal-800 text-white'
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200',
                    )}
                  >
                    {m.isCurrentUser ? 'You' : m.profileName}
                  </button>
                ))}
              </div>
            )
          })()}

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
          ) : filteredBills.length === 0 ? (
            <div className="mt-4 flex flex-col items-center py-8 text-center">
              <p className="text-sm text-stone-400">No bills paid by {billFilterName}</p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {filteredBills.slice(0, billsShown).map((bill) => (
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
                      Paid by {bill.payorName} · {new Date(bill.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-stone-800">
                    {formatCurrency(bill.total_amount, bill.currency)}
                  </span>
                </button>
              ))}
              {filteredBills.length > billsShown && (
                <button
                  type="button"
                  onClick={() => setBillsShown((n) => n + 10)}
                  className="w-full rounded-xl border border-stone-200 py-2.5 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50"
                >
                  Show more ({filteredBills.length - billsShown} remaining)
                </button>
              )}
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
          onTotalSpending={() => {
            setShowOptionsMenu(false)
            setShowTotalSpending(true)
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
          onSaved={detail.refresh}
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
          onChanged={detail.refresh}
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

      {showTotalSpending && groupId && group && userId && (
        <TotalSpendingDialog
          groupId={groupId}
          currency={group.currency}
          currentUserId={userId}
          onClose={() => setShowTotalSpending(false)}
        />
      )}

      {editingSettlement && (
        <EditSettlementDialog
          item={editingSettlement}
          onClose={() => setEditingSettlement(null)}
          onSaved={() => {
            void detail.refresh()
          }}
        />
      )}

      {userId && (
        <PayIntoGroupDialog
          open={payIntoGroupOpen}
          onOpenChange={setPayIntoGroupOpen}
          groupId={groupId!}
          currency={group.currency}
          currentUserId={userId}
          members={(members ?? []).map((m) => ({
            userId: m.userId,
            name: m.profileName,
            isCurrentUser: m.isCurrentUser,
          }))}
          onRecorded={() => void detail.refresh()}
        />
      )}

      {userId && (
        <GroupSettleUpDialog
          open={settleUpPayer !== null}
          onOpenChange={(open) => { if (!open) setSettleUpPayer(null) }}
          groupId={groupId!}
          currency={group.currency}
          markedBy={userId}
          payer={settleUpPayer}
          onRecorded={() => void detail.refresh()}
          onUsePayInto={() => { setSettleUpPayer(null); setPayIntoGroupOpen(true) }}
        />
      )}

      {userId && (
        <MemberBalancesDialog
          open={viewMember !== null}
          onOpenChange={(o) => !o && setViewMember(null)}
          groupId={groupId!}
          currency={group.currency}
          currentUserId={userId}
          member={viewMember}
        />
      )}

      {payPerson && userId && (
        <RecordSettlementDialog
          open={!!payPerson}
          onOpenChange={(o) => !o && setPayPerson(null)}
          groupId={groupId ?? null}
          currency={group.currency}
          fromUserId={userId}
          toUserId={payPerson.memberUserId}
          defaultAmount={payPerson.owed}
          amountEditable
          fromName="You"
          toName={payPerson.name}
          markedBy={userId}
          title={`Pay ${payPerson.name}`}
          helperLines={[`You owe ${payPerson.name} ${formatCurrency(payPerson.owed, group.currency)}.`]}
          onSubmit={async ({ amount }) => {
            await createSettlement(
              groupId ?? null,
              userId,
              payPerson.memberUserId,
              amount,
              group.currency,
              userId,
              undefined,
              null,
              { enforceCap: true },
            )
          }}
          onRecorded={() => {
            setPayPerson(null)
            void detail.refresh()
          }}
        />
      )}

      <ConfirmDialog
        open={mergeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setMergeTarget(null)
        }}
        title="Merge these contacts?"
        description={
          mergeTarget
            ? `“${mergeTarget.localName}” will be linked to the group member “${mergeTarget.targetName}”. Their bills, splits, and payments will be combined under one person for everyone in the group.`
            : ''
        }
        confirmLabel="Merge"
        onConfirm={confirmMerge}
      />

      <ConfirmDialog
        open={deleteGroupConfirmOpen}
        onOpenChange={setDeleteGroupConfirmOpen}
        title="Delete this group?"
        description="This will remove the group and related bills from this device. This cannot be undone here."
        confirmLabel="Delete group"
        variant="danger"
        onConfirm={executeDeleteGroup}
      />

      {exportOpen && exportBalanceSummary && balanceSummary && (
        <ExportImageDialog
          filename={makeExportFilename(group.name, 'png').replace('.png', '')}
          // Gated on the payment history having actually loaded, not just on the group. `?? []`
          // would emit a file whose Payments section is empty because the fetch had not finished
          // — indistinguishable from a group where nobody has ever settled up.
          onExportPDF={
            userId && detail.data && settlementHistory
              ? () => generateGroupPDF(detail.data!, settlementHistory)
              : undefined
          }
          onExportCSV={
            userId && detail.data && settlementHistory
              ? () => exportGroupToCSV(detail.data!, settlementHistory)
              : undefined
          }
          onClose={() => setExportOpen(false)}
        >
          <GroupExportCard
            groupName={group.name}
            currency={group.currency}
            members={(members ?? []).map((m) => ({
              userId: m.userId,
              profileName: m.profileName,
            }))}
            balanceSummary={exportBalanceSummary}
            pairwiseSummary={balanceSummary}
            bills={(bills ?? []).map((b) => ({
              id: b.id,
              title: b.title,
              note: (b as { note?: string | null }).note ?? null,
              total_amount: b.total_amount,
              currency: b.currency,
              created_at: b.created_at,
              payorName: b.payorName,
            }))}
            payments={settlementHistory ?? []}
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
          onUpdated={detail.refresh}
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
          onSaved={detail.refresh}
        />
      )}
    </>
  )
}
