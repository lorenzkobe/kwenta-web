import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Plus, ReceiptText, Scale, Settings2, Trash2, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { addGroupMember, removeGroupMember, createSettlement, deleteGroup } from '@/db/operations'
import { computeGroupBalances, type GroupBalanceSummary } from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { AddBillDialog } from '@/components/common/AddBillDialog'

type MemberRow = {
  id: string
  userId: string
  profileName: string
  isCurrentUser: boolean
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
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-blue-600" />
            <h2 className="text-base font-semibold">Manage members</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Member list */}
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
                      <Badge className="ml-1.5 text-[0.65rem] px-1.5">you</Badge>
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

        {/* Add member */}
        <div className="border-t border-slate-100 px-5 py-4">
          <p className="mb-2 text-xs font-medium text-slate-500">Add a member</p>
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

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const { userId } = useCurrentUser()

  const [copied, setCopied] = useState(false)
  const [showManage, setShowManage] = useState(false)
  const [showAddBill, setShowAddBill] = useState(false)
  const [balanceSummary, setBalanceSummary] = useState<GroupBalanceSummary | null>(null)
  const [settling, setSettling] = useState<string | null>(null)

  const group = useLiveQuery(
    () => (groupId ? db.groups.get(groupId) : undefined),
    [groupId],
  )

  const members = useLiveQuery(async () => {
    if (!groupId) return []
    const all = await db.group_members.where('group_id').equals(groupId).toArray()
    const active = all.filter((m) => !m.is_deleted)
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

  async function handleSettle(fromUserId: string, toUserId: string, amount: number) {
    if (!groupId || !userId || !group) return
    const key = `${fromUserId}-${toUserId}`
    setSettling(key)
    try {
      await createSettlement(groupId, fromUserId, toUserId, amount, group.currency, userId)
      await refreshBalances()
    } finally {
      setSettling(null)
    }
  }

  async function handleDelete() {
    if (!groupId || !userId) return
    await deleteGroup(groupId, userId)
    navigate('/app/groups')
  }

  function handleCopyInvite() {
    if (!group) return
    navigator.clipboard.writeText(group.invite_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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

  return (
    <>
      <div className="space-y-5">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
            <Link to="/app/groups">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full text-red-600"
            onClick={handleDelete}
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>

        {/* Group info */}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
              <p className="mt-1 text-sm text-slate-500">
                {group.currency} · {members?.length ?? 0} member{(members?.length ?? 0) !== 1 ? 's' : ''}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full gap-1"
              onClick={handleCopyInvite}
            >
              <Copy className="size-3.5" />
              {copied ? 'Copied!' : group.invite_code}
            </Button>
          </div>
        </div>

        {/* Members */}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-blue-600" />
              <h2 className="text-lg font-semibold">Members</h2>
              <span className="text-sm text-slate-400">({members?.length ?? 0})</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full gap-1"
              onClick={() => setShowManage(true)}
            >
              <Settings2 className="size-3.5" />
              Manage
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {(members ?? []).map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5"
              >
                <div className="flex size-5 items-center justify-center rounded-full bg-blue-600/15 text-[0.6rem] font-semibold text-blue-600">
                  {m.profileName.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-slate-700">{m.profileName}</span>
                {m.isCurrentUser && (
                  <Badge className="text-[0.6rem] px-1 py-0">you</Badge>
                )}
              </div>
            ))}

            <button
              onClick={() => setShowManage(true)}
              className="flex items-center gap-1.5 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-400 transition-colors hover:border-blue-400 hover:text-blue-600"
            >
              <Plus className="size-3.5" />
              Add
            </button>
          </div>
        </div>

        {/* Balances */}
        {balanceSummary && balanceSummary.balances.some((b) => Math.abs(b.amount) > 0.01) && (
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Scale className="size-4 text-blue-600" />
              <h2 className="text-lg font-semibold">Balances</h2>
            </div>

            <div className="mt-4 space-y-1.5">
              {balanceSummary.balances
                .filter((b) => Math.abs(b.amount) > 0.01)
                .sort((a, b) => b.amount - a.amount)
                .map((balance) => (
                  <div
                    key={balance.userId}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-2.5"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-7 items-center justify-center rounded-full bg-blue-600/15 text-xs font-semibold text-blue-600">
                        {balance.displayName.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm font-medium">{balance.displayName}</span>
                    </div>
                    <span
                      className={cn(
                        'text-sm font-semibold',
                        balance.amount > 0 ? 'text-emerald-600' : 'text-amber-600',
                      )}
                    >
                      {balance.amount > 0 ? '+' : ''}
                      {formatCurrency(balance.amount, balanceSummary.currency)}
                    </span>
                  </div>
                ))}
            </div>

            {balanceSummary.suggestions.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-slate-400">Settlement suggestions</p>
                <div className="mt-2 space-y-2">
                  {balanceSummary.suggestions.map((s) => {
                    const key = `${s.fromUserId}-${s.toUserId}`
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3"
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{s.fromName}</span>
                          <ArrowRight className="size-3.5 text-slate-400" />
                          <span className="font-medium">{s.toName}</span>
                          <span className="font-semibold text-blue-600">
                            {formatCurrency(s.amount, balanceSummary.currency)}
                          </span>
                        </div>
                        <Button
                          variant="success"
                          size="xs"
                          className="rounded-lg"
                          onClick={() => handleSettle(s.fromUserId, s.toUserId, s.amount)}
                          disabled={settling === key}
                        >
                          <Check className="size-3" />
                          {settling === key ? '...' : 'Settle'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Group bills */}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ReceiptText className="size-4 text-blue-600" />
              <h2 className="text-lg font-semibold">Group bills</h2>
            </div>
            <Button size="sm" className="rounded-full" onClick={() => setShowAddBill(true)}>
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
                <Link
                  key={bill.id}
                  to={`/app/bills/${bill.id}`}
                  className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3 transition-colors hover:bg-slate-100/80"
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
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Manage members dialog */}
      {showManage && userId && groupId && (
        <ManageMembersDialog
          groupId={groupId}
          members={members ?? []}
          currentUserId={userId}
          onClose={() => setShowManage(false)}
          onChanged={refreshBalances}
        />
      )}

      {/* Add bill dialog */}
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
          onClose={() => setShowAddBill(false)}
          onSaved={refreshBalances}
        />
      )}
    </>
  )
}
