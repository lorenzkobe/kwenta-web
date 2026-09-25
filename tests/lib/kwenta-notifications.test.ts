import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  fetchKwentaNotifications,
  flushQueuedKwentaNotifications,
  hasQueuedKwentaNotifications,
  notifyAddedToGroup,
  notifyBillParticipantsCreated,
  notifyPaymentRecorded,
  notifyPaymentsRecorded,
  notifyProfileLinked,
  resolveRecipientProfileIdForNotify,
} from '@/lib/kwenta-notifications'
import { useAppStore } from '@/store/app-store'
import { makeProfile, resetDb } from '../helpers/db'

// Controllable mock state for the Supabase client + sync layer. Defined via
// vi.hoisted so the vi.mock factories (which are hoisted above imports) can
// close over it.
const h = vi.hoisted(() => {
  const state = {
    session: { user: { id: 'ACTOR' } } as { user: { id: string } } | null,
    insertError: null as null | { message: string },
    selectResult: { data: [] as unknown[], error: null as null | { message: string } },
    syncErrors: [] as unknown[],
    insertedRows: [] as unknown[][],
  }
  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: unknown[]) => {
        state.insertedRows.push(rows)
        return Promise.resolve({ error: state.insertError, data: rows })
      },
      update: () => b,
      delete: () => b,
      eq: () => b,
      order: () => b,
      limit: () => Promise.resolve(state.selectResult),
      then: (resolve: (v: unknown) => unknown) => resolve(state.selectResult),
    }
    return b
  }
  return { state, builder }
})

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: h.state.session } }) },
    from: () => h.builder(),
  },
}))

const syncSpy = vi.hoisted(() => vi.fn())

vi.mock('@/sync/sync-service', () => ({
  syncRoundTrip: async (...args: unknown[]) => {
    syncSpy(...args)
    return { errors: h.state.syncErrors }
  },
}))

const OUTBOX_KEY = 'kwenta_notification_outbox_v1'

function readOutbox(): Array<{ actorId: string; rows: unknown[]; attempts: number }> {
  return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  h.state.session = { user: { id: 'ACTOR' } }
  h.state.insertError = null
  h.state.selectResult = { data: [], error: null }
  h.state.syncErrors = []
  h.state.insertedRows = []
  syncSpy.mockClear()
  useAppStore.getState().setOnline(true)
})

describe('resolveRecipientProfileIdForNotify', () => {
  it('returns the linked remote id for a linked contact', async () => {
    await db.profiles.add(
      makeProfile({ id: 'LOCAL', is_local: true, linked_profile_id: 'REMOTE' }),
    )
    expect(await resolveRecipientProfileIdForNotify('LOCAL')).toBe('REMOTE')
  })

  it('returns the own id for a non-local profile with an email', async () => {
    await db.profiles.add(makeProfile({ id: 'U', is_local: false, email: 'u@example.com' }))
    expect(await resolveRecipientProfileIdForNotify('U')).toBe('U')
  })

  it('returns null for an unlinked local contact', async () => {
    await db.profiles.add(
      makeProfile({ id: 'L', is_local: true, linked_profile_id: null }),
    )
    expect(await resolveRecipientProfileIdForNotify('L')).toBeNull()
  })

  it('returns null for a missing or deleted profile', async () => {
    expect(await resolveRecipientProfileIdForNotify('nope')).toBeNull()
    await db.profiles.add(makeProfile({ id: 'D', is_deleted: true }))
    expect(await resolveRecipientProfileIdForNotify('D')).toBeNull()
  })

  it('returns null for a non-local profile without an email', async () => {
    await db.profiles.add(makeProfile({ id: 'N', is_local: false, email: '' }))
    expect(await resolveRecipientProfileIdForNotify('N')).toBeNull()
  })
})

