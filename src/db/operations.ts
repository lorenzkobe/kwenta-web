import { db } from './db'
import type {
  ActivityLog,
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  MutationEntityType,
  Profile,
  ProfilePeerLink,
  Settlement,
  SplitType,
} from '@/types'
import { generateId, getDeviceId, now } from '@/lib/utils'
import { enqueuePendingMutation } from '@/sync/cloud-first-mutations'
import { commitCloudFirstWrite, type CloudWritePayload } from '@/sync/cloud-write'
import {
  notifyAddedToGroup,
  notifyBillParticipantsCreated,
  notifyPaymentsRecorded,
  notifyProfileLinked,
  resolveRecipientProfileIdForNotify,
} from '@/lib/kwenta-notifications'
import { computeSplits, type SplitInput } from '@/lib/splits'
import { loadGroupMemberBreakdownFresh, loadOwedInGroup } from '@/api/balances'
import type { SettlementLeg } from '@/lib/settlement-suggestions'
import {
  expandProfileIdsForSplitMatching,
  fetchRemoteProfileIntoDexie,
  participantUnionForBill,
} from '@/lib/people'

/**
 * Commit a mutation's complete rows cloud-first, deriving the offline staging from the payload.
 *
 * Every row in the payload is a whole record, so staging is just a bulkPut per table — there is
 * no need for each operation to hand-write its own local transaction. Online, nothing is written
 * until the server confirms; offline, the rows are staged and queued for replay.
 */
async function commitRows(input: {
  actorUserId: string
  payload: CloudWritePayload
  pending: {
    operation: string
    entityType: MutationEntityType
    entityId: string | null
    payload: unknown
    routeHint: string
  }
}): Promise<{ mode: 'cloud' | 'queued' }> {
  const tables = (Object.keys(input.payload) as (keyof CloudWritePayload)[]).filter(
    (t) => (input.payload[t]?.length ?? 0) > 0,
  )

  return commitCloudFirstWrite({
    actorUserId: input.actorUserId,
    payload: input.payload,
    stageOffline: async () => {
      await db.transaction(
        'rw',
        tables.map((t) => db[t]),
        async () => {
          for (const t of tables) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (db[t] as any).bulkPut(input.payload[t])
          }
        },
      )
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: input.actorUserId,
        operation: input.pending.operation,
        entityType: input.pending.entityType,
        entityId: input.pending.entityId,
        payload: input.pending.payload,
        routeHint: input.pending.routeHint,
      })
    },
  })
}

/** Group membership must use the Kwenta account id so Postgres RLS and sync match `auth.uid()`. */
function membershipUserIdForProfile(p: { id: string; linked_profile_id: string | null }): string {
  return p.linked_profile_id ?? p.id
}

/**
 * Resolve a chosen profile id to the canonical group_members.user_id for a group.
 * The group roster is the single source of identity truth: every shared group row
 * (item_splits.user_id, bills.paid_by, settlements.from/to_user_id) must reference a
 * roster user_id, never a device-private local-contact id. Two devices that each track
 * the same person as their own local contact would otherwise push divergent ids into
 * the shared dataset, producing different balances/suggestions for the same group.
 *
 * Precedence (strongest identity first):
 *   1. chosenProfileId is already a member user_id
 *   2. chosen.linked_profile_id is a member user_id
 *   3. a member whose profile.linked_profile_id === chosenProfileId
 *   4. a member matched by non-empty normalized email
 *   5. no match -> chosenProfileId unchanged
 *
 * Matching is restricted to EXACT identity signals (id, account link, email). Display-name
 * matching is deliberately NOT used here: two distinct people can share a name within one
 * group, and silently rewriting a split/payer/settlement to a same-named member would
 * mis-attribute money with no way for the user to notice. (The historical data-repair in
 * migration 043 offers an equivalent name match, but only behind an operator-gated,
 * reviewable dry-run flag — never on the live write path.)
 */
