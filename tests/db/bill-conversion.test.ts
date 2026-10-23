import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { createBill, deletePerson, updateBill } from '@/db/operations'
import { loadStagedBillDetail, loadStagedPersonalBillRows } from '@/lib/staged-rows'
import { makeGroup, makeMember, makeProfile, resetDb } from '../helpers/db'

// Foreign-currency bills through the REAL builders and the real cloud-first commit (the Supabase
// RPC is the fake server in ../helpers/cloud-sync-mock, as tests/db/cloud-first-write.test.ts
// does). A converted bill stores its BALANCE-currency money in the existing columns (so every SQL
// money function is untouched) plus what was typed: bills.original_currency / exchange_rate /
// rate_source / original_total, bill_items.original_amount, item_splits.original_amount.
//
// Expected numbers are hand-derived: 500000 VND x 0.00246385 = 1231.925 -> 1231.93 PHP; the two
// 250000 VND shares split 123193 cents as 61597 + 61596 (largest remainder, tie to the earliest).

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop' | 'reject' | 'transport' | 'lost' | 'inactive',
  status: 0 as number,
  errorCode: undefined as string | undefined,
  errorStatus: undefined as number | undefined,
  submissionIds: [] as (string | undefined)[],
  refuse: new Set<string>(),
  pushes: [] as Record<string, Record<string, unknown>[]>[],
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

const VND_PHP = 0.00246385

const EQUAL_ME_FR = [
  { userId: 'ME', splitType: 'equal' as const, splitValue: 1 },
  { userId: 'FR', splitType: 'equal' as const, splitValue: 1 },
]

const VND_BILL = {
  title: 'Pho night',
  currency: 'PHP',
  groupId: null,
  createdBy: 'ME',
  note: '',
  items: [{ name: 'Pho', amount: 500000, splits: EQUAL_ME_FR }],
  conversion: { fromCurrency: 'VND', rate: VND_PHP, source: 'online' as const },
}

const PLAIN_BILL = {
  title: 'Lunch',
  currency: 'PHP',
  groupId: null,
  createdBy: 'ME',
  note: '',
  items: [{ name: 'Pizza', amount: 100, splits: EQUAL_ME_FR }],
}

type Row = Record<string, unknown>

async function liveItems(billId: string) {
  return (await db.bill_items.where('bill_id').equals(billId).toArray()).filter((i) => !i.is_deleted) as unknown as Row[]
}

