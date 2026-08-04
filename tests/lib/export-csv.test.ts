import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { exportBillsToCSV, exportGroupToCSV, exportPersonToCSV } from '@/lib/export-csv'
import type {
  GroupDetail,
  PersonalBillRow,
  SettlementHistoryItem,
  StatementEvent,
} from '@/api/balances'
import {
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSplit,
  resetDb,
  seedSimpleBill,
} from '../helpers/db'

/**
 * exportXToCSV builds a Blob and triggers a download. We spy on
 * URL.createObjectURL to grab the Blob, then read its text (stripping the
 * UTF-8 BOM the exporter prepends) so we can assert on the CSV body.
 */
let capturedBlob: Blob | null = null

/** Read the captured CSV body, stripping the UTF-8 BOM the exporter prepends. */
async function readCsv(): Promise<string> {
  if (!capturedBlob) throw new Error('no CSV was produced')
  const text = await capturedBlob.text()
  return text.replace(/^\uFEFF/, '')
}

beforeEach(async () => {
  await resetDb()
  capturedBlob = null
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    if (blob instanceof Blob) capturedBlob = blob
    return 'blob:mock'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The exporters now take the SCREEN's server-computed payload rather than recomputing money
 * locally, so what these assert is the CSV shape and that the given rows are rendered faithfully.
 * Which rows exist, and their amounts, is decided server-side and covered by the SQL suites
 * (059 for the bill list, 061 for group balances, 062 for the statement).
 */

function billRow(over: Partial<PersonalBillRow> = {}): PersonalBillRow {
  return {
    id: 'B1',
    title: 'Lunch',
    currency: 'PHP',
    totalAmount: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'ME',
    payorName: 'Me',
    itemCount: 1,
    settled: false,
    category: 'food',
    participants: [],
    ...over,
  }
}

describe('exportBillsToCSV', () => {
  it('emits a personal-bills CSV with the user share and settled status', async () => {
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me' }))
    await seedSimpleBill({ groupId: null, paidBy: 'ME', shares: { ME: 40, FRIEND: 60 } })
    const seeded = (await db.bills.toArray())[0]

    await exportBillsToCSV('ME', [billRow({ id: seeded.id, title: 'Lunch' })])

    const csv = await readCsv()
    expect(csv).toContain('Personal Bills')
    expect(csv).toContain('Lunch')
    // My own share still comes from my own split rows.
    expect(csv).toContain('40')
    expect(csv).toContain('No')
  })

  // The settled flag is the server's answer, not a local recomputation — that is the whole point
  // of passing rows in, since a stale mirror answers a cross-group tab differently.
  it('renders the settled flag it was given', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await exportBillsToCSV('ME', [billRow({ settled: true, title: 'Paid up' })])
    const csv = await readCsv()
    expect(csv).toContain('Paid up')
    expect(csv).toContain('Yes')
  })

  it('emits only the rows it was given', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(
      makeBill({ id: 'B9', title: 'GhostBill', created_by: 'ME', paid_by: 'ME', is_deleted: true }),
    )
    await exportBillsToCSV('ME', [billRow({ title: 'Real' })])
    const csv = await readCsv()
    expect(csv).toContain('Real')
    expect(csv).not.toContain('GhostBill')
  })

  /**
   * The pre-migration exporter concatenated both buckets internally. When the rows became a
   * parameter every caller passed only `mine`, so bills someone else created and split the viewer
   * into vanished from the export with no indication anything was missing.
   */
  it('exports bills from both buckets when it is given both', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await exportBillsToCSV('ME', [
      billRow({ id: 'B1', title: 'MyLunch', payorName: 'Me' }),
      billRow({ id: 'B2', title: 'TheirDinner', createdBy: 'FRIEND', payorName: 'Friend' }),
    ])
    const csv = await readCsv()
    expect(csv).toContain('MyLunch')
    expect(csv).toContain('TheirDinner')
    // Who paid matters on a shared bill — it is the only thing distinguishing the two buckets.
    expect(csv).toContain('Friend')
  })
})

