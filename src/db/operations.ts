import { db } from './db'
import { requestSyncNow, triggerSync } from '@/sync/sync-manager'
import type {
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  MutationEntityType,
  ProfilePeerLink,
  SplitType,
} from '@/types'
import { generateId, getDeviceId, now } from '@/lib/utils'
import { finalizeMutationSync } from '@/sync/cloud-first-mutations'
import {
  notifyAddedToGroup,
  notifyBillParticipantsCreated,
  notifyPaymentRecorded,
  notifyProfileLinked,
  resolveRecipientProfileIdForNotify,
} from '@/lib/kwenta-notifications'
import { computeSplits, type SplitInput } from '@/lib/splits'
import {
  computePairwiseNetForBill,
  expandProfileIdsForSplitMatching,
  fetchRemoteProfileIntoDexie,
  listEligibleSharedGroupsForGeneralCredit,
  participantUnionForBill,
} from '@/lib/people'

async function notifySyncAfterMutation(meta?: {
  actorUserId: string
  operation: string
  entityType: MutationEntityType
  entityId?: string | null
  payload?: unknown
  routeHint?: string | null
}) {
  if (meta) {
    await finalizeMutationSync(meta)
    return
  }
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    requestSyncNow()
    return
  }
  triggerSync()
}

/** Group membership must use the Kwenta account id so Postgres RLS and sync match `auth.uid()`. */
function membershipUserIdForProfile(p: { id: string; linked_profile_id: string | null }): string {
  return p.linked_profile_id ?? p.id
}

function syncFields(overrides?: Partial<{ id: string }>) {
  const timestamp = now()
  return {
    id: overrides?.id ?? generateId(),
    created_at: timestamp,
    updated_at: timestamp,
    synced_at: null as string | null,
    is_deleted: false,
    device_id: getDeviceId(),
  }
}

/**
 * For cloud-visible relationships (e.g. personal settlements), prefer linked Kwenta id.
 * Keep original id when a profile is purely local and not linked.
 */
async function resolveSettlementPartyId(id: string): Promise<string> {
  const p = await db.profiles.get(id)
  if (!p || p.is_deleted) return id
  if (p.linked_profile_id) return p.linked_profile_id
  return id
}

// ── Bills ────────────────────────────────────────────

export interface CreateBillInput {
  title: string
  currency: string
  groupId: string | null
  createdBy: string
  note: string
  items: {
    name: string
    amount: number
    splits: {
      userId: string
      splitType: SplitType
      splitValue: number
    }[]
  }[]
}

export async function createBill(input: CreateBillInput): Promise<string> {
  const billId = generateId()
  const totalAmount = input.items.reduce((sum, item) => sum + item.amount, 0)

  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log], async () => {
    const bill: Bill = {
      ...syncFields({ id: billId }),
      title: input.title,
      group_id: input.groupId,
      currency: input.currency,
      created_by: input.createdBy,
      total_amount: totalAmount,
      note: input.note,
    }
    await db.bills.add(bill)

    for (const item of input.items) {
      const itemId = generateId()
      const billItem: BillItem = {
        ...syncFields({ id: itemId }),
        bill_id: billId,
        name: item.name,
        amount: item.amount,
      }
      await db.bill_items.add(billItem)

      if (item.splits.length > 0) {
        const computed = computeSplits(item.amount, item.splits as SplitInput[])
        for (let i = 0; i < item.splits.length; i++) {
          const split: ItemSplit = {
            ...syncFields(),
            item_id: itemId,
            user_id: item.splits[i].userId,
            split_type: item.splits[i].splitType,
            split_value: item.splits[i].splitValue,
            computed_amount: computed[i].computedAmount,
          }
          await db.item_splits.add(split)
        }
      }
    }

    await db.activity_log.add({
      ...syncFields(),
      group_id: input.groupId,
      user_id: input.createdBy,
      action: 'created',
      entity_type: 'bill',
      entity_id: billId,
      description: `Created bill "${input.title}"`,
    })
  })

  const recipientIds = new Set<string>()
  for (const item of input.items) {
    for (const sp of item.splits) {
      const resolved = await resolveRecipientProfileIdForNotify(sp.userId)
      if (resolved && resolved !== input.createdBy) recipientIds.add(resolved)
    }
  }
  let groupName: string | null = null
  if (input.groupId) {
    const g = await db.groups.get(input.groupId)
    if (g && !g.is_deleted) groupName = g.name
  }
  const actor = await db.profiles.get(input.createdBy)

  await notifySyncAfterMutation({
    actorUserId: input.createdBy,
    operation: 'create_bill',
    entityType: 'bill',
    entityId: billId,
    payload: { title: input.title, groupId: input.groupId },
    routeHint: input.groupId ? `/app/groups/${input.groupId}` : '/app/bills',
  })

  void notifyBillParticipantsCreated({
    actorId: input.createdBy,
    actorName: actor?.display_name?.trim() || 'Someone',
    recipientIds: [...recipientIds],
    billId,
    billTitle: input.title,
    groupId: input.groupId,
    groupName,
  })

  return billId
}

export type UpdateBillItemsInput = CreateBillInput['items']

export async function updateBill(
  billId: string,
  editorUserId: string,
  patch: {
    title: string
    note: string
    currency: string
    items: UpdateBillItemsInput
  },
): Promise<void> {
  const timestamp = now()
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return
  if (bill.created_by !== editorUserId) return

  const totalAmount = patch.items.reduce((sum, item) => sum + item.amount, 0)

  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log], async () => {
    const existingItems = await db.bill_items.where('bill_id').equals(billId).toArray()
    for (const item of existingItems) {
      if (!item.is_deleted) {
        await db.bill_items.update(item.id, { is_deleted: true, updated_at: timestamp })
        const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
        for (const s of splits) {
          if (!s.is_deleted) {
            await db.item_splits.update(s.id, { is_deleted: true, updated_at: timestamp })
          }
        }
      }
    }

    await db.bills.update(billId, {
      title: patch.title,
      note: patch.note,
      currency: patch.currency,
      total_amount: totalAmount,
      updated_at: timestamp,
      synced_at: null,
    })

    for (const item of patch.items) {
      const itemId = generateId()
      const billItem: BillItem = {
        ...syncFields({ id: itemId }),
        bill_id: billId,
        name: item.name,
        amount: item.amount,
      }
      await db.bill_items.add(billItem)

      if (item.splits.length > 0) {
        const computed = computeSplits(item.amount, item.splits as SplitInput[])
        for (let i = 0; i < item.splits.length; i++) {
          await db.item_splits.add({
            ...syncFields(),
            item_id: itemId,
            user_id: item.splits[i].userId,
            split_type: item.splits[i].splitType,
            split_value: item.splits[i].splitValue,
            computed_amount: computed[i].computedAmount,
          })
        }
      }
    }

    await db.activity_log.add({
      ...syncFields(),
      group_id: bill.group_id,
      user_id: editorUserId,
      action: 'updated',
      entity_type: 'bill',
      entity_id: billId,
      description: `Updated bill "${patch.title}"`,
    })
  })
  await notifySyncAfterMutation({
    actorUserId: editorUserId,
    operation: 'update_bill',
    entityType: 'bill',
    entityId: billId,
    payload: { title: patch.title, currency: patch.currency, groupId: bill.group_id },
    routeHint: bill.group_id ? `/app/groups/${bill.group_id}` : `/app/bills/${billId}`,
  })
}

