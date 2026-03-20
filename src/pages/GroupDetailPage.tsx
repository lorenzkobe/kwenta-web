import { useState, useEffect } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Plus, ReceiptText, Scale, Trash2, UserPlus, Users } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { addGroupMember, createSettlement, deleteGroup } from '@/db/operations'
import { computeGroupBalances, type GroupBalanceSummary } from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

export function GroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const { userId } = useCurrentUser()
  const [memberName, setMemberName] = useState('')
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)
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
          ...m,
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

  useEffect(() => {
    if (!groupId || !userId) return
    computeGroupBalances(groupId, userId).then(setBalanceSummary)
  }, [groupId, userId, bills])

  async function handleSettle(fromUserId: string, toUserId: string, amount: number) {
    if (!groupId || !userId || !group) return
    const key = `${fromUserId}-${toUserId}`
    setSettling(key)
    try {
      await createSettlement(groupId, fromUserId, toUserId, amount, group.currency, userId)
      const updated = await computeGroupBalances(groupId, userId)
      setBalanceSummary(updated)
    } finally {
      setSettling(null)
    }
  }

  async function handleAddMember() {
    if (!groupId || !userId || !memberName.trim()) return
    setAdding(true)
    try {
      await addGroupMember(groupId, memberName.trim(), userId)
      setMemberName('')
    } finally {
      setAdding(false)
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
    <div className="space-y-5">
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

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-blue-600" />
          <h2 className="text-lg font-semibold">Members</h2>
        </div>

        <div className="mt-4 space-y-2">
          {(members ?? []).map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3"
            >
              <div className="flex size-8 items-center justify-center rounded-full bg-blue-600/15 text-xs font-semibold text-blue-600">
                {member.profileName.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm font-medium text-slate-800">
                {member.profileName}
                {member.isCurrentUser && (
                  <Badge className="ml-1.5 text-[0.65rem] px-1.5">you</Badge>
                )}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <Input
            type="text"
            placeholder="Add member name"
            className="flex-1 rounded-lg"
            value={memberName}
            onChange={(e) => setMemberName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
          />
          <Button
            size="sm"
            className="rounded-lg"
            onClick={handleAddMember}
            disabled={!memberName.trim() || adding}
          >
            <UserPlus className="size-3.5" />
            {adding ? '…' : 'Add'}
          </Button>
        </div>
      </div>

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

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-blue-600" />
            <h2 className="text-lg font-semibold">Group bills</h2>
          </div>
          <Button asChild size="sm" className="rounded-full">
            <Link to={`/app/bills/new?groupId=${groupId}`}>
              <Plus className="size-3.5" />
              Add bill
            </Link>
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
  )
}
