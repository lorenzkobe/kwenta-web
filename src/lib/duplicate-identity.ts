import { db } from '@/db/db'

/**
 * A viewer-owned local contact that appears to be the same person as a real
 * account in the same group. Surfaced so the owner can merge the two identities
 * (row-rewrite), which is the only mechanism that converges balances/suggestions
 * for every member — see the comment in `src/lib/settlement.ts` on why a
 * viewer-local canonicalization map cannot be used at compute time.
 */
export interface DuplicateIdentityCandidate {
  groupId: string
  localId: string
  localName: string
  targetId: string
  targetName: string
}

const normalizeName = (name: string | null | undefined): string =>
  (name ?? '').trim().toLowerCase()

/**
 * Find viewer-owned, unlinked local contacts in `groupId` whose display name
 * matches a real-account participant in the same group. Only the contact's owner
 * can resolve the duplicate, so the result is intentionally viewer-scoped.
 */
export async function findDuplicateIdentityCandidates(
  groupId: string,
  viewerUserId: string,
): Promise<DuplicateIdentityCandidate[]> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return []

  // Every id that participates in this group's identity space.
  const ids = new Set<string>()
  const memberNames = new Map<string, string>()
  const members = await db.group_members.where('group_id').equals(groupId).toArray()
  for (const m of members) {
    if (m.is_deleted) continue
    ids.add(m.user_id)
    if (m.display_name.trim()) memberNames.set(m.user_id, m.display_name.trim())
  }

  const bills = (await db.bills.where('group_id').equals(groupId).toArray()).filter(
    (b) => !b.is_deleted,
  )
  for (const b of bills) ids.add(b.paid_by)
  const billIds = bills.map((b) => b.id)
  const items =
    billIds.length > 0
      ? (await db.bill_items.where('bill_id').anyOf(billIds).toArray()).filter((i) => !i.is_deleted)
      : []
  const itemIds = items.map((i) => i.id)
  const splits =
    itemIds.length > 0
      ? (await db.item_splits.where('item_id').anyOf(itemIds).toArray()).filter((s) => !s.is_deleted)
      : []
  for (const s of splits) ids.add(s.user_id)
  const settlements = (await db.settlements.where('group_id').equals(groupId).toArray()).filter(
    (s) => !s.is_deleted,
  )
  for (const s of settlements) {
    ids.add(s.from_user_id)
    ids.add(s.to_user_id)
  }

  // Resolve each id to {name, flavor}.
  interface Resolved {
    id: string
    name: string
    isViewerLocalUnlinked: boolean
    isViewerLocal: boolean
    isRealAccount: boolean
  }
  const resolved: Resolved[] = []
  for (const id of ids) {
    const profile = await db.profiles.get(id)
    const name = profile?.display_name?.trim() || memberNames.get(id) || ''
    const isViewerLocal = Boolean(
      profile && !profile.is_deleted && profile.is_local && profile.owner_id === viewerUserId,
    )
    const isViewerLocalUnlinked = isViewerLocal && !profile!.linked_profile_id
    // A real-account target: a non-local profile, or an id that simply isn't one of
    // the viewer's own local contacts (e.g. a co-member whose profile row the viewer
    // doesn't hold because of the pull-bundle privacy boundary).
    const isRealAccount = Boolean(profile ? !profile.is_local && !profile.is_deleted : true)
    resolved.push({ id, name, isViewerLocalUnlinked, isViewerLocal, isRealAccount })
  }

  const candidates: DuplicateIdentityCandidate[] = []
  for (const local of resolved) {
    if (!local.isViewerLocalUnlinked) continue
    const key = normalizeName(local.name)
    if (!key) continue
    const target = resolved.find(
      (r) => r.id !== local.id && !r.isViewerLocal && r.isRealAccount && normalizeName(r.name) === key,
    )
    if (!target) continue
    candidates.push({
      groupId,
      localId: local.id,
      localName: local.name,
      targetId: target.id,
      targetName: target.name,
    })
  }
  return candidates
}
