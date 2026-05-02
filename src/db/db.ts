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

    // Version 12: repair stale data for profiles that were linked before the
    // linkProfileToRemote fix. Previously, item_splits, bills.paid_by, and
    // settlements were not re-queued after a link. Mark them unsynced so the
    // next syncRoundTrip rewrites all localContactId references to remoteProfileId.
    this.version(12).stores({
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
      const timestamp = new Date().toISOString()
      const profiles = await tx.table('profiles').toArray()
      const linkedContacts = (profiles as Record<string, unknown>[]).filter(
        (p) => p.is_local === true && p.linked_profile_id != null && !p.is_deleted,
      )
      for (const contact of linkedContacts) {
        const localId = contact.id as string
        const remoteId = contact.linked_profile_id as string

        await tx.table('item_splits').where('user_id').equals(localId).modify(
          (s: Record<string, unknown>) => {
            if (!s.is_deleted && s.synced_at !== null) {
              s.updated_at = timestamp
              s.synced_at = null
            }
          },
        )

        await tx.table('bills').where('paid_by').equals(localId).modify(
          (b: Record<string, unknown>) => {
            if (!b.is_deleted) {
              b.paid_by = remoteId
              b.updated_at = timestamp
              b.synced_at = null
            }
          },
        )

        await tx.table('settlements').where('from_user_id').equals(localId).modify(
          (s: Record<string, unknown>) => {
            if (!s.is_deleted) {
              s.from_user_id = remoteId
              s.updated_at = timestamp
              s.synced_at = null
            }
          },
        )
        await tx.table('settlements').where('to_user_id').equals(localId).modify(
          (s: Record<string, unknown>) => {
            if (!s.is_deleted) {
              s.to_user_id = remoteId
              s.updated_at = timestamp
              s.synced_at = null
            }
          },
        )
      }
    })

    // Version 13: repair stale item_splits.user_id for contacts that were already
    // linked before this fix. Version 12 only marked those splits as unsynced so
    // resolveSplitUserIdForPush would rewrite on the next push, but the local
    // user_id field was never updated in Dexie. Rewrite it now so direct Dexie
    // queries by remoteProfileId find these rows immediately.
    this.version(13).stores({
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
      const profiles = await tx.table('profiles').toArray()
      const linkedContacts = (profiles as Record<string, unknown>[]).filter(
        (p) => p.is_local === true && p.linked_profile_id != null && !p.is_deleted,
      )
      const timestamp = new Date().toISOString()
      for (const contact of linkedContacts) {
        const localId = contact.id as string
        const remoteId = contact.linked_profile_id as string
        await tx.table('item_splits').where('user_id').equals(localId).modify(
          (s: Record<string, unknown>) => {
            if (!s.is_deleted) {
              s.user_id = remoteId
              s.updated_at = timestamp
              s.synced_at = null
            }
          },
        )
      }
    })
  }
}

export const db = new KwentaDB()