export async function deleteBill(billId: string, userId: string) {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return
  if (bill.created_by !== userId) return

  const timestamp = now()
  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log], async () => {
    await db.bills.update(billId, { is_deleted: true, updated_at: timestamp })

    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    for (const item of items) {
      await db.bill_items.update(item.id, { is_deleted: true, updated_at: timestamp })
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      for (const split of splits) {
        await db.item_splits.update(split.id, { is_deleted: true, updated_at: timestamp })
      }
    }

    await db.activity_log.add({
      ...syncFields(),
      group_id: bill.group_id,
      user_id: userId,
      action: 'deleted',
      entity_type: 'bill',
      entity_id: billId,
      description: `Deleted bill "${bill.title}"`,
    })
  })
  await notifySyncAfterMutation({
    actorUserId: userId,
    operation: 'delete_bill',
    entityType: 'bill',
    entityId: billId,
    payload: { title: bill.title, groupId: bill.group_id },
    routeHint: bill.group_id ? `/app/groups/${bill.group_id}` : '/app/bills',
  })
}

// ── Groups ───────────────────────────────────────────

export async function createGroup(
  name: string,
  currency: string,
  createdBy: string,
): Promise<string> {
  const groupId = generateId()
  const inviteCode = generateId().slice(0, 6).toUpperCase()

  await db.transaction('rw', [db.groups, db.group_members, db.activity_log], async () => {
    const group: Group = {
      ...syncFields({ id: groupId }),
      name,
      currency,
      created_by: createdBy,
      invite_code: inviteCode,
    }
    await db.groups.add(group)

    const member: GroupMember = {
      ...syncFields(),
      group_id: groupId,
      user_id: createdBy,
      display_name: 'You',
      joined_at: now(),
    }
    await db.group_members.add(member)

    await db.activity_log.add({
      ...syncFields(),
      group_id: groupId,
      user_id: createdBy,
      action: 'created',
      entity_type: 'group',
      entity_id: groupId,
      description: `Created group "${name}"`,
    })
  })

  await notifySyncAfterMutation({
    actorUserId: createdBy,
    operation: 'create_group',
    entityType: 'group',
    entityId: groupId,
    payload: { name, currency },
    routeHint: `/app/groups/${groupId}`,
  })
  return groupId
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string; currency?: string },
  userId: string,
): Promise<void> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return
  if (group.created_by !== userId) return

  const timestamp = now()
  const nextName = patch.name?.trim() ?? group.name
  const nextCurrency = patch.currency ?? group.currency

  await db.transaction('rw', [db.groups, db.activity_log], async () => {
    await db.groups.update(groupId, {
      name: nextName,
      currency: nextCurrency,
      updated_at: timestamp,
      synced_at: null,
    })

    await db.activity_log.add({
      ...syncFields(),
      group_id: groupId,
      user_id: userId,
      action: 'updated',
      entity_type: 'group',
      entity_id: groupId,
      description: `Updated group "${nextName}"`,
    })
  })
  await notifySyncAfterMutation({
    actorUserId: userId,
    operation: 'update_group',
    entityType: 'group',
    entityId: groupId,
    payload: { name: nextName, currency: nextCurrency },
    routeHint: `/app/groups/${groupId}`,
  })
}

export async function addGroupMember(
  groupId: string,
  displayName: string,
  addedBy: string,
): Promise<string> {
  const trimmed = displayName.trim()
  const normalized = trimmed.toLowerCase()

  const existingMembership = await db.group_members
    .where('group_id')
    .equals(groupId)
    .filter((m) => !m.is_deleted)
    .toArray()
  for (const m of existingMembership) {
    const p = await db.profiles.get(m.user_id)
    if (p && !p.is_deleted && p.display_name.trim().toLowerCase() === normalized) {
      await notifySyncAfterMutation({
        actorUserId: addedBy,
        operation: 'group_member_exists',
        entityType: 'group_member',
        entityId: m.id,
        payload: { groupId, memberUserId: m.user_id },
        routeHint: `/app/groups/${groupId}`,
      })
      return m.user_id
    }
  }

  let userId: string | undefined
  const existingProfile = await db.profiles
    .where('owner_id')
    .equals(addedBy)
    .filter((p) => !p.is_deleted && p.display_name.trim().toLowerCase() === normalized)
    .first()
  if (existingProfile) {
    userId = existingProfile.id
  }

  if (userId) {
    const pCheck = await db.profiles.get(userId)
    const rowUid = pCheck ? membershipUserIdForProfile(pCheck) : userId
    const already = await db.group_members.where('[group_id+user_id]').equals([groupId, rowUid]).first()
    if (already && !already.is_deleted) {
      await notifySyncAfterMutation({
        actorUserId: addedBy,
        operation: 'group_member_exists',
        entityType: 'group_member',
        entityId: already.id,
        payload: { groupId, memberUserId: rowUid },
        routeHint: `/app/groups/${groupId}`,
      })
      return userId
    }
  }

  const memberId = generateId()

  await db.transaction('rw', [db.profiles, db.group_members, db.activity_log], async () => {
    if (!userId) {
      userId = generateId()
      await db.profiles.add({
        ...syncFields({ id: userId }),
        email: '',
        display_name: trimmed,
        avatar_url: null,
        user_type: 'user',
        account_status: 'active',
        is_local: true,
        linked_profile_id: null,
        owner_id: addedBy,
      })
    }

    const p = await db.profiles.get(userId)
    const memberRowUserId = p ? membershipUserIdForProfile(p) : userId
    const member: GroupMember = {
      ...syncFields({ id: memberId }),
      group_id: groupId,
      user_id: memberRowUserId,
      display_name: p?.display_name ?? trimmed,
      joined_at: now(),
    }
    await db.group_members.add(member)

    await db.activity_log.add({
      ...syncFields(),
      group_id: groupId,
      user_id: addedBy,
      action: 'created',
      entity_type: 'group',
      entity_id: memberId,
      description: `Added "${p?.display_name ?? trimmed}" to group`,
    })
  })

  const pFinal = await db.profiles.get(userId!)
  if (pFinal?.linked_profile_id) {
    await fetchRemoteProfileIntoDexie(pFinal.linked_profile_id)
  }

  const group = await db.groups.get(groupId)
  const actor = await db.profiles.get(addedBy)
  const recipient = await resolveRecipientProfileIdForNotify(userId!)
  if (recipient && recipient !== addedBy && group && !group.is_deleted) {
    void notifyAddedToGroup({
      actorId: addedBy,
      actorName: actor?.display_name?.trim() || 'Someone',
      recipientId: recipient,
      groupId,
      groupName: group.name,
    })
  }

  await notifySyncAfterMutation({
    actorUserId: addedBy,
    operation: 'add_group_member',
    entityType: 'group_member',
    entityId: memberId,
    payload: { groupId, memberUserId: userId },
    routeHint: `/app/groups/${groupId}`,
  })
  return userId!
}

export type CreateLocalProfileResult =
  | { outcome: 'created'; id: string }
  | { outcome: 'already_exists'; id: string }

