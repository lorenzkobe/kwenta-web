import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { toast } from 'sonner'
import {
  planKwentaDataRepair,
  applyKwentaDataRepair,
  type KwentaDataRepairPlan,
} from '@/lib/kwenta-data-repair'
import { Button } from '@/components/ui/button'

/**
 * Advanced tool: dry-run a safe data repair (orphans / duplicates / non-canonical ids) on the
 * signed-in user's own settlements, then apply. Non-destructive to real payments; kept out of
 * the normal flow.
 */
export function RepairDataPanel({ userId }: { userId: string }) {
  const [plan, setPlan] = useState<KwentaDataRepairPlan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)

  async function scan() {
    setScanning(true)
    try {
      setPlan(await planKwentaDataRepair(userId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not scan your data.')
    } finally {
      setScanning(false)
    }
  }

  async function apply() {
    if (!plan) return
    setApplying(true)
    try {
      const res = await applyKwentaDataRepair(userId, plan)
      toast.success(`Repaired: removed ${res.softDeleted}, canonicalized ${res.rewritten}.`)
      setPlan(await planKwentaDataRepair(userId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not apply the repair.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-2">
        <Wrench className="mt-0.5 size-4 shrink-0 text-teal-800" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Repair data</h2>
          <p className="mt-1 text-sm text-stone-600">
            Scan your payments for orphaned rows, exact duplicates, and stale ids. Real payments are
            never removed — only artifacts. Changes sync to the cloud.
          </p>

          {plan && (
            <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50/60 p-4 text-sm">
              {plan.summary.total === 0 ? (
                <p className="text-stone-600">Nothing to repair — your data is clean.</p>
              ) : (
                <ul className="space-y-1 text-stone-700">
                  <li>Orphaned rows: <strong>{plan.summary.orphans}</strong></li>
                  <li>Duplicate rows: <strong>{plan.summary.duplicates}</strong></li>
                  <li>Stale-id rows: <strong>{plan.summary.nonCanonical}</strong></li>
                </ul>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={scanning || applying}
              onClick={() => void scan()}
            >
              {scanning ? 'Scanning…' : plan ? 'Re-scan' : 'Scan for issues'}
            </Button>
            {plan && plan.summary.total > 0 && (
              <Button
                type="button"
                size="sm"
                className="rounded-xl"
                disabled={applying}
                onClick={() => void apply()}
              >
                {applying ? 'Applying…' : `Apply repair (${plan.summary.total})`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