async function liveSplitsOf(itemId: string) {
  // Dexie returns ids in random-UUID key order: compare order-insensitively.
  return ((await db.item_splits.where('item_id').equals(itemId).toArray()).filter((s) => !s.is_deleted) as unknown as Row[])
    .sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)))
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await resetDb()
  cloud.mode = 'ok'
  cloud.refuse = new Set()
  cloud.pushes = []
  cloud.hold = null
  cloud.status = 0
  cloud.errorCode = undefined
  cloud.errorStatus = undefined
  cloud.submissionIds = []
  // No rate is ever fetched on the save path (C22): a call here fails the test that made it.
  fetchSpy = vi.fn(async () => {
    throw new TypeError('Failed to fetch')
  })
  vi.stubGlobal('fetch', fetchSpy)
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'FR', display_name: 'Friend', is_local: true, owner_id: 'ME' }),
  ])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createBill with a conversion', () => {
  it('C1: VND -> PHP stores the PHP amounts, the typed VND amounts and the locked rate', async () => {
    const billId = await createBill(VND_BILL)

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.currency).toBe('PHP')
    expect(bill.total_amount).toBe(1231.93)
    expect(bill.original_currency).toBe('VND')
    expect(bill.original_total).toBe(500000)
    expect(bill.exchange_rate).toBe(0.00246385)
    expect(bill.rate_source).toBe('online')

    const items = await liveItems(billId)
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(1231.93)
    expect(items[0].original_amount).toBe(500000)

    const splits = await liveSplitsOf(items[0].id as string)
    expect(splits.map((s) => s.original_amount)).toEqual([250000, 250000])
    expect(splits.map((s) => s.split_value)).toEqual([1, 1])
    const computed = splits.map((s) => s.computed_amount as number).sort((a, b) => b - a)
    expect(computed).toEqual([615.97, 615.96])
    expect(Math.round(computed.reduce((s, x) => s + x, 0) * 100)).toBe(123193)
  })

  it('C1: the first listed participant gets the extra cent (tie to the earliest index)', async () => {
    await createBill(VND_BILL)
    const push = cloud.pushes[0]
    // The push keeps builder order, unlike a Dexie read.
    expect(push.item_splits.map((s) => [s.user_id, s.computed_amount])).toEqual([
      ['ME', 615.97],
      ['FR', 615.96],
    ])
  })

  it('C2: a group bill converts into the group currency, in ONE write with its activity line', async () => {
    await db.groups.add(makeGroup({ id: 'G1', currency: 'USD', created_by: 'ME' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G1', user_id: 'ME', display_name: 'Me' }),
      makeMember({ group_id: 'G1', user_id: 'FR', display_name: 'Friend' }),
    ])

    // 500000 VND x 0.00004 = 20.00 USD -> 10.00 each.
    const billId = await createBill({
      ...VND_BILL,
      currency: 'USD',
      groupId: 'G1',
      conversion: { fromCurrency: 'VND', rate: 0.00004, source: 'manual' },
    })

    expect(cloud.pushes).toHaveLength(1)
    const push = cloud.pushes[0]
    expect(push.bills).toHaveLength(1)
    expect(push.bill_items).toHaveLength(1)
    expect(push.item_splits).toHaveLength(2)
    expect(push.activity_log).toHaveLength(1)

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.group_id).toBe('G1')
    expect(bill.currency).toBe('USD')
    expect(bill.total_amount).toBe(20)
    expect(bill.original_currency).toBe('VND')
    expect(bill.original_total).toBe(500000)
    expect(bill.exchange_rate).toBe(0.00004)
    expect(bill.rate_source).toBe('manual')
    const items = await liveItems(billId)
    const splits = await liveSplitsOf(items[0].id as string)
    expect(splits.map((s) => s.computed_amount)).toEqual([10, 10])
    expect(splits.map((s) => s.original_amount)).toEqual([250000, 250000])
  })

  it('C5: a quantity line stores the converted UNIT price; the bill total comes from the converted shares', async () => {
    // 2.5 USD each, ME x3 + FR x1 = 10 USD -> 563 PHP (422.25 / 140.75); item amount = 140.75.
    const billId = await createBill({
      ...VND_BILL,
      items: [
        {
          name: 'Beer',
          amount: 2.5,
          splits: [
            { userId: 'ME', splitType: 'quantity', splitValue: 3 },
            { userId: 'FR', splitType: 'quantity', splitValue: 1 },
          ],
        },
      ],
      conversion: { fromCurrency: 'USD', rate: 56.3, source: 'manual' },
    })

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.total_amount).toBe(563)
    expect(bill.original_total).toBe(10)
    const items = await liveItems(billId)
    expect(items[0].amount).toBe(140.75)
    expect(items[0].original_amount).toBe(2.5)
    const byUser = new Map((await liveSplitsOf(items[0].id as string)).map((s) => [s.user_id, s]))
    expect(byUser.get('ME')).toMatchObject({ split_value: 3, computed_amount: 422.25, original_amount: 7.5 })
    expect(byUser.get('FR')).toMatchObject({ split_value: 1, computed_amount: 140.75, original_amount: 2.5 })
  })

  it('C5: percentage keeps the percentage; custom stores the converted share, and auto (0) stays 0', async () => {
    const billId = await createBill({
      ...VND_BILL,
      items: [
        {
          name: 'Tour',
          amount: 10,
          splits: [
            { userId: 'ME', splitType: 'percentage', splitValue: 60 },
            { userId: 'FR', splitType: 'percentage', splitValue: 40 },
          ],
        },
        {
          name: 'Taxi',
          amount: 10,
          splits: [
            { userId: 'ME', splitType: 'custom', splitValue: 7 },
            { userId: 'FR', splitType: 'custom', splitValue: 0 },
          ],
        },
      ],
      conversion: { fromCurrency: 'USD', rate: 56.3, source: 'manual' },
    })

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.total_amount).toBe(1126)
    expect(bill.original_total).toBe(20)

    const items = await liveItems(billId)
    const tour = items.find((i) => i.name === 'Tour')!
    const taxi = items.find((i) => i.name === 'Taxi')!
    expect(tour.amount).toBe(563)
    expect(taxi.amount).toBe(563)

    const pct = new Map((await liveSplitsOf(tour.id as string)).map((s) => [s.user_id, s]))
    expect(pct.get('ME')).toMatchObject({ split_type: 'percentage', split_value: 60, computed_amount: 337.8, original_amount: 6 })
    expect(pct.get('FR')).toMatchObject({ split_type: 'percentage', split_value: 40, computed_amount: 225.2, original_amount: 4 })

    const custom = new Map((await liveSplitsOf(taxi.id as string)).map((s) => [s.user_id, s]))
    expect(custom.get('ME')).toMatchObject({ split_type: 'custom', split_value: 394.1, computed_amount: 394.1, original_amount: 7 })
    expect(custom.get('FR')).toMatchObject({ split_type: 'custom', split_value: 0, computed_amount: 168.9, original_amount: 3 })
  })
})

