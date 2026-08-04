import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { toast } from 'sonner'
import {
  previewSettlementRepair,
  repairSettlementsViaServer,
  type KwentaRepairResult,
} from '@/lib/kwenta-data-repair'
import { describeError } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Advanced tool: ask the server to repair this user's settlements (orphans / duplicates /
 * non-canonical ids) and mirror the result back. Non-destructive to real payments; kept out of
 * the normal flow.
 *
 * Two steps on purpose. The apply soft-deletes rows across the account — and, for group
 * settlements, rows other members also see — with no undo, so it is not a thing to trigger on one
 * tap with nothing shown first. The preview is NOT computed here: a guess from this device's cache
 * is exactly what used to delete real payments. It is the same server-side classification the
 * apply uses (migration 048), run with p_dry_run.
 */
export function RepairDataPanel({ userId }: { userId: string }) {
  const [result, setResult] = useState<KwentaRepairResult | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)

  async function check() {
    setBusy('preview')
    try {
      const res = await previewSettlementRepair()
      setResult(res)
      toast.success(
        res.total === 0
          ? 'Nothing to repair — your data is clean.'
          : `Found ${res.total} to fix. Review below, then apply.`,
      )
    } catch (e) {
      // Clear first: leaving the previous run's counts on screen under a failed run reads as
      // though this run produced them.
      setResult(null)
      toast.error(describeError(e, 'Could not check your data.'))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setBusy('apply')
    try {
      const res = await repairSettlementsViaServer(userId)
      setResult(res)
      toast.success(
        res.total === 0
          ? 'Nothing to repair — your data is clean.'
          : `Repaired: removed ${res.orphans + res.duplicates}, fixed ${res.canonicalized} ids.`,
      )
    } catch (e) {
      setResult(null)
      toast.error(describeError(e, 'Could not run the repair.'))
    } finally {
      setBusy(null)
    }
  }

  const pending = result?.dryRun === true && result.total > 0

  return (
    <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-2">
        <Wrench className="mt-0.5 size-4 shrink-0 text-teal-800" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Repair data</h2>
          <p className="mt-1 text-sm text-stone-600">
            Checks your payments for orphaned rows, exact duplicates, and stale ids. Runs on the
            server, where every account is visible. Real payments are never removed — only
            artifacts.
          </p>

          {result && (
            <div className="mt-3 rounded-2xl border border-stone-200 bg-stone-50/60 p-4 text-sm">
              {result.total === 0 ? (
                <p className="text-stone-600">Nothing to repair — your data is clean.</p>
              ) : (
                <>
                  <ul className="space-y-1 text-stone-700">
                    <li>
                      Orphaned rows {result.dryRun ? 'to remove' : 'removed'}:{' '}
                      <strong>{result.orphans}</strong>
                    </li>
                    <li>
                      Duplicate rows {result.dryRun ? 'to remove' : 'removed'}:{' '}
                      <strong>{result.duplicates}</strong>
                    </li>
                    <li>
                      Stale ids {result.dryRun ? 'to fix' : 'fixed'}:{' '}
                      <strong>{result.canonicalized}</strong>
                    </li>
                  </ul>
                  {result.dryRun && (
                    <p className="mt-2 text-xs text-stone-500">
                      Nothing has been changed yet. Removals are permanent once applied.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={busy !== null}
              onClick={() => void check()}
            >
              {busy === 'preview' ? 'Checking…' : 'Check my data'}
            </Button>
            {pending && (
              <Button
                type="button"
                size="sm"
                className="rounded-xl"
                disabled={busy !== null}
                onClick={() => void apply()}
              >
                {busy === 'apply' ? 'Repairing…' : 'Apply repair'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
