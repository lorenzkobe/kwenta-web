import Dexie, { type Table } from 'dexie'
import type {
  ActivityLog,
  Bill,
  BillItem,
  Group,
  GroupMember,
  ItemSplit,
  NotAppliedChange,
  PendingMutation,
  Profile,
  Settlement,
} from '@/types'

export class KwentaDB extends Dexie {
  profiles!: Table<Profile, string>
  groups!: Table<Group, string>
  group_members!: Table<GroupMember, string>
  bills!: Table<Bill, string>
  bill_items!: Table<BillItem, string>
  item_splits!: Table<ItemSplit, string>
  settlements!: Table<Settlement, string>
  activity_log!: Table<ActivityLog, string>
  pending_mutations!: Table<PendingMutation, string>
  not_applied_changes!: Table<NotAppliedChange, string>

  constructor() {
    super('kwenta')

    this.version(1).stores({
      profiles: 'id, email, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements: 'id, group_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
    })

    this.version(2).stores({
      profiles: 'id, email, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements: 'id, group_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
    }).upgrade(async (tx) => {
      await tx.table('settlements').toCollection().modify((s: Record<string, unknown>) => {
        if (s.label === undefined) s.label = ''
      })
    })

    this.version(3).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements: 'id, group_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
    }).upgrade(async (tx) => {
      await tx.table('profiles').toCollection().modify((p: Record<string, unknown>) => {
        if (p.is_local === undefined) p.is_local = false
        if (p.linked_profile_id === undefined) p.linked_profile_id = null
        if (p.owner_id === undefined) p.owner_id = null
      })
    })

    this.version(4).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements: 'id, group_id, bill_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
    }).upgrade(async (tx) => {
      await tx.table('settlements').toCollection().modify((s: Record<string, unknown>) => {
        if (s.bill_id === undefined) s.bill_id = null
      })
    })

    this.version(5).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements: 'id, group_id, bill_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    })
  }
}

export const db = new KwentaDB()
