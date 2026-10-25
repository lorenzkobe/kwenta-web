import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { upsertRemoteRow } from '@/sync/mirror-upsert'
import { currentSessionEpoch } from '@/sync/session-epoch'
import type { Settlement } from '@/types'

/** Returns how many rows MOVED (see `upsertRemoteRow`), not how many it wrote. */
export async function applySettlementBundle(bundle: unknown, epoch: number): Promise<number> {
  if (!bundle || typeof bundle !== 'object') return 0
  const settlement = (bundle as { settlement?: Settlement }).settlement
  if (settlement && (await upsertRemoteRow('settlements', settlement, epoch))) return 1
  return 0
}

/**
 * `present`: the payment is on this device. `missing`: the server answered with no payment, which
 * is not proof it is gone (013's lookup misses a payment filed under a linked contact). `unreachable`:
 * offline, a failed request, or a wipe during the fetch.
 */
export type SettlementLoadOutcome = 'present' | 'missing' | 'unreachable'

/** One `kwenta_fetch_settlement`, applied under the realtime rules; a payment already here costs nothing. */
export async function loadSettlementIntoMirror(settlementId: string): Promise<SettlementLoadOutcome> {
  if (await db.settlements.get(settlementId)) return 'present'
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'unreachable'

  const epoch = currentSessionEpoch()
  let bundle: unknown
  try {
    const { data, error } = await supabase.rpc('kwenta_fetch_settlement', { p_settlement_id: settlementId })
    if (error) return 'unreachable'
    bundle = data
  } catch {
    return 'unreachable'
  }
  if (!bundle || !(bundle as { settlement?: unknown }).settlement) return 'missing'
  await applySettlementBundle(bundle, epoch)
  return (await db.settlements.get(settlementId)) ? 'present' : 'unreachable'
}