describe('notification senders enqueue to the outbox', () => {
  beforeEach(() => {
    // Offline → the fire-and-forget flush no-ops, leaving the outbox intact.
    useAppStore.getState().setOnline(false)
  })

  it('notifyProfileLinked queues one profile_linked row', async () => {
    await notifyProfileLinked({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'REC',
      linkedAsName: 'Bob',
    })
    const queue = readOutbox()
    expect(queue).toHaveLength(1)
    expect(queue[0].actorId).toBe('ACTOR')
    expect((queue[0].rows[0] as { kind: string }).kind).toBe('profile_linked')
    expect(await hasQueuedKwentaNotifications('ACTOR')).toBe(true)
  })

  it('notifyBillParticipantsCreated queues one row per recipient', async () => {
    await notifyBillParticipantsCreated({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: ['R1', 'R2'],
      billId: 'B',
      billTitle: 'Dinner',
      groupId: null,
      groupName: null,
    })
    const rows = readOutbox()[0].rows
    expect(rows).toHaveLength(2)
    expect((rows[0] as { kind: string }).kind).toBe('bill_participant')
  })

  it('notifyBillParticipantsCreated does nothing with no recipients', async () => {
    await notifyBillParticipantsCreated({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: [],
      billId: 'B',
      billTitle: 'Dinner',
      groupId: null,
      groupName: null,
    })
    expect(readOutbox()).toHaveLength(0)
  })

  it('notifyPaymentRecorded and notifyAddedToGroup queue their kinds', async () => {
    await notifyPaymentRecorded({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'REC',
      amount: 100,
      currency: 'PHP',
      fromName: 'Ann',
      toName: 'Bob',
      groupId: null,
      groupName: null,
      settlementId: 'S',
    })
    // perf-pass-1: notifyAddedToGroup takes `recipientIds: string[]` (one call per batch add).
    await notifyAddedToGroup({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: ['REC'],
      groupId: 'G',
      groupName: 'Trip',
    })
    const kinds = readOutbox().map((e) => (e.rows[0] as { kind: string }).kind)
    expect(kinds).toEqual(['payment_recorded', 'added_to_group'])
  })

  it('notifyAddedToGroup queues one added_to_group row per recipient', async () => {
    await notifyAddedToGroup({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: ['R1', 'R2', 'R3'],
      groupId: 'G',
      groupName: 'Trip',
    })
    const rows = readOutbox().flatMap((e) => e.rows) as Array<{
      kind: string
      recipient_id: string
      group_id: string
    }>
    expect(rows.map((r) => r.recipient_id)).toEqual(['R1', 'R2', 'R3'])
    expect(rows.every((r) => r.kind === 'added_to_group' && r.group_id === 'G')).toBe(true)
  })

  it('notifyAddedToGroup does nothing with no recipients', async () => {
    await notifyAddedToGroup({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: [],
      groupId: 'G',
      groupName: 'Trip',
    })
    expect(readOutbox()).toHaveLength(0)
  })

  it('notifyPaymentsRecorded batches all legs into a single outbox entry', async () => {
    await notifyPaymentsRecorded({
      actorId: 'ACTOR',
      actorName: 'Ann',
      groupId: 'G',
      groupName: 'Trip',
      currency: 'PHP',
      payments: [
        { recipientId: 'R1', amount: 100, fromName: 'Ann', toName: 'Bob', settlementId: 'S1' },
        { recipientId: 'R2', amount: 50, fromName: 'Cha', toName: 'Bob', settlementId: 'S2' },
        { recipientId: 'R3', amount: 25, fromName: 'Ann', toName: 'Dee', settlementId: 'S3' },
      ],
    })
    const queue = readOutbox()
    // One outbox entry (→ one batched insert on flush), not three.
    expect(queue).toHaveLength(1)
    const rows = queue[0].rows as Array<{ kind: string; recipient_id: string; entity_id: string }>
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.kind === 'payment_recorded')).toBe(true)
    expect(rows.map((r) => r.recipient_id)).toEqual(['R1', 'R2', 'R3'])
    expect(rows.map((r) => r.entity_id)).toEqual(['S1', 'S2', 'S3'])
  })

  it('notifyPaymentsRecorded does nothing with no payments', async () => {
    await notifyPaymentsRecorded({
      actorId: 'ACTOR',
      actorName: 'Ann',
      groupId: null,
      groupName: null,
      currency: 'PHP',
      payments: [],
    })
    expect(readOutbox()).toHaveLength(0)
  })
})

