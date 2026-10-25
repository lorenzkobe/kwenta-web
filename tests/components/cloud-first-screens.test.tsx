import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * cloud-first-guards-and-screens, C7-C10 C14 C15 C17: a screen that decides or displays from this
 * device's copy while online asks the server first. Real Dexie (fake-indexeddb), real
 * `useLiveQuery`, real group/bill mirrors and a real router; only the network edge is faked.
 *
 * Server answer shapes are the RPCs' own:
 *   kwenta_fetch_group_bundle        -> { group, group_members } | null  (src/sync/group-mirror.ts)
 *   kwenta_fetch_bill_bundle         -> { bill, bill_items, item_splits } | null (src/sync/bill-mirror.ts)
 *   kwenta_fetch_profile_for_linking -> profile row | null               (039)
 */

const server = vi.hoisted(() => ({
  groups: new Map<string, unknown>(),
  groupFetchCalls: [] as string[],
  groupFetchError: null as { message: string } | null,
  bills: new Map<string, unknown>(),
  billFetchCalls: [] as string[],
  billFetchError: null as { message: string } | null,
  profiles: new Map<string, unknown>(),
  profileFetchCalls: [] as string[],
  profileFetchError: null as { message: string } | null,
  cloud: { mode: 'ok' as const, calls: 0, pushes: [] as Record<string, { id: string }[]>[] },
  toasts: [] as string[],
  notifications: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(server.cloud)
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    unsubscribe: async () => 'ok',
  }
  return {
    supabase: {
      ...base,
      channel: () => channel,
      removeChannel: async () => 'ok',
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'kwenta_fetch_group_bundle') {
          const id = String(args?.p_group_id)
          server.groupFetchCalls.push(id)
          if (server.groupFetchError) return { data: null, error: server.groupFetchError }
          return { data: server.groups.get(id) ?? null, error: null }
        }
        if (fn === 'kwenta_fetch_bill_bundle') {
          const id = String(args?.p_bill_id)
          server.billFetchCalls.push(id)
          if (server.billFetchError) return { data: null, error: server.billFetchError }
          return { data: server.bills.get(id) ?? null, error: null }
        }
        if (fn === 'kwenta_fetch_profile_for_linking') {
          const id = String(args?.p_id)
          server.profileFetchCalls.push(id)
          if (server.profileFetchError) return { data: null, error: server.profileFetchError }
          return { data: server.profiles.get(id) ?? null, error: null }
        }
        return base.rpc(fn, args)
      },
    },
  }
})
vi.mock('@/sync/sync-service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, changed: 0, errors: [] })),
}))
vi.mock('@/sync/sync-manager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestSyncNow: vi.fn(),
  triggerSync: vi.fn(),
}))
vi.mock('@/lib/kwenta-notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchKwentaNotifications: vi.fn(async () => server.notifications),
  markKwentaNotificationRead: vi.fn(async () => {}),
  deleteKwentaNotification: vi.fn(async () => {}),
}))
// The Person page's money endpoints are not what decides "not found"; they stay pending so the
// page's decision comes from the profile lookup alone.
vi.mock('@/api/balances', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPersonSummary: vi.fn(() => new Promise(() => {})),
  fetchPersonStatement: vi.fn(() => new Promise(() => {})),
  fetchPersonSettlementHistory: vi.fn(() => new Promise(() => {})),
}))
vi.mock('@/hooks/useExchangeRate', () => ({ useExchangeRate: () => ({ live: null, loading: false }) }))
vi.mock('sonner', () => {
  const record = (msg: unknown) => {
    server.toasts.push(String(msg))
  }
  const toast = Object.assign(vi.fn(record), {
    info: vi.fn(record),
    error: vi.fn(record),
    success: vi.fn(record),
    warning: vi.fn(record),
    message: vi.fn(record),
  })
  return { toast, Toaster: () => null }
})

import { db } from '@/db/db'
import { fullSync } from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import { BillDetailModal } from '@/components/common/BillDetailModal'
import { NotificationsBell } from '@/components/notifications/NotificationsBell'
import { PersonDetailPage } from '@/pages/PersonDetailPage'
import { AddBillPage } from '@/pages/AddBillPage'
import type { Group, GroupMember } from '@/types'
import { makeBill, makeGroup, makeItem, makeMember, makeProfile, makeSplit, resetDb } from '../helpers/db'