/** Local phonebook contact (unique name per owner). */
export async function createLocalProfile(
  displayName: string,
  ownerUserId: string,
): Promise<CreateLocalProfileResult> {
  const trimmed = displayName.trim()
  const normalized = trimmed.toLowerCase()
  if (!trimmed) throw new Error('Name required')

  const existing = await db.profiles
    .where('owner_id')
    .equals(ownerUserId)
    .filter((p) => !p.is_deleted && p.display_name.trim().toLowerCase() === normalized)
    .first()
  if (existing) return { outcome: 'already_exists', id: existing.id }

  const userId = generateId()
  await db.profiles.add({
    ...syncFields({ id: userId }),
    email: '',
    display_name: trimmed,
    avatar_url: null,
    user_type: 'user',
    account_status: 'active',
    is_local: true,
    linked_profile_id: null,
    owner_id: ownerUserId,
  })
  await notifySyncAfterMutation({
    actorUserId: ownerUserId,
    operation: 'create_local_profile',
    entityType: 'profile',
    entityId: userId,
    payload: { displayName: trimmed },
    routeHint: `/app/people/${userId}`,
  })
  return { outcome: 'created', id: userId }
}

/** Add someone who already exists in your phonebook or groups (by profile id). */
export async function addExistingGroupMember(
  groupId: string,
  memberUserId: string,
  addedBy: string,
): Promise<void> {
  const p = await db.profiles.get(memberUserId)
  if (!p || p.is_deleted) return

  const memberRowUserId = membershipUserIdForProfile(p)
  const existingLocal = await db.group_members
    .where('[group_id+user_id]')
    .equals([groupId, memberUserId])
    .first()
  const existingCanon =
    memberRowUserId !== memberUserId
      ? await db.group_members.where('[group_id+user_id]').equals([groupId, memberRowUserId]).first()
      : undefined
  if (
    (existingLocal && !existingLocal.is_deleted) ||
    (existingCanon && !existingCanon.is_deleted)
  ) {
    await notifySyncAfterMutation({
      actorUserId: addedBy,
      operation: 'group_member_exists',
      entityType: 'group_member',
      entityId: existingLocal?.id ?? existingCanon?.id ?? null,
      payload: { groupId, memberUserId: memberRowUserId },
      routeHint: `/app/groups/${groupId}`,
    })
    return
  }

  await fetchRemoteProfileIntoDexie(memberRowUserId)

  const memberId = generateId()
  await db.transaction('rw', [db.group_members, db.activity_log], async () => {
    await db.group_members.add({
      ...syncFields({ id: memberId }),
      group_id: groupId,
      user_id: memberRowUserId,
      display_name: p.display_name,
      joined_at: now(),
    })

    await db.activity_log.add({
      ...syncFields(),
      group_id: groupId,
      user_id: addedBy,
      action: 'created',
      entity_type: 'group',
      entity_id: memberId,
      description: `Added "${p.display_name}" to group`,
    })
  })
  const group = await db.groups.get(groupId)
  const actor = await db.profiles.get(addedBy)
  const recipient = await resolveRecipientProfileIdForNotify(memberUserId)
  if (recipient && recipient !== addedBy && group && !group.is_deleted) {
    void notifyAddedToGroup({
      actorId: addedBy,
      actorName: actor?.display_name?.trim() || 'Someone',
      recipientId: recipient,
      groupId,
      groupName: group.name,
    })
  }
  await notifySyncAfterMutation({
    actorUserId: addedBy,
    operation: 'add_group_member',
    entityType: 'group_member',
    entityId: memberId,
    payload: { groupId, memberUserId: memberRowUserId },
    routeHint: `/app/groups/${groupId}`,
  })
}

