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
  group_id: string
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
