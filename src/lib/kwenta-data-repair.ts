import { supabase } from '@/lib/supabase'
import { fullSync } from '@/sync/sync-service'

/**
 * Settlement repair — a thin client over the server-authoritative RPC (migration 048).
 *
 * The client used to compute the repair itself (plan/apply over Dexie) and soft-delete rows it
 * judged to be junk. That was unsound: `kwenta_build_pull_bundle` sends a device only its own
 * profile plus its own local contacts, so another user's account profile is invisible there by
 * design. A personal payment between two accounts with no shared group looked like it referenced
 * a non-existent person, so the client deleted it and pushed the deletion — the payment vanished
 * for BOTH sides and balances jumped back up. Existence is not knowable from an intentionally
 * partial cache, so the decision belongs to the server, which can see every profile, bill and
 * group. This module now only asks, and mirrors the result back.
 *
 * The RPC is self-scoped by `auth.uid()` and conservative by construction (see 048): it removes
 * orphans and byte-identical duplicates and canonicalizes stale party ids, never a real payment.
 */

export interface KwentaRepairResult {
  orphans: number
  duplicates: number
  canonicalized: number
  total: number
  /** True when the server only reported what it would change and wrote nothing. */
  dryRun: boolean
}

const EMPTY_RESULT: KwentaRepairResult = {
  orphans: 0,
  duplicates: 0,
  canonicalized: 0,
  total: 0,
  dryRun: false,
}

function toResult(data: unknown, dryRun: boolean): KwentaRepairResult {
  if (typeof data !== 'object' || data === null) return { ...EMPTY_RESULT, dryRun }
  const d = data as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const orphans = num(d.orphans)
  const duplicates = num(d.duplicates)
  const canonicalized = num(d.canonicalized)
  return {
    orphans,
    duplicates,
    canonicalized,
    total: num(d.total) || orphans + duplicates + canonicalized,
    dryRun: typeof d.dry_run === 'boolean' ? d.dry_run : dryRun,
  }
}

/**
 * Ask the server what a repair would change, without writing anything.
 *
 * A preview computed from this device's cache would be a guess, and that guess is exactly what
 * used to delete real payments — so the dry run is the same server-side classification the apply
 * uses (`kwenta_repair_settlement_plan`), just not acted on.
 */
export async function previewSettlementRepair(): Promise<KwentaRepairResult> {
  const { data, error } = await supabase.rpc('kwenta_repair_settlements', { p_dry_run: true })
  if (error) throw error
  return toResult(data, true)
}

/**
 * Run the server repair, then pull the result into Dexie so the UI reflects it immediately.
 * Throws on RPC failure, and on a failed mirror, so callers can surface both.
 */
export async function repairSettlementsViaServer(userId: string): Promise<KwentaRepairResult> {
  const { data, error } = await supabase.rpc('kwenta_repair_settlements', { p_dry_run: false })
  if (error) throw error
  const result = toResult(data, false)
  if (result.total > 0) {
    // The repair wrote rows with synced_at = NULL server-side; a round trip mirrors them back.
    //
    // Via fullSync, not syncRoundTrip: fullSync is the wrapper that serializes round trips per
    // user. Calling the inner function directly let this one overlap with the sync manager's,
    // and since every bundle now carries the caller's COMPLETE row set, whichever finished last
    // could write its older snapshot over a row the other had just synced — reverting an edit the
    // user had already saved.
    //
    // syncRoundTrip/fullSync report failure by RETURNING errors, never by throwing. Dropping that
    // channel meant a repair that wrote server-side but never mirrored was reported as a complete
    // success: a green toast and counts, while Dexie still showed every bad row.
    const sync = await fullSync(userId)
    if (sync.errors.length > 0) {
      throw new Error(`Repaired on the server, but could not refresh this device: ${sync.errors.join(' | ')}`)
    }
  }
  return result
}

// Runs once per app session (module-scoped), so the post-sync auto-repair doesn't re-run on every
// backup sync. A full page reload resets it, re-checking for newly-accumulated artifacts.
let autoRepairDone = false
let autoRepairInFlight = false

/**
 * Fire-and-forget auto-repair: ask the server to repair once per session after a successful sync.
 *
 * Never throws: a repair failure must not break app startup or sync. Only marks itself done on
 * success, so a transient failure retries on the next session.
 */
export async function maybeAutoRepairData(userId: string): Promise<void> {
  if (autoRepairDone || autoRepairInFlight) return
  autoRepairInFlight = true
  try {
    const result = await repairSettlementsViaServer(userId)
    if (result.total > 0) {
      console.info(
        `[kwenta] auto data repair: removed ${result.orphans + result.duplicates}, canonicalized ${result.canonicalized}`,
      )
    }
    autoRepairDone = true
  } catch (err) {
    console.warn('[kwenta] auto data repair failed (will retry next session):', err)
  } finally {
    autoRepairInFlight = false
  }
}

/**
 * Drop the once-per-session guard.
 *
 * Called on sign-out (see `clearKwentaLocalData`). The guard is module state, so it outlives the
 * account that set it: without this, a second account signing in on the same tab — no page reload
 * — is refused its own repair for the rest of the session and keeps whatever wrong balances the
 * artifacts cause.
 */
export function resetAutoRepairGuard(): void {
  autoRepairDone = false
  autoRepairInFlight = false
}

/** Test-only alias for {@link resetAutoRepairGuard}. */
export const __resetAutoRepairGuardForTests = resetAutoRepairGuard