/** Point a local contact at a synced account (for display & future migration). */
export async function linkProfileToRemote(
  localProfileId: string,
  remoteProfileId: string,
  actorUserId: string,
): Promise<void> {
  const local = await db.profiles.get(localProfileId)
  const remote = await db.profiles.get(remoteProfileId)
  if (!local || local.is_deleted || !remote || remote.is_deleted) return
  if (local.id === remote.id) return
  if (remoteProfileId === actorUserId) return
  if (local.owner_id !== actorUserId || !local.is_local) return
  if (!remote.email?.trim()) return

  const timestamp = now()
  await db.profiles.update(localProfileId, {
    linked_profile_id: remoteProfileId,
    updated_at: timestamp,
    synced_at: null,
  })

  const memberships = await db.group_members.where('user_id').equals(localProfileId).toArray()
  for (const m of memberships) {
    if (m.is_deleted) continue
    await db.group_members.update(m.id, {
      user_id: remoteProfileId,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  const actor = await db.profiles.get(actorUserId)
  void notifyProfileLinked({
    actorId: actorUserId,
    actorName: actor?.display_name?.trim() || 'Someone',
    recipientId: remoteProfileId,
    linkedAsName: local.display_name,
  })
  await notifySyncAfterMutation({
    actorUserId,
    operation: 'link_profile',
    entityType: 'profile',
    entityId: localProfileId,
    payload: { remoteProfileId },
    routeHint: `/app/people/${localProfileId}`,
  })
}

/** Link another profile (e.g. group “Sam”) to this local contact; balances aggregate by resolution logic. */
export async function addProfilePeerLink(
  anchorLocalId: string,
  peerProfileId: string,
  actorUserId: string,
): Promise<void> {
  if (anchorLocalId === peerProfileId) {
    throw new Error('Cannot link a profile to itself.')
  }
  const anchor = await db.profiles.get(anchorLocalId)
  if (!anchor || anchor.is_deleted || !anchor.is_local || anchor.owner_id !== actorUserId) {
    throw new Error('Only your local contacts can be link anchors.')
  }
  let peer = await db.profiles.get(peerProfileId)
  if (!peer || peer.is_deleted) {
    await fetchRemoteProfileIntoDexie(peerProfileId)
    peer = await db.profiles.get(peerProfileId)
  }
  if (!peer || peer.is_deleted) {
    throw new Error(
      'Could not load that person’s profile from the server. Check your connection, or make sure you share a group with them.',
    )
  }
  if (peerProfileId === actorUserId) {
    throw new Error('You can’t link your own account as a duplicate.')
  }

  const dupe = await db.profile_peer_links
    .filter(
      (l) =>
        !l.is_deleted &&
        l.owner_user_id === actorUserId &&
        l.anchor_profile_id === anchorLocalId &&
        l.peer_profile_id === peerProfileId,
    )
    .first()
  if (dupe) {
    throw new Error('That profile is already linked to this contact.')
  }

  const row: ProfilePeerLink = {
    ...syncFields(),
    owner_user_id: actorUserId,
    anchor_profile_id: anchorLocalId,
    peer_profile_id: peerProfileId,
  }
  await db.profile_peer_links.add(row)
  await notifySyncAfterMutation({
    actorUserId,
    operation: 'add_profile_peer_link',
    entityType: 'profile_peer_link',
    entityId: row.id,
    payload: { anchorLocalId, peerProfileId },
    routeHint: `/app/people/${anchorLocalId}`,
  })
}

export async function removeProfilePeerLink(linkId: string, actorUserId: string): Promise<void> {
  const row = await db.profile_peer_links.get(linkId)
  if (!row || row.is_deleted || row.owner_user_id !== actorUserId) return
  const anchor = await db.profiles.get(row.anchor_profile_id)
  const isPrimaryAccountLink = Boolean(anchor?.linked_profile_id && anchor.linked_profile_id === row.peer_profile_id)
  if (isPrimaryAccountLink) return

  const timestamp = now()
  await db.profile_peer_links.update(linkId, {
    is_deleted: true,
    updated_at: timestamp,
    synced_at: null,
  })
  await notifySyncAfterMutation({
    actorUserId,
    operation: 'remove_profile_peer_link',
    entityType: 'profile_peer_link',
    entityId: linkId,
    payload: { anchorLocalId: row.anchor_profile_id, peerProfileId: row.peer_profile_id },
    routeHint: `/app/people/${row.anchor_profile_id}`,
  })
}

export async function removeGroupMember(
  groupId: string,
  memberUserId: string,
  removedBy: string,
): Promise<void> {
  const timestamp = now()

  await db.transaction(
    'rw',
    [db.profiles, db.group_members, db.bills, db.bill_items, db.item_splits, db.activity_log],
    async () => {
      // Soft-delete the membership record
      const allMembers = await db.group_members.where('group_id').equals(groupId).toArray()
      const membership = allMembers.find((m) => m.user_id === memberUserId && !m.is_deleted)
      if (!membership) return

      const profile = await db.profiles.get(memberUserId)
      const displayName = profile?.display_name ?? membership.display_name

      await db.group_members.update(membership.id, { is_deleted: true, updated_at: timestamp })

      // Remove the member's splits from all bills in this group and recompute equal splits
      const bills = await db.bills.where('group_id').equals(groupId).toArray()
      const activeBills = bills.filter((b) => !b.is_deleted)

      for (const bill of activeBills) {
        const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
        const activeItems = items.filter((i) => !i.is_deleted)

        for (const item of activeItems) {
          const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
          const activeSplits = splits.filter((s) => !s.is_deleted)
          const memberSplit = activeSplits.find((s) => s.user_id === memberUserId)
          if (!memberSplit) continue

          await db.item_splits.update(memberSplit.id, {
            is_deleted: true,
            updated_at: timestamp,
          })

          // For equal splits: redistribute amount evenly across remaining members
          const remaining = activeSplits.filter((s) => s.user_id !== memberUserId)
          if (memberSplit.split_type === 'equal' && remaining.length > 0) {
            const newAmount = item.amount / remaining.length
            for (const s of remaining) {
              await db.item_splits.update(s.id, {
                computed_amount: newAmount,
                updated_at: timestamp,
                synced_at: null,
              })
            }
          }
        }
      }

      await db.activity_log.add({
        ...syncFields(),
        group_id: groupId,
        user_id: removedBy,
        action: 'deleted',
        entity_type: 'group',
        entity_id: membership.id,
        description: `Removed "${displayName}" from group`,
      })
    },
  )
  await notifySyncAfterMutation({
    actorUserId: removedBy,
    operation: 'remove_group_member',
    entityType: 'group_member',
    entityId: memberUserId,
    payload: { groupId, memberUserId },
    routeHint: `/app/groups/${groupId}`,
  })
}

/**
 * Remove a person from all personal (non-group) bills.
 * - If the bill only involves you and them (no other participants), soft-delete the whole bill.
 * - Otherwise remove their splits and redistribute equal splits among remaining people (same as group removal).
 */
async function removePersonFromPersonalBills(memberUserId: string, removedBy: string): Promise<void> {
  const actorId = removedBy
  const allPersonal = await db.bills
    .filter((b) => !b.is_deleted && (b.group_id === null || b.group_id === undefined))
    .toArray()

  for (const bill of allPersonal) {
    const union = await participantUnionForBill(bill.id)
    if (!union.has(memberUserId)) continue

    const othersBesidesYouTwo = [...union].filter((id) => id !== actorId && id !== memberUserId)
    if (othersBesidesYouTwo.length === 0) {
      await deleteBill(bill.id, actorId)
    }
  }

  const timestamp = now()
  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log], async () => {
    const bills = await db.bills
      .filter((b) => !b.is_deleted && (b.group_id === null || b.group_id === undefined))
      .toArray()

    for (const bill of bills) {
      const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
      const activeItems = items.filter((i) => !i.is_deleted)

      for (const item of activeItems) {
        const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
        const activeSplits = splits.filter((s) => !s.is_deleted)
        const memberSplit = activeSplits.find((s) => s.user_id === memberUserId)
        if (!memberSplit) continue

        await db.item_splits.update(memberSplit.id, {
          is_deleted: true,
          updated_at: timestamp,
        })

        const remaining = activeSplits.filter((s) => s.user_id !== memberUserId)
        if (memberSplit.split_type === 'equal' && remaining.length > 0) {
          const newAmount = item.amount / remaining.length
          for (const s of remaining) {
            await db.item_splits.update(s.id, {
              computed_amount: newAmount,
              updated_at: timestamp,
              synced_at: null,
            })
          }
        }
      }
    }

    await db.activity_log.add({
      ...syncFields(),
      group_id: null,
      user_id: removedBy,
      action: 'deleted',
      entity_type: 'bill',
      entity_id: memberUserId,
      description:
        'Removed contact from personal bills (bills only between you two were deleted; other bills had their splits updated)',
    })
  })
}

/**
 * Remove someone from all groups (splits recomputed per group), personal bills, payments, then soft-delete their profile.
 */
export async function deletePerson(personId: string, actorUserId: string): Promise<void> {
  if (personId === actorUserId) return

  const p = await db.profiles.get(personId)
  if (!p || p.is_deleted) return

  const displayName = p.display_name

  const memberships = await db.group_members.where('user_id').equals(personId).toArray()
  const groupIds = [...new Set(memberships.filter((m) => !m.is_deleted).map((m) => m.group_id))]

  for (const gid of groupIds) {
    await removeGroupMember(gid, personId, actorUserId)
  }

  await removePersonFromPersonalBills(personId, actorUserId)

  const settlements = await db.settlements
    .filter((s) => !s.is_deleted && (s.from_user_id === personId || s.to_user_id === personId))
    .toArray()
  for (const s of settlements) {
    await deleteSettlement(s.id, actorUserId)
  }

  const timestamp = now()

  const peerLinks = await db.profile_peer_links
    .filter(
      (l) =>
        !l.is_deleted &&
        l.owner_user_id === actorUserId &&
        (l.anchor_profile_id === personId || l.peer_profile_id === personId),
    )
    .toArray()
  for (const l of peerLinks) {
    await db.profile_peer_links.update(l.id, {
      is_deleted: true,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  await db.profiles.update(personId, {
    is_deleted: true,
    updated_at: timestamp,
    synced_at: null,
  })

  await db.activity_log.add({
    ...syncFields(),
    group_id: null,
    user_id: actorUserId,
    action: 'deleted',
    entity_type: 'group',
    entity_id: personId,
    description: `Removed contact "${displayName}"`,
  })
  await notifySyncAfterMutation({
    actorUserId,
    operation: 'delete_person',
    entityType: 'profile',
    entityId: personId,
    payload: { personId },
    routeHint: '/app/people',
  })
}

export async function deleteGroup(groupId: string, userId: string) {
  const timestamp = now()
  await db.transaction(
    'rw',
    [db.groups, db.group_members, db.bills, db.bill_items, db.item_splits, db.settlements, db.activity_log],
    async () => {
      const group = await db.groups.get(groupId)
      if (!group) return
      if (group.created_by !== userId) return

      const bills = await db.bills.where('group_id').equals(groupId).toArray()
      for (const bill of bills) {
        if (bill.is_deleted) continue
        await db.bills.update(bill.id, { is_deleted: true, updated_at: timestamp })

        const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
        for (const item of items) {
          if (item.is_deleted) continue
          await db.bill_items.update(item.id, { is_deleted: true, updated_at: timestamp })
          const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
          for (const split of splits) {
            if (split.is_deleted) continue
            await db.item_splits.update(split.id, { is_deleted: true, updated_at: timestamp })
          }
        }
      }

      const settlements = await db.settlements.where('group_id').equals(groupId).toArray()
      for (const s of settlements) {
        if (s.is_deleted) continue
        await db.settlements.update(s.id, { is_deleted: true, updated_at: timestamp, synced_at: null })
      }

      await db.groups.update(groupId, { is_deleted: true, updated_at: timestamp })

      const members = await db.group_members.where('group_id').equals(groupId).toArray()
      for (const m of members) {
        await db.group_members.update(m.id, { is_deleted: true, updated_at: timestamp })
      }

      await db.activity_log.add({
        ...syncFields(),
        group_id: groupId,
        user_id: userId,
        action: 'deleted',
        entity_type: 'group',
        entity_id: groupId,
        description: `Deleted group "${group.name}"`,
      })
    },
  )
  await notifySyncAfterMutation({
    actorUserId: userId,
    operation: 'delete_group',
    entityType: 'group',
    entityId: groupId,
    payload: { groupId },
    routeHint: '/app/groups',
  })
}

// ── Settlements ─────────────────────────────────────

export async function createSettlement(
  groupId: string | null,
  fromUserId: string,
  toUserId: string,
  amount: number,
  currency: string,
  markedBy: string,
  label?: string,
  billId?: string | null,
  options?: {
    suppressNotification?: boolean
    suppressSync?: boolean
    syncOperation?: string
    routeHint?: string
  },
): Promise<string> {
  const settlementId = generateId()
  const labelTrim = (label ?? '').trim()
  const [resolvedFromUserId, resolvedToUserId] = await Promise.all([
    resolveSettlementPartyId(fromUserId),
    resolveSettlementPartyId(toUserId),
  ])

  if (billId) {
    const bill = await db.bills.get(billId)
    if (!bill || bill.is_deleted) throw new Error('Bill not found')
    if (bill.group_id !== groupId) throw new Error('Bill does not match this payment context')
    const union = await participantUnionForBill(billId)
    union.add(bill.created_by)
    if (!union.has(fromUserId) || !union.has(toUserId)) {
      throw new Error('Both people must be on this bill')
    }
  }

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    await db.settlements.add({
      ...syncFields({ id: settlementId }),
      group_id: groupId,
      bill_id: billId ?? null,
      bundle_id: null,
      from_user_id: resolvedFromUserId,
      to_user_id: resolvedToUserId,
      amount,
      currency,
      label: labelTrim,
      is_settled: true,
    })

    const fromProfile = (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(fromUserId))
    const toProfile = (await db.profiles.get(resolvedToUserId)) ?? (await db.profiles.get(toUserId))
    const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''

    await db.activity_log.add({
      ...syncFields(),
      group_id: groupId,
      user_id: markedBy,
      action: 'settled',
      entity_type: 'settlement',
      entity_id: settlementId,
      description: `${fromProfile?.display_name ?? 'Someone'} settled ${new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount)} with ${toProfile?.display_name ?? 'someone'}${labelSuffix}`,
    })
  })

  const actor = await db.profiles.get(markedBy)
  const fromProfile = (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(fromUserId))
  const toProfile = (await db.profiles.get(resolvedToUserId)) ?? (await db.profiles.get(toUserId))
  let groupName: string | null = null
  if (groupId) {
    const g = await db.groups.get(groupId)
    if (g && !g.is_deleted) groupName = g.name
  }

  if (!options?.suppressNotification) {
    const recipientCandidates = [resolvedFromUserId, resolvedToUserId].filter((id) => id !== markedBy)
    for (const candidate of recipientCandidates) {
      const recipientId = await resolveRecipientProfileIdForNotify(candidate)
      if (!recipientId || recipientId === markedBy) continue
      void notifyPaymentRecorded({
        actorId: markedBy,
        actorName: actor?.display_name?.trim() || 'Someone',
        recipientId,
        amount,
        currency,
        fromName: fromProfile?.display_name?.trim() || 'Someone',
        toName: toProfile?.display_name?.trim() || 'Someone',
        groupId,
        groupName,
        settlementId,
      })
    }
  }

  if (!options?.suppressSync) {
    await notifySyncAfterMutation({
      actorUserId: markedBy,
      operation: options?.syncOperation ?? 'create_settlement',
      entityType: 'settlement',
      entityId: settlementId,
      payload: { groupId, billId: billId ?? null, amount, currency },
      routeHint: options?.routeHint ?? (groupId ? `/app/groups/${groupId}` : '/app/settings'),
    })
  }
  return settlementId
}

export async function createBundledGroupSettlement(params: {
  groupId: string
  fromUserId: string
  recipients: { toUserId: string; amount: number }[]
  currency: string
  markedBy: string
  label?: string
}): Promise<{ bundleId: string; settlementIds: string[] }> {
  const cleanedRecipients = params.recipients
    .map((recipient) => ({
      ...recipient,
      amount: Math.round(recipient.amount * 100) / 100,
    }))
    .filter((recipient) => recipient.amount > 0.005)
  if (cleanedRecipients.length === 0) {
    throw new Error('No payment recipients found for this bundled payment.')
  }

  const group = await db.groups.get(params.groupId)
  if (!group || group.is_deleted) throw new Error('Group not found')

  const bundleId = generateId()
  const settlementIds = cleanedRecipients.map(() => generateId())
  const [resolvedFromUserId, resolvedRecipients] = await Promise.all([
    resolveSettlementPartyId(params.fromUserId),
    Promise.all(
      cleanedRecipients.map(async (recipient) => ({
        toUserId: await resolveSettlementPartyId(recipient.toUserId),
        amount: recipient.amount,
      })),
    ),
  ])
  const labelTrim = (params.label ?? '').trim()

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    for (let i = 0; i < resolvedRecipients.length; i++) {
      const recipient = resolvedRecipients[i]
      await db.settlements.add({
        ...syncFields({ id: settlementIds[i] }),
        group_id: params.groupId,
        bill_id: null,
        bundle_id: bundleId,
        from_user_id: resolvedFromUserId,
        to_user_id: recipient.toUserId,
        amount: recipient.amount,
        currency: params.currency,
        label: labelTrim,
        is_settled: true,
      })
    }

    const fromProfile =
      (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(params.fromUserId))
    const detailParts: string[] = []
    for (const recipient of resolvedRecipients) {
      const toProfile = await db.profiles.get(recipient.toUserId)
      detailParts.push(
        `${toProfile?.display_name ?? 'Someone'} ${new Intl.NumberFormat('en-PH', {
          style: 'currency',
          currency: params.currency,
          minimumFractionDigits: 0,
        }).format(recipient.amount)}`,
      )
    }
    const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''
    await db.activity_log.add({
      ...syncFields(),
      group_id: params.groupId,
      user_id: params.markedBy,
      action: 'settled',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `${fromProfile?.display_name ?? 'Someone'} paid ${detailParts.join(', ')}${labelSuffix}`,
    })
  })

  const actor = await db.profiles.get(params.markedBy)
  const fromProfile = (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(params.fromUserId))
  for (let i = 0; i < resolvedRecipients.length; i++) {
    const recipient = resolvedRecipients[i]
    const toProfile = await db.profiles.get(recipient.toUserId)
    const recipientId = await resolveRecipientProfileIdForNotify(recipient.toUserId)
    if (!recipientId || recipientId === params.markedBy) continue
    void notifyPaymentRecorded({
      actorId: params.markedBy,
      actorName: actor?.display_name?.trim() || 'Someone',
      recipientId,
      amount: recipient.amount,
      currency: params.currency,
      fromName: fromProfile?.display_name?.trim() || 'Someone',
      toName: toProfile?.display_name?.trim() || 'Someone',
      groupId: params.groupId,
      groupName: group.name,
      settlementId: settlementIds[i],
    })
  }

  await notifySyncAfterMutation({
    actorUserId: params.markedBy,
    operation: 'create_settlement_bundle',
    entityType: 'settlement',
    entityId: bundleId,
    payload: {
      groupId: params.groupId,
      recipients: resolvedRecipients.length,
      totalAmount: Math.round(resolvedRecipients.reduce((sum, recipient) => sum + recipient.amount, 0) * 100) / 100,
      currency: params.currency,
    },
    routeHint: `/app/groups/${params.groupId}`,
  })

  return { bundleId, settlementIds }
}

