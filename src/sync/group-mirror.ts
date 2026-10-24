import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { upsertRemoteRow } from '@/sync/mirror-upsert'
import { currentSessionEpoch } from '@/sync/session-epoch'
import type { Group, GroupMember } from '@/types'

export type GroupUnavailableKind = 'not_found' | 'unreachable'

/** A group this device could not load; a connection blip must never read as "it no longer exists". */
export class GroupUnavailableError extends Error {
  readonly kind: GroupUnavailableKind

  constructor(kind: GroupUnavailableKind) {
    super(
      kind === 'not_found'
        ? 'This group no longer exists, or you no longer have access to it.'
        : "Couldn't load this group. Check your connection and try again.",
    )
    this.name = 'GroupUnavailableError'
    this.kind = kind
  }
}

/** Returns how many rows MOVED (see `upsertRemoteRow`), not how many it wrote. */
export async function applyGroupBundle(bundle: unknown, epoch: number): Promise<number> {
  if (!bundle || typeof bundle !== 'object') return 0
  const { group, group_members } = bundle as { group?: Group; group_members?: GroupMember[] }
  let moved = 0
  if (group && (await upsertRemoteRow('groups', group, epoch))) moved++
  for (const m of group_members ?? []) if (await upsertRemoteRow('group_members', m, epoch)) moved++
  return moved
}

/**
 * Bring the group row and its WHOLE roster (`kwenta_fetch_group_bundle`) into the mirror, under the
 * realtime rules: a staged local row keeps its edit unless the server copy is newer, and nothing is
 * written after a wipe. Screens read the roster from the server, so a write that judges membership
 * from a mirror that has not caught up refuses real members; this is how such a write catches up.
 */
export async function refreshGroupIntoMirror(groupId: string): Promise<'present' | GroupUnavailableKind> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'unreachable'
  const epoch = currentSessionEpoch()
  let bundle: unknown
  try {
    const { data, error } = await supabase.rpc('kwenta_fetch_group_bundle', { p_group_id: groupId })
    if (error) return 'unreachable'
    bundle = data
  } catch {
    return 'unreachable'
  }
  if (!bundle || typeof bundle !== 'object' || !(bundle as { group?: unknown }).group) return 'not_found'
  await applyGroupBundle(bundle, epoch)
  return 'present'
}

/** Resolves once the group row is on this device; throws `GroupUnavailableError` otherwise. */
export async function ensureGroupInMirror(groupId: string): Promise<Group> {
  const local = await db.groups.get(groupId)
  if (local) return local
  const outcome = await refreshGroupIntoMirror(groupId)
  if (outcome !== 'present') throw new GroupUnavailableError(outcome)
  const loaded = await db.groups.get(groupId)
  // Only a wipe during the fetch leaves it absent; the action belongs to the ended session.
  if (!loaded) throw new GroupUnavailableError('unreachable')
  return loaded
}
