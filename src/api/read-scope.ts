import type { CloudWritePayload } from '@/sync/cloud-write'

/** The cache-key prefix before the first colon: `bill-payments:<id>` -> `bill-payments`. */
export function endpointFamily(key: string): string {
  const i = key.indexOf(':')
  return i === -1 ? key : key.slice(0, i)
}

const NEW_BILL_TABLES = new Set(['bills', 'bill_items', 'item_splits', 'activity_log'])
const PAYMENT_TABLES = new Set(['settlements', 'activity_log'])

function tablesWithRows(payload: CloudWritePayload): Set<string> {
  const out = new Set<string>()
  for (const [table, rows] of Object.entries(payload)) {
    if (Array.isArray(rows) && rows.length > 0) out.add(table)
  }
  return out
}

/**
 * Endpoint families a write cannot change, so it neither asks the server to recompute them nor
 * makes them refetch. Payment history shows the title of the bill a payment is attached to (069),
 * and existing payments already carry bill ids, so only a NEW bill cannot change it; group
 * spending (064) reads only groups, bills, items and splits, so a payment cannot move it.
 * Anything else, or an empty payload, skips nothing.
 */
export function readsUnaffectedBy(payload: CloudWritePayload, opts?: { createsBill?: boolean }): string[] {
  const tables = tablesWithRows(payload)
  const touched = [...tables].filter((t) => t !== 'activity_log')
  if (touched.length === 0) return []
  if (opts?.createsBill && [...tables].every((t) => NEW_BILL_TABLES.has(t))) {
    return ['bill-payments', 'group-payments-page', 'person-payment-items']
  }
  if ([...tables].every((t) => PAYMENT_TABLES.has(t)) && tables.has('settlements')) {
    return ['group-spending']
  }
  return []
}