export async function resolveGroupMemberUserId(
  groupId: string,
  chosenProfileId: string,
): Promise<string> {
  const members = (await db.group_members.where('group_id').equals(groupId).toArray()).filter(
    (m) => !m.is_deleted,
  )
  if (members.length === 0) return chosenProfileId

  const memberIds = new Set(members.map((m) => m.user_id))
  if (memberIds.has(chosenProfileId)) return chosenProfileId // (1)

  const chosen = await db.profiles.get(chosenProfileId)
  if (chosen?.linked_profile_id && memberIds.has(chosen.linked_profile_id)) {
    return chosen.linked_profile_id // (2)
  }

  // Load member profiles once for the remaining checks.
  const memberProfiles = new Map<string, Profile | undefined>()
  for (const m of members) {
    memberProfiles.set(m.user_id, await db.profiles.get(m.user_id))
  }

  for (const m of members) {
    const mp = memberProfiles.get(m.user_id)
    if (mp && !mp.is_deleted && mp.linked_profile_id === chosenProfileId) return m.user_id // (3)
  }

  const chosenEmail = (chosen?.email ?? '').trim().toLowerCase()
  if (chosenEmail) {
    for (const m of members) {
      const mp = memberProfiles.get(m.user_id)
      const memberEmail = (mp?.email ?? '').trim().toLowerCase()
      if (memberEmail && memberEmail === chosenEmail) return m.user_id // (4)
    }
  }

  return chosenProfileId // (5) no exact-identity match
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
export async function resolveSettlementPartyId(id: string): Promise<string> {
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
  paidBy?: string
  note: string
  category?: string | null
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

  // Resolve chosen ids to the canonical group roster member id BEFORE the transaction
  // (group_members/profiles are out of the transaction scope below). Personal bills
  // (groupId === null) resolve to no-ops, leaving ids unchanged.
  const groupId = input.groupId
  let resolvedPaidBy = input.paidBy ?? input.createdBy
  const resolvedSplitUserId = new Map<string, string>()
  if (groupId) {
    resolvedPaidBy = await resolveGroupMemberUserId(groupId, resolvedPaidBy)
    const distinctSplitIds = new Set<string>()
    for (const item of input.items) {
      for (const sp of item.splits) distinctSplitIds.add(sp.userId)
    }
    for (const uid of distinctSplitIds) {
      resolvedSplitUserId.set(uid, await resolveGroupMemberUserId(groupId, uid))
    }

    // Restrict group-bill participants to roster members. The add-bill UI only
    // offers current members, so this never fires for UI-created bills; it is a
    // backstop that keeps a non-member (orphan local-contact) id out of
    // item_splits.user_id / bills.paid_by. Such an id is invisible to every
    // other member (pull-bundle privacy boundary) and renders as "Unknown" in
    // balances and settle-up. Adding someone new must go through the group roster.
    const memberIds = new Set(
      (await db.group_members.where('group_id').equals(groupId).toArray())
        .filter((m) => !m.is_deleted)
        .map((m) => m.user_id),
    )
    const offenders = [...new Set([resolvedPaidBy, ...resolvedSplitUserId.values()])].filter(
      (id) => !memberIds.has(id),
    )
    if (offenders.length > 0) {
      throw new Error(
        `Cannot create a group bill with non-member participant(s): ${offenders.join(', ')}. Add them to the group first.`,
      )
    }
  }

  const totalAmount = input.items.reduce((sum, item) => {
    if (item.splits.length > 0 && item.splits[0].splitType === 'quantity') {
      const computed = computeSplits(item.amount, item.splits as SplitInput[])
      return sum + computed.reduce((s, r) => s + r.computedAmount, 0)
    }
    return sum + item.amount
  }, 0)

  // BUILD — pure, in memory. Nothing touches Dexie until the server has accepted these rows
  // (or we know we are offline). See `commitCloudFirstWrite`.
  const bill: Bill = {
    ...syncFields({ id: billId }),
    title: input.title,
    group_id: input.groupId,
    currency: input.currency,
    created_by: input.createdBy,
    paid_by: resolvedPaidBy,
    total_amount: totalAmount,
    note: input.note,
    category: input.category ?? null,
  }

  const billItems: BillItem[] = []
  const itemSplits: ItemSplit[] = []
  for (const item of input.items) {
    const itemId = generateId()
    billItems.push({
      ...syncFields({ id: itemId }),
      bill_id: billId,
      name: item.name,
      amount: item.amount,
    })
    if (item.splits.length === 0) continue
    const computed = computeSplits(item.amount, item.splits as SplitInput[])
    for (let i = 0; i < item.splits.length; i++) {
      itemSplits.push({
        ...syncFields(),
        item_id: itemId,
        user_id: resolvedSplitUserId.get(item.splits[i].userId) ?? item.splits[i].userId,
        split_type: item.splits[i].splitType,
        split_value: item.splits[i].splitValue,
        computed_amount: computed[i].computedAmount,
      })
    }
  }

  const activity = {
    ...syncFields(),
    group_id: input.groupId,
    user_id: input.createdBy,
    action: 'created' as const,
    entity_type: 'bill' as const,
    entity_id: billId,
    description: `Created bill "${input.title}"`,
  }

  const payload: CloudWritePayload = {
    bills: [bill],
    bill_items: billItems,
    item_splits: itemSplits,
    activity_log: [activity],
  }

  // COMMIT — cloud first. A rejection throws here and leaves Dexie untouched, so a failed
  // save cannot leave a bill on screen that the user retries into a duplicate.
  await commitCloudFirstWrite({
    actorUserId: input.createdBy,
    payload,
    stageOffline: async () => {
      await db.transaction(
        'rw',
        [db.bills, db.bill_items, db.item_splits, db.activity_log],
        async () => {
          await db.bills.add(bill)
          if (billItems.length > 0) await db.bill_items.bulkAdd(billItems)
          if (itemSplits.length > 0) await db.item_splits.bulkAdd(itemSplits)
          await db.activity_log.add(activity)
        },
      )
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: input.createdBy,
        operation: 'create_bill',
        entityType: 'bill',
        entityId: billId,
        payload: { title: input.title, groupId: input.groupId },
        routeHint: input.groupId ? `/app/groups/${input.groupId}` : '/app/bills',
      })
    },
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

  // No post-write sync call: `commitCloudFirstWrite` above already round-tripped through the
  // server (online) or queued for replay (offline). Calling finalizeMutationSync here would
  // push a second time for the same mutation.

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

/**
 * Complete rows for soft-deleting a bill's live items and their splits.
 *
 * Shared by updateBill (which replaces the line items) and deleteBill. Returns whole rows
 * rather than patches because the server upsert takes full records — and because the same
 * rows have to be stage-able locally on the offline path.
 *
 * `updated_at` is bumped without clearing `synced_at`: a row counts as unsynced when
 * `updated_at > synced_at`, so this marks the change for push exactly as the previous
 * per-row `update()` calls did.
 */
async function buildBillChildSoftDeletes(
  billId: string,
  timestamp: string,
): Promise<{ items: BillItem[]; splits: ItemSplit[] }> {
  const items: BillItem[] = []
  const splits: ItemSplit[] = []
  const existingItems = await db.bill_items.where('bill_id').equals(billId).toArray()
  for (const item of existingItems) {
    if (item.is_deleted) continue
    items.push({ ...item, is_deleted: true, updated_at: timestamp })
    const itemSplits = await db.item_splits.where('item_id').equals(item.id).toArray()
    for (const s of itemSplits) {
      if (s.is_deleted) continue
      splits.push({ ...s, is_deleted: true, updated_at: timestamp })
    }
  }
  return { items, splits }
}

export async function updateBill(
  billId: string,
  editorUserId: string,
  patch: {
    title: string
    note: string
    currency: string
    paidBy?: string
    category?: string | null
    items: UpdateBillItemsInput
  },
): Promise<void> {
  const timestamp = now()
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return
  if (bill.created_by !== editorUserId) return

  // Resolve chosen ids to roster member ids before the transaction (see createBill).
  const groupId = bill.group_id
  let resolvedPaidBy = patch.paidBy
  const resolvedSplitUserId = new Map<string, string>()
  if (groupId) {
    if (patch.paidBy !== undefined) {
      resolvedPaidBy = await resolveGroupMemberUserId(groupId, patch.paidBy)
    }
    const distinctSplitIds = new Set<string>()
    for (const item of patch.items) {
      for (const sp of item.splits) distinctSplitIds.add(sp.userId)
    }
    for (const uid of distinctSplitIds) {
      resolvedSplitUserId.set(uid, await resolveGroupMemberUserId(groupId, uid))
    }
  }

  const totalAmount = patch.items.reduce((sum, item) => {
    if (item.splits.length > 0 && item.splits[0].splitType === 'quantity') {
      const computed = computeSplits(item.amount, item.splits as SplitInput[])
      return sum + computed.reduce((s, r) => s + r.computedAmount, 0)
    }
    return sum + item.amount
  }, 0)

  // BUILD — the replaced items/splits are soft-deleted and the new ones created. The upsert
  // needs COMPLETE rows, so each change is expressed as a whole row rather than a patch.
  const { items: retiredItems, splits: retiredSplits } = await buildBillChildSoftDeletes(
    billId,
    timestamp,
  )

  const updatedBill: Bill = {
    ...bill,
    title: patch.title,
    note: patch.note,
    currency: patch.currency,
    ...(resolvedPaidBy !== undefined && { paid_by: resolvedPaidBy }),
    category: patch.category ?? null,
    total_amount: totalAmount,
    updated_at: timestamp,
    synced_at: null,
  }

  const newItems: BillItem[] = []
  const newSplits: ItemSplit[] = []
  for (const item of patch.items) {
    const itemId = generateId()
    newItems.push({
      ...syncFields({ id: itemId }),
      bill_id: billId,
      name: item.name,
      amount: item.amount,
    })
    if (item.splits.length === 0) continue
    const computed = computeSplits(item.amount, item.splits as SplitInput[])
    for (let i = 0; i < item.splits.length; i++) {
      newSplits.push({
        ...syncFields(),
        item_id: itemId,
        user_id: resolvedSplitUserId.get(item.splits[i].userId) ?? item.splits[i].userId,
        split_type: item.splits[i].splitType,
        split_value: item.splits[i].splitValue,
        computed_amount: computed[i].computedAmount,
      })
    }
  }

  const activity = {
    ...syncFields(),
    group_id: bill.group_id,
    user_id: editorUserId,
    action: 'updated' as const,
    entity_type: 'bill' as const,
    entity_id: billId,
    description: `Updated bill "${patch.title}"`,
  }

  const billItemRows = [...retiredItems, ...newItems]
  const itemSplitRows = [...retiredSplits, ...newSplits]

  await commitCloudFirstWrite({
    actorUserId: editorUserId,
    payload: {
      bills: [updatedBill],
      bill_items: billItemRows,
      item_splits: itemSplitRows,
      activity_log: [activity],
    },
    stageOffline: async () => {
      await db.transaction(
        'rw',
        [db.bills, db.bill_items, db.item_splits, db.activity_log],
        async () => {
          await db.bills.put(updatedBill)
          if (billItemRows.length > 0) await db.bill_items.bulkPut(billItemRows)
          if (itemSplitRows.length > 0) await db.item_splits.bulkPut(itemSplitRows)
          await db.activity_log.add(activity)
        },
      )
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: editorUserId,
        operation: 'update_bill',
        entityType: 'bill',
        entityId: billId,
        payload: { title: patch.title, currency: patch.currency, groupId: bill.group_id },
        routeHint: bill.group_id ? `/app/groups/${bill.group_id}` : `/app/bills/${billId}`,
      })
    },
  })
}

