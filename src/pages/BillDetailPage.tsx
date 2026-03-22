import { useState, useEffect } from 'react'
import { ArrowLeft, Loader2, Pencil, ReceiptText, Trash2, Users } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getBillWithDetails, deleteBill } from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type BillDetails = Awaited<ReturnType<typeof getBillWithDetails>>

export function BillDetailPage() {
  const { billId } = useParams<{ billId: string }>()
  const navigate = useNavigate()
  const { userId } = useCurrentUser()
  const [bill, setBill] = useState<BillDetails>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!billId) return
    getBillWithDetails(billId).then((data) => {
      setBill(data)
      setLoading(false)
    })
  }, [billId])

  async function handleDelete() {
    if (!billId || !userId) return
    await deleteBill(billId, userId)
    navigate('/app/bills')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (!bill) {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/bills">
            <ArrowLeft className="size-4" />
            Back to bills
          </Link>
        </Button>
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-center text-sm text-stone-500">Bill not found</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/bills">
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="rounded-full">
            <Link to={`/app/bills/new?edit=${billId}`}>
              <Pencil className="size-4" />
              Edit
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
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{bill.title}</h1>
            <p className="mt-1 text-sm text-stone-500">
              Created by {bill.creatorName} · {new Date(bill.created_at).toLocaleDateString()}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-teal-800">
              {formatCurrency(bill.total_amount, bill.currency)}
            </p>
            <p className="text-xs text-stone-400">{bill.currency}</p>
          </div>
        </div>

        {bill.note && (
          <div className="mt-4 rounded-2xl bg-stone-100/80 px-4 py-3">
            <p className="text-sm text-stone-600">{bill.note}</p>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <ReceiptText className="size-4 text-teal-800" />
          <h2 className="text-lg font-semibold">
            Items ({bill.items.length})
          </h2>
        </div>

        <div className="mt-4 space-y-3">
          {bill.items.map((item) => (
            <div
              key={item.id}
              className="rounded-2xl border border-stone-200 bg-stone-100/60 p-4"
            >
              <div className="flex items-center justify-between">
                <p className="font-medium text-stone-800">{item.name}</p>
                <p className="font-semibold text-stone-800">
                  {formatCurrency(item.amount, bill.currency)}
                </p>
              </div>

              {item.splits.length > 0 && (
                <div className="mt-3 border-t border-stone-200 pt-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-stone-400">
                    <Users className="size-3.5" />
                    Split ({item.splits[0].split_type})
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {item.splits.map((split) => (
                      <div
                        key={split.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-stone-600">{split.displayName}</span>
                        <span className="font-medium text-stone-800">
                          {formatCurrency(split.computed_amount, bill.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
