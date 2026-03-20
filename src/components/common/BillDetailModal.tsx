import { useEffect, useState } from 'react'
import { Loader2, Pencil, ReceiptText, Trash2, Users, X } from 'lucide-react'
import { deleteBill, getBillWithDetails } from '@/db/operations'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type BillDetails = NonNullable<Awaited<ReturnType<typeof getBillWithDetails>>>

export function BillDetailModal({
  billId,
  currentUserId,
  onClose,
  onUpdated,
  onEdit,
}: {
  billId: string
  currentUserId: string
  onClose: () => void
  onUpdated: () => void
  onEdit: (billId: string) => void
}) {
  const [bill, setBill] = useState<BillDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setLoading(true)
    getBillWithDetails(billId).then((data) => {
      setBill(data)
      setLoading(false)
    })
  }, [billId])

  async function handleDelete() {
    if (!bill || !confirm(`Delete bill "${bill.title}"?`)) return
    setDeleting(true)
    try {
      await deleteBill(billId, currentUserId)
      onUpdated()
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="relative flex max-h-[min(90dvh,640px)] w-full max-w-lg animate-[slideUp_0.25s_ease-out] flex-col rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-blue-600" />
            <h2 className="text-base font-semibold">Bill details</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex justify-center py-12">
              <Loader2 className="size-5 animate-spin text-blue-600" />
            </div>
          )}

          {!loading && !bill && (
            <p className="py-8 text-center text-sm text-slate-500">Bill not found</p>
          )}

          {!loading && bill && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold tracking-tight text-slate-800">{bill.title}</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {bill.creatorName} · {new Date(bill.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-lg font-semibold text-blue-600">
                      {formatCurrency(bill.total_amount, bill.currency)}
                    </p>
                    <p className="text-[0.65rem] text-slate-400">{bill.currency}</p>
                  </div>
                </div>
                {bill.note ? (
                  <p className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-sm text-slate-600">{bill.note}</p>
                ) : null}
              </div>

              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <ReceiptText className="size-3.5 text-blue-600" />
                  Items ({bill.items.length})
                </div>
                <div className="mt-2 space-y-2">
                  {bill.items.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-slate-800">{item.name}</p>
                        <p className="shrink-0 font-semibold text-slate-800">
                          {formatCurrency(item.amount, bill.currency)}
                        </p>
                      </div>
                      {item.splits.length > 0 && (
                        <div className="mt-2 border-t border-slate-100 pt-2">
                          <p className="text-[0.65rem] font-medium uppercase tracking-wide text-slate-400">
                            Split ({item.splits[0].split_type})
                          </p>
                          <div className="mt-1.5 space-y-1">
                            {item.splits.map((split) => (
                              <div
                                key={split.id}
                                className="flex items-center justify-between text-sm"
                              >
                                <span className="flex items-center gap-1.5 text-slate-600">
                                  <Users className="size-3 text-slate-400" />
                                  {split.displayName}
                                </span>
                                <span className="font-medium text-slate-800">
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
          )}
        </div>

        {!loading && bill && (
          <div className="shrink-0 space-y-2 border-t border-slate-100 px-5 py-4">
            <Button className="w-full rounded-xl" variant="outline" onClick={() => onEdit(billId)}>
              <Pencil className="size-4" />
              Edit bill
            </Button>
            <Button
              variant="ghost"
              className="w-full rounded-xl text-red-600 hover:bg-red-500/5 hover:text-red-700"
              disabled={deleting}
              onClick={handleDelete}
            >
              <Trash2 className="size-4" />
              {deleting ? 'Deleting…' : 'Delete bill'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
