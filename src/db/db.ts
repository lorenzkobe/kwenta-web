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
  ProfilePeerLink,
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
  profile_peer_links!: Table<ProfilePeerLink, string>
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

    this.version(6).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    }).upgrade(async (tx) => {
      await tx.table('settlements').toCollection().modify((s: Record<string, unknown>) => {
        if (s.bundle_id === undefined) s.bundle_id = null
      })
    })

    this.version(7).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    }).upgrade(async (tx) => {
      await tx.table('profiles').toCollection().modify((p: Record<string, unknown>) => {
        if (p.user_type === undefined) p.user_type = 'user'
        if (p.account_status === undefined) p.account_status = 'active'
      })
    })

    this.version(8).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted',
      groups: 'id, created_by, invite_code, synced_at, is_deleted',
      group_members: 'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted',
      bills: 'id, group_id, created_by, created_at, synced_at, is_deleted',
      bill_items: 'id, bill_id, synced_at, is_deleted',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted',
      activity_log: 'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted',
      profile_peer_links:
        'id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id]',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    })

    this.version(9).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted, [owner_id+is_deleted]',
      groups: 'id, created_by, invite_code, synced_at, is_deleted, [created_by+is_deleted]',
      group_members:
        'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted, [group_id+is_deleted], [user_id+is_deleted]',
      bills:
        'id, group_id, created_by, created_at, synced_at, is_deleted, [created_by+group_id], [group_id+is_deleted], [created_by+is_deleted]',
      bill_items: 'id, bill_id, synced_at, is_deleted, [bill_id+is_deleted]',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted, [item_id+is_deleted], [user_id+is_deleted]',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted, [group_id+is_deleted], [bill_id+is_deleted], [from_user_id+to_user_id]',
      activity_log:
        'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted, [user_id+created_at]',
      profile_peer_links:
        'id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id], [owner_user_id+is_deleted]',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    })

    this.version(10).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted, [owner_id+is_deleted]',
      groups: 'id, created_by, invite_code, synced_at, is_deleted, [created_by+is_deleted]',
      group_members:
        'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted, [group_id+is_deleted], [user_id+is_deleted]',
      bills:
        'id, group_id, created_by, created_at, synced_at, is_deleted, [created_by+group_id], [group_id+is_deleted], [created_by+is_deleted]',
      bill_items: 'id, bill_id, synced_at, is_deleted, [bill_id+is_deleted]',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted, [item_id+is_deleted], [user_id+is_deleted]',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted, [group_id+is_deleted], [bill_id+is_deleted], [from_user_id+to_user_id]',
      activity_log:
        'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted, [user_id+created_at]',
      profile_peer_links:
        'id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id], [owner_user_id+is_deleted]',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    }).upgrade(async (tx) => {
      await tx.table('bills').toCollection().modify((b: Record<string, unknown>) => {
        if (b.category === undefined) b.category = null
      })
    })

    this.version(11).stores({
      profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted, [owner_id+is_deleted]',
      groups: 'id, created_by, invite_code, synced_at, is_deleted, [created_by+is_deleted]',
      group_members:
        'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted, [group_id+is_deleted], [user_id+is_deleted]',
      bills:
        'id, group_id, created_by, paid_by, created_at, synced_at, is_deleted, [created_by+group_id], [group_id+is_deleted], [created_by+is_deleted]',
      bill_items: 'id, bill_id, synced_at, is_deleted, [bill_id+is_deleted]',
      item_splits: 'id, item_id, user_id, synced_at, is_deleted, [item_id+is_deleted], [user_id+is_deleted]',
      settlements:
        'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted, [group_id+is_deleted], [bill_id+is_deleted], [from_user_id+to_user_id]',
      activity_log:
        'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted, [user_id+created_at]',
      profile_peer_links:
        'id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id], [owner_user_id+is_deleted]',
      pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
      not_applied_changes:
        'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
    }).upgrade(async (tx) => {
      await tx.table('bills').toCollection().modify((b: Record<string, unknown>) => {
        if (!b.paid_by) b.paid_by = b.created_by
      })
    })
  }
}

export const db = new KwentaDB()
