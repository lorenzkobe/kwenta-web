import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { exportBillsToCSV, exportGroupToCSV, exportPersonToCSV } from '@/lib/export-csv'
import {
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSettlement,
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
  return text.replace(/^﻿/, '')
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

describe('exportBillsToCSV', () => {
  it('emits a personal-bills CSV with the user share and settled status', async () => {
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me' }))
    await seedSimpleBill({
      groupId: null,
      paidBy: 'ME',
      shares: { ME: 40, FRIEND: 60 },
    })
    // Rename the seeded bill so we can assert on its title.
    const bill = (await db.bills.toArray())[0]
    await db.bills.update(bill.id, { title: 'Lunch', category: 'food' })

    await exportBillsToCSV('ME')

    const csv = await readCsv()
    expect(csv).toContain('Personal Bills')
    expect(csv).toContain('Lunch')
    // My share (40) appears; bill is unsettled (no settlements) → 'No'.
    expect(csv).toContain('40')
    expect(csv).toContain('No')
  })

  it('excludes soft-deleted bills', async () => {
    await db.profiles.add(makeProfile({ id: 'ME' }))
    await db.bills.add(
      makeBill({ id: 'B1', title: 'GhostBill', created_by: 'ME', paid_by: 'ME', is_deleted: true }),
    )
    await exportBillsToCSV('ME')
    const csv = await readCsv()
    expect(csv).not.toContain('GhostBill')
  })
})

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
    const bill = makeBill({ id: 'GB', title: 'Hotel', group_id: 'G', paid_by: 'A', total_amount: 100 })
    const item = makeItem({ id: 'GI', bill_id: 'GB', amount: 100 })
    await db.bills.add(bill)
    await db.bill_items.add(item)
    await db.item_splits.bulkAdd([
      makeSplit({ item_id: 'GI', user_id: 'A', computed_amount: 50 }),
      makeSplit({ item_id: 'GI', user_id: 'B', computed_amount: 50 }),
    ])

    await exportGroupToCSV('G', 'A')

    const csv = await readCsv()
    expect(csv).toContain('Trip')
    expect(csv).toContain('Hotel')
    expect(csv).toContain('Alice')
    expect(csv).toContain('Bob')
    expect(csv).toContain('MEMBER BALANCES')
  })

  it('returns silently when the group does not exist', async () => {
    await exportGroupToCSV('missing', 'A')
    expect(capturedBlob).toBeNull()
  })
})

describe('exportPersonToCSV', () => {
  it('emits a per-person CSV with shared bills', async () => {
    await db.profiles.bulkAdd([
      makeProfile({ id: 'ME', display_name: 'Me' }),
      makeProfile({ id: 'P', display_name: 'Pat' }),
    ])
    await seedSimpleBill({
      groupId: null,
      paidBy: 'ME',
      shares: { ME: 30, P: 70 },
    })
    const bill = (await db.bills.toArray())[0]
    await db.bills.update(bill.id, { title: 'Groceries' })
    await db.settlements.add(
      makeSettlement({ from_user_id: 'P', to_user_id: 'ME', amount: 70, group_id: null }),
    )

    await exportPersonToCSV('P', 'ME')

    const csv = await readCsv()
    expect(csv).toContain('Pat')
    expect(csv).toContain('Groceries')
  })
})