const ME = 'ME'
const OWNER = 'OWNER'
const ANN = 'ANN'
const BEN = 'BEN'
const LATER = '2030-01-01T00:00:00.000Z'

let container: HTMLDivElement
let root: Root

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.getState().setOnline(online)
}

function text(): string {
  return container.textContent ?? ''
}

/** Let Dexie live queries and the mount effects' requests resolve. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function until(check: () => void) {
  await vi.waitFor(
    async () => {
      await settle(1)
      check()
    },
    { timeout: 3000, interval: 20 },
  )
}

// The pages are heavy to mount; under a parallel run the default 5 s budget is too tight for a
// test that waits on two server answers.
vi.setConfig({ testTimeout: 15000 })

beforeEach(async () => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  await resetDb()
  server.groups.clear()
  server.groupFetchCalls = []
  server.groupFetchError = null
  server.bills.clear()
  server.billFetchCalls = []
  server.billFetchError = null
  server.profiles.clear()
  server.profileFetchCalls = []
  server.profileFetchError = null
  server.toasts = []
  server.notifications = []
  vi.mocked(fullSync).mockClear()
  setOnline(true)
  useAppStore.setState({ currentUserId: ME })
  await db.profiles.add(makeProfile({ id: ME, display_name: 'Me' }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.style.overflow = ''
})

type GroupBundle = { group: Group; group_members: GroupMember[] }

function member(userId: string, name: string, over: Partial<GroupMember> = {}): GroupMember {
  return makeMember({ id: `gm-${userId}`, group_id: 'G', user_id: userId, display_name: name, ...over })
}

// ── C8 / C14: Bill detail popup ──────────────────────────────────────────────

describe('BillDetailModal reads the bill fresh online', () => {
  async function seedLocalBill() {
    // Rows shaped as the app writes them: an equal split carries split_value 1.
    await db.bills.add(makeBill({ id: 'B1', title: 'Dinner', created_by: ME, paid_by: ME, total_amount: 300 }))
    await db.bill_items.add(makeItem({ id: 'I1', bill_id: 'B1', name: 'Food', amount: 300 }))
    await db.item_splits.add(makeSplit({ id: 'S1', item_id: 'I1', user_id: ME, computed_amount: 300 }))
  }

  function serverEditedBill() {
    return {
      bill: makeBill({
        id: 'B1',
        title: 'Dinner at Mesa',
        created_by: ME,
        paid_by: ME,
        total_amount: 300,
        updated_at: LATER,
        synced_at: LATER,
      }),
      bill_items: [makeItem({ id: 'I1', bill_id: 'B1', name: 'Food and drinks', amount: 300, updated_at: LATER, synced_at: LATER })],
      item_splits: [makeSplit({ id: 'S1', item_id: 'I1', user_id: ME, computed_amount: 300 })],
    }
  }

  async function open() {
    await act(async () =>
      root.render(<BillDetailModal billId="B1" currentUserId={ME} onClose={vi.fn()} onEdit={vi.fn()} />),
    )
  }

  it("C8: online, opening the popup fetches the bill and shows another device's edit", async () => {
    await seedLocalBill()
    server.bills.set('B1', serverEditedBill())

    await open()

    await until(() => expect(text()).toContain('Dinner at Mesa'))
    expect(server.billFetchCalls).toEqual(['B1'])
    expect(text()).toContain('Food and drinks')
  })

  it('C14: a bill the server no longer has shows "This bill no longer exists", not the stale copy', async () => {
    await seedLocalBill()

    await open()

    await until(() => expect(text()).toMatch(/no longer exists/i))
    expect(server.billFetchCalls).toEqual(['B1'])
  })

  it('C14: an unreachable server keeps the local copy on screen with no error', async () => {
    await seedLocalBill()
    server.billFetchError = { message: 'Failed to fetch' }

    await open()
    await until(() => expect(server.billFetchCalls).toEqual(['B1']))
    await settle()

    expect(text()).toContain('Dinner')
    expect(text()).toContain('Food')
    expect(text()).not.toMatch(/no longer exists|not found|connection/i)
  })

  it("C20: a group bill naming a co-member's contact the device lacks loads that profile once and renders", async () => {
    await db.bills.add(makeBill({ id: 'B1', title: 'Dinner', created_by: ME, paid_by: ME, group_id: 'G', total_amount: 300 }))
    await db.bill_items.add(makeItem({ id: 'I1', bill_id: 'B1', name: 'Food', amount: 300 }))
    await db.item_splits.bulkAdd([
      makeSplit({ id: 'S1', item_id: 'I1', user_id: ME, computed_amount: 150 }),
      makeSplit({ id: 'S2', item_id: 'I1', user_id: 'COCONTACT', computed_amount: 150 }),
    ])
    server.bills.set('B1', { bill: await db.bills.get('B1'), bill_items: await db.bill_items.toArray(), item_splits: await db.item_splits.toArray() })
    server.profiles.set(
      'COCONTACT',
      makeProfile({ id: 'COCONTACT', display_name: 'Cora Contact', is_local: true, owner_id: OWNER, email: '' }),
    )

    await open()

    await until(() => expect(text()).toContain('Cora Contact'))
    expect(server.profileFetchCalls).toEqual(['COCONTACT'])
    expect(text()).toContain('Dinner')
  })

  it('C8: offline, the local copy is shown without a request', async () => {
    await seedLocalBill()
    setOnline(false)

    await open()
    await until(() => expect(text()).toContain('Dinner'))

    expect(server.billFetchCalls).toEqual([])
    expect(text()).not.toMatch(/no longer exists|not found/i)
  })
})

// ── C9 / C15: notification tap on an added_to_group notification ─────────────

describe('NotificationsBell group tap asks the server online', () => {
  function groupNotification() {
    server.notifications = [
      {
        id: 'n1',
        recipient_id: ME,
        actor_id: OWNER,
        kind: 'added_to_group',
        title: 'Added to Trip',
        body: 'Owner added you to Trip',
        group_id: 'G',
        entity_id: 'G',
        read_at: null,
        created_at: '2026-10-24T00:00:00.000Z',
      },
    ]
  }

  async function renderBell() {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/app']}>
          <Routes>
            <Route path="/app" element={<NotificationsBell userId={ME} />} />
            <Route path="/app/groups/:groupId" element={<p>GROUP PAGE</p>} />
            <Route path="/app/groups" element={<p>GROUPS LIST</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    )
  }

  async function tapGroupNotification() {
    groupNotification()
    await renderBell()
    const bell = container.querySelector('button[aria-label="Notifications"]') as HTMLButtonElement
    expect(bell).not.toBeNull()
    await act(async () => bell.click())
    await until(() => expect(text()).toContain('Added to Trip'))
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Added to Trip'))
    expect(row).toBeDefined()
    await act(async () => row!.click())
    await settle()
  }

  it('C9/C15: present on the server with a live membership opens the group, with no fullSync', async () => {
    server.groups.set('G', {
      group: makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }),
      group_members: [member(OWNER, 'Owner'), member(ME, 'Me')],
    } satisfies GroupBundle)

    await tapGroupNotification()

    await until(() => expect(text()).toContain('GROUP PAGE'))
    expect(server.groupFetchCalls).toEqual(['G'])
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })

  it('C9/C15: a group the server does not return says it is no longer available', async () => {
    await tapGroupNotification()

    await until(() => expect(server.toasts.join('\n')).toMatch(/no longer available/i))
    expect(text()).not.toContain('GROUP PAGE')
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })

  it('C15: a group whose roster no longer lists me does not open', async () => {
    server.groups.set('G', {
      group: makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }),
      group_members: [member(OWNER, 'Owner'), member(ME, 'Me', { is_deleted: true, updated_at: LATER })],
    } satisfies GroupBundle)

    await tapGroupNotification()

    await until(() => expect(server.toasts.join('\n')).toMatch(/no longer available/i))
    expect(text()).not.toContain('GROUP PAGE')
  })

  it('C15: an unreachable server says check your connection, not that the group is gone', async () => {
    server.groupFetchError = { message: 'Failed to fetch' }

    await tapGroupNotification()

    await until(() => expect(server.toasts.join('\n')).toMatch(/check your connection/i))
    expect(server.toasts.join('\n')).not.toMatch(/no longer available/i)
    expect(text()).not.toContain('GROUP PAGE')
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })

  it('C9/C15: offline keeps the device check: a group on the device opens without a request', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }))
    await db.group_members.add(member(ME, 'Me'))
    // The panel renders no rows while the STORE says offline, so the only way to tap a row offline
    // is the connection dropping before the store flag follows it (online-status.ts documents that
    // lag). `navigator.onLine` is what the write and mirror paths read.
    groupNotification()
    await renderBell()
    const bell = container.querySelector('button[aria-label="Notifications"]') as HTMLButtonElement
    await act(async () => bell.click())
    await until(() => expect(text()).toContain('Added to Trip'))
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Added to Trip'))
    expect(row).toBeDefined()
    await act(async () => row!.click())

    await until(() => expect(text()).toContain('GROUP PAGE'))
    expect(server.groupFetchCalls).toEqual([])
    expect(vi.mocked(fullSync)).not.toHaveBeenCalled()
  })
})

// ── C10 / C17: Person page ───────────────────────────────────────────────────

describe('PersonDetailPage decides "not found" from the server online', () => {
  async function openPerson(id: string) {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/app/people/${id}`]}>
          <Routes>
            <Route path="/app/people/:personId" element={<PersonDetailPage />} />
            <Route path="/app/people" element={<p>PEOPLE LIST</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    )
  }

  it("C10: online, 'Person not found' when the server has no such person", async () => {
    await openPerson('GHOST')

    await until(() => expect(text()).toContain('Person not found'))
    expect(server.profileFetchCalls).toContain('GHOST')
  })

  it('C10: online, a person the server returns is shown', async () => {
    server.profiles.set('GUS', makeProfile({ id: 'GUS', display_name: 'Gus Account', email: 'gus@example.com' }))

    await openPerson('GUS')

    await until(() => expect(text()).toContain('Gus Account'))
    expect(text()).not.toContain('Person not found')
  })

  it("C17: an unreachable server shows a connection message with a retry, not 'Person not found'", async () => {
    server.profileFetchError = { message: 'Failed to fetch' }

    await openPerson('GUS')

    await until(() => expect(text()).toMatch(/connection/i))
    expect(text()).not.toContain('Person not found')
    const retry = [...container.querySelectorAll('button')].find((b) => /retry|try again/i.test(b.textContent ?? ''))
    expect(retry).toBeDefined()

    // The retry asks again; with the server back the person appears.
    server.profileFetchError = null
    server.profiles.set('GUS', makeProfile({ id: 'GUS', display_name: 'Gus Account', email: 'gus@example.com' }))
    const callsBefore = server.profileFetchCalls.length
    await act(async () => retry!.click())

    await until(() => expect(text()).toContain('Gus Account'))
    expect(server.profileFetchCalls.length).toBeGreaterThan(callsBefore)
  })

  it('C21: a contact deleted on this device shows not found without a request and stays deleted', async () => {
    await db.profiles.add(
      makeProfile({
        id: 'GONE',
        display_name: 'Gone Contact',
        is_local: true,
        owner_id: ME,
        is_deleted: true,
        synced_at: null,
        updated_at: '2030-01-01T00:00:00.000Z',
      }),
    )
    server.profiles.set('GONE', makeProfile({ id: 'GONE', display_name: 'Gone Contact', is_local: true, owner_id: ME }))

    await openPerson('GONE')

    await until(() => expect(text()).toContain('Person not found'))
    expect(server.profileFetchCalls).toEqual([])
    expect((await db.profiles.get('GONE'))?.is_deleted).toBe(true)
  })

  it('a person deleted after the page showed them resolves to not found, not a spinner', async () => {
    await db.profiles.add(makeProfile({ id: 'LIVE', display_name: 'Live Contact', is_local: true, owner_id: ME }))
    await openPerson('LIVE')
    await until(() => expect(text()).toContain('Live Contact'))

    await db.profiles.update('LIVE', { is_deleted: true })

    await until(() => expect(text()).toContain('Person not found'))
  })

  it("the unreachable state's retry is at least 44px tall", async () => {
    server.profileFetchError = { message: 'Failed to fetch' }
    await openPerson('GUS')
    await until(() => expect(text()).toMatch(/connection/i))
    const retry = [...container.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent ?? ''))
    expect(retry?.className).toMatch(/min-h-11/)
  })

  it("a merged peer's profile the device lacks is loaded once so the linked-identities label names it", async () => {
    await db.profiles.add(makeProfile({ id: 'ANCHOR', display_name: 'Anchor Contact', is_local: true, owner_id: ME }))
    await db.profile_peer_links.add({
      id: 'L1',
      owner_user_id: ME,
      anchor_profile_id: 'ANCHOR',
      peer_profile_id: 'PEER',
      created_at: LATER,
      updated_at: LATER,
      synced_at: LATER,
      is_deleted: false,
      device_id: 'd',
    })
    server.profiles.set('PEER', makeProfile({ id: 'PEER', display_name: 'Peer Account', email: 'peer@example.com' }))

    await openPerson('ANCHOR')

    await until(() => expect(text()).toContain('Peer Account'))
    expect(server.profileFetchCalls).toEqual(['PEER'])
  })

  it('C10: offline keeps the device fallback (a shared group roster name), with no request', async () => {
    await db.groups.add(makeGroup({ id: 'G', created_by: ME, name: 'Trip' }))
    await db.group_members.bulkAdd([member(ME, 'Me'), member('GUS', 'Gus from Trip')])
    setOnline(false)

    await openPerson('GUS')

    await until(() => expect(text()).toContain('Gus from Trip'))
    expect(text()).not.toContain('Person not found')
    expect(server.profileFetchCalls).toEqual([])
  })
})

// ── C7: Add bill page, group payer/split picker ──────────────────────────────

describe('AddBillPage group picker follows the server roster online', () => {
  async function seedStaleGroup() {
    // The device's roster: Owner, Me and Ben. On the server Ann has since joined and Ben left.
    await db.profiles.bulkAdd([
      makeProfile({ id: OWNER, display_name: 'Owner' }),
      makeProfile({ id: BEN, display_name: 'Benedict' }),
    ])
    await db.groups.add(makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }))
    await db.group_members.bulkAdd([member(OWNER, 'Owner'), member(ME, 'Me'), member(BEN, 'Benedict')])
    server.groups.set('G', {
      group: makeGroup({ id: 'G', created_by: OWNER, name: 'Trip' }),
      group_members: [
        member(OWNER, 'Owner'),
        member(ME, 'Me'),
        member(BEN, 'Benedict', { is_deleted: true, updated_at: LATER, synced_at: LATER }),
        member(ANN, 'Annabel', { updated_at: LATER, synced_at: LATER }),
      ],
    } satisfies GroupBundle)
  }

  async function openAddBill() {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/app/bills/new?groupId=G']}>
          <Routes>
            <Route path="/app/bills/new" element={<AddBillPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    )
  }

  /** The "Split with" picker lists its options in a portal on document.body once opened. */
  async function openSplitPicker(): Promise<() => string> {
    const trigger = await vi.waitFor(
      async () => {
        await settle(1)
        const b = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes('Select people'))
        expect(b).toBeDefined()
        return b!
      },
      { timeout: 5000, interval: 20 },
    )
    await act(async () => trigger.click())
    return () => document.body.textContent ?? ''
  }

  it('C7: online, mounting refreshes the roster once; a member added elsewhere appears and a removed one does not', async () => {
    await seedStaleGroup()

    await openAddBill()
    await settle()
    const picker = await openSplitPicker()

    await until(() => expect(picker()).toContain('Annabel'))
    expect(picker()).not.toContain('Benedict')
    expect(server.groupFetchCalls).toEqual(['G'])
  })

  it('C7: offline, the picker falls back to the device roster and makes no request', async () => {
    await seedStaleGroup()
    setOnline(false)

    await openAddBill()
    await settle()
    const picker = await openSplitPicker()

    await until(() => expect(picker()).toContain('Benedict'))
    expect(picker()).not.toContain('Annabel')
    expect(server.groupFetchCalls).toEqual([])
  })
})
