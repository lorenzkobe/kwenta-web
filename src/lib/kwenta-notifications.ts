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
  /**
   * The write this notification describes was accepted by the server (`commitCloudFirstWrite`
   * returned `mode: 'cloud'`), so it can be sent without the pre-flush `syncRoundTrip`. Entries
   * written before this field existed lack it and are treated as unconfirmed.
   */
  confirmed?: boolean
  /**
   * The queued write this notification describes (`pending_mutations.submission_id`). Held while
   * that entry is still queued, sent once it has applied (applied entries are deleted), dropped
   * when it is refused or discarded.
   */
  submissionId?: string
}

const NOTIFICATION_OUTBOX_KEY = 'kwenta_notification_outbox_v1'
// After this many failed insert attempts, drop (dead-letter) an outbox entry so a
// permanently-rejecting notification (e.g. recipient profile deleted) doesn't retry
// forever on every sync and keep the outbox perpetually non-empty.
const MAX_NOTIFICATION_FLUSH_ATTEMPTS = 6
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

function enqueueNotificationRows(
  actorId: string,
  rows: NotificationInsertRow[],
  params: { cloudConfirmed?: boolean; submissionId?: string },
) {
  if (rows.length === 0) return
  const queue = readOutbox()
  queue.push({
    id: crypto.randomUUID(),
    actorId,
    rows,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    confirmed: params.cloudConfirmed === true,
    ...(params.submissionId ? { submissionId: params.submissionId } : {}),
  })
  writeOutbox(queue)
}

/** Forget the notifications of writes that will never land (refused, blocked or discarded). */
export function dropQueuedKwentaNotifications(submissionIds: string[]): void {
  if (submissionIds.length === 0) return
  const dropped = new Set(submissionIds)
  const queue = readOutbox()
  const next = queue.filter((entry) => !entry.submissionId || !dropped.has(entry.submissionId))
  if (next.length !== queue.length) writeOutbox(next)
}

/**
 * Whether this actor has a notification a sync or flush could send now. An entry HELD by its queued
 * write (a `pending_mutations` row with its submission id — the flush's own rule) does not count:
 * it goes out after the drain applies that write, and a full sync cannot release it. Counting it
 * made every focus run the complete bundle while a queued write waited.
 */
export async function hasQueuedKwentaNotifications(actorId: string): Promise<boolean> {
  const mine = readOutbox().filter((entry) => entry.actorId === actorId)
  if (mine.some((entry) => !entry.submissionId)) return true
  const tracked = mine.map((entry) => entry.submissionId as string)
  if (tracked.length === 0) return false
  const held = new Set(
    (await db.pending_mutations.where('submission_id').anyOf(tracked).toArray()).map((m) => m.submission_id),
  )
  return tracked.some((id) => !held.has(id))
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

    // An entry tied to a queued write waits for that write: it is still queued (held) or it has
    // applied — the queue deletes an entry once the server stores it — which confirms it.
    const tracked = queue.flatMap((entry) =>
      entry.actorId === actorId && entry.submissionId ? [entry.submissionId] : [],
    )
    const held = new Set(
      tracked.length > 0
        ? (await db.pending_mutations.where('submission_id').anyOf(tracked).toArray()).map((m) => m.submission_id)
        : [],
    )
    const isConfirmed = (entry: NotificationOutboxEntry) => entry.confirmed === true || Boolean(entry.submissionId)

    // The sync exists so a notification never points at a row the server lacks. When every entry
    // this actor would send describes a write the server already accepted, that already holds and
    // the full-bundle sync is pure cost. One unconfirmed legacy entry still gates the whole flush.
    const needsSync = queue.some((entry) => entry.actorId === actorId && !isConfirmed(entry))
    if (!options?.assumeCloudAck && needsSync) {
      const syncResult = await syncRoundTrip(actorId)
      if (syncResult.errors.length > 0) {
        return
      }
    }

    const nextQueue: NotificationOutboxEntry[] = []
    for (const entry of queue) {
      if (entry.actorId !== actorId || (entry.submissionId && held.has(entry.submissionId))) {
        nextQueue.push(entry)
        continue
      }
      const { error } = await supabase.from('kwenta_notifications').insert(entry.rows)
      if (error) {
        const attempts = entry.attempts + 1
        if (attempts >= MAX_NOTIFICATION_FLUSH_ATTEMPTS) {
          // Dead-letter: stop retrying this entry so it can't block the outbox forever.
          console.warn(
            `[notifications] dropping outbox entry after ${attempts} failed attempts:`,
            error.message,
          )
          continue
        }
        nextQueue.push({
          ...entry,
          attempts,
          lastError: error.message,
        })
      }
    }

    // The inserts awaited; meanwhile a write may have queued a notification or the write queue
    // dropped one. Keep both: a dropped entry must not come back, a new one must not be lost.
    const latest = readOutbox()
    const latestIds = new Set(latest.map((entry) => entry.id))
    const flushedIds = new Set(queue.map((entry) => entry.id))
    writeOutbox([
      ...nextQueue.filter((entry) => latestIds.has(entry.id)),
      ...latest.filter((entry) => !flushedIds.has(entry.id)),
    ])
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
  cloudConfirmed?: boolean
  submissionId?: string
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
  ], params)
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
  cloudConfirmed?: boolean
  submissionId?: string
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

  enqueueNotificationRows(params.actorId, rows, params)
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
  cloudConfirmed?: boolean
  submissionId?: string
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
  ], params)
  void flushQueuedKwentaNotifications()
}

/**
 * Bulk variant of {@link notifyPaymentRecorded}. A settle-up records many legs
 * at once; enqueueing each via notifyPaymentRecorded would create one outbox
 * entry — and one Supabase insert on flush — per leg. This batches every
 * recipient's row into ONE outbox entry (one insert) and flushes once.
 */
export async function notifyPaymentsRecorded(params: {
  actorId: string
  actorName: string
  groupId: string | null
  groupName: string | null
  currency: string
  payments: {
    recipientId: string
    amount: number
    fromName: string
    toName: string
    settlementId: string
  }[]
  cloudConfirmed?: boolean
  submissionId?: string
}): Promise<void> {
  if (params.payments.length === 0) return
  const scope =
    params.groupId && params.groupName ? `Group · ${params.groupName}` : 'Personal payment'
  const fmt = new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: params.currency,
    minimumFractionDigits: 0,
  })
  const rows: NotificationInsertRow[] = params.payments.map((p) => ({
    recipient_id: p.recipientId,
    actor_id: params.actorId,
    kind: 'payment_recorded',
    title: 'Payment recorded',
    body: `${params.actorName} recorded ${fmt.format(p.amount)} (${p.fromName} -> ${p.toName}) · ${scope}.`,
    entity_id: p.settlementId,
    group_id: params.groupId,
  }))
  enqueueNotificationRows(params.actorId, rows, params)
  void flushQueuedKwentaNotifications()
}

/** One outbox entry (one insert) for every member a single add brought in. */
export async function notifyAddedToGroup(params: {
  actorId: string
  actorName: string
  recipientIds: string[]
  groupId: string
  groupName: string
  cloudConfirmed?: boolean
  submissionId?: string
}): Promise<void> {
  if (params.recipientIds.length === 0) return
  const rows: NotificationInsertRow[] = params.recipientIds.map((recipient_id) => ({
    recipient_id,
    actor_id: params.actorId,
    kind: 'added_to_group',
    title: 'Added to a group',
    body: `${params.actorName} added you to “${params.groupName}”.`,
    entity_id: params.groupId,
    group_id: params.groupId,
  }))
  enqueueNotificationRows(params.actorId, rows, params)
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