export interface DistributedSettlementSlice {
  billId: string
  amount: number
}

export interface GeneralCreditGroupAllocation {
  groupId: string
  amount: number
}

async function emitSinglePaymentNotification(params: {
  markedBy: string
  fromUserId: string
  toUserId: string
  amount: number
  currency: string
  groupId: string | null
  settlementId: string
}) {
  const actor = await db.profiles.get(params.markedBy)
  const [fromProfile, toProfile] = await Promise.all([
    db.profiles.get(params.fromUserId),
    db.profiles.get(params.toUserId),
  ])
  let groupName: string | null = null
  if (params.groupId) {
    const g = await db.groups.get(params.groupId)
    if (g && !g.is_deleted) groupName = g.name
  }
  const recipientCandidates = [params.fromUserId, params.toUserId].filter((id) => id !== params.markedBy)
  for (const candidate of recipientCandidates) {
    const recipientId = await resolveRecipientProfileIdForNotify(candidate)
    if (!recipientId || recipientId === params.markedBy) continue
    void notifyPaymentRecorded({
      actorId: params.markedBy,
      actorName: actor?.display_name?.trim() || 'Someone',
      recipientId,
      amount: params.amount,
      currency: params.currency,
      fromName: fromProfile?.display_name?.trim() || 'Someone',
      toName: toProfile?.display_name?.trim() || 'Someone',
      groupId: params.groupId,
      groupName,
      settlementId: params.settlementId,
    })
  }
}