describe('without a conversion', () => {
  it('C3: createBill writes today\'s rows with every new field null', async () => {
    const billId = await createBill(PLAIN_BILL)

    const push = cloud.pushes[0]
    const pushedBill = push.bills[0]
    expect(pushedBill.total_amount).toBe(100)
    expect(pushedBill.currency).toBe('PHP')
    for (const k of ['original_currency', 'exchange_rate', 'rate_source', 'original_total']) {
      expect(pushedBill[k], k).toBeNull()
    }
    expect(push.bill_items[0].amount).toBe(100)
    expect(push.bill_items[0].original_amount).toBeNull()
    expect(push.item_splits.map((s) => [s.split_value, s.computed_amount, s.original_amount])).toEqual([
      [1, 50, null],
      [1, 50, null],
    ])

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.original_currency).toBeNull()
    expect(bill.exchange_rate).toBeNull()
  })

  it('C3: conversion: null is the same as no conversion', async () => {
    await createBill({ ...PLAIN_BILL, conversion: null })
    const pushedBill = cloud.pushes[0].bills[0]
    expect(pushedBill.total_amount).toBe(100)
    expect(pushedBill.original_currency).toBeNull()
    expect(cloud.pushes[0].bill_items[0].original_amount).toBeNull()
  })

  it('C3: updateBill of a plain bill keeps the new fields null', async () => {
    const billId = await createBill(PLAIN_BILL)
    await updateBill(billId, 'ME', {
      title: 'Lunch',
      note: '',
      currency: 'PHP',
      items: [{ name: 'Pizza', amount: 120, splits: EQUAL_ME_FR }],
    })

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.total_amount).toBe(120)
    expect(bill.original_currency).toBeNull()
    expect(bill.original_total).toBeNull()
    const items = await liveItems(billId)
    expect(items[0].original_amount).toBeNull()
    expect((await liveSplitsOf(items[0].id as string)).map((s) => s.original_amount)).toEqual([null, null])
  })
})

