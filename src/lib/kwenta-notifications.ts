import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'

export type KwentaNotificationKind =
  | 'profile_linked'
  | 'bill_participant'
  | 'payment_recorded'
  | 'added_to_group'

export interface KwentaNotificationRow {
  id: string
  recipient_id: string
  actor_id: string
  kind: KwentaNotificationKind
  title: string
  body: string
  entity_id: string | null
  group_id: string | null
  read_at: string | null
  created_at: string
  updated_at: string
}

/**
 * Real Kwenta account id to notify for a split row: linked remote, or non-local profile with email.
 */
export async function resolveRecipientProfileIdForNotify(splitUserId: string): Promise<string | null> {
  const p = await db.profiles.get(splitUserId)
  if (!p || p.is_deleted) return null
  if (p.linked_profile_id) return p.linked_profile_id
  if (p.is_local) return null
  if (!p.email?.trim()) return null
  return p.id
}

function shouldSendCloudNotification(): boolean {
  return useAppStore.getState().isOnline
}

export async function notifyProfileLinked(params: {
  actorId: string
  actorName: string
  recipientId: string
  linkedAsName: string
}): Promise<void> {
  if (!shouldSendCloudNotification()) return
  const { error } = await supabase.from('kwenta_notifications').insert({
    recipient_id: params.recipientId,
    actor_id: params.actorId,
    kind: 'profile_linked',
    title: 'Contact linked to you',
    body: `${params.actorName} linked a saved contact (“${params.linkedAsName}”) to your Kwenta account.`,
    entity_id: null,
    group_id: null,
  })
  if (error) console.warn('[kwenta-notifications] profile_linked:', error.message)
}

export async function notifyBillParticipantsCreated(params: {
  actorId: string
  actorName: string
  recipientIds: string[]
  billId: string
  billTitle: string
  groupId: string | null
  groupName: string | null
}): Promise<void> {
  if (!shouldSendCloudNotification() || params.recipientIds.length === 0) return

  const scope =
    params.groupId && params.groupName
      ? `Group · ${params.groupName}`
      : 'Personal bill'

  const rows = params.recipientIds.map((recipient_id) => ({
    recipient_id,
    actor_id: params.actorId,
    kind: 'bill_participant' as const,
    title: 'Added to a bill',
    body: `${params.actorName} added you to “${params.billTitle}” (${scope}).`,
    entity_id: params.billId,
    group_id: params.groupId,
  }))

  const { error } = await supabase.from('kwenta_notifications').insert(rows)
  if (error) console.warn('[kwenta-notifications] bill_participant:', error.message)
}

export async function notifyPaymentRecorded(params: {
  actorId: string
  actorName: string
  recipientId: string
  amount: number
  currency: string
  fromName: string
  toName: string
  groupId: string | null
  groupName: string | null
  settlementId: string
}): Promise<void> {
  if (!shouldSendCloudNotification()) return
  const scope =
    params.groupId && params.groupName
      ? `Group · ${params.groupName}`
      : 'Personal payment'
  const amountLabel = new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: params.currency,
    minimumFractionDigits: 0,
  }).format(params.amount)

  const { error } = await supabase.from('kwenta_notifications').insert({
    recipient_id: params.recipientId,
    actor_id: params.actorId,
    kind: 'payment_recorded',
    title: 'Payment recorded',
    body: `${params.actorName} recorded ${amountLabel} (${params.fromName} -> ${params.toName}) · ${scope}.`,
    entity_id: params.settlementId,
    group_id: params.groupId,
  })
  if (error) console.warn('[kwenta-notifications] payment_recorded:', error.message)
}

export async function notifyAddedToGroup(params: {
  actorId: string
  actorName: string
  recipientId: string
  groupId: string
  groupName: string
}): Promise<void> {
  if (!shouldSendCloudNotification()) return
  const { error } = await supabase.from('kwenta_notifications').insert({
    recipient_id: params.recipientId,
    actor_id: params.actorId,
    kind: 'added_to_group',
    title: 'Added to a group',
    body: `${params.actorName} added you to “${params.groupName}”.`,
    entity_id: params.groupId,
    group_id: params.groupId,
  })
  if (error) console.warn('[kwenta-notifications] added_to_group:', error.message)
}

export async function fetchKwentaNotifications(recipientId: string, limit = 50): Promise<KwentaNotificationRow[]> {
  const { data, error } = await supabase
    .from('kwenta_notifications')
    .select('*')
    .eq('recipient_id', recipientId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.warn('[kwenta-notifications] fetch:', error.message)
    return []
  }
  return (data ?? []) as KwentaNotificationRow[]
}

export async function fetchUnreadKwentaNotificationCount(recipientId: string): Promise<number> {
  const { count, error } = await supabase
    .from('kwenta_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .is('read_at', null)

  if (error) {
    console.warn('[kwenta-notifications] count:', error.message)
    return 0
  }
  return count ?? 0
}

export async function markKwentaNotificationRead(id: string, recipientId: string): Promise<void> {
  const ts = new Date().toISOString()
  const { error } = await supabase
    .from('kwenta_notifications')
    .update({ read_at: ts, updated_at: ts })
    .eq('id', id)
    .eq('recipient_id', recipientId)

  if (error) console.warn('[kwenta-notifications] mark read:', error.message)
}