export async function createPersonalPaymentWithDistribution(params: {
  fromUserId: string
  toUserId: string
  totalAmount: number
  currency: string
  markedBy: string
  label?: string
  slices: DistributedSettlementSlice[]
  remainderAmount: number
  routeHint?: string
}): Promise<{ settlementIds: string[] }> {
  const settlementIds: string[] = []

  for (const slice of params.slices) {
    if (slice.amount <= 0.005) continue
    const id = await createSettlement(
      null,
      params.fromUserId,
      params.toUserId,
      slice.amount,
      params.currency,
      params.markedBy,
      params.label,
      slice.billId,
      { suppressNotification: true, suppressSync: true },
    )
    settlementIds.push(id)
  }

  if (params.remainderAmount > 0.005) {
    const id = await createSettlement(
      null,
      params.fromUserId,
      params.toUserId,
      params.remainderAmount,
      params.currency,
      params.markedBy,
      params.label,
      null,
      { suppressNotification: true, suppressSync: true },
    )
    settlementIds.push(id)
  }

  const notifyEntityId = settlementIds[0] ?? null
  if (notifyEntityId) {
    await emitSinglePaymentNotification({
      markedBy: params.markedBy,
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      amount: Math.round(params.totalAmount * 100) / 100,
      currency: params.currency,
      groupId: null,
      settlementId: notifyEntityId,
    })
  }

  await notifySyncAfterMutation({
    actorUserId: params.markedBy,
    operation: 'create_settlement_distributed',
    entityType: 'settlement',
    entityId: notifyEntityId,
    payload: {
      totalAmount: params.totalAmount,
      currency: params.currency,
      slices: params.slices.length,
      remainderAmount: params.remainderAmount,
    },
    routeHint: params.routeHint ?? '/app/settings',
  })

  return { settlementIds }
}

export async function applyGeneralCreditToPersonalBills(params: {
  fromUserId: string
  toUserId: string
  currency: string
  markedBy: string
  appliedAmount: number
  slices: DistributedSettlementSlice[]
  routeHint?: string
}): Promise<{ settlementIds: string[] }> {
  let remainingToConsume = Math.round(params.appliedAmount * 100) / 100
  if (remainingToConsume <= 0.005) return { settlementIds: [] }

  const [resolvedFromUserId, resolvedToUserId] = await Promise.all([
    resolveSettlementPartyId(params.fromUserId),
    resolveSettlementPartyId(params.toUserId),
  ])

  const sourceGeneral = (
    await db.settlements
      .filter(
        (s) =>
          !s.is_deleted &&
          s.is_settled &&
          s.group_id === null &&
          s.bill_id === null &&
          s.currency === params.currency &&
          s.from_user_id === resolvedFromUserId &&
          s.to_user_id === resolvedToUserId,
      )
      .toArray()
  ).sort((a, b) => a.created_at.localeCompare(b.created_at))

  const totalAvailable = sourceGeneral.reduce((sum, row) => sum + row.amount, 0)
  if (totalAvailable + 0.005 < remainingToConsume) {
    throw new Error('General credit changed. Refresh and try again.')
  }

  const timestamp = now()
  for (const row of sourceGeneral) {
    if (remainingToConsume <= 0.005) break
    const consume = Math.min(row.amount, remainingToConsume)
    const nextAmount = Math.round((row.amount - consume) * 100) / 100
    if (nextAmount <= 0.005) {
      await db.settlements.update(row.id, {
        amount: 0,
        is_deleted: true,
        updated_at: timestamp,
        synced_at: null,
      })
    } else {
      await db.settlements.update(row.id, {
        amount: nextAmount,
        updated_at: timestamp,
        synced_at: null,
      })
    }
    remainingToConsume -= consume
  }

  const settlementIds: string[] = []
  for (const slice of params.slices) {
    if (slice.amount <= 0.005) continue
    const id = await createSettlement(
      null,
      params.fromUserId,
      params.toUserId,
      slice.amount,
      params.currency,
      params.markedBy,
      'Applied general credit to bills',
      slice.billId,
      { suppressNotification: true, suppressSync: true },
    )
    settlementIds.push(id)
  }

  const notifyEntityId = settlementIds[0] ?? null
  if (notifyEntityId) {
    await emitSinglePaymentNotification({
      markedBy: params.markedBy,
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      amount: Math.round(params.appliedAmount * 100) / 100,
      currency: params.currency,
      groupId: null,
      settlementId: notifyEntityId,
    })
  }

  await notifySyncAfterMutation({
    actorUserId: params.markedBy,
    operation: 'apply_general_credit_to_bills',
    entityType: 'settlement',
    entityId: notifyEntityId,
    payload: {
      amount: params.appliedAmount,
      currency: params.currency,
      slices: params.slices.length,
    },
    routeHint: params.routeHint ?? '/app/settings',
  })

  return { settlementIds }
}