describe('refused conversions (C6)', () => {
  const bad: [string, unknown][] = [
    ['rate 0', { fromCurrency: 'VND', rate: 0, source: 'manual' }],
    ['a negative rate', { fromCurrency: 'VND', rate: -VND_PHP, source: 'manual' }],
    ['NaN', { fromCurrency: 'VND', rate: Number.NaN, source: 'manual' }],
    ['Infinity', { fromCurrency: 'VND', rate: Number.POSITIVE_INFINITY, source: 'manual' }],
    ['a string rate', { fromCurrency: 'VND', rate: '0.00246385', source: 'manual' }],
    ['a missing rate', { fromCurrency: 'VND', source: 'manual' }],
    ['fromCurrency equal to the bill currency', { fromCurrency: 'PHP', rate: 1, source: 'manual' }],
  ]

  for (const [label, conversion] of bad) {
    it(`C6: createBill refuses ${label} before any network call, Dexie untouched`, async () => {
      await expect(
        createBill({ ...VND_BILL, conversion: conversion as typeof VND_BILL.conversion }),
      ).rejects.toThrow()

      expect(cloud.pushes).toHaveLength(0)
      expect(cloud.submissionIds).toHaveLength(0)
      expect(await db.bills.count()).toBe(0)
      expect(await db.bill_items.count()).toBe(0)
      expect(await db.item_splits.count()).toBe(0)
      expect(await db.activity_log.count()).toBe(0)
      expect(await db.pending_mutations.count()).toBe(0)
    })
  }

  it('C6: offline, a refused conversion is not queued either', async () => {
    cloud.mode = 'transport'
    await expect(
      createBill({ ...VND_BILL, conversion: { fromCurrency: 'VND', rate: 0, source: 'manual' } }),
    ).rejects.toThrow()
    expect(cloud.submissionIds).toHaveLength(0)
    expect(await db.pending_mutations.count()).toBe(0)
    expect(await db.bills.count()).toBe(0)
  })

  it('C6: updateBill refuses a bad rate and leaves the stored bill as it was', async () => {
    const billId = await createBill(VND_BILL)
    expect(cloud.pushes).toHaveLength(1)

    await expect(
      updateBill(billId, 'ME', {
        title: 'Pho night',
        note: '',
        currency: 'PHP',
        items: VND_BILL.items,
        conversion: { fromCurrency: 'VND', rate: -1, source: 'manual' },
      }),
    ).rejects.toThrow()
    await expect(
      updateBill(billId, 'ME', {
        title: 'Pho night',
        note: '',
        currency: 'PHP',
        items: VND_BILL.items,
        conversion: { fromCurrency: 'PHP', rate: 1, source: 'manual' },
      }),
    ).rejects.toThrow()

    expect(cloud.pushes).toHaveLength(1)
    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.exchange_rate).toBe(0.00246385)
    expect(bill.total_amount).toBe(1231.93)
  })
})

describe('updateBill of a converted bill (C7)', () => {
  it('C7: re-saving with the same conversion keeps the rate exactly and the amounts unchanged', async () => {
    const billId = await createBill(VND_BILL)
    await updateBill(billId, 'ME', {
      title: 'Pho night',
      note: 'edited',
      currency: 'PHP',
      items: VND_BILL.items,
      conversion: VND_BILL.conversion,
    })

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.note).toBe('edited')
    expect(bill.exchange_rate).toBe(0.00246385)
    expect(bill.rate_source).toBe('online')
    expect(bill.total_amount).toBe(1231.93)
    expect(bill.original_total).toBe(500000)
    const items = await liveItems(billId)
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(1231.93)
    expect(items[0].original_amount).toBe(500000)
  })

  it('C7: a new rate re-converts every row', async () => {
    const billId = await createBill(VND_BILL)
    // 500000 x 0.0025 = 1250 -> 625 / 625.
    await updateBill(billId, 'ME', {
      title: 'Pho night',
      note: '',
      currency: 'PHP',
      items: VND_BILL.items,
      conversion: { fromCurrency: 'VND', rate: 0.0025, source: 'manual' },
    })

    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.exchange_rate).toBe(0.0025)
    expect(bill.rate_source).toBe('manual')
    expect(bill.total_amount).toBe(1250)
    expect(bill.original_total).toBe(500000)
    const items = await liveItems(billId)
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(1250)
    const splits = await liveSplitsOf(items[0].id as string)
    expect(splits.map((s) => s.computed_amount)).toEqual([625, 625])
    expect(splits.map((s) => s.original_amount)).toEqual([250000, 250000])
  })

  for (const [label, conversion] of [
    ['conversion: null', null],
    ['conversion omitted', undefined],
  ] as const) {
    it(`C7: ${label} clears the four bill fields and every item/split original_amount`, async () => {
      const billId = await createBill(VND_BILL)
      await updateBill(billId, 'ME', {
        title: 'Pho night',
        note: '',
        currency: 'PHP',
        items: [{ name: 'Pho', amount: 1231.93, splits: EQUAL_ME_FR }],
        ...(conversion === undefined ? {} : { conversion }),
      })

      const bill = (await db.bills.get(billId)) as unknown as Row
      expect(bill.total_amount).toBe(1231.93)
      expect(bill.original_currency).toBeNull()
      expect(bill.exchange_rate).toBeNull()
      expect(bill.rate_source).toBeNull()
      expect(bill.original_total).toBeNull()
      const items = await liveItems(billId)
      expect(items).toHaveLength(1)
      expect(items[0].amount).toBe(1231.93)
      expect(items[0].original_amount).toBeNull()
      const splits = await liveSplitsOf(items[0].id as string)
      expect(splits.map((s) => s.original_amount)).toEqual([null, null])
      expect(splits.map((s) => s.computed_amount).sort()).toEqual([615.96, 615.97])
    })
  }

  it('C7: an update is still ONE write (bill + retired and new children + activity)', async () => {
    const billId = await createBill(VND_BILL)
    await updateBill(billId, 'ME', {
      title: 'Pho night',
      note: '',
      currency: 'PHP',
      items: VND_BILL.items,
      conversion: { fromCurrency: 'VND', rate: 0.0025, source: 'manual' },
    })
    expect(cloud.pushes).toHaveLength(2)
    const push = cloud.pushes[1]
    expect(push.bills).toHaveLength(1)
    expect(push.bill_items).toHaveLength(2) // the retired item + the new one
    expect(push.item_splits).toHaveLength(4)
    expect(push.activity_log).toHaveLength(1)
  })
})