function groupDetail(over: Partial<GroupDetail> = {}): GroupDetail {
  return {
    group: {
      id: 'G',
      name: 'Trip',
      currency: 'PHP',
      createdBy: 'A',
      inviteCode: 'x',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    members: [
      { id: 'm1', userId: 'A', profileName: 'Alice', isCurrentUser: true },
      { id: 'm2', userId: 'B', profileName: 'Bob', isCurrentUser: false },
    ],
    bills: [],
    pairwise: [{ memberUserId: 'B', displayName: 'Bob', net: 50 }],
    totalToReceive: 50,
    totalToPay: 0,
    memberBalances: [
      { userId: 'A', displayName: 'Alice', amount: 50 },
      { userId: 'B', displayName: 'Bob', amount: -50 },
    ],
    rawDebts: [{ from: 'B', to: 'A', amount: 50 }],
    ...over,
  }
}

describe('exportGroupToCSV', () => {
  it('emits group metadata, member balances, and bills', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'A', display_name: 'Alice' }),
      makeProfile({ id: 'B', display_name: 'Bob' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', name: 'Trip', created_by: 'A', currency: 'PHP' }))
    await db.group_members.bulkAdd([
      makeMember({ group_id: 'G', user_id: 'A', display_name: 'Alice' }),
      makeMember({ group_id: 'G', user_id: 'B', display_name: 'Bob' }),
    ])
    await db.bills.add(makeBill({ id: 'GB', title: 'Hotel', group_id: 'G', paid_by: 'A', total_amount: 100 }))
    await db.bill_items.add(makeItem({ id: 'GI', bill_id: 'GB', amount: 100 }))
    await db.item_splits.bulkAdd([
      makeSplit({ item_id: 'GI', user_id: 'A', computed_amount: 50 }),
      makeSplit({ item_id: 'GI', user_id: 'B', computed_amount: 50 }),
    ])

    await exportGroupToCSV(
      groupDetail({
        bills: [
          {
            id: 'GB',
            title: 'Hotel',
            note: '',
            currency: 'PHP',
            totalAmount: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            createdBy: 'A',
            paidBy: 'A',
            groupId: 'G',
            category: null,
            payorName: 'Alice',
          },
        ],
      }),
      [],
    )

    const csv = await readCsv()
    expect(csv).toContain('Trip')
    expect(csv).toContain('Hotel')
    expect(csv).toContain('Alice')
    expect(csv).toContain('Bob')
    expect(csv).toContain('MEMBER BALANCES')
    // The per-member share matrix is the one thing still read locally — it is a record of who was
    // on which item, not derived money.
    expect(csv).toContain('50')
  })

  // The balances written are the ones the screen was showing, verbatim.
  it('writes the balances it was handed, not a recomputation', async () => {
    await exportGroupToCSV(
      groupDetail({
        memberBalances: [{ userId: 'B', displayName: 'Bob', amount: -123.45 }],
        pairwise: [],
      }),
      [],
    )
    const csv = await readCsv()
    expect(csv).toContain('123.45')
    expect(csv).toContain('Pays')
  })

  /**
   * The group row used to be fetched from Dexie and a miss returned with no file and no error —
   * the user pressed Export and nothing happened. Everything identifying now comes from the
   * payload the screen already holds, so an empty mirror cannot suppress the export.
   */
  it('exports from the server payload even when the mirror holds no group row', async () => {
    await exportGroupToCSV(groupDetail(), [])
    const csv = await readCsv()
    expect(csv).toContain('Trip')
    expect(csv).toContain('Alice')
  })

  /** Payments come from the server history, so a leg missing from the mirror still exports. */
  it('writes payment legs from the history payload', async () => {
    await exportGroupToCSV(groupDetail(), [
      historyItem({
        label: 'settling up',
        legs: [{ fromUserId: 'B', fromName: 'Bob', toUserId: 'A', toName: 'Alice', amount: 50 }],
      }),
    ])
    const csv = await readCsv()
    expect(csv).toContain('PAYMENTS')
    expect(csv).toContain('Bob')
    expect(csv).toContain('settling up')
  })
})

function statementEvent(over: Partial<StatementEvent> & { id: string }): StatementEvent {
  return {
    type: 'personal_bill',
    createdAt: '2026-01-01T00:00:00.000Z',
    currency: 'PHP',
    groupId: null,
    bundleId: null,
    contextLabel: 'Personal',
    title: 'Groceries',
    rawAmount: 70,
    delta: 70,
    category: null,
    ...over,
  }
}