export async function applyGeneralCreditToSelection(params: {
  fromUserId: string
  toUserId: string
  currency: string
  markedBy: string
  appliedAmount: number
  personalSlices: DistributedSettlementSlice[]
  groupAllocations: GeneralCreditGroupAllocation[]
  routeHint?: string
}): Promise<{ settlementIds: string[] }> {
  const roundedAppliedAmount = Math.round(params.appliedAmount * 100) / 100
  if (roundedAppliedAmount <= 0.005) {
    return { settlementIds: [] }
  }

  const personalTotal = Math.round(
    params.personalSlices.reduce((sum, slice) => sum + Math.max(0, slice.amount), 0) * 100,
  ) / 100
  const groupTotal = Math.round(
    params.groupAllocations.reduce((sum, group) => sum + Math.max(0, group.amount), 0) * 100,
  ) / 100
  const requestedTotal = Math.round((personalTotal + groupTotal) * 100) / 100
  if (Math.abs(requestedTotal - roundedAppliedAmount) > 0.06) {
    throw new Error('Selected credit allocations no longer match the amount to apply.')
  }

  let remainingToConsume = roundedAppliedAmount
  const [resolvedFromUserId, resolvedToUserId, sourceFromIds, sourceToIds] = await Promise.all([
    resolveSettlementPartyId(params.fromUserId),
    resolveSettlementPartyId(params.toUserId),
    expandProfileIdsForSplitMatching(params.fromUserId, params.markedBy),
    expandProfileIdsForSplitMatching(params.toUserId, params.markedBy),
  ])
  const otherParticipantId =
    params.fromUserId === params.markedBy ? params.toUserId : params.fromUserId
  const settlementIds: string[] = []
  const createdGroupSettlements: { settlementId: string; groupId: string; amount: number }[] = []
  let personalSettlementId: string | null = null
  const currencyFormatter = new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: params.currency,
    minimumFractionDigits: 0,
  })

  await db.transaction(
    'rw',
    [
      db.settlements,
      db.activity_log,
      db.profiles,
      db.profile_peer_links,
      db.bills,
      db.bill_items,
      db.item_splits,
      db.groups,
      db.group_members,
    ],
    async () => {
      const sourceGeneral = (
        await db.settlements
          .filter(
            (s) =>
              !s.is_deleted &&
              s.is_settled &&
              s.group_id === null &&
              s.bill_id === null &&
              s.currency === params.currency &&
              sourceFromIds.has(s.from_user_id) &&
              sourceToIds.has(s.to_user_id),
          )
          .toArray()
      ).sort((a, b) => a.created_at.localeCompare(b.created_at))

      const totalAvailable = sourceGeneral.reduce((sum, row) => sum + row.amount, 0)
      if (totalAvailable + 0.005 < remainingToConsume) {
        throw new Error('General credit changed. Refresh and try again.')
      }

      for (const slice of params.personalSlices) {
        if (slice.amount <= 0.005) continue
        const bill = await db.bills.get(slice.billId)
        if (!bill || bill.is_deleted) throw new Error('A selected personal bill no longer exists.')
        if (bill.group_id !== null) throw new Error('A selected bill no longer matches the personal payment context.')
        const union = await participantUnionForBill(slice.billId)
        union.add(bill.created_by)
        if (
          ![...sourceFromIds].some((id) => union.has(id)) ||
          ![...sourceToIds].some((id) => union.has(id))
        ) {
          throw new Error('Both people must still be on the selected personal bill.')
        }
        const currentNet = await computePairwiseNetForBill(
          slice.billId,
          params.markedBy,
          otherParticipantId,
        )
        let currentAllocatable = 0
        if (params.fromUserId === otherParticipantId && params.toUserId === params.markedBy) {
          currentAllocatable = currentNet > 0.005 ? currentNet : 0
        } else if (params.fromUserId === params.markedBy && params.toUserId === otherParticipantId) {
          currentAllocatable = currentNet < -0.005 ? Math.abs(currentNet) : 0
        }
        if (slice.amount > currentAllocatable + 0.005) {
          throw new Error('A selected personal bill balance changed. Refresh and try again.')
        }
      }

      const currentEligibleGroups = await listEligibleSharedGroupsForGeneralCredit({
        meId: params.markedBy,
        otherId: otherParticipantId,
        fromUserId: params.fromUserId,
        toUserId: params.toUserId,
        currency: params.currency,
      })
      const currentGroupAmountById = new Map(
        currentEligibleGroups.map((group) => [group.groupId, group.allocatableAmount]),
      )
      for (const group of params.groupAllocations) {
        if (group.amount <= 0.005) continue
        const existingGroup = await db.groups.get(group.groupId)
        if (!existingGroup || existingGroup.is_deleted) {
          throw new Error('A selected group no longer exists.')
        }
        const currentAllocatable = currentGroupAmountById.get(group.groupId) ?? 0
        if (group.amount > currentAllocatable + 0.005) {
          throw new Error('A selected group balance changed. Refresh and try again.')
        }
      }

      const [fromProfile, toProfile] = await Promise.all([
        db.profiles.get(resolvedFromUserId),
        db.profiles.get(resolvedToUserId),
      ])

      const timestamp = now()
      for (const row of sourceGeneral) {
        if (remainingToConsume <= 0.005) break
        const consume = Math.min(row.amount, remainingToConsume)
        const nextAmount = Math.round((row.amount - consume) * 100) / 100
        if (nextAmount <= 0.005) {
          await db.settlements.update(row.id, {
            amount: 0,
            is_deleted: true,
            updated_at: timestamp,
            synced_at: null,
          })
        } else {
          await db.settlements.update(row.id, {
            amount: nextAmount,
            updated_at: timestamp,
            synced_at: null,
          })
        }
        remainingToConsume -= consume
      }

      for (const slice of params.personalSlices) {
        if (slice.amount <= 0.005) continue
        const settlementId = generateId()
        const label = 'Applied general credit to bills'
        const labelSuffix = ` · ${label}`
        await db.settlements.add({
          ...syncFields({ id: settlementId }),
          group_id: null,
          bill_id: slice.billId,
          bundle_id: null,
          from_user_id: resolvedFromUserId,
          to_user_id: resolvedToUserId,
          amount: slice.amount,
          currency: params.currency,
          label,
          is_settled: true,
        })
        await db.activity_log.add({
          ...syncFields(),
          group_id: null,
          user_id: params.markedBy,
          action: 'settled',
          entity_type: 'settlement',
          entity_id: settlementId,
          description: `${fromProfile?.display_name ?? 'Someone'} settled ${currencyFormatter.format(slice.amount)} with ${toProfile?.display_name ?? 'someone'}${labelSuffix}`,
        })
        if (!personalSettlementId) personalSettlementId = settlementId
        settlementIds.push(settlementId)
      }

      for (const group of params.groupAllocations) {
        if (group.amount <= 0.005) continue
        const settlementId = generateId()
        const label = 'Applied general credit to group balance'
        const labelSuffix = ` · ${label}`
        await db.settlements.add({
          ...syncFields({ id: settlementId }),
          group_id: group.groupId,
          bill_id: null,
          bundle_id: null,
          from_user_id: resolvedFromUserId,
          to_user_id: resolvedToUserId,
          amount: group.amount,
          currency: params.currency,
          label,
          is_settled: true,
        })
        await db.activity_log.add({
          ...syncFields(),
          group_id: group.groupId,
          user_id: params.markedBy,
          action: 'settled',
          entity_type: 'settlement',
          entity_id: settlementId,
          description: `${fromProfile?.display_name ?? 'Someone'} settled ${currencyFormatter.format(group.amount)} with ${toProfile?.display_name ?? 'someone'}${labelSuffix}`,
        })
        settlementIds.push(settlementId)
        createdGroupSettlements.push({
          settlementId,
          groupId: group.groupId,
          amount: Math.round(group.amount * 100) / 100,
        })
      }
    },
  )

  if (personalSettlementId && personalTotal > 0.005) {
    await emitSinglePaymentNotification({
      markedBy: params.markedBy,
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      amount: personalTotal,
      currency: params.currency,
      groupId: null,
      settlementId: personalSettlementId,
    })
  }

  for (const group of createdGroupSettlements) {
    await emitSinglePaymentNotification({
      markedBy: params.markedBy,
      fromUserId: params.fromUserId,
      toUserId: params.toUserId,
      amount: group.amount,
      currency: params.currency,
      groupId: group.groupId,
      settlementId: group.settlementId,
    })
  }

  const notifyEntityId = settlementIds[0] ?? null
  await notifySyncAfterMutation({
    actorUserId: params.markedBy,
    operation: 'apply_general_credit_to_selection',
    entityType: 'settlement',
    entityId: notifyEntityId,
    payload: {
      amount: roundedAppliedAmount,
      currency: params.currency,
      personalSlices: params.personalSlices.length,
      groupAllocations: createdGroupSettlements.length,
    },
    routeHint: params.routeHint ?? '/app/settings',
  })

  return { settlementIds }
}

