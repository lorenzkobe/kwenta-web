import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Table } from 'dexie'
import { db } from '@/db/db'
import { KWENTA_LAST_REFRESH_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

/**
 * The header's "unsent" indicator, against a REAL Dexie (the sibling RefreshButton suite stubs
 * `useLiveQuery`, so it cannot see what the query reads).
 *
 * C29: the live query re-runs on every Dexie write, so a full-table `toArray` per synced table ran
 * after every write on every screen. The indicator must answer from index counts.
 * C32 / H1.2: queue entries are the source of truth for "unsent" (pending) and "not applied"
 * (conflict); a conflict entry must not read as pending forever.
 */

vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'ME', profile: undefined }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
  },
}))

import { RefreshButton } from '@/components/common/RefreshButton'

const SYNCED_TABLES = [
  'profiles',
  'groups',
  'group_members',
  'bills',
  'bill_items',
  'item_splits',
  'settlements',
  'activity_log',
  'profile_peer_links',
]

let container: HTMLDivElement
let root: Root

const label = () => container.querySelector('button')?.textContent ?? ''

function queueEntry(id: string, status: 'pending' | 'conflict', seq: number) {
  const ts = '2026-09-25T00:00:00.000Z'
  return {
    id,
    actor_user_id: 'ME',
    operation: 'createBill',
    entity_type: 'bill',
    entity_id: `bill-${id}`,
    payload_json: '{}',
    status,
    retry_count: 0,
    last_error: status === 'conflict' ? 'refused' : null,
    submission_id: `sub-${id}`,
    seq,
    push: { bills: [] },
    row_keys: [`bills:bill-${id}`],
    next_attempt_at: null,
    last_error_kind: status === 'conflict' ? 'rejected' : null,
    created_at: ts,
    updated_at: ts,
  } as never
}

async function settle(check: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) return
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  // A fresh refresh marker, so the resting label is "Refresh" rather than "Data may be behind".
  localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, new Date().toISOString())
  useAppStore.setState({ screenLoadCount: 0, syncStatus: 'idle', isOnline: true, pullStale: false, syncRetryAt: null })
  await db.profiles.add(makeProfile({ id: 'ME' }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => root.render(<RefreshButton />))
}

describe('RefreshButton — unsent indicator', () => {
  it('C29: computing the indicator never scans a synced table with toArray', async () => {
    const scanned: string[] = []
    const proto = Object.getPrototypeOf(db.bills) as Table
    const original = proto.toArray
    vi.spyOn(proto, 'toArray').mockImplementation(function (this: Table, ...args: unknown[]) {
      scanned.push(this.name)
      return (original as (...a: unknown[]) => unknown).apply(this, args) as never
    })
    await db.bills.add(makeBill({ id: 'b-legacy', created_by: 'ME', paid_by: 'ME', synced_at: null }))

    await render()
    await settle(() => label().includes('Waiting to sync'))

    expect(label()).toContain('Waiting to sync')
    expect(scanned.filter((t) => SYNCED_TABLES.includes(t))).toEqual([])
  })

  it('C32: a pending queue entry reads as unsent', async () => {
    await db.pending_mutations.add(queueEntry('p1', 'pending', 1))

    await render()
    await settle(() => label().includes('Waiting to sync'))

    expect(label()).toContain('Waiting to sync')
  })

  it('C32: a conflict entry reads as not applied, never as pending forever', async () => {
    await db.pending_mutations.add(queueEntry('c1', 'conflict', 1))

    await render()
    await settle(() => /not applied/i.test(label()))

    expect(label()).toMatch(/not applied/i)
    expect(label()).not.toContain('Waiting to sync')
  })

  it('shows the resting label when there is nothing queued and nothing unsynced', async () => {
    await render()
    await settle(() => false, 200)
    expect(label()).toContain('Refresh')
    expect(label()).not.toContain('Waiting to sync')
  })
})