function historyItem(over: Partial<SettlementHistoryItem> = {}): SettlementHistoryItem {
  const base: SettlementHistoryItem = {
    id: 'S1',
    settlementIds: ['S1'],
    bundleId: null,
    isBundled: false,
    groupId: null,
    billId: null,
    billTitle: null,
    fromUserId: 'P',
    toUserId: 'ME',
    fromName: 'Pat',
    toName: 'Me',
    amount: 70,
    currency: 'PHP',
    label: '',
    createdAt: '2026-01-02T00:00:00.000Z',
    recipients: [],
    legs: [{ fromUserId: 'P', fromName: 'Pat', toUserId: 'ME', toName: 'Me', amount: 70 }],
    recordedByUserId: null,
    recordedByName: null,
  }
  return { ...base, ...over }
}

describe('exportPersonToCSV', () => {
  it('emits a per-person CSV from the statement events', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME', display_name: 'Me' }),
      makeProfile({ id: 'P', display_name: 'Pat' }),
    ])

    await exportPersonToCSV(
      'P',
      'ME',
      [statementEvent({ id: 'b1', title: 'Groceries', delta: 70 })],
      [historyItem()],
    )

    const csv = await readCsv()
    expect(csv).toContain('Pat')
    expect(csv).toContain('Groceries')
    expect(csv).toContain('Pat owes you')
    expect(csv).toContain('PAYMENTS')
  })

  it('labels direction from the viewer’s side', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME', display_name: 'Me' }),
      makeProfile({ id: 'P', display_name: 'Pat' }),
    ])
    await exportPersonToCSV(
      'P',
      'ME',
      [statementEvent({ id: 'b1', delta: -25, title: 'Taxi' })],
      [],
    )
    const csv = await readCsv()
    expect(csv).toContain('You owe Pat')
  })

  it('omits the payments section when there are none', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await exportPersonToCSV('P', 'ME', [statementEvent({ id: 'b1', delta: 10 })], [])
    const csv = await readCsv()
    expect(csv).not.toContain('PAYMENTS')
  })

  /**
   * A payment's parties and the user's own note live on the stored settlement rows and nowhere
   * else. Deriving the Payments section from statement events dropped both — an event carries
   * only a generated "You paid X" description — so a note could not be exported at all.
   */
  it('writes the payment parties and the user’s note, not the generated description', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME', display_name: 'Me' }),
      makeProfile({ id: 'P', display_name: 'Pat' }),
    ])

    await exportPersonToCSV(
      'P',
      'ME',
      [],
      [historyItem({ label: 'rent June, half', fromName: 'Pat', toName: 'Me' })],
    )

    const csv = await readCsv()
    expect(csv).toContain('Date,From,To,Amount,Currency,Group,Note')
    expect(csv).toContain('"rent June, half"')
    expect(csv).toContain('Pat')
    expect(csv).toContain('Me')
  })

  /** A bundled payment is several real transfers; one CSV row per stored leg, not per bundle. */
  it('emits one row per leg of a bundled payment', async () => {
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me' }))

    await exportPersonToCSV(
      'P',
      'ME',
      [],
      [
        historyItem({
          isBundled: true,
          bundleId: 'BU1',
          settlementIds: ['S1', 'S2'],
          legs: [
            { fromUserId: 'ME', fromName: 'Me', toUserId: 'P', toName: 'Pat', amount: 30 },
            { fromUserId: 'P', fromName: 'Pat', toUserId: 'C', toName: 'Cha', amount: 30 },
          ],
        }),
      ],
    )

    const csv = await readCsv()
    const paymentLines = csv.split('\r\n').filter((l) => l.includes('30'))
    expect(paymentLines).toHaveLength(2)
    expect(csv).toContain('Cha')
  })

  /** The Category column was rendered but always blank once bills came from statement events. */
  it('writes the bill category it was given', async () => {
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me' }))
    await exportPersonToCSV(
      'P',
      'ME',
      [statementEvent({ id: 'b1', title: 'Dinner', category: 'food' })],
      [],
    )
    const csv = await readCsv()
    expect(csv).toContain('Date,Bill Title,Category,Group,Currency,Balance,Direction')
    expect(csv).toContain('Food')
  })
})