describe('offline and rate-independence', () => {
  it('C20: an offline save queues the exact converted rows', async () => {
    cloud.mode = 'transport'

    const billId = await createBill(VND_BILL)

    const entries = (await db.pending_mutations.toArray()) as unknown as Row[]
    expect(entries).toHaveLength(1)
    const push = entries[0].push as Record<string, Row[]>
    expect(push.bills[0]).toMatchObject({
      id: billId,
      currency: 'PHP',
      total_amount: 1231.93,
      original_currency: 'VND',
      exchange_rate: 0.00246385,
      rate_source: 'online',
      original_total: 500000,
    })
    expect(push.bill_items[0]).toMatchObject({ amount: 1231.93, original_amount: 500000 })
    expect(push.item_splits.map((s) => [s.computed_amount, s.original_amount])).toEqual([
      [615.97, 250000],
      [615.96, 250000],
    ])
  })

  it('C20: the staged Bills list row of an unsent converted bill carries the original amount', async () => {
    cloud.mode = 'transport'
    const billId = await createBill(VND_BILL)

    const rows = await loadStagedPersonalBillRows('ME')
    const row = rows.find((r) => r.id === billId) as unknown as Row
    expect(row).toBeTruthy()
    expect(row.originalCurrency).toBe('VND')
    expect(row.originalTotal).toBe(500000)
    expect(row.exchangeRate).toBe(0.00246385)
  })

  it('C20: the staged bill detail of an unsent converted bill carries the originals', async () => {
    cloud.mode = 'transport'
    const billId = await createBill(VND_BILL)

    const detail = await loadStagedBillDetail(billId, 'ME')
    expect(detail).not.toBeNull()
    const bill = detail!.bill as unknown as Row
    expect(bill.originalCurrency).toBe('VND')
    expect(bill.exchangeRate).toBe(0.00246385)
    expect(bill.rateSource).toBe('online')
    expect(bill.originalTotal).toBe(500000)
    const item = detail!.items[0] as unknown as Row & { splits: Row[] }
    expect(item.originalAmount).toBe(500000)
    expect(item.splits.map((s) => s.originalAmount)).toEqual([250000, 250000])
  })

  it('C20: a staged plain bill reads as unconverted (null, not undefined)', async () => {
    cloud.mode = 'transport'
    const billId = await createBill(PLAIN_BILL)

    const row = (await loadStagedPersonalBillRows('ME')).find((r) => r.id === billId) as unknown as Row
    expect(row.originalCurrency).toBeNull()
    expect(row.originalTotal).toBeNull()
    expect(row.exchangeRate).toBeNull()
    const detail = await loadStagedBillDetail(billId, 'ME')
    expect((detail!.bill as unknown as Row).originalCurrency).toBeNull()
    expect((detail!.items[0] as unknown as Row).originalAmount).toBeNull()
  })

  it('C21: with the rate service unreachable, a typed manual rate saves and is recorded as manual', async () => {
    const billId = await createBill({
      ...VND_BILL,
      conversion: { fromCurrency: 'VND', rate: 0.0025, source: 'manual' },
    })
    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.rate_source).toBe('manual')
    expect(bill.exchange_rate).toBe(0.0025)
    expect(bill.total_amount).toBe(1250)
  })

  it('C21: offline with a manual rate, the bill is staged and queued, not refused', async () => {
    cloud.mode = 'transport'
    const billId = await createBill({
      ...VND_BILL,
      conversion: { fromCurrency: 'VND', rate: 0.0025, source: 'manual' },
    })
    const bill = (await db.bills.get(billId)) as unknown as Row
    expect(bill.synced_at).toBeNull()
    expect(bill.rate_source).toBe('manual')
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('C22: saving a converted bill makes no rate request and one write', async () => {
    await createBill(VND_BILL)
    const billId = (await db.bills.toArray())[0].id
    await updateBill(billId, 'ME', {
      title: 'Pho night',
      note: '',
      currency: 'PHP',
      items: VND_BILL.items,
      conversion: VND_BILL.conversion,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(cloud.pushes).toHaveLength(2)
  })
})

describe('too-large converted amounts (builder cap)', () => {
  for (const [label, rate] of [
    ['a rate typed in the wrong direction on a huge amount', 1e9],
    ['an overflowing rate', 1e300],
  ] as const) {
    it(`refuses ${label} with a readable message, before any network call, Dexie untouched`, async () => {
      await expect(
        createBill({ ...VND_BILL, conversion: { fromCurrency: 'VND', rate, source: 'manual' } }),
      ).rejects.toThrow(/too large/i)

      expect(cloud.pushes).toHaveLength(0)
      expect(cloud.submissionIds).toHaveLength(0)
      expect(await db.bills.count()).toBe(0)
      expect(await db.pending_mutations.count()).toBe(0)
    })
  }

  it('H9.1: 50,000,000 VND at the backwards rate 405.87 (2.03e10 PHP) overflows numeric(12,2) and is refused', async () => {
    const bill = { ...VND_BILL, items: [{ name: 'Tour', amount: 50_000_000, splits: EQUAL_ME_FR }] }
    await expect(
      createBill({ ...bill, conversion: { fromCurrency: 'VND', rate: 405.87, source: 'manual' } }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(0)
    expect(cloud.submissionIds).toHaveLength(0)
    expect(await db.bills.count()).toBe(0)

    // The right direction (123,192.50 PHP) saves.
    const billId = await createBill({ ...bill, conversion: { fromCurrency: 'VND', rate: 0.00246385, source: 'online' } })
    const saved = (await db.bills.get(billId)) as unknown as Row
    expect(saved.total_amount).toBe(123192.5)
    expect(saved.original_total).toBe(50_000_000)
  })

  it('H9.1: a custom share of 1e8 or more would overflow split_value numeric(12,4) and is refused', async () => {
    await expect(
      createBill({
        ...VND_BILL,
        items: [
          {
            name: 'Villa',
            amount: 1e8,
            splits: [
              { userId: 'ME', splitType: 'custom', splitValue: 1e8 },
              { userId: 'FR', splitType: 'custom', splitValue: 0 },
            ],
          },
        ],
        conversion: { fromCurrency: 'VND', rate: 1, source: 'manual' },
      }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(0)
  })

  it('H16.1: a custom share that is small as typed but converts to 2.8e8 overflows split_value numeric(12,4)', async () => {
    // 5,000,000 USD x 56.3 = 281,500,000 PHP: fine for numeric(12,2) (< 1e10), not for split_value (< 1e8).
    await expect(
      createBill({
        ...VND_BILL,
        items: [
          {
            name: 'Villa',
            amount: 5_000_000,
            splits: [
              { userId: 'ME', splitType: 'custom', splitValue: 5_000_000 },
              { userId: 'FR', splitType: 'custom', splitValue: 0 },
            ],
          },
        ],
        conversion: { fromCurrency: 'USD', rate: 56.3, source: 'manual' },
      }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(0)
    expect(await db.bills.count()).toBe(0)
  })

  it('H16.1: a converted total around 1.5e10 (overflows numeric(12,2)) is refused', async () => {
    await expect(
      createBill({
        ...VND_BILL,
        items: [{ name: 'Tour', amount: 37_000_000, splits: EQUAL_ME_FR }],
        conversion: { fromCurrency: 'VND', rate: 405.87, source: 'manual' },
      }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(0)
  })

  it('refuses an original amount of 1e14 or more even at a rate of 1e-9', async () => {
    await expect(
      createBill({
        ...VND_BILL,
        items: [{ name: 'Yacht', amount: 1e14, splits: EQUAL_ME_FR }],
        conversion: { fromCurrency: 'VND', rate: 1e-9, source: 'manual' },
      }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(0)
  })

  it('updateBill refuses it too and leaves the stored bill as it was', async () => {
    const billId = await createBill(VND_BILL)
    await expect(
      updateBill(billId, 'ME', {
        title: 'Pho night',
        note: '',
        currency: 'PHP',
        items: VND_BILL.items,
        conversion: { fromCurrency: 'VND', rate: 1e9, source: 'manual' },
      }),
    ).rejects.toThrow(/too large/i)
    expect(cloud.pushes).toHaveLength(1)
    expect(((await db.bills.get(billId)) as unknown as Row).total_amount).toBe(1231.93)
  })

  it('accepts a large but sane conversion (500000 VND at 405.87 PHP per VND is 202,935,000)', async () => {
    const billId = await createBill({
      ...VND_BILL,
      conversion: { fromCurrency: 'VND', rate: 405.87, source: 'manual' },
    })
    expect(((await db.bills.get(billId)) as unknown as Row).total_amount).toBe(202935000)
  })
})

describe('deletePerson on a converted personal bill (H8.1)', () => {
  it('re-divides the paid-in shares and keeps the balance shares summing to the item amount', async () => {
    await db.profiles.add(makeProfile({ id: 'B3', display_name: 'Third', is_local: true, owner_id: 'ME' }))
    const billId = await createBill({
      ...VND_BILL,
      items: [
        {
          name: 'Pho',
          amount: 500000,
          splits: [
            { userId: 'ME', splitType: 'equal', splitValue: 1 },
            { userId: 'FR', splitType: 'equal', splitValue: 1 },
            { userId: 'B3', splitType: 'equal', splitValue: 1 },
          ],
        },
      ],
    })
    const before = await liveItems(billId)
    const beforeSplits = await liveSplitsOf(before[0].id as string)
    expect(beforeSplits.map((s) => s.original_amount).sort()).toEqual([166666.66, 166666.66, 166666.68])

    await deletePerson('B3', 'ME')

    const items = await liveItems(billId)
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(1231.93)
    expect(items[0].original_amount).toBe(500000)
    const splits = await liveSplitsOf(items[0].id as string)
    expect(splits.map((s) => s.user_id)).toEqual(['FR', 'ME'])
    // Which survivor takes the extra cent follows Dexie's random-UUID read order.
    expect(splits.map((s) => s.original_amount)).toEqual([250000, 250000])
    expect(splits.map((s) => s.computed_amount as number).sort((a, b) => a - b)).toEqual([615.96, 615.97])
    const balanceCents = Math.round(splits.reduce((sum, s) => sum + (s.computed_amount as number), 0) * 100)
    expect(balanceCents).toBe(123193)
    expect(splits.reduce((sum, s) => sum + (s.original_amount as number), 0)).toBe(500000)
  })
})
