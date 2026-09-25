import { db } from '@/db/db'
import { clearKwentaLocalData, KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import { mayHaveStagedRows } from '@/sync/sync-service'
import type { SyncFields } from '@/types'

/**
 * Who this device's mirror belongs to, and what a sign-in does about it.
 *
 * - `kept`: the stored owner is this user.
 * - `adopted`: no owner was recorded (an upgraded device — the key was declared but never written)
 *   and nothing in the mirror provably belongs to someone else.
 * - `wiped`: the mirror belonged to someone else and held nothing unsent; it was cleared.
 * - `confirm_unsent`: the recorded owner is someone else AND has unsent changes. Nothing was
 *   touched; the caller must warn, then `claimDeviceFor` (continue) or sign out (cancel).
 */
export type DeviceOwnership =
  | { outcome: 'kept' | 'adopted' | 'wiped' }
  | { outcome: 'confirm_unsent'; previousUserId: string }

function readOwner(): string | null {
  try {
    return localStorage.getItem(KWENTA_LOCAL_USER_KEY)
  } catch {
    return null
  }
}

function writeOwner(userId: string): void {
  try {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, userId)
  } catch {
    /* unwritable storage: the next sign-in re-derives ownership from the mirror */
  }
}

/** The account this device's mirror belongs to, or null when none is recorded. */
export function deviceOwner(): string | null {
  return readOwner()
}

/** Queued writes (any status still in the queue) or never-pushed rows, from index counts only. */
async function hasUnsentChanges(): Promise<boolean> {
  const queued = await db.pending_mutations
    .where('status')
    .anyOf(['pending', 'conflict', 'blocked_by_earlier'])
    .count()
  return queued > 0 || (await mayHaveStagedRows())
}

type Row = SyncFields & Record<string, unknown>

/**
 * Tables whose staged rows name who wrote them. Items, splits, members and settlements do not; a
 * write that stages them also stages an authored row (its bill, group, or activity line).
 */
const AUTHORED: readonly { table: string; author: (r: Row) => unknown }[] = [
  { table: 'profiles', author: (r) => (r.is_local ? r.owner_id : r.id) },
  { table: 'groups', author: (r) => r.created_by },
  { table: 'bills', author: (r) => r.created_by },
  { table: 'activity_log', author: (r) => r.user_id },
  { table: 'profile_peer_links', author: (r) => r.owner_user_id },
]

/**
 * No owner key, and the device holds unsent work that is ALL this user's: a queued write, or a
 * never-pushed row this user authored, and nothing unsent by anyone else. Adopting keeps that work;
 * wiping would destroy the one thing a resync cannot bring back. Index counts decide first; the
 * table scan runs only when legacy staged rows exist, once per upgraded device.
 */
async function unsentWorkIsOnly(userId: string): Promise<boolean> {
  if ((await db.pending_mutations.where('actor_user_id').notEqual(userId).count()) > 0) return false
  let mine = (await db.pending_mutations.where('actor_user_id').equals(userId).count()) > 0
  if (!(await mayHaveStagedRows())) return mine
  let foreign = false
  for (const { table, author } of AUTHORED) {
    await db
      .table<Row>(table)
      .filter((r) => r.synced_at === null)
      .each((r) => {
        if (author(r) === userId) mine = true
        else foreign = true
      })
    if (foreign) return false
  }
  return mine
}

/**
 * With no owner key, adopt unless the mirror provably belongs to someone else (skeptic H1.4,
 * review H2.3): a queued write by another actor, a local contact another user owns that is not
 * linked to me (049 delivers exactly those linked to me), or an account row that is neither mine
 * nor linked from one of my contacts. The last check runs even when my own row is present: a
 * previous user's mirror holds my row whenever their contact of me was hydrated, and THEIR own
 * account row is exactly the stray that gives them away.
 */
async function mirrorBelongsToSomeoneElse(userId: string): Promise<boolean> {
  if ((await db.pending_mutations.where('actor_user_id').notEqual(userId).count()) > 0) return true

  const foreignContact = await db.profiles
    .where('owner_id')
    .notEqual(userId)
    .filter((p) => p.is_local && p.linked_profile_id !== userId)
    .first()
  if (foreignContact) return true

  const linkedFromMine = new Set<string>()
  await db.profiles
    .where('owner_id')
    .equals(userId)
    .each((p) => {
      if (p.linked_profile_id) linkedFromMine.add(p.linked_profile_id)
    })
  const strayAccount = await db.profiles
    .filter((p) => !p.is_local && p.id !== userId && !linkedFromMine.has(p.id))
    .first()
  return strayAccount !== undefined
}

/** Wipe the mirror and record `userId` as its owner. */
export async function claimDeviceFor(userId: string): Promise<void> {
  await clearKwentaLocalData()
  writeOwner(userId)
}

/**
 * Run on every sign-in before the app renders. A different user's mirror is wiped (or, when it
 * holds unsent changes, reported so the caller can ask first); the same user's copy, including its
 * unsent changes, is kept.
 */
export async function ensureDeviceOwnedBy(userId: string): Promise<DeviceOwnership> {
  const owner = readOwner()
  if (owner === userId) return { outcome: 'kept' }

  if (owner) {
    if (await hasUnsentChanges()) return { outcome: 'confirm_unsent', previousUserId: owner }
    await claimDeviceFor(userId)
    return { outcome: 'wiped' }
  }

  if (!(await unsentWorkIsOnly(userId)) && (await mirrorBelongsToSomeoneElse(userId))) {
    await claimDeviceFor(userId)
    return { outcome: 'wiped' }
  }
  writeOwner(userId)
  return { outcome: 'adopted' }
}
