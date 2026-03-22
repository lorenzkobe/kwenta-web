import { Plus, ReceiptText, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { deleteBill } from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency, timeAgo } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function BillsPage() {
  const { userId } = useCurrentUser()

  const bills = useLiveQuery(async () => {
    if (!userId) return []
    const all = await db.bills.where('created_by').equals(userId).toArray()
    const active = all.filter((b) => !b.is_deleted && b.group_id == null)
    active.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return Promise.all(
      active.map(async (bill) => {
        const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
        const activeItems = items.filter((i) => !i.is_deleted)
        return { ...bill, itemCount: activeItems.length }
      }),
    )
  }, [userId])

  async function handleDelete(billId: string) {
    if (!userId) return
    await deleteBill(billId, userId)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Personal bills</h1>
          <p className="mt-1 text-sm text-stone-600">
            {bills?.length ?? 0} bill{(bills?.length ?? 0) !== 1 ? 's' : ''} · Group bills stay in each
            group
          </p>
        </div>
        <Button asChild className="rounded-full">
          <Link to="/app/bills/new">
            <Plus className="size-4" />
            Add bill
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-teal-800/20 bg-teal-800/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800">Looking for group bills?</p>
          <p className="mt-1 text-xs text-stone-600">
            Shared expenses live inside each group. Open a group to add or view bills there.
          </p>
        </div>
        <Button asChild variant="secondary" className="shrink-0 rounded-full">
          <Link to="/app/groups">
            <Users className="size-4" />
            Go to groups
          </Link>
        </Button>
      </div>

      {(!bills || bills.length === 0) ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <ReceiptText className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No personal bills yet</p>
            <p className="mt-1 text-xs text-stone-400">
              Bills you add without a group show up here. Open a group for shared group expenses.
            </p>
            <Button asChild size="sm" className="mt-4 rounded-full">
              <Link to="/app/bills/new">
                <Plus className="size-3.5" />
                Add bill
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {bills.map((bill) => (
            <div
              key={bill.id}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
            >
              <div className="flex items-start justify-between gap-3">
                <Link to={`/app/bills/${bill.id}`} className="min-w-0 flex-1">
                  <p className="font-semibold text-stone-800">{bill.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <span>{timeAgo(bill.created_at)}</span>
                    <span>·</span>
                    <span>{bill.itemCount} item{bill.itemCount !== 1 ? 's' : ''}</span>
                  </div>
                </Link>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-stone-800">
                    {formatCurrency(bill.total_amount, bill.currency)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full text-stone-400 hover:text-red-600"
                    onClick={() => handleDelete(bill.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
