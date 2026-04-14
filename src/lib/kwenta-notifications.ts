import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { syncRoundTrip } from '@/sync/sync-service'

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

type NotificationInsertRow = {
  recipient_id: string
  actor_id: string
  kind: KwentaNotificationKind
  title: string
  body: string
  entity_id: string | null
  group_id: string | null
}

type NotificationOutboxEntry = {
  id: string
  actorId: string
  rows: NotificationInsertRow[]
  createdAt: string
  attempts: number
  lastError: string | null
}

const NOTIFICATION_OUTBOX_KEY = 'kwenta_notification_outbox_v1'
let flushInFlight: Promise<void> | null = null

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

function readOutbox(): NotificationOutboxEntry[] {
  const raw = localStorage.getItem(NOTIFICATION_OUTBOX_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as NotificationOutboxEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => Array.isArray(entry.rows) && entry.rows.length > 0)
  } catch {
    return []
  }
}

function writeOutbox(next: NotificationOutboxEntry[]) {
  localStorage.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify(next))
}

function enqueueNotificationRows(actorId: string, rows: NotificationInsertRow[]) {
  if (rows.length === 0) return
  const queue = readOutbox()
  queue.push({
    id: crypto.randomUUID(),
    actorId,
    rows,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  })
  writeOutbox(queue)
}

export async function hasQueuedKwentaNotifications(actorId: string): Promise<boolean> {
  const queue = readOutbox()
  return queue.some((entry) => entry.actorId === actorId)
}

type FlushOptions = {
  assumeCloudAck?: boolean
}

export async function flushQueuedKwentaNotifications(options?: FlushOptions): Promise<void> {
  if (flushInFlight) return flushInFlight

  flushInFlight = (async () => {
    const isOnline = useAppStore.getState().isOnline
    if (!isOnline) return

    const {
      data: { session },
    } = await supabase.auth.getSession()
    const actorId = session?.user?.id
    if (!actorId) return

    const queue = readOutbox()
    if (queue.length === 0) return

    if (!options?.assumeCloudAck) {
      const syncResult = await syncRoundTrip(actorId)
      if (syncResult.errors.length > 0) {
        return
      }
    }

    const nextQueue: NotificationOutboxEntry[] = []
    for (const entry of queue) {
      if (entry.actorId !== actorId) {
        nextQueue.push(entry)
        continue
      }
      const { error } = await supabase.from('kwenta_notifications').insert(entry.rows)
      if (error) {
        nextQueue.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastError: error.message,
        })
      }
    }

    writeOutbox(nextQueue)
  })()

  try {
    await flushInFlight
  } finally {
    flushInFlight = null
  }
}

export async function notifyProfileLinked(params: {
  actorId: string
  actorName: string
  recipientId: string
  linkedAsName: string
}): Promise<void> {
  enqueueNotificationRows(params.actorId, [
    {
      recipient_id: params.recipientId,
      actor_id: params.actorId,
      kind: 'profile_linked',
      title: 'Contact linked to you',
      body: `${params.actorName} linked a saved contact (“${params.linkedAsName}”) to your Kwenta account.`,
      entity_id: null,
      group_id: null,
    },
  ])
  void flushQueuedKwentaNotifications()
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
  if (params.recipientIds.length === 0) return

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

  enqueueNotificationRows(params.actorId, rows)
  void flushQueuedKwentaNotifications()
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
  const scope =
    params.groupId && params.groupName
      ? `Group · ${params.groupName}`
      : 'Personal payment'
  const amountLabel = new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: params.currency,
    minimumFractionDigits: 0,
  }).format(params.amount)

  enqueueNotificationRows(params.actorId, [
    {
      recipient_id: params.recipientId,
      actor_id: params.actorId,
      kind: 'payment_recorded',
      title: 'Payment recorded',
      body: `${params.actorName} recorded ${amountLabel} (${params.fromName} -> ${params.toName}) · ${scope}.`,
      entity_id: params.settlementId,
      group_id: params.groupId,
    },
  ])
  void flushQueuedKwentaNotifications()
}

export async function notifyAddedToGroup(params: {
  actorId: string
  actorName: string
  recipientId: string
  groupId: string
  groupName: string
}): Promise<void> {
  enqueueNotificationRows(params.actorId, [
    {
      recipient_id: params.recipientId,
      actor_id: params.actorId,
      kind: 'added_to_group',
      title: 'Added to a group',
      body: `${params.actorName} added you to “${params.groupName}”.`,
      entity_id: params.groupId,
      group_id: params.groupId,
    },
  ])
  void flushQueuedKwentaNotifications()
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

export async function markKwentaNotificationRead(id: string, recipientId: string): Promise<void> {
  const ts = new Date().toISOString()
  const { error } = await supabase
    .from('kwenta_notifications')
    .update({ read_at: ts, updated_at: ts })
    .eq('id', id)
    .eq('recipient_id', recipientId)

  if (error) console.warn('[kwenta-notifications] mark read:', error.message)
}

export async function deleteKwentaNotification(id: string, recipientId: string): Promise<void> {
  const { error } = await supabase
    .from('kwenta_notifications')
    .delete()
    .eq('id', id)
    .eq('recipient_id', recipientId)

  if (error) console.warn('[kwenta-notifications] delete:', error.message)
}