export async function updateSettlement(
  settlementId: string,
  patch: {
    fromUserId: string
    toUserId: string
    amount: number
    currency: string
    label: string
  },
  editorUserId: string,
): Promise<void> {
  const s = await db.settlements.get(settlementId)
  if (!s || s.is_deleted) return

  const timestamp = now()
  const labelTrim = patch.label.trim()
  const [resolvedFromUserId, resolvedToUserId] = await Promise.all([
    resolveSettlementPartyId(patch.fromUserId),
    resolveSettlementPartyId(patch.toUserId),
  ])

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    await db.settlements.update(settlementId, {
      from_user_id: resolvedFromUserId,
      to_user_id: resolvedToUserId,
      amount: patch.amount,
      currency: patch.currency,
      label: labelTrim,
      updated_at: timestamp,
      synced_at: null,
    })

    const fromProfile = (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(patch.fromUserId))
    const toProfile = (await db.profiles.get(resolvedToUserId)) ?? (await db.profiles.get(patch.toUserId))
    const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''

    await db.activity_log.add({
      ...syncFields(),
      group_id: s.group_id,
      user_id: editorUserId,
      action: 'updated',
      entity_type: 'settlement',
      entity_id: settlementId,
      description: `${fromProfile?.display_name ?? 'Someone'} → ${toProfile?.display_name ?? 'someone'} · ${new Intl.NumberFormat('en-PH', { style: 'currency', currency: patch.currency, minimumFractionDigits: 0 }).format(patch.amount)} (updated)${labelSuffix}`,
    })
  })

  await notifySyncAfterMutation({
    actorUserId: editorUserId,
    operation: 'update_settlement',
    entityType: 'settlement',
    entityId: settlementId,
    payload: { amount: patch.amount, currency: patch.currency },
    routeHint: s.group_id ? `/app/groups/${s.group_id}` : '/app/settings',
  })
}

export async function updateBundledPaymentLabel(
  bundleId: string,
  patch: { label: string },
  editorUserId: string,
): Promise<void> {
  const rows = await db.settlements.where('bundle_id').equals(bundleId).toArray()
  const activeRows = rows.filter((row) => !row.is_deleted)
  if (activeRows.length === 0) return

  const timestamp = now()
  const labelTrim = patch.label.trim()
  const first = activeRows[0]

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    for (const row of activeRows) {
      await db.settlements.update(row.id, {
        label: labelTrim,
        updated_at: timestamp,
        synced_at: null,
      })
    }

    const fromProfile = await db.profiles.get(first.from_user_id)
    await db.activity_log.add({
      ...syncFields(),
      group_id: first.group_id,
      user_id: editorUserId,
      action: 'updated',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `Updated bundled payment label for ${fromProfile?.display_name ?? 'Someone'}`,
    })
  })

  await notifySyncAfterMutation({
    actorUserId: editorUserId,
    operation: 'update_settlement_bundle_label',
    entityType: 'settlement',
    entityId: bundleId,
    payload: { bundleId, label: labelTrim },
    routeHint: first.group_id ? `/app/groups/${first.group_id}` : '/app/settings',
  })
}

export async function deleteSettlement(settlementId: string, editorUserId: string): Promise<void> {
  const s = await db.settlements.get(settlementId)
  if (!s || s.is_deleted) return

  const timestamp = now()

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    await db.settlements.update(settlementId, {
      is_deleted: true,
      updated_at: timestamp,
      synced_at: null,
    })

    const fromProfile = await db.profiles.get(s.from_user_id)
    const toProfile = await db.profiles.get(s.to_user_id)

    await db.activity_log.add({
      ...syncFields(),
      group_id: s.group_id,
      user_id: editorUserId,
      action: 'deleted',
      entity_type: 'settlement',
      entity_id: settlementId,
      description: `Removed payment ${fromProfile?.display_name ?? '?'} → ${toProfile?.display_name ?? '?'}`,
    })
  })
  await notifySyncAfterMutation({
    actorUserId: editorUserId,
    operation: 'delete_settlement',
    entityType: 'settlement',
    entityId: settlementId,
    payload: { groupId: s.group_id },
    routeHint: s.group_id ? `/app/groups/${s.group_id}` : '/app/settings',
  })
}

export async function deleteBundledPayment(bundleId: string, editorUserId: string): Promise<void> {
  const rows = await db.settlements.where('bundle_id').equals(bundleId).toArray()
  const activeRows = rows.filter((row) => !row.is_deleted)
  if (activeRows.length === 0) return

  const timestamp = now()
  const first = activeRows[0]
  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    for (const row of activeRows) {
      await db.settlements.update(row.id, {
        is_deleted: true,
        updated_at: timestamp,
        synced_at: null,
      })
    }

    const fromProfile = await db.profiles.get(first.from_user_id)
    await db.activity_log.add({
      ...syncFields(),
      group_id: first.group_id,
      user_id: editorUserId,
      action: 'deleted',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `Removed bundled payment from ${fromProfile?.display_name ?? 'Someone'}`,
    })
  })

  await notifySyncAfterMutation({
    actorUserId: editorUserId,
    operation: 'delete_settlement_bundle',
    entityType: 'settlement',
    entityId: bundleId,
    payload: { bundleId, settlementIds: activeRows.map((row) => row.id), groupId: first.group_id },
    routeHint: first.group_id ? `/app/groups/${first.group_id}` : '/app/settings',
  })
}

// ── Queries ──────────────────────────────────────────

export async function getBillWithDetails(billId: string) {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return null

  const items = await db.bill_items.where('bill_id').equals(billId).toArray()
  const activeItems = items.filter((i) => !i.is_deleted)

  const itemsWithSplits = await Promise.all(
    activeItems.map(async (item) => {
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const activeSplits = splits.filter((s) => !s.is_deleted)

      const splitsWithNames = await Promise.all(
        activeSplits.map(async (split) => {
          const profile = await db.profiles.get(split.user_id)
          let displayName = profile?.display_name
          if (!displayName && bill.group_id) {
            const member = await db.group_members
              .where('[group_id+user_id]')
              .equals([bill.group_id, split.user_id])
              .first()
            displayName = member?.display_name
          }
          return { ...split, displayName: displayName ?? 'Unknown' }
        }),
      )

      return { ...item, splits: splitsWithNames }
    }),
  )

  const creator = await db.profiles.get(bill.created_by)
  let creatorName = creator?.display_name
  if (!creatorName && bill.group_id) {
    const member = await db.group_members
      .where('[group_id+user_id]')
      .equals([bill.group_id, bill.created_by])
      .first()
    creatorName = member?.display_name
  }

  return {
    ...bill,
    creatorName: creatorName ?? 'Unknown',
    items: itemsWithSplits,
  }
}
