import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import {
  fetchKwentaNotifications,
  flushQueuedKwentaNotifications,
  hasQueuedKwentaNotifications,
  notifyAddedToGroup,
  notifyBillParticipantsCreated,
  notifyPaymentRecorded,
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

vi.mock('@/sync/sync-service', () => ({
  syncRoundTrip: async () => ({ errors: h.state.syncErrors }),
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
    await notifyAddedToGroup({
      actorId: 'ACTOR',
      actorName: 'Ann',
      recipientId: 'REC',
      groupId: 'G',
      groupName: 'Trip',
    })
    const kinds = readOutbox().map((e) => (e.rows[0] as { kind: string }).kind)
    expect(kinds).toEqual(['payment_recorded', 'added_to_group'])
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