export async function deleteBill(
  billId: string,
  userId: string,
  options?: { collect?: MutationRowCollector },
) {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return
  if (bill.created_by !== userId) return

  const timestamp = now()

  const deletedBill: Bill = { ...bill, is_deleted: true, updated_at: timestamp }
  const { items, splits } = await buildBillChildSoftDeletes(billId, timestamp)
  const activity = {
    ...syncFields(),
    group_id: bill.group_id,
    user_id: userId,
    action: 'deleted' as const,
    entity_type: 'bill' as const,
    entity_id: billId,
    description: `Deleted bill "${bill.title}"`,
  }

  // A cascade (deletePerson, deleteGroup) collects these rows and submits the whole cascade in
  // one round trip, so nothing is written or sent here.
  if (options?.collect) {
    options.collect.bills.push(deletedBill)
    options.collect.bill_items.push(...items)
    options.collect.item_splits.push(...splits)
    options.collect.activity_log.push(activity)
    return
  }

  await commitCloudFirstWrite({
    actorUserId: userId,
    payload: {
      bills: [deletedBill],
      bill_items: items,
      item_splits: splits,
      activity_log: [activity],
    },
    stageOffline: async () => {
      await db.transaction(
        'rw',
        [db.bills, db.bill_items, db.item_splits, db.activity_log],
        async () => {
          await db.bills.put(deletedBill)
          if (items.length > 0) await db.bill_items.bulkPut(items)
          if (splits.length > 0) await db.item_splits.bulkPut(splits)
          await db.activity_log.add(activity)
        },
      )
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: userId,
        operation: 'delete_bill',
        entityType: 'bill',
        entityId: billId,
        payload: { title: bill.title, groupId: bill.group_id },
        routeHint: bill.group_id ? `/app/groups/${bill.group_id}` : '/app/bills',
      })
    },
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

  const creatorProfile = await db.profiles.get(createdBy)

  const group: Group = {
    ...syncFields({ id: groupId }),
    name,
    currency,
    created_by: createdBy,
    invite_code: inviteCode,
  }
  const member: GroupMember = {
    ...syncFields(),
    group_id: groupId,
    user_id: createdBy,
    display_name: creatorProfile?.display_name ?? createdBy,
    joined_at: now(),
  }

  await commitRows({
    actorUserId: createdBy,
    payload: {
      groups: [group],
      group_members: [member],
      activity_log: [
        {
          ...syncFields(),
          group_id: groupId,
          user_id: createdBy,
          action: 'created',
          entity_type: 'group',
          entity_id: groupId,
          description: `Created group "${name}"`,
        },
      ],
    },
    pending: {
      operation: 'create_group',
      entityType: 'group',
      entityId: groupId,
      payload: { name, currency },
      routeHint: `/app/groups/${groupId}`,
    },
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

  await commitRows({
    actorUserId: userId,
    payload: {
      groups: [
        { ...group, name: nextName, currency: nextCurrency, updated_at: timestamp, synced_at: null },
      ],
      activity_log: [
        {
          ...syncFields(),
          group_id: groupId,
          user_id: userId,
          action: 'updated',
          entity_type: 'group',
          entity_id: groupId,
          description: `Updated group "${nextName}"`,
        },
      ],
    },
    pending: {
      operation: 'update_group',
      entityType: 'group',
      entityId: groupId,
      payload: { name: nextName, currency: nextCurrency },
      routeHint: `/app/groups/${groupId}`,
    },
  })
}

export async function addGroupMember(
  groupId: string,
  displayName: string,
  addedBy: string,
): Promise<string> {
  const targetGroup = await db.groups.get(groupId)
  if (!targetGroup || targetGroup.is_deleted) throw new Error('Group not found')
  if (targetGroup.created_by !== addedBy) {
    throw new Error('Only the group creator can add members.')
  }

  const trimmed = displayName.trim()
  const normalized = trimmed.toLowerCase()

  const existingMembership = await db.group_members
    .where('group_id')
    .equals(groupId)
    .filter((m) => !m.is_deleted)
    .toArray()
  for (const m of existingMembership) {
    const p = await db.profiles.get(m.user_id)
    // A real co-member's profile row may be absent here (pull-bundle privacy
    // boundary). Fall back to the synced group_members.display_name so we reuse
    // the existing member instead of minting a duplicate local contact.
    const memberName = ((p && !p.is_deleted ? p.display_name : m.display_name) || '').trim().toLowerCase()
    // Already a member — nothing is written, so there is nothing to submit.
    if (memberName === normalized) return m.user_id
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
    // Already a member — nothing is written, so there is nothing to submit.
    if (already && !already.is_deleted) return userId
  }

  const memberId = generateId()

  // A brand-new contact and their membership row are built together and submitted as one unit:
  // a membership pointing at a profile the server never stored would render as "Unknown".
  const newProfiles: Profile[] = []
  if (!userId) {
    userId = generateId()
    newProfiles.push({
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

  const existing = newProfiles[0] ?? (await db.profiles.get(userId))
  const memberRowUserId = existing ? membershipUserIdForProfile(existing) : userId
  const member: GroupMember = {
    ...syncFields({ id: memberId }),
    group_id: groupId,
    user_id: memberRowUserId,
    display_name: existing?.display_name ?? trimmed,
    joined_at: now(),
  }

  await commitRows({
    actorUserId: addedBy,
    payload: {
      ...(newProfiles.length > 0 && { profiles: newProfiles }),
      group_members: [member],
      activity_log: [
        {
          ...syncFields(),
          group_id: groupId,
          user_id: addedBy,
          action: 'created',
          entity_type: 'group',
          entity_id: memberId,
          description: `Added "${existing?.display_name ?? trimmed}" to group`,
        },
      ],
    },
    pending: {
      operation: 'add_group_member',
      entityType: 'group_member',
      entityId: memberId,
      payload: { groupId, memberUserId: memberRowUserId },
      routeHint: `/app/groups/${groupId}`,
    },
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
  await commitRows({
    actorUserId: ownerUserId,
    payload: {
      profiles: [
        {
          ...syncFields({ id: userId }),
          email: '',
          display_name: trimmed,
          avatar_url: null,
          user_type: 'user',
          account_status: 'active',
          is_local: true,
          linked_profile_id: null,
          owner_id: ownerUserId,
        },
      ],
    },
    pending: {
      operation: 'create_local_profile',
      entityType: 'profile',
      entityId: userId,
      payload: { displayName: trimmed },
      routeHint: `/app/people/${userId}`,
    },
  })
  return { outcome: 'created', id: userId }
}

/** Add someone who already exists in your phonebook or groups (by profile id). */
export async function addExistingGroupMember(
  groupId: string,
  memberUserId: string,
  addedBy: string,
): Promise<void> {
  const targetGroup = await db.groups.get(groupId)
  if (!targetGroup || targetGroup.is_deleted) throw new Error('Group not found')
  if (targetGroup.created_by !== addedBy) {
    throw new Error('Only the group creator can add members.')
  }

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
    // Already a member — nothing is written, so there is nothing to submit.
    return
  }

  await fetchRemoteProfileIntoDexie(memberRowUserId)

  const memberId = generateId()
  await commitRows({
    actorUserId: addedBy,
    payload: {
      group_members: [
        {
          ...syncFields({ id: memberId }),
          group_id: groupId,
          user_id: memberRowUserId,
          display_name: p.display_name,
          joined_at: now(),
        },
      ],
      activity_log: [
        {
          ...syncFields(),
          group_id: groupId,
          user_id: addedBy,
          action: 'created',
          entity_type: 'group',
          entity_id: memberId,
          description: `Added "${p.display_name}" to group`,
        },
      ],
    },
    pending: {
      operation: 'add_group_member',
      entityType: 'group_member',
      entityId: memberId,
      payload: { groupId, memberUserId: memberRowUserId },
      routeHint: `/app/groups/${groupId}`,
    },
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
}

/** Point a local contact at a synced account (for display & future migration). */
export async function linkProfileToRemote(
  localProfileId: string,
  remoteProfileId: string,
  actorUserId: string,
): Promise<{ mode: 'cloud' | 'queued' }> {
  // These used to `return` silently. A link that does nothing and says nothing is indistinguishable
  // from one that worked, and the consequence is not cosmetic: the People list is the SERVER's
  // answer, and the server collapses a contact into its account only when it can see
  // `linked_profile_id` — so a link that never happened leaves the same person on screen twice,
  // with nothing to explain why. Each guard now says which one it is.
  const local = await db.profiles.get(localProfileId)
  const remote = await db.profiles.get(remoteProfileId)
  if (!local || local.is_deleted) {
    throw new Error('That contact no longer exists on this device.')
  }
  if (!remote || remote.is_deleted) {
    throw new Error(
      'Could not load that account’s profile. Check your connection, or make sure you share a group with them.',
    )
  }
  if (local.id === remote.id) {
    throw new Error('That’s the same record — pick the other person’s account.')
  }
  if (remoteProfileId === actorUserId) {
    throw new Error('You can’t link a contact to your own Kwenta account.')
  }
  if (local.owner_id !== actorUserId || !local.is_local) {
    throw new Error('Only your own local contacts can be linked to an account.')
  }
  if (!remote.email?.trim()) {
    throw new Error('That profile has no email — only signed-in accounts can be linked.')
  }

  const timestamp = now()

  // The link and EVERY id rewrite it implies go in one submission. Landing only some of them
  // is the failure that produces "Unknown" people and wrong balances: a membership rewritten
  // to the remote id while the splits still carry the local id (or the reverse) leaves the two
  // sides of the same person disagreeing on every device.
  const collect = newRowCollector()

  collect.profiles.push({
    ...local,
    linked_profile_id: remoteProfileId,
    updated_at: timestamp,
    synced_at: null,
  })

  const memberships = await db.group_members.where('user_id').equals(localProfileId).toArray()
  for (const m of memberships) {
    if (m.is_deleted) continue
    collect.group_members.push({
      ...m,
      user_id: remoteProfileId,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  // PROFILE ID REWRITE — all Dexie fields that store a profile ID must be rewritten
  // here from localProfileId → remoteProfileId. If you add a new table/field that
  // stores a user/profile ID, add it to this list.
  //
  // Covered:
  //   group_members.user_id     — immediate rewrite (membership must match server auth.uid)
  //   item_splits.user_id       — immediate rewrite (pull filter checks ish.user_id = auth.uid)
  //   bills.paid_by             — immediate rewrite (payer credit in kwenta_group_pairwise, 053)
  //   settlements.from_user_id  — immediate rewrite (personal settlement RLS check)
  //   settlements.to_user_id    — immediate rewrite (personal settlement RLS check)
  //
  // NOT covered (by design):
  //   bills.created_by          — always the logged-in actor; local contacts can't create bills
  //   groups.created_by         — always the logged-in actor; local contacts can't create groups
  //   activity_log.user_id      — always the logged-in actor; local contacts can't perform actions
  //   profile_peer_links        — peer links become redundant after hard-link; expandProfileIds handles both

  const splits = await db.item_splits.where('user_id').equals(localProfileId).toArray()
  for (const split of splits) {
    if (split.is_deleted) continue
    collect.item_splits.push({
      ...split,
      user_id: remoteProfileId,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  // Rewrite bills.paid_by from the local contact to the remote profile so the linked account is
  // credited correctly as payer by `kwenta_group_pairwise` (migration 053). Without this the
  // server keeps paid_by = localProfileId and the payer shows as "Unknown" on User B's device
  // (their profile is not visible due to the privacy boundary).
  const allBills = await db.bills.toArray()
  for (const bill of allBills) {
    if (bill.is_deleted || bill.paid_by !== localProfileId) continue
    collect.bills.push({
      ...bill,
      paid_by: remoteProfileId,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  // Mark settlements where the local contact is a party as unsynced.
  // resolveSettlementPartyIdForPush rewrites from/to_user_id at push time;
  // we also update Dexie immediately so local display is correct before the push.
  const fromSettlements = await db.settlements.where('from_user_id').equals(localProfileId).toArray()
  const toSettlements = await db.settlements.where('to_user_id').equals(localProfileId).toArray()
  const seenSettlementIds = new Set<string>()
  for (const s of [...fromSettlements, ...toSettlements]) {
    if (s.is_deleted || seenSettlementIds.has(s.id)) continue
    seenSettlementIds.add(s.id)
    collect.settlements.push({
      ...s,
      ...(s.from_user_id === localProfileId ? { from_user_id: remoteProfileId } : {}),
      ...(s.to_user_id === localProfileId ? { to_user_id: remoteProfileId } : {}),
      updated_at: timestamp,
      synced_at: null,
    })
  }

  const { mode } = await commitRows({
    actorUserId,
    payload: collectorToPayload(collect),
    pending: {
      operation: 'link_profile',
      entityType: 'profile',
      entityId: localProfileId,
      payload: { remoteProfileId },
      routeHint: `/app/people/${localProfileId}`,
    },
  })

  // Notify only after the link is committed — telling someone they were linked to an account
  // when the write was rejected would be a lie the other device cannot verify.
  const actor = await db.profiles.get(actorUserId)
  void notifyProfileLinked({
    actorId: actorUserId,
    actorName: actor?.display_name?.trim() || 'Someone',
    recipientId: remoteProfileId,
    linkedAsName: local.display_name,
  })

  // 'queued' means the link exists on THIS device only. That is the state that shows the person
  // twice on /app/people, because the server cannot collapse a pair whose link it has not been
  // told about — so the caller has to be able to say so rather than report a plain success.
  return { mode }
}

/**
 * Resolve a duplicate identity by merging a viewer-owned local contact into the
 * person it actually is. This rewrites the synced rows (the only mechanism that
 * converges balances/suggestions for every group member — see the comment in
 * `src/lib/settlement.ts`).
 *
 * - Target is a real account (has an email): hard-link via `linkProfileToRemote`,
 *   which rewrites `group_members.user_id`, `item_splits.user_id`, `bills.paid_by`,
 *   and `settlements.from/to_user_id` and re-syncs.
 * - Target is another of the viewer's local contacts: record a manual peer link so
 *   balance helpers treat them as one person (no remote id to rewrite to).
 *
 * The target's profile may not be in Dexie yet (pull-bundle privacy boundary), so
 * we fetch it first. No-ops if `sourceLocalId` is not a local contact owned by the
 * actor.
 */
export async function mergeProfileIdentity(
  sourceLocalId: string,
  targetId: string,
  actorUserId: string,
): Promise<void> {
  if (sourceLocalId === targetId) return
  const source = await db.profiles.get(sourceLocalId)
  if (!source || source.is_deleted || !source.is_local || source.owner_id !== actorUserId) return
  if (source.linked_profile_id) return // already resolved

  let target = await db.profiles.get(targetId)
  if (!target || target.is_deleted) {
    await fetchRemoteProfileIntoDexie(targetId)
    target = await db.profiles.get(targetId)
  }

  // Real account → hard-link (rewrites + re-syncs the shared rows).
  if (target && !target.is_deleted && !target.is_local && target.email?.trim()) {
    await linkProfileToRemote(sourceLocalId, targetId, actorUserId)
    return
  }

  // Otherwise treat them as the same person via a manual peer link.
  await addProfilePeerLink(sourceLocalId, targetId, actorUserId)
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
  await commitRows({
    actorUserId,
    payload: { profile_peer_links: [row] },
    pending: {
      operation: 'add_profile_peer_link',
      entityType: 'profile_peer_link',
      entityId: row.id,
      payload: { anchorLocalId, peerProfileId },
      routeHint: `/app/people/${anchorLocalId}`,
    },
  })
}

export async function removeProfilePeerLink(linkId: string, actorUserId: string): Promise<void> {
  const row = await db.profile_peer_links.get(linkId)
  if (!row || row.is_deleted || row.owner_user_id !== actorUserId) return
  const anchor = await db.profiles.get(row.anchor_profile_id)
  const isPrimaryAccountLink = Boolean(anchor?.linked_profile_id && anchor.linked_profile_id === row.peer_profile_id)
  if (isPrimaryAccountLink) return

  const timestamp = now()
  await commitRows({
    actorUserId,
    payload: {
      profile_peer_links: [{ ...row, is_deleted: true, updated_at: timestamp, synced_at: null }],
    },
    pending: {
      operation: 'remove_profile_peer_link',
      entityType: 'profile_peer_link',
      entityId: linkId,
      payload: { anchorLocalId: row.anchor_profile_id, peerProfileId: row.peer_profile_id },
      routeHint: `/app/people/${row.anchor_profile_id}`,
    },
  })
}

export async function removeGroupMember(
  groupId: string,
  memberUserId: string,
  removedBy: string,
  options?: { force?: boolean; collect?: MutationRowCollector },
): Promise<void> {
  const group = await db.groups.get(groupId)
  if (!group || group.is_deleted) return
  if (!options?.force && group.created_by !== removedBy) {
    throw new Error('Only the group creator can remove members.')
  }

  const allMembers = await db.group_members.where('group_id').equals(groupId).toArray()
  const membership = allMembers.find((m) => m.user_id === memberUserId && !m.is_deleted)
  if (!membership) return

  // Block removal unless fully settled (owes no one and is owed by no one).
  //
  // Refuses rather than skipping when the answer is unavailable: stranding an unsettled member's
  // debt is not something the user would notice, so an unchecked removal is worse than a blocked
  // one. (The payment cap below makes the opposite call, for the opposite reason.)
  if (!options?.force) {
    // Catches a refusal (ServerDeclinedError) as well as a transport failure: both mean the
    // balance is unknown, and an unchecked removal strands the debt on a roster row nobody can
    // settle. Before, a refusal resolved to null and short-circuited the check to false.
    const breakdown = await loadGroupMemberBreakdownFresh(groupId, memberUserId).catch(() => {
      throw new Error('Could not check this member’s balance. Reconnect and try again.')
    })
    if (breakdown.pays.length > 0 || breakdown.receives.length > 0) {
      throw new Error(
        'This member still has an outstanding balance. Settle up before removing them.',
      )
    }
  }

  const profile = await db.profiles.get(memberUserId)
  const displayName = profile?.display_name ?? membership.display_name
  const timestamp = now()

  // Soft-delete the membership ONLY. Past bills/splits are preserved (no redistribution),
  // so historical balances and names stay intact.
  const removedMembership: GroupMember = {
    ...membership,
    is_deleted: true,
    updated_at: timestamp,
    synced_at: null,
  }
  const removalActivity: ActivityLog = {
    ...syncFields(),
    group_id: groupId,
    user_id: removedBy,
    action: 'deleted',
    entity_type: 'group',
    entity_id: membership.id,
    description: `Removed "${displayName}" from group`,
  }

  if (options?.collect) {
    options.collect.group_members.push(removedMembership)
    options.collect.activity_log.push(removalActivity)
    return
  }
  await commitRows({
    actorUserId: removedBy,
    payload: { group_members: [removedMembership], activity_log: [removalActivity] },
    pending: {
      operation: 'remove_group_member',
      entityType: 'group_member',
      entityId: memberUserId,
      payload: { groupId, memberUserId },
      routeHint: `/app/groups/${groupId}`,
    },
  })
}

/**
 * Remove a person from all personal (non-group) bills.
 * - If the bill only involves you and them (no other participants), soft-delete the whole bill.
 * - Otherwise remove their splits and redistribute equal splits among remaining people (same as group removal).
 */
async function removePersonFromPersonalBills(
  memberUserId: string,
  removedBy: string,
  collect: MutationRowCollector,
): Promise<void> {
  const actorId = removedBy
  const allPersonal = await db.bills
    .filter((b) => !b.is_deleted && (b.group_id === null || b.group_id === undefined))
    .toArray()

  // Bills that involve only you two are removed outright; their rows join the cascade.
  const deletedBillIds = new Set<string>()
  for (const bill of allPersonal) {
    const union = await participantUnionForBill(bill.id)
    if (!union.has(memberUserId)) continue

    const othersBesidesYouTwo = [...union].filter((id) => id !== actorId && id !== memberUserId)
    if (othersBesidesYouTwo.length === 0) {
      await deleteBill(bill.id, actorId, { collect })
      deletedBillIds.add(bill.id)
    }
  }

  const timestamp = now()

  // Bills with other participants keep existing: drop this person's split and redistribute an
  // equal split across whoever is left. Skip bills already deleted above so the same split is
  // not queued twice with different states.
  for (const bill of allPersonal) {
    if (deletedBillIds.has(bill.id)) continue
    const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
    for (const item of items) {
      if (item.is_deleted) continue
      const splits = await db.item_splits.where('item_id').equals(item.id).toArray()
      const activeSplits = splits.filter((s) => !s.is_deleted)
      const memberSplit = activeSplits.find((s) => s.user_id === memberUserId)
      if (!memberSplit) continue

      collect.item_splits.push({ ...memberSplit, is_deleted: true, updated_at: timestamp })

      const remaining = activeSplits.filter((s) => s.user_id !== memberUserId)
      if (memberSplit.split_type === 'equal' && remaining.length > 0) {
        // floor-to-cent + remainder-to-first so splits sum to item.amount exactly.
        const base = Math.floor((item.amount / remaining.length) * 100) / 100
        const cents = Math.round((item.amount - base * remaining.length) * 100) / 100
        for (let i = 0; i < remaining.length; i++) {
          collect.item_splits.push({
            ...remaining[i],
            computed_amount: i === 0 ? base + cents : base,
            updated_at: timestamp,
            synced_at: null,
          })
        }
      }
    }
  }

  collect.activity_log.push({
    ...syncFields(),
    group_id: null,
    user_id: removedBy,
    action: 'deleted',
    entity_type: 'bill',
    entity_id: memberUserId,
    description:
      'Removed contact from personal bills (bills only between you two were deleted; other bills had their splits updated)',
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

  // Gather the WHOLE cascade — memberships, personal bills and splits, payments, peer links and
  // the profile itself — then submit it as one unit. Deleting a person is the widest write in
  // the app; landing it partly would leave memberships pointing at a profile that is gone, or
  // payments referencing a contact that no longer exists.
  const collect = newRowCollector()

  const memberships = await db.group_members.where('user_id').equals(personId).toArray()
  const groupIds = [...new Set(memberships.filter((m) => !m.is_deleted).map((m) => m.group_id))]

  for (const gid of groupIds) {
    await removeGroupMember(gid, personId, actorUserId, { collect, force: true })
  }

  await removePersonFromPersonalBills(personId, actorUserId, collect)

  const settlements = await db.settlements
    .filter((s) => !s.is_deleted && (s.from_user_id === personId || s.to_user_id === personId))
    .toArray()
  for (const s of settlements) {
    await deleteSettlement(s.id, actorUserId, { collect })
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
    collect.profile_peer_links.push({
      ...l,
      is_deleted: true,
      updated_at: timestamp,
      synced_at: null,
    })
  }

  collect.profiles.push({ ...p, is_deleted: true, updated_at: timestamp, synced_at: null })

  collect.activity_log.push({
    ...syncFields(),
    group_id: null,
    user_id: actorUserId,
    action: 'deleted',
    entity_type: 'group',
    entity_id: personId,
    description: `Removed contact "${displayName}"`,
  })

  await commitRows({
    actorUserId,
    payload: collectorToPayload(collect),
    pending: {
      operation: 'delete_person',
      entityType: 'profile',
      entityId: personId,
      payload: { personId },
      routeHint: '/app/people',
    },
  })
}

export async function deleteGroup(groupId: string, userId: string) {
  const group = await db.groups.get(groupId)
  if (!group) return
  if (group.created_by !== userId) return

  const timestamp = now()

  // BUILD the whole cascade — group, memberships, bills, their items and splits, and the
  // group's settlements — then submit it as ONE unit. A partially-applied group deletion is
  // especially bad: a bill whose group row is gone renders nowhere but still moves balances.
  const deletedBills: Bill[] = []
  const deletedItems: BillItem[] = []
  const deletedSplits: ItemSplit[] = []
  const groupBills = await db.bills.where('group_id').equals(groupId).toArray()
  for (const bill of groupBills) {
    if (bill.is_deleted) continue
    deletedBills.push({ ...bill, is_deleted: true, updated_at: timestamp })
    const children = await buildBillChildSoftDeletes(bill.id, timestamp)
    deletedItems.push(...children.items)
    deletedSplits.push(...children.splits)
  }

  const groupSettlements = (await db.settlements.where('group_id').equals(groupId).toArray())
    .filter((s) => !s.is_deleted)
    .map((s) => ({ ...s, is_deleted: true, updated_at: timestamp, synced_at: null }))

  const members = (await db.group_members.where('group_id').equals(groupId).toArray()).map((m) => ({
    ...m,
    is_deleted: true,
    updated_at: timestamp,
  }))

  await commitRows({
    actorUserId: userId,
    payload: {
      groups: [{ ...group, is_deleted: true, updated_at: timestamp }],
      ...(members.length > 0 && { group_members: members }),
      ...(deletedBills.length > 0 && { bills: deletedBills }),
      ...(deletedItems.length > 0 && { bill_items: deletedItems }),
      ...(deletedSplits.length > 0 && { item_splits: deletedSplits }),
      ...(groupSettlements.length > 0 && { settlements: groupSettlements }),
      activity_log: [
        {
          ...syncFields(),
          group_id: groupId,
          user_id: userId,
          action: 'deleted',
          entity_type: 'group',
          entity_id: groupId,
          description: `Deleted group "${group.name}"`,
        },
      ],
    },
    pending: {
      operation: 'delete_group',
      entityType: 'group',
      entityId: groupId,
      payload: { groupId },
      routeHint: '/app/groups',
    },
  })
}

// ── Settlements ─────────────────────────────────────

/**
 * Rows gathered from several sub-operations so they can be submitted as one unit.
 *
 * A bundled payment splits ONE real transfer across contexts (personal + each group). Landing
 * only some legs would misstate the balance in both directions at once, so the legs are built
 * up here and committed together rather than written one at a time.
 */
export type MutationRowCollector = {
  profiles: Profile[]
  groups: Group[]
  group_members: GroupMember[]
  bills: Bill[]
  bill_items: BillItem[]
  item_splits: ItemSplit[]
  settlements: Settlement[]
  activity_log: ActivityLog[]
  profile_peer_links: ProfilePeerLink[]
}

function newRowCollector(): MutationRowCollector {
  return {
    profiles: [],
    groups: [],
    group_members: [],
    bills: [],
    bill_items: [],
    item_splits: [],
    settlements: [],
    activity_log: [],
    profile_peer_links: [],
  }
}

/** Drop the empty tables so the payload only names what actually changed. */
function collectorToPayload(c: MutationRowCollector): CloudWritePayload {
  const out: CloudWritePayload = {}
  if (c.profiles.length) out.profiles = c.profiles
  if (c.groups.length) out.groups = c.groups
  if (c.group_members.length) out.group_members = c.group_members
  if (c.bills.length) out.bills = c.bills
  if (c.bill_items.length) out.bill_items = c.bill_items
  if (c.item_splits.length) out.item_splits = c.item_splits
  if (c.settlements.length) out.settlements = c.settlements
  if (c.activity_log.length) out.activity_log = c.activity_log
  if (c.profile_peer_links.length) out.profile_peer_links = c.profile_peer_links
  return out
}

/**
 * Commit settlement row changes cloud-first. Shared by the update/delete settlement operations,
 * which all reduce to "some complete settlement rows plus one activity row".
 */
async function commitSettlementRows(input: {
  actorUserId: string
  settlements: Settlement[]
  activity: ActivityLog
  pending: {
    operation: string
    entityId: string | null
    payload: unknown
    routeHint: string
  }
}): Promise<void> {
  await commitCloudFirstWrite({
    actorUserId: input.actorUserId,
    payload: { settlements: input.settlements, activity_log: [input.activity] },
    stageOffline: async () => {
      await db.transaction('rw', [db.settlements, db.activity_log], async () => {
        await db.settlements.bulkPut(input.settlements)
        await db.activity_log.add(input.activity)
      })
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: input.actorUserId,
        operation: input.pending.operation,
        entityType: 'settlement',
        entityId: input.pending.entityId,
        payload: input.pending.payload,
        routeHint: input.pending.routeHint,
      })
    },
  })
}

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
    syncOperation?: string
    routeHint?: string
    enforceCap?: boolean
    /** When set, this row is one leg of a multi-leg atomic payment. */
    bundleId?: string | null
    /** How the money moved (cash / transfer / …) — audit detail. */
    method?: string | null
    /** Hand the built rows to an aggregating caller instead of writing or submitting them. */
    collect?: MutationRowCollector
  },
): Promise<string> {
  const settlementId = generateId()
  const labelTrim = (label ?? '').trim()
  let [resolvedFromUserId, resolvedToUserId] = await Promise.all([
    resolveSettlementPartyId(fromUserId),
    resolveSettlementPartyId(toUserId),
  ])
  if (groupId) {
    ;[resolvedFromUserId, resolvedToUserId] = await Promise.all([
      resolveGroupMemberUserId(groupId, resolvedFromUserId),
      resolveGroupMemberUserId(groupId, resolvedToUserId),
    ])
  }

  if (billId) {
    const bill = await db.bills.get(billId)
    if (!bill || bill.is_deleted) throw new Error('Bill not found')
    if (bill.group_id !== groupId) throw new Error('Bill does not match this payment context')
    const union = await participantUnionForBill(billId)
    union.add(bill.paid_by)
    // Validate the SAME identities we store (resolved to the group roster), not the raw input
    // ids — otherwise a linked/email-matched party fails this check while a legitimate payment is
    // written, or vice versa.
    if (!union.has(resolvedFromUserId) || !union.has(resolvedToUserId)) {
      throw new Error('Both people must be on this bill')
    }
  }

  if (options?.enforceCap && groupId) {
    const owed = await loadOwedInGroup(groupId, resolvedFromUserId, resolvedToUserId).catch(
      () => null,
    )
    if (owed !== null && amount > owed + 0.005) {
      throw new Error(`You can only pay up to ${owed.toFixed(2)} — that's what you owe them.`)
    }
  }

  const settlement: Settlement = {
    ...syncFields({ id: settlementId }),
    group_id: groupId,
    bill_id: billId ?? null,
    bundle_id: options?.bundleId ?? null,
    from_user_id: resolvedFromUserId,
    to_user_id: resolvedToUserId,
    amount,
    currency,
    label: labelTrim,
    method: options?.method ?? null,
    is_settled: true,
  }

  const fromProfileForLog =
    (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(fromUserId))
  const toProfileForLog =
    (await db.profiles.get(resolvedToUserId)) ?? (await db.profiles.get(toUserId))
  const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''

  const settlementActivity: ActivityLog = {
    ...syncFields(),
    group_id: groupId,
    user_id: markedBy,
    action: 'settled',
    entity_type: 'settlement',
    entity_id: settlementId,
    description: `${fromProfileForLog?.display_name ?? 'Someone'} settled ${new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount)} with ${toProfileForLog?.display_name ?? 'someone'}${labelSuffix}`,
  }

  // A caller aggregating several legs into one logical payment (recordPersonPayment) passes a
  // collector: this leg's rows are handed over and NOTHING is written or submitted here, so the
  // caller can land every leg in a single round trip. Collecting rather than staging is what
  // keeps the payment atomic without needing to undo half-written legs on failure.
  if (options?.collect) {
    options.collect.settlements.push(settlement)
    options.collect.activity_log.push(settlementActivity)
  } else {
    await commitCloudFirstWrite({
      actorUserId: markedBy,
      payload: { settlements: [settlement], activity_log: [settlementActivity] },
      stageOffline: async () => {
        await db.transaction('rw', [db.settlements, db.activity_log], async () => {
          await db.settlements.add(settlement)
          await db.activity_log.add(settlementActivity)
        })
      },
      queueOffline: async () => {
        await enqueuePendingMutation({
          actorUserId: markedBy,
          operation: options?.syncOperation ?? 'create_settlement',
          entityType: 'settlement',
          entityId: settlementId,
          payload: { groupId, billId: billId ?? null, amount, currency },
          routeHint: options?.routeHint ?? (groupId ? `/app/groups/${groupId}` : '/app/settings'),
        })
      },
    })
  }

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
    const payments: Parameters<typeof notifyPaymentsRecorded>[0]['payments'] = []
    for (const candidate of recipientCandidates) {
      const recipientId = await resolveRecipientProfileIdForNotify(candidate)
      if (!recipientId || recipientId === markedBy) continue
      payments.push({
        recipientId,
        amount,
        fromName: fromProfile?.display_name?.trim() || 'Someone',
        toName: toProfile?.display_name?.trim() || 'Someone',
        settlementId,
      })
    }
    void notifyPaymentsRecorded({
      actorId: markedBy,
      actorName: actor?.display_name?.trim() || 'Someone',
      groupId,
      groupName,
      currency,
      payments,
    })
  }

  // No trailing sync: the commit above already round-tripped, and a suppressed leg is the
  // caller's to submit.
  return settlementId
}

export async function createBundledGroupSettlement(params: {
  groupId: string
  fromUserId: string
  recipients: { toUserId: string; amount: number }[]
  currency: string
  markedBy: string
  label?: string
  enforceCap?: boolean
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
  // Resolve to the group roster id (not just the linked-account id) so this device stores the
  // same identity every member's roster uses — without it, balances on a device that tracks a
  // recipient as its own local contact stay wrong until the server-side 042 backstop runs.
  const [resolvedFromUserId, resolvedRecipients] = await Promise.all([
    resolveSettlementPartyId(params.fromUserId).then((id) =>
      resolveGroupMemberUserId(params.groupId, id),
    ),
    Promise.all(
      cleanedRecipients.map(async (recipient) => ({
        toUserId: await resolveGroupMemberUserId(
          params.groupId,
          await resolveSettlementPartyId(recipient.toUserId),
        ),
        amount: recipient.amount,
      })),
    ),
  ])
  const labelTrim = (params.label ?? '').trim()

  // One call for every recipient: `pays` already lists what this payer owes each person, so
  // asking per recipient would be N round trips for one answer.
  if (params.enforceCap) {
    const breakdown = await loadGroupMemberBreakdownFresh(
      params.groupId,
      resolvedFromUserId,
    ).catch(() => null)
    if (breakdown) {
      const owedTo = new Map(breakdown.pays.map((p) => [p.memberUserId, p.amount]))
      for (const recipient of resolvedRecipients) {
        // The two sides of this comparison come from different id spaces. `pays` is keyed by the
        // ids the SERVER's roster holds, while `toUserId` came from `resolveGroupMemberUserId`,
        // which deliberately maps an account id BACK to a local contact id when this device's
        // roster row holds the local one. Matching literally made the recipient look like someone
        // owed 0, so the cap rejected a settle-up the same screen had just offered. Expanding to
        // the identity set is how every other cross-id match in this codebase is done.
        const candidateIds = await expandProfileIdsForSplitMatching(
          recipient.toUserId,
          params.markedBy,
        )
        let owed = 0
        for (const id of candidateIds) {
          const hit = owedTo.get(id)
          if (hit !== undefined) {
            owed = hit
            break
          }
        }
        if (recipient.amount > owed + 0.005) {
          throw new Error(`You can only pay up to ${owed.toFixed(2)} — that's what you owe them.`)
        }
      }
    }
  }

  const bundleRows: Settlement[] = resolvedRecipients.map((recipient, i) => ({
    ...syncFields({ id: settlementIds[i] }),
    group_id: params.groupId,
    bill_id: null,
    bundle_id: bundleId,
    from_user_id: resolvedFromUserId,
    to_user_id: recipient.toUserId,
    amount: recipient.amount,
    currency: params.currency,
    label: labelTrim,
    method: null,
    is_settled: true,
  }))

  const payerProfile =
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

  // One payment to several people is one submission: a partially-landed bundle would clear
  // some recipients' balances and not others.
  await commitSettlementRows({
    actorUserId: params.markedBy,
    settlements: bundleRows,
    activity: {
      ...syncFields(),
      group_id: params.groupId,
      user_id: params.markedBy,
      action: 'settled',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `${payerProfile?.display_name ?? 'Someone'} paid ${detailParts.join(', ')}${labelSuffix}`,
    },
    pending: {
      operation: 'create_settlement_bundle',
      entityId: bundleId,
      payload: {
        groupId: params.groupId,
        recipients: resolvedRecipients.length,
        totalAmount:
          Math.round(resolvedRecipients.reduce((sum, r) => sum + r.amount, 0) * 100) / 100,
        currency: params.currency,
      },
      routeHint: `/app/groups/${params.groupId}`,
    },
  })

  const actor = await db.profiles.get(params.markedBy)
  const fromProfile = (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(params.fromUserId))
  const payments: Parameters<typeof notifyPaymentsRecorded>[0]['payments'] = []
  for (let i = 0; i < resolvedRecipients.length; i++) {
    const recipient = resolvedRecipients[i]
    const toProfile = await db.profiles.get(recipient.toUserId)
    const recipientId = await resolveRecipientProfileIdForNotify(recipient.toUserId)
    if (!recipientId || recipientId === params.markedBy) continue
    payments.push({
      recipientId,
      amount: recipient.amount,
      fromName: fromProfile?.display_name?.trim() || 'Someone',
      toName: toProfile?.display_name?.trim() || 'Someone',
      settlementId: settlementIds[i],
    })
  }
  void notifyPaymentsRecorded({
    actorId: params.markedBy,
    actorName: actor?.display_name?.trim() || 'Someone',
    groupId: params.groupId,
    groupName: group.name,
    currency: params.currency,
    payments,
  })

  return { bundleId, settlementIds }
}

/**
 * Record a decomposed settle-up suggestion: a set of pairwise legs that may have different
 * payers (e.g. Ana→Carlo and Carlo→John when Ana physically pays on Carlo's behalf), all
 * under one bundle_id. Each leg's from/to is resolved to the canonical group roster id.
 * `markedBy` is the signed-in user who recorded it (distinct from each leg's payer).
 */
export async function recordDecomposedSettlement(params: {
  groupId: string
  currency: string
  legs: SettlementLeg[]
  markedBy: string
  label?: string
}): Promise<{ bundleId: string; settlementIds: string[] }> {
  const cleaned = params.legs
    .map((leg) => ({ ...leg, amount: Math.round(leg.amount * 100) / 100 }))
    .filter((leg) => leg.amount > 0.005 && leg.fromUserId !== leg.toUserId)
  if (cleaned.length === 0) {
    throw new Error('No payments to record for this settle-up.')
  }

  const group = await db.groups.get(params.groupId)
  if (!group || group.is_deleted) throw new Error('Group not found')

  const bundleId = generateId()
  const resolved = await Promise.all(
    cleaned.map(async (leg) => ({
      fromUserId: await resolveGroupMemberUserId(
        params.groupId,
        await resolveSettlementPartyId(leg.fromUserId),
      ),
      toUserId: await resolveGroupMemberUserId(
        params.groupId,
        await resolveSettlementPartyId(leg.toUserId),
      ),
      amount: leg.amount,
      settlementId: generateId(),
    })),
  )
  const labelTrim = (params.label ?? '').trim()
  const settlementIds = resolved.map((r) => r.settlementId)

  const legRows: Settlement[] = resolved.map((r) => ({
    ...syncFields({ id: r.settlementId }),
    group_id: params.groupId,
    bill_id: null,
    bundle_id: bundleId,
    from_user_id: r.fromUserId,
    to_user_id: r.toUserId,
    amount: r.amount,
    currency: params.currency,
    label: labelTrim,
    method: null,
    is_settled: true,
  }))

  const fmt = (amt: number) =>
    new Intl.NumberFormat('en-PH', {
      style: 'currency',
      currency: params.currency,
      minimumFractionDigits: 0,
    }).format(amt)
  const parts: string[] = []
  for (const r of resolved) {
    const from = await db.profiles.get(r.fromUserId)
    const to = await db.profiles.get(r.toUserId)
    parts.push(`${from?.display_name ?? 'Someone'} -> ${to?.display_name ?? 'Someone'} ${fmt(r.amount)}`)
  }
  const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''

  // A decomposed settle-up is one agreed set of transfers. Landing only some legs would leave
  // the group half-settled in a way no member intended.
  await commitSettlementRows({
    actorUserId: params.markedBy,
    settlements: legRows,
    activity: {
      ...syncFields(),
      group_id: params.groupId,
      user_id: params.markedBy,
      action: 'settled',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `Settle up: ${parts.join(', ')}${labelSuffix}`,
    },
    pending: {
      operation: 'create_settlement_bundle',
      entityId: bundleId,
      payload: {
        groupId: params.groupId,
        recipients: resolved.length,
        totalAmount: Math.round(resolved.reduce((s, r) => s + r.amount, 0) * 100) / 100,
        currency: params.currency,
      },
      routeHint: `/app/groups/${params.groupId}`,
    },
  })

  const actor = await db.profiles.get(params.markedBy)
  const payments: Parameters<typeof notifyPaymentsRecorded>[0]['payments'] = []
  for (const r of resolved) {
    const recipientId = await resolveRecipientProfileIdForNotify(r.toUserId)
    if (!recipientId || recipientId === params.markedBy) continue
    const from = await db.profiles.get(r.fromUserId)
    const to = await db.profiles.get(r.toUserId)
    payments.push({
      recipientId,
      amount: r.amount,
      fromName: from?.display_name?.trim() || 'Someone',
      toName: to?.display_name?.trim() || 'Someone',
      settlementId: r.settlementId,
    })
  }
  void notifyPaymentsRecorded({
    actorId: params.markedBy,
    actorName: actor?.display_name?.trim() || 'Someone',
    groupId: params.groupId,
    groupName: group.name,
    currency: params.currency,
    payments,
  })

  return { bundleId, settlementIds }
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
  const payments: Parameters<typeof notifyPaymentsRecorded>[0]['payments'] = []
  for (const candidate of recipientCandidates) {
    const recipientId = await resolveRecipientProfileIdForNotify(candidate)
    if (!recipientId || recipientId === params.markedBy) continue
    payments.push({
      recipientId,
      amount: params.amount,
      fromName: fromProfile?.display_name?.trim() || 'Someone',
      toName: toProfile?.display_name?.trim() || 'Someone',
      settlementId: params.settlementId,
    })
  }
  void notifyPaymentsRecorded({
    actorId: params.markedBy,
    actorName: actor?.display_name?.trim() || 'Someone',
    groupId: params.groupId,
    groupName,
    currency: params.currency,
    payments,
  })
}

/**
 * Record a person-to-person payment as ONE atomic, auditable unit. The `allocations`
 * partition `totalAmount` across contexts (personal and/or specific groups) so the tab and
 * every group page stay consistent; a multi-context payment shares a `bundleId` so the
 * history still shows one "they paid you ₱X" record. No bill-slicing, no "credit" — an
 * overpayment simply flips the tab because balances are a plain signed sum.
 */
export async function recordPersonPayment(params: {
  meId: string
  otherId: string
  direction: 'they_paid_me' | 'i_paid_them'
  totalAmount: number
  allocations: { context: 'personal' | { groupId: string }; amount: number }[]
  currency: string
  markedBy: string
  method?: string | null
  note?: string
  routeHint?: string
}): Promise<{ settlementIds: string[]; bundleId: string | null }> {
  const fromUserId = params.direction === 'they_paid_me' ? params.otherId : params.meId
  const toUserId = params.direction === 'they_paid_me' ? params.meId : params.otherId

  let legs = params.allocations.filter((a) => a.amount > 0.005)
  if (legs.length === 0) {
    // No explicit split → a single personal leg for the whole amount.
    legs = [{ context: 'personal', amount: params.totalAmount }]
  }

  const bundleId = legs.length > 1 ? generateId() : null
  const settlementIds: string[] = []
  const collect = newRowCollector()

  for (const leg of legs) {
    const groupId = leg.context === 'personal' ? null : leg.context.groupId
    const id = await createSettlement(
      groupId,
      fromUserId,
      toUserId,
      Math.round(leg.amount * 100) / 100,
      params.currency,
      params.markedBy,
      params.note,
      null,
      { suppressNotification: true, bundleId, method: params.method ?? null, collect },
    )
    settlementIds.push(id)
  }

  const notifyEntityId = settlementIds[0] ?? null

  // Submit every leg in ONE round trip. A multi-leg payment partitions one real transfer across
  // contexts, so a partial landing would misstate the balance in both directions — the group leg
  // cleared but the personal one not, or the reverse. One RPC is one Postgres transaction, so
  // either all legs are stored or none are.
  await commitCloudFirstWrite({
    actorUserId: params.markedBy,
    payload: { settlements: collect.settlements, activity_log: collect.activity_log },
    stageOffline: async () => {
      await db.transaction('rw', [db.settlements, db.activity_log], async () => {
        await db.settlements.bulkAdd(collect.settlements)
        await db.activity_log.bulkAdd(collect.activity_log)
      })
    },
    queueOffline: async () => {
      await enqueuePendingMutation({
        actorUserId: params.markedBy,
        operation: 'record_person_payment',
        entityType: 'settlement',
        entityId: notifyEntityId,
        payload: { totalAmount: params.totalAmount, currency: params.currency, legs: legs.length },
        routeHint: params.routeHint ?? `/app/people/${params.otherId}`,
      })
    },
  })

  // Notify only AFTER the payment is committed. Emitting first would tell the other person
  // they were paid even when the write was rejected and nothing was recorded anywhere.
  if (notifyEntityId) {
    // Attribute the notification to a group only when every leg belongs to that one group; a
    // personal-only or mixed-context payment has no single group, so it notifies as personal.
    const legGroupIds = new Set(
      legs.map((l) => (l.context === 'personal' ? null : l.context.groupId)),
    )
    const notifyGroupId = legGroupIds.size === 1 ? [...legGroupIds][0] : null
    await emitSinglePaymentNotification({
      markedBy: params.markedBy,
      fromUserId,
      toUserId,
      amount: Math.round(params.totalAmount * 100) / 100,
      currency: params.currency,
      groupId: notifyGroupId,
      settlementId: notifyEntityId,
    })
  }

  return { settlementIds, bundleId }
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

  const updated: Settlement = {
    ...s,
    from_user_id: resolvedFromUserId,
    to_user_id: resolvedToUserId,
    amount: patch.amount,
    currency: patch.currency,
    label: labelTrim,
    updated_at: timestamp,
    synced_at: null,
  }

  const fromProfile =
    (await db.profiles.get(resolvedFromUserId)) ?? (await db.profiles.get(patch.fromUserId))
  const toProfile =
    (await db.profiles.get(resolvedToUserId)) ?? (await db.profiles.get(patch.toUserId))
  const labelSuffix = labelTrim ? ` · ${labelTrim}` : ''

  await commitSettlementRows({
    actorUserId: editorUserId,
    settlements: [updated],
    activity: {
      ...syncFields(),
      group_id: s.group_id,
      user_id: editorUserId,
      action: 'updated',
      entity_type: 'settlement',
      entity_id: settlementId,
      description: `${fromProfile?.display_name ?? 'Someone'} → ${toProfile?.display_name ?? 'someone'} · ${new Intl.NumberFormat('en-PH', { style: 'currency', currency: patch.currency, minimumFractionDigits: 0 }).format(patch.amount)} (updated)${labelSuffix}`,
    },
    pending: {
      operation: 'update_settlement',
      entityId: settlementId,
      payload: { amount: patch.amount, currency: patch.currency },
      routeHint: s.group_id ? `/app/groups/${s.group_id}` : '/app/settings',
    },
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

  const relabelled: Settlement[] = activeRows.map((row) => ({
    ...row,
    label: labelTrim,
    updated_at: timestamp,
    synced_at: null,
  }))

  const fromProfile = await db.profiles.get(first.from_user_id)

  await commitSettlementRows({
    actorUserId: editorUserId,
    settlements: relabelled,
    activity: {
      ...syncFields(),
      group_id: first.group_id,
      user_id: editorUserId,
      action: 'updated',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `Updated bundled payment label for ${fromProfile?.display_name ?? 'Someone'}`,
    },
    pending: {
      operation: 'update_settlement_bundle_label',
      entityId: bundleId,
      payload: { bundleId, label: labelTrim },
      routeHint: first.group_id ? `/app/groups/${first.group_id}` : '/app/settings',
    },
  })
}

export async function deleteSettlement(
  settlementId: string,
  editorUserId: string,
  options?: { collect?: MutationRowCollector },
): Promise<void> {
  const s = await db.settlements.get(settlementId)
  // The id comes from a SERVER-fetched history list while the row is resolved from the local
  // mirror, and the two can legitimately disagree — a payment another member recorded is listed
  // as soon as the endpoint answers, before realtime or the next sync has mirrored the row.
  // Returning here made the dialog report a successful delete that did nothing, so the user
  // pressed Remove again. Refusing is recoverable; a silent no-op is not.
  if (!s) {
    throw new Error(
      'This payment has not finished syncing to this device yet. Refresh and try again.',
    )
  }
  if (s.is_deleted) return

  const timestamp = now()

  const deleted: Settlement = { ...s, is_deleted: true, updated_at: timestamp, synced_at: null }
  const fromProfile = await db.profiles.get(s.from_user_id)
  const toProfile = await db.profiles.get(s.to_user_id)
  const activity: ActivityLog = {
    ...syncFields(),
    group_id: s.group_id,
    user_id: editorUserId,
    action: 'deleted',
    entity_type: 'settlement',
    entity_id: settlementId,
    description: `Removed payment ${fromProfile?.display_name ?? '?'} → ${toProfile?.display_name ?? '?'}`,
  }

  if (options?.collect) {
    options.collect.settlements.push(deleted)
    options.collect.activity_log.push(activity)
    return
  }
  await commitSettlementRows({
    actorUserId: editorUserId,
    settlements: [deleted],
    activity,
    pending: {
      operation: 'delete_settlement',
      entityId: settlementId,
      payload: { groupId: s.group_id },
      routeHint: s.group_id ? `/app/groups/${s.group_id}` : '/app/settings',
    },
  })
}

export async function deleteBundledPayment(
  bundleId: string,
  editorUserId: string,
  /**
   * Every leg the SERVER says this bundle has.
   *
   * The mirror is not a reliable census of a bundle: `where('bundle_id')` returns the legs this
   * device happens to hold, so a bundle whose legs had not all arrived was deleted PARTIALLY —
   * the surviving legs keep moving the balance and the payment can never be reassembled. The
   * caller already has the authoritative list from the settlement-history endpoint.
   */
  expectedSettlementIds: string[],
): Promise<void> {
  const rows = await db.settlements.where('bundle_id').equals(bundleId).toArray()
  const known = new Set(rows.map((row) => row.id))
  const missing = expectedSettlementIds.filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw new Error(
      'This payment has not finished syncing to this device yet. Refresh and try again.',
    )
  }

  const activeRows = rows.filter((row) => !row.is_deleted)
  if (activeRows.length === 0) return

  const timestamp = now()
  const first = activeRows[0]
  const deletedRows: Settlement[] = activeRows.map((row) => ({
    ...row,
    is_deleted: true,
    updated_at: timestamp,
    synced_at: null,
  }))

  const fromProfile = await db.profiles.get(first.from_user_id)

  // Every leg of the bundle goes in one submission: removing only some of them would leave a
  // half-deleted payment that under- or over-states the balance.
  await commitSettlementRows({
    actorUserId: editorUserId,
    settlements: deletedRows,
    activity: {
      ...syncFields(),
      group_id: first.group_id,
      user_id: editorUserId,
      action: 'deleted',
      entity_type: 'settlement',
      entity_id: bundleId,
      description: `Removed bundled payment from ${fromProfile?.display_name ?? 'Someone'}`,
    },
    pending: {
      operation: 'delete_settlement_bundle',
      entityId: bundleId,
      payload: {
        bundleId,
        settlementIds: activeRows.map((row) => row.id),
        groupId: first.group_id,
      },
      routeHint: first.group_id ? `/app/groups/${first.group_id}` : '/app/settings',
    },
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
          let profile = await db.profiles.get(split.user_id)
          if (!profile) {
            await fetchRemoteProfileIntoDexie(split.user_id)
            profile = await db.profiles.get(split.user_id)
          }
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

  let creator = await db.profiles.get(bill.created_by)
  if (!creator) {
    await fetchRemoteProfileIntoDexie(bill.created_by)
    creator = await db.profiles.get(bill.created_by)
  }
  let creatorName = creator?.display_name
  if (!creatorName && bill.group_id) {
    const member = await db.group_members
      .where('[group_id+user_id]')
      .equals([bill.group_id, bill.created_by])
      .first()
    creatorName = member?.display_name
  }

  let payorName: string | undefined
  if (bill.paid_by === bill.created_by) {
    payorName = creatorName
  } else {
    let payor = await db.profiles.get(bill.paid_by)
    if (!payor) {
      await fetchRemoteProfileIntoDexie(bill.paid_by)
      payor = await db.profiles.get(bill.paid_by)
    }
    payorName = payor?.display_name
    if (!payorName && bill.group_id) {
      const member = await db.group_members
        .where('[group_id+user_id]')
        .equals([bill.group_id, bill.paid_by])
        .first()
      payorName = member?.display_name
    }
  }

  return {
    ...bill,
    creatorName: creatorName ?? 'Unknown',
    payorName: payorName ?? 'Unknown',
    items: itemsWithSplits,
  }
}
