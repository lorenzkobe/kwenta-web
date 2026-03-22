import { useMemo, useState } from 'react'
import {
  ArrowUpRight,
  ChevronRight,
  CreditCard,
  History,
  Plus,
  ReceiptText,
  Sparkles,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { db } from '@/db/db'
import { useUserSettlementHistory } from '@/db/hooks'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency, timeAgo } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export function HomePage() {
  const { userId, profile } = useCurrentUser()

  const settlementHistory = useUserSettlementHistory(userId ?? undefined)
  const [editingSettlement, setEditingSettlement] = useState<SettlementHistoryItem | null>(null)
  const paymentsInvolvingYou = useMemo(() => {
    if (!userId || !settlementHistory?.length) return []
    return settlementHistory
      .filter((h) => h.fromUserId === userId || h.toUserId === userId)
      .slice(0, 6)
  }, [userId, settlementHistory])

  const stats = useLiveQuery(async () => {
    if (!userId) return { billCount: 0, totalSpent: 0, groupCount: 0 }
    const bills = await db.bills.where('created_by').equals(userId).toArray()
    const activeBills = bills.filter((b) => !b.is_deleted)
    const totalSpent = activeBills.reduce((sum, b) => sum + b.total_amount, 0)
    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    const activeGroups = memberships.filter((m) => !m.is_deleted)
    return { billCount: activeBills.length, totalSpent, groupCount: activeGroups.length }
  }, [userId])

  const recentBills = useLiveQuery(async () => {
    if (!userId) return []
    const bills = await db.bills.where('created_by').equals(userId).toArray()
    const active = bills.filter((b) => !b.is_deleted)
    active.sort((a, b) => b.created_at.localeCompare(a.created_at))
    const slice = active.slice(0, 5)
    return Promise.all(
      slice.map(async (b) => {
        let groupName: string | undefined
        if (b.group_id) {
          const g = await db.groups.get(b.group_id)
          if (g && !g.is_deleted) groupName = g.name
        }
        return {
          id: b.id,
          title: b.title,
          amount: b.total_amount,
          currency: b.currency,
          createdAt: b.created_at,
          groupName,
        }
      }),
    )
  }, [userId])

  const recentActivity = useLiveQuery(async () => {
    if (!userId) return []
    const logs = await db.activity_log.orderBy('created_at').reverse().limit(5).toArray()
    return logs.filter((l) => !l.is_deleted)
  }, [userId])

  function greeting() {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[2rem] border border-stone-900/15 bg-stone-900 p-5 text-white shadow-[0_20px_70px_rgba(28,25,23,0.14)] lg:p-8">
        <Badge className="border-none bg-white/12 text-white">
          <Sparkles className="mr-1 size-3.5" />
          Dashboard
        </Badge>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          {greeting()}{profile?.display_name && profile.display_name !== 'You' ? `, ${profile.display_name}` : ''}
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-7 text-white/80">
          Your overview of bills, groups, and expenses.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Total bills</p>
            <p className="mt-1 text-2xl font-semibold">{stats?.billCount ?? 0}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Total spent</p>
            <p className="mt-1 text-2xl font-semibold">{formatCurrency(stats?.totalSpent ?? 0)}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Active groups</p>
            <p className="mt-1 text-2xl font-semibold">{stats?.groupCount ?? 0}</p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Quick actions</h3>
          <Button asChild size="icon-sm" className="rounded-full">
            <Link to="/app/bills/new">
              <Plus className="size-4" />
            </Link>
          </Button>
        </div>
        <div className="mt-4 space-y-2">
          {[
            { title: 'Add bill', detail: 'Restaurant, utilities, or debt', icon: ReceiptText, to: '/app/bills/new' },
            { title: 'New group', detail: 'Invite housemates or friends', icon: Users, to: '/app/groups' },
            { title: 'Balances', detail: 'See who should receive or pay', icon: CreditCard, to: '/app/balances' },
          ].map((action) => (
            <Link
              key={action.title}
              to={action.to}
              className="flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-100/80 px-4 py-3.5 transition-colors hover:bg-stone-100"
            >
              <div className="flex items-center gap-3">
                <span className="rounded-xl bg-teal-800/15 p-2 text-teal-800">
                  <action.icon className="size-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{action.title}</span>
                  <span className="block text-xs text-stone-500">{action.detail}</span>
                </span>
              </div>
              <ChevronRight className="size-4 text-stone-400" />
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-teal-800" />
            <h3 className="text-base font-semibold">Recent bills</h3>
          </div>
          {(recentBills?.length ?? 0) > 0 && (
            <Button asChild variant="ghost" size="xs" className="rounded-full text-teal-800">
              <Link to="/app/bills">View all</Link>
            </Button>
          )}
        </div>

        {(!recentBills || recentBills.length === 0) ? (
          <div className="mt-4 flex flex-col items-center py-8 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <ReceiptText className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No bills yet</p>
            <p className="mt-1 text-xs text-stone-400">
              Add your first bill to get started
            </p>
            <Button asChild size="sm" className="mt-4 rounded-full">
              <Link to="/app/bills/new">
                <Plus className="size-3.5" />
                Add bill
              </Link>
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {recentBills.map((bill) => (
              <Link
                key={bill.id}
                to={`/app/bills/${bill.id}`}
                className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100/80"
              >
                <div>
                  <p className="text-sm font-medium text-stone-800">{bill.title}</p>
                  <p className="text-xs text-stone-400">
                    {bill.groupName ? (
                      <>
                        <span className="font-medium text-stone-500">{bill.groupName}</span>
                        <span> · </span>
                      </>
                    ) : null}
                    {timeAgo(bill.createdAt)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-stone-800">
                  {formatCurrency(bill.amount, bill.currency)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {paymentsInvolvingYou.length > 0 && (
        <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History className="size-4 text-teal-800" />
              <h3 className="text-base font-semibold">Your payments</h3>
            </div>
            <Button asChild variant="ghost" size="xs" className="rounded-full text-teal-800">
              <Link to="/app/balances">Balances</Link>
            </Button>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            Recorded settlements across your groups (you paid or were paid).
          </p>
          <div className="mt-4">
            <SettlementHistoryList
              items={paymentsInvolvingYou}
              currentUserId={userId}
              showGroupName
              onEdit={(item) => setEditingSettlement(item)}
            />
          </div>
        </section>
      )}

      {editingSettlement && (
        <EditSettlementDialog
          item={editingSettlement}
          onClose={() => setEditingSettlement(null)}
          onSaved={() => setEditingSettlement(null)}
        />
      )}

      {(recentActivity?.length ?? 0) > 0 && (
        <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ArrowUpRight className="size-4 text-teal-800" />
            <h3 className="text-base font-semibold">Recent activity</h3>
          </div>
          <div className="mt-4 space-y-2">
            {recentActivity!.map((log) => (
              <div
                key={log.id}
                className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
              >
                <p className="text-sm text-stone-600">{log.description}</p>
                <p className="mt-0.5 text-xs text-stone-400">{timeAgo(log.created_at)}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