describe('flushQueuedKwentaNotifications', () => {
  async function seedOutboxEntry(actorId = 'ACTOR') {
    useAppStore.getState().setOnline(false)
    await notifyProfileLinked({
      actorId,
      actorName: 'Ann',
      recipientId: 'REC',
      linkedAsName: 'Bob',
    })
    useAppStore.getState().setOnline(true)
  }

  it('inserts queued rows and drains the outbox on success', async () => {
    await seedOutboxEntry()
    await flushQueuedKwentaNotifications()
    expect(h.state.insertedRows).toHaveLength(1)
    expect(readOutbox()).toHaveLength(0)
  })

  it('does nothing while offline', async () => {
    await seedOutboxEntry()
    useAppStore.getState().setOnline(false)
    await flushQueuedKwentaNotifications()
    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('skips insertion (keeps the outbox) when the pre-flush sync fails', async () => {
    await seedOutboxEntry()
    h.state.syncErrors = [{ message: 'sync down' }]
    await flushQueuedKwentaNotifications()
    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('leaves entries belonging to a different actor untouched', async () => {
    await seedOutboxEntry('OTHER')
    await flushQueuedKwentaNotifications()
    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('dead-letters an entry after repeated insert failures', async () => {
    await seedOutboxEntry()
    h.state.insertError = { message: 'permanent reject' }
    // MAX_NOTIFICATION_FLUSH_ATTEMPTS = 6 — the 6th attempt drops the entry.
    for (let i = 0; i < 6; i++) {
      await flushQueuedKwentaNotifications()
    }
    expect(readOutbox()).toHaveLength(0)
  })
})

/**
 * perf-pass-1, C11-C13. The pre-flush `syncRoundTrip` exists so a notification never points at a
 * row the server does not have. After a CLOUD-CONFIRMED write (`kwenta_write` accepted it) that
 * guarantee already holds, so the full-bundle sync is pure cost. It stays mandatory for anything
 * staged offline, and for an outbox entry written before entries carried `confirmed`.
 */
describe('flushQueuedKwentaNotifications skips the sync only for cloud-confirmed writes', () => {
  async function queueLink(cloudConfirmed: boolean | undefined, actorId = 'ACTOR') {
    useAppStore.getState().setOnline(false)
    await notifyProfileLinked({
      actorId,
      actorName: 'Ann',
      recipientId: 'REC',
      linkedAsName: 'Bob',
      ...(cloudConfirmed === undefined ? {} : { cloudConfirmed }),
    } as Parameters<typeof notifyProfileLinked>[0])
    useAppStore.getState().setOnline(true)
  }

  it('C11: a confirmed-only outbox flushes without syncRoundTrip and inserts the row', async () => {
    await queueLink(true)
    await flushQueuedKwentaNotifications()

    expect(syncSpy).not.toHaveBeenCalled()
    expect(h.state.insertedRows).toHaveLength(1)
    expect((h.state.insertedRows[0][0] as { kind: string; recipient_id: string })).toMatchObject({
      kind: 'profile_linked',
      recipient_id: 'REC',
    })
    expect(readOutbox()).toHaveLength(0)
  })

  it('C11: a confirmed-only outbox is not held back by a sync that would have failed', async () => {
    // Proves the sync is actually skipped, not merely run with its result ignored.
    await queueLink(true)
    h.state.syncErrors = [{ message: 'sync down' }]
    await flushQueuedKwentaNotifications()

    expect(syncSpy).not.toHaveBeenCalled()
    expect(h.state.insertedRows).toHaveLength(1)
  })

  it('C11: every notify helper carries cloudConfirmed into the outbox', async () => {
    useAppStore.getState().setOnline(false)
    await notifyBillParticipantsCreated({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: ['R1'],
      billId: 'B',
      billTitle: 'Dinner',
      groupId: null,
      groupName: null,
      cloudConfirmed: true,
    } as Parameters<typeof notifyBillParticipantsCreated>[0])
    await notifyPaymentRecorded({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'R2',
      amount: 100,
      currency: 'PHP',
      fromName: 'Ann',
      toName: 'Bob',
      groupId: null,
      groupName: null,
      settlementId: 'S',
      cloudConfirmed: true,
    } as Parameters<typeof notifyPaymentRecorded>[0])
    await notifyPaymentsRecorded({
      actorId: 'ACTOR',
      actorName: 'Ann',
      groupId: 'G',
      groupName: 'Trip',
      currency: 'PHP',
      payments: [{ recipientId: 'R3', amount: 10, fromName: 'Ann', toName: 'Cha', settlementId: 'S3' }],
      cloudConfirmed: true,
    } as Parameters<typeof notifyPaymentsRecorded>[0])
    await notifyAddedToGroup({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientIds: ['R4'],
      groupId: 'G',
      groupName: 'Trip',
      cloudConfirmed: true,
    } as Parameters<typeof notifyAddedToGroup>[0])
    await notifyProfileLinked({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'R5',
      linkedAsName: 'Eve',
      cloudConfirmed: true,
    } as Parameters<typeof notifyProfileLinked>[0])
    useAppStore.getState().setOnline(true)

    await flushQueuedKwentaNotifications()

    expect(syncSpy).not.toHaveBeenCalled()
    const recipients = h.state.insertedRows.flat().map((r) => (r as { recipient_id: string }).recipient_id)
    expect(recipients.sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
  })

  it('C12: an entry queued for a staged (unconfirmed) write still syncs first', async () => {
    await queueLink(false)
    await flushQueuedKwentaNotifications()

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith('ACTOR')
    expect(h.state.insertedRows).toHaveLength(1)
  })

  it('C12: omitting cloudConfirmed counts as unconfirmed and still syncs first', async () => {
    await queueLink(undefined)
    await flushQueuedKwentaNotifications()

    expect(syncSpy).toHaveBeenCalledTimes(1)
  })

  it('C12: an unconfirmed entry is still held back when the pre-flush sync fails', async () => {
    await queueLink(false)
    h.state.syncErrors = [{ message: 'sync down' }]
    await flushQueuedKwentaNotifications()

    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('C12: a mixed outbox (one confirmed, one not) syncs first', async () => {
    await queueLink(true)
    await queueLink(false)
    await flushQueuedKwentaNotifications()

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(h.state.insertedRows).toHaveLength(2)
  })

  it('C12: a mixed outbox whose sync fails inserts nothing, not even the confirmed entry', async () => {
    await queueLink(true)
    await queueLink(false)
    h.state.syncErrors = [{ message: 'sync down' }]
    await flushQueuedKwentaNotifications()

    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(2)
  })

  it("C12: another actor's unconfirmed entry does not force a sync for this actor", async () => {
    await queueLink(true, 'ACTOR')
    await queueLink(false, 'OTHER')
    await flushQueuedKwentaNotifications()

    expect(syncSpy).not.toHaveBeenCalled()
    expect(h.state.insertedRows).toHaveLength(1)
    expect(readOutbox().map((e) => e.actorId)).toEqual(['OTHER'])
  })

  it('C13: a legacy outbox entry without `confirmed` is treated as unconfirmed', async () => {
    // The shape written before perf-pass-1: every field except `confirmed`.
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify([
        {
          id: 'legacy-1',
          actorId: 'ACTOR',
          rows: [
            {
              recipient_id: 'REC',
              actor_id: 'ACTOR',
              kind: 'profile_linked',
              title: 'Linked',
              body: 'Ann linked you',
              entity_id: null,
              group_id: null,
            },
          ],
          createdAt: '2026-09-01T00:00:00.000Z',
          attempts: 0,
          lastError: null,
        },
      ]),
    )
    await flushQueuedKwentaNotifications()

    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(h.state.insertedRows).toHaveLength(1)
  })

  it('assumeCloudAck still sends an unconfirmed entry without syncing (unchanged)', async () => {
    await queueLink(false)
    await flushQueuedKwentaNotifications({ assumeCloudAck: true })

    expect(syncSpy).not.toHaveBeenCalled()
    expect(h.state.insertedRows).toHaveLength(1)
  })
})

describe('fetchKwentaNotifications', () => {
  it('returns rows from Supabase', async () => {
    h.state.selectResult = {
      data: [{ id: 'n1', recipient_id: 'REC' }],
      error: null,
    }
    const rows = await fetchKwentaNotifications('REC')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('n1')
  })

  it('returns an empty array on error', async () => {
    h.state.selectResult = { data: [], error: { message: 'boom' } }
    expect(await fetchKwentaNotifications('REC')).toEqual([])
  })
})

describe('C16: an outbox entry follows the queued write it describes', () => {
  async function queueForSubmission(submissionId: string) {
    useAppStore.getState().setOnline(false)
    await notifyProfileLinked({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'REC',
      linkedAsName: 'Bob',
      cloudConfirmed: false,
      submissionId,
    } as Parameters<typeof notifyProfileLinked>[0])
    useAppStore.getState().setOnline(true)
  }

  async function queueEntry(submissionId: string, status: string) {
    await db.pending_mutations.add({
      id: `PM-${submissionId}`, actor_user_id: 'ACTOR', operation: 'linkProfileToRemote',
      entity_type: 'profile', entity_id: 'P', payload_json: '{}', status, retry_count: 0,
      last_error: null, seq: 1, submission_id: submissionId, push: { profiles: [] },
      row_keys: [], next_attempt_at: null, last_error_kind: null,
      created_at: '2026-09-25T00:00:00.000Z', updated_at: '2026-09-25T00:00:00.000Z',
    } as never)
  }

  it('C16: the outbox entry records the submission id of its write', async () => {
    await queueForSubmission('SUB-1')

    expect((readOutbox()[0] as unknown as { submissionId?: string }).submissionId).toBe('SUB-1')
  })

  it('C16: held while its queue entry is pending — nothing inserted, entry kept', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')

    await flushQueuedKwentaNotifications()

    expect(h.state.insertedRows).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('C16: released once the entry has applied (applied entries are deleted)', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')
    await flushQueuedKwentaNotifications()
    await db.pending_mutations.delete('PM-SUB-1')

    await flushQueuedKwentaNotifications()

    expect(h.state.insertedRows).toHaveLength(1)
    expect((h.state.insertedRows[0][0] as { recipient_id: string }).recipient_id).toBe('REC')
    expect(readOutbox()).toHaveLength(0)
  })

  for (const status of ['conflict', 'blocked_by_earlier']) {
    it(`C16: never sent while its entry is ${status}`, async () => {
      await queueForSubmission('SUB-1')
      await queueEntry('SUB-1', status)

      await flushQueuedKwentaNotifications()

      expect(h.state.insertedRows).toHaveLength(0)
    })
  }

  it('C16: a held entry does not count as queued (the drain releases it, a full sync cannot)', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')

    expect(await hasQueuedKwentaNotifications('ACTOR')).toBe(false)
  })

  it('C16: once its write has applied, the same entry counts as queued again', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')
    await db.pending_mutations.delete('PM-SUB-1')

    expect(await hasQueuedKwentaNotifications('ACTOR')).toBe(true)
  })

  it('C16: an untracked entry beside a held one still counts as queued', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')
    useAppStore.getState().setOnline(false)
    await notifyProfileLinked({
      actorId: 'ACTOR', actorName: 'Ann', recipientId: 'OTHER', linkedAsName: 'Cy', cloudConfirmed: true,
    } as Parameters<typeof notifyProfileLinked>[0])
    useAppStore.getState().setOnline(true)

    expect(await hasQueuedKwentaNotifications('ACTOR')).toBe(true)
  })

  it('C16: a held entry does not hold back an unrelated one', async () => {
    await queueForSubmission('SUB-1')
    await queueEntry('SUB-1', 'pending')
    useAppStore.getState().setOnline(false)
    await notifyProfileLinked({
      actorId: 'ACTOR', actorName: 'Ann', recipientId: 'OTHER', linkedAsName: 'Cy', cloudConfirmed: true,
    } as Parameters<typeof notifyProfileLinked>[0])
    useAppStore.getState().setOnline(true)

    await flushQueuedKwentaNotifications()

    const recipients = h.state.insertedRows.flat().map((r) => (r as { recipient_id: string }).recipient_id)
    expect(recipients).toEqual(['OTHER'])
  })
})
