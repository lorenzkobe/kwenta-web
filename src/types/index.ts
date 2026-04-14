export interface SyncFields {
  id: string
  created_at: string
  updated_at: string
  synced_at: string | null
  is_deleted: boolean
  device_id: string
}

export interface Profile extends SyncFields {
  email: string
  display_name: string
  avatar_url: string | null
  /** Created offline / phonebook — not a signed-in account */
  is_local: boolean
  /** When set, this local profile is linked to another profile (usually a synced account) */
  linked_profile_id: string | null
  /** Profile id of the user who created this local profile (for unique names per phonebook) */
  owner_id: string | null
}

export interface Group extends SyncFields {
  name: string
  currency: string
  created_by: string
  invite_code: string
}

export interface GroupMember extends SyncFields {
  group_id: string
  user_id: string
  display_name: string
  joined_at: string
}

export interface Bill extends SyncFields {
  title: string
  group_id: string | null
  currency: string
  created_by: string
  total_amount: number
  note: string
}

export interface BillItem extends SyncFields {
  bill_id: string
  name: string
  amount: number
}

export type SplitType = 'equal' | 'percentage' | 'custom'

export interface ItemSplit extends SyncFields {
  item_id: string
  user_id: string
  split_type: SplitType
  split_value: number
  computed_amount: number
}

export interface Settlement extends SyncFields {
  /** Null = personal payment between two people (no group) */
  group_id: string | null
  /** When set, payment is attributed to this bill (Phase B allocation). */
  bill_id: string | null
  from_user_id: string
  to_user_id: string
  amount: number
  currency: string
  /** Short note (e.g. "Cash", "Dinner") — shown in group & global payment history */
  label: string
  is_settled: boolean
}

export type ActivityAction = 'created' | 'updated' | 'deleted' | 'settled'
export type EntityType = 'bill' | 'bill_item' | 'item_split' | 'settlement' | 'group'

export interface ActivityLog extends SyncFields {
  group_id: string | null
  user_id: string
  action: ActivityAction
  entity_type: EntityType
  entity_id: string
  description: string
}

export type PendingMutationStatus = 'pending' | 'applied' | 'conflict' | 'dismissed'

export type MutationEntityType =
  | 'bill'
  | 'group'
  | 'group_member'
  | 'settlement'
  | 'profile'
  | 'activity_log'
  | 'unknown'

export interface PendingMutation {
  id: string
  actor_user_id: string
  operation: string
  entity_type: MutationEntityType
  entity_id: string | null
  payload_json: string
  status: PendingMutationStatus
  retry_count: number
  last_error: string | null
  idempotency_key: string
  created_at: string
  updated_at: string
}

export interface NotAppliedChange {
  id: string
  actor_user_id: string
  pending_mutation_id: string | null
  entity_type: MutationEntityType
  entity_id: string | null
  operation: string
  reason_code: string
  reason_message: string
  payload_json: string
  route_hint: string | null
  created_at: string
  resolved_at: string | null
  resolution: 'pending' | 'dismissed' | 'reapplied' | 'auto_resolved'
}
