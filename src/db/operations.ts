import { db } from './db'
import { triggerSync } from '@/sync/sync-manager'
import type {
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  SplitType,
} from '@/types'
import { generateId, getDeviceId, now } from '@/lib/utils'
import {
  notifyBillParticipantsCreated,
  notifyProfileLinked,
  resolveRecipientProfileIdForNotify,
} from '@/lib/kwenta-notifications'
import { computeSplits, type SplitInput } from '@/lib/splits'
import { participantUnionForBill } from '@/lib/people'

function notifySyncAfterMutation() {
  triggerSync()
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
  void notifyBillParticipantsCreated({
    actorId: input.createdBy,
    actorName: actor?.display_name?.trim() || 'Someone',
    recipientIds: [...recipientIds],
    billId,
    billTitle: input.title,
    groupId: input.groupId,
    groupName,
  })

  notifySyncAfterMutation()
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
  notifySyncAfterMutation()
}

export async function deleteBill(billId: string, userId: string) {
  const timestamp = now()
  await db.transaction('rw', [db.bills, db.bill_items, db.item_splits, db.activity_log], async () => {
    const bill = await db.bills.get(billId)
    if (!bill) return

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
  notifySyncAfterMutation()
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

  notifySyncAfterMutation()
  return groupId
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string; currency?: string },
  userId: string,
): Promise<void> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return

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
  notifySyncAfterMutation()
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
      notifySyncAfterMutation()
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
    const already = await db.group_members.where('[group_id+user_id]').equals([groupId, userId]).first()
    if (already && !already.is_deleted) {
      notifySyncAfterMutation()
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
        is_local: true,
        linked_profile_id: null,
        owner_id: addedBy,
      })
    }

    const p = await db.profiles.get(userId)
    const member: GroupMember = {
      ...syncFields({ id: memberId }),
      group_id: groupId,
      user_id: userId,
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

  notifySyncAfterMutation()
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
    is_local: true,
    linked_profile_id: null,
    owner_id: ownerUserId,
  })
  notifySyncAfterMutation()
  return { outcome: 'created', id: userId }
}

/** Add someone who already exists in your phonebook or groups (by profile id). */
export async function addExistingGroupMember(
  groupId: string,
  memberUserId: string,
  addedBy: string,
): Promise<void> {
  const existing = await db.group_members.where('[group_id+user_id]').equals([groupId, memberUserId]).first()
  if (existing && !existing.is_deleted) {
    notifySyncAfterMutation()
    return
  }

  const p = await db.profiles.get(memberUserId)
  if (!p || p.is_deleted) return

  const memberId = generateId()
  await db.transaction('rw', [db.group_members, db.activity_log], async () => {
    await db.group_members.add({
      ...syncFields({ id: memberId }),
      group_id: groupId,
      user_id: memberUserId,
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
  notifySyncAfterMutation()
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
  const actor = await db.profiles.get(actorUserId)
  void notifyProfileLinked({
    actorId: actorUserId,
    actorName: actor?.display_name?.trim() || 'Someone',
    recipientId: remoteProfileId,
    linkedAsName: local.display_name,
  })
  notifySyncAfterMutation()
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
  notifySyncAfterMutation()
}

/**
 * Remove a person from all personal (non-group) bill splits — same rules as removeGroupMember
 * (equal splits redistributed across remaining members).
 */
async function removePersonFromPersonalBills(memberUserId: string, removedBy: string): Promise<void> {
  const timestamp = now()
  const allBills = await db.bills
    .filter((b) => !b.is_deleted && (b.group_id === null || b.group_id === undefined))
    .toArray()

  await db.transaction('rw', [db.bill_items, db.item_splits, db.activity_log], async () => {
    for (const bill of allBills) {
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
      description: 'Removed person from personal bill splits',
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
  notifySyncAfterMutation()
}

export async function deleteGroup(groupId: string, userId: string) {
  const timestamp = now()
  await db.transaction('rw', [db.groups, db.group_members, db.activity_log], async () => {
    const group = await db.groups.get(groupId)
    if (!group) return

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
  })
  notifySyncAfterMutation()
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
): Promise<string> {
  const settlementId = generateId()
  const labelTrim = (label ?? '').trim()

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
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount,
      currency,
      label: labelTrim,
      is_settled: true,
    })

    const fromProfile = await db.profiles.get(fromUserId)
    const toProfile = await db.profiles.get(toUserId)
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

  notifySyncAfterMutation()
  return settlementId
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

  await db.transaction('rw', [db.settlements, db.activity_log, db.profiles], async () => {
    await db.settlements.update(settlementId, {
      from_user_id: patch.fromUserId,
      to_user_id: patch.toUserId,
      amount: patch.amount,
      currency: patch.currency,
      label: labelTrim,
      updated_at: timestamp,
      synced_at: null,
    })

    const fromProfile = await db.profiles.get(patch.fromUserId)
    const toProfile = await db.profiles.get(patch.toUserId)
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
  notifySyncAfterMutation()
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
          return { ...split, displayName: profile?.display_name ?? 'Unknown' }
        }),
      )

      return { ...item, splits: splitsWithNames }
    }),
  )

  const creator = await db.profiles.get(bill.created_by)

  return {
    ...bill,
    creatorName: creator?.display_name ?? 'Unknown',
    items: itemsWithSplits,
  }
}
