import { db } from '@/db/db'
import { compareTimestamps, selectServerRowsToApply, type TableName } from '@/sync/sync-service'
import { isSessionEpochCurrent } from '@/sync/session-epoch'
import type { SyncFields } from '@/types'

/**
 * Mirrors `row`; returns whether its content moved — `sync-service`'s `contentMoved` rule. A row
 * this device staged and has not pushed keeps its edit unless the server copy is strictly newer
 * (`shouldApplyPulledRow`, the pull's own rule): overwriting it lost the edit and marked it synced.
 * A row staged only by a refused write is the exception (`selectServerRowsToApply`).
 */
export async function upsertRemoteRow<T extends SyncFields>(tableName: keyof typeof db, row: T, epoch: number): Promise<boolean> {
  // Dexie tables are defined on db instance; index signature is fine here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any)[tableName] as { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<void>; update: (id: string, v: Partial<T>) => Promise<void> }
  const existing = await table.get(row.id)
  // The mirror was wiped (sign-out, account switch) after the request that fetched `row` began:
  // never write the ended session's rows into the next one's mirror.
  if (!isSessionEpochCurrent(epoch)) return false
  if (existing) {
    if (!(await selectServerRowsToApply(tableName as TableName, [row], [existing]))[0]) return false
    await table.update(row.id, { ...(row as unknown as Partial<T>), synced_at: row.updated_at } as Partial<T>)
    return compareTimestamps(existing.updated_at, row.updated_at) !== 0
  }
  await table.add({ ...(row as T), synced_at: row.updated_at })
  return true
}
