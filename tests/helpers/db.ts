import { db } from '@/db/db'
import type {
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  Profile,
  Settlement,
} from '@/types'

let seq = 0
/** Deterministic, unique-enough id for test rows. */
export function tid(prefix = 'id'): string {
  seq += 1
  return `${prefix}-${seq}`
}

const ISO = '2026-06-18T00:00:00.000Z'

function syncFields(id: string) {
  return {
    id,
    created_at: ISO,
    updated_at: ISO,
    synced_at: ISO,
    is_deleted: false,
    device_id: 'test-device',
  }
}

/** Wipe every table so each test starts from a clean DB. */
export async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()))
}

export function makeProfile(over: Partial<Profile> = {}): Profile {
  const id = over.id ?? tid('profile')
  return {
    ...syncFields(id),
    email: `${id}@example.com`,
    display_name: id,
    avatar_url: null,
    user_type: 'user',
    account_status: 'active',
    is_local: false,
    linked_profile_id: null,
    owner_id: null,
    ...over,
  }
}

export function makeGroup(over: Partial<Group> = {}): Group {
  const id = over.id ?? tid('group')
  return {
    ...syncFields(id),
    name: 'Test Group',
    currency: 'PHP',
    created_by: over.created_by ?? tid('user'),
    invite_code: id,
    ...over,
  }
}

export function makeMember(over: Partial<GroupMember> = {}): GroupMember {
  const id = over.id ?? tid('member')
  return {
    ...syncFields(id),
    group_id: over.group_id ?? tid('group'),
    user_id: over.user_id ?? tid('user'),
    display_name: over.user_id ?? 'Member',
    joined_at: ISO,
    ...over,
  }
}

export function makeBill(over: Partial<Bill> = {}): Bill {
  const id = over.id ?? tid('bill')
  const createdBy = over.created_by ?? tid('user')
  return {
    ...syncFields(id),
    title: 'Bill',
    group_id: over.group_id ?? null,
    currency: 'PHP',
    created_by: createdBy,
    paid_by: over.paid_by ?? createdBy,
    total_amount: over.total_amount ?? 0,
    note: '',
    category: null,
    ...over,
  }
}

export function makeItem(over: Partial<BillItem> = {}): BillItem {
  const id = over.id ?? tid('item')
  return {
    ...syncFields(id),
    bill_id: over.bill_id ?? tid('bill'),
    name: 'Item',
    amount: over.amount ?? 0,
    ...over,
  }
}

export function makeSplit(over: Partial<ItemSplit> = {}): ItemSplit {
  const id = over.id ?? tid('split')
  return {
    ...syncFields(id),
    item_id: over.item_id ?? tid('item'),
    user_id: over.user_id ?? tid('user'),
    split_type: 'equal',
    split_value: 1,
    computed_amount: over.computed_amount ?? 0,
    ...over,
  }
}

export function makeSettlement(over: Partial<Settlement> = {}): Settlement {
  const id = over.id ?? tid('settlement')
  return {
    ...syncFields(id),
    group_id: over.group_id ?? null,
    bill_id: over.bill_id ?? null,
    bundle_id: over.bundle_id ?? null,
    from_user_id: over.from_user_id ?? tid('user'),
    to_user_id: over.to_user_id ?? tid('user'),
    amount: over.amount ?? 0,
    currency: 'PHP',
    label: '',
    is_settled: over.is_settled ?? true,
    ...over,
  }
}

/**
 * Seed a single-item bill where each entry in `shares` is one participant's
 * computed share. Returns the created bill id.
 */
export async function seedSimpleBill(params: {
  groupId: string | null
  paidBy: string
  createdBy?: string
  currency?: string
  shares: Record<string, number>
  isDeleted?: boolean
}): Promise<string> {
  const total = Object.values(params.shares).reduce((a, b) => a + b, 0)
  const bill = makeBill({
    group_id: params.groupId,
    paid_by: params.paidBy,
    created_by: params.createdBy ?? params.paidBy,
    currency: params.currency ?? 'PHP',
    total_amount: total,
    is_deleted: params.isDeleted ?? false,
  })
  const item = makeItem({ bill_id: bill.id, amount: total })
  const splits = Object.entries(params.shares).map(([userId, amount]) =>
    makeSplit({ item_id: item.id, user_id: userId, computed_amount: amount }),
  )
  await db.bills.add(bill)
  await db.bill_items.add(item)
  await db.item_splits.bulkAdd(splits)
  return bill.id
}
