import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { createBill } from '@/db/operations'
import { clearKwentaLocalData } from '@/lib/clear-kwenta-local'
import { makeProfile, resetDb } from '../helpers/db'

/**
 * C27 — a response that lands after a wipe must never write to Dexie.
 *
 * `clearKwentaLocalData` runs on sign-out and on an account switch. A `kwenta_write` that was in
 * flight when it ran still resolves afterwards, and mirroring its echo would put the PREVIOUS
 * account's bill into the next account's empty mirror. The session epoch (bumped by the wipe) is
 * what every response-driven Dexie write must check. Driven through the real write path with the
 * RPC held open, so the guard is exercised where it matters rather than asserted on a counter.
 */

const cloud = vi.hoisted(() => ({
  pushes: [] as Record<string, { id: string }[]>[],
  hold: null as Promise<void> | null,
}))

vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

const BILL_INPUT = {
  title: 'Lunch',
  currency: 'PHP',
  groupId: null,
  createdBy: 'ME',
  note: '',
  items: [
    {
      name: 'Pizza',
      amount: 100,
      splits: [
        { userId: 'ME', splitType: 'equal' as const, splitValue: 1 },
        { userId: 'FR', splitType: 'equal' as const, splitValue: 1 },
      ],
    },
  ],
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  cloud.pushes = []
  cloud.hold = null
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'FR', display_name: 'Friend', is_local: true, owner_id: 'ME' }),
  ])
})

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('session epoch', () => {
  it('C27: a kwenta_write response arriving after clearKwentaLocalData writes nothing to Dexie', async () => {
    let release!: () => void
    cloud.hold = new Promise<void>((r) => {
      release = r
    })

    const save = createBill(BILL_INPUT).catch((e: unknown) => e)
    await until(() => cloud.pushes.length === 1)

    await clearKwentaLocalData()
    release()
    await save

    expect(await db.bills.count()).toBe(0)
    expect(await db.bill_items.count()).toBe(0)
    expect(await db.item_splits.count()).toBe(0)
    expect(await db.activity_log.count()).toBe(0)
    expect(await db.pending_mutations.count()).toBe(0)
  })

  it('C27 (control): the same response with no wipe in between is mirrored', async () => {
    const id = await createBill(BILL_INPUT)
    expect(await db.bills.get(id)).toBeTruthy()
  })
})
