import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { db } from '@/db/db'
import { enqueueWrite } from '@/sync/write-queue'
import { KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

/**
 * Sign-out with a queued write (review-2 H2.1). The row-scan checks ignore queue-owned rows by design
 * (C31/C32), so a sign-out that asked only them reported "nothing unsent" and then wiped the queue:
 * a bill saved offline, or one whose save hit a network failure, was lost. The dialog must count
 * the queue, and "Sync now, then sign out" must send it before it decides.
 */

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'transport',
  pushes: [] as Record<string, { id: string }[]>[],
  submissionIds: [] as (string | undefined)[],
  rpcNames: [] as string[],
}))
const h = vi.hoisted(() => ({ clearLocal: vi.fn(async () => {}), signOut: vi.fn(async () => ({ error: null })) }))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  const base = makeSupabaseCloudMock(cloud)
  return { supabase: { ...base, auth: { ...base.auth, signOut: h.signOut } } }
})
vi.mock('@/lib/clear-kwenta-local', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearKwentaLocalData: h.clearLocal,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'ME' }, isAuthenticated: true, updateDisplayName: vi.fn() }),
}))
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'ME', profile: { id: 'ME', display_name: 'Me' } }),
}))
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _deps: unknown, fallback?: unknown) => fallback,
}))
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/components/settings/RepairDataPanel', () => ({ RepairDataPanel: () => null }))

import { SettingsPage } from '@/pages/SettingsPage'

let container: HTMLDivElement
let root: Root

const buttonNamed = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

async function queueStagedBill(id: string) {
  const bill = makeBill({ id, created_by: 'ME', paid_by: 'ME', group_id: null })
  await enqueueWrite({
    actorUserId: 'ME',
    payload: { bills: [{ ...bill, synced_at: null }] },
    pending: { operation: 'create_bill', entityType: 'bill', entityId: id, payload: {}, routeHint: null },
    submissionId: `SUB-${id}`,
  })
}

async function openSignOut() {
  await act(async () => buttonNamed('Sign out')!.click())
  await settle()
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  cloud.mode = 'ok'
  cloud.pushes = []
  cloud.submissionIds = []
  cloud.rpcNames = []
  h.clearLocal.mockClear()
  h.signOut.mockClear()
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  await db.profiles.add({ ...makeProfile({ id: 'ME', display_name: 'Me' }), synced_at: '2026-09-01T00:00:00.000Z' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('SettingsPage — sign-out with queued writes (H2.1)', () => {
  it('warns about a queued write the row scan ignores', async () => {
    await queueStagedBill('B1')

    await openSignOut()

    expect(container.textContent).toContain('You have changes that are not uploaded yet')
    expect(buttonNamed('Sign out anyway')).toBeTruthy()
  })

  it('warns about a refused (conflict) entry too: signing out would discard it', async () => {
    await queueStagedBill('B1')
    const [entry] = await db.pending_mutations.toArray()
    await db.pending_mutations.update(entry.id, { status: 'conflict' })

    await openSignOut()

    expect(container.textContent).toContain('You have changes that are not uploaded yet')
  })

  it('"Sync now, then sign out" drains the queue with its submission id, then signs out', async () => {
    await queueStagedBill('B1')
    await openSignOut()

    await act(async () => buttonNamed('Sync now, then sign out')!.click())
    await settle()

    const writeIndex = cloud.rpcNames.indexOf('kwenta_write')
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(cloud.submissionIds).toContain('SUB-B1')
    expect(await db.pending_mutations.count()).toBe(0)
    expect(h.clearLocal).toHaveBeenCalledTimes(1)
  })

  it('"Sync now, then sign out" keeps the device when the queue could not be sent', async () => {
    await queueStagedBill('B1')
    await openSignOut()
    cloud.mode = 'transport'

    await act(async () => buttonNamed('Sync now, then sign out')!.click())
    await settle()

    expect(h.clearLocal).not.toHaveBeenCalled()
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('with nothing queued or staged, the dialog offers a plain sign-out', async () => {
    await openSignOut()

    expect(container.textContent).not.toContain('not uploaded yet')
    expect(buttonNamed('Sign out anyway')).toBeUndefined()
  })
})

describe('SettingsPage — Reset local data warns like sign-out', () => {
  async function openReset() {
    const entry = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().startsWith('Reset local data'),
    ) as HTMLButtonElement
    await act(async () => entry.click())
    await settle()
  }

  it('warns about a queued write and offers "Reset anyway" instead of a plain reset', async () => {
    await queueStagedBill('B1')

    await openReset()

    expect(container.textContent).toContain('You have changes that are not uploaded yet. Resetting removes')
    expect(buttonNamed('Reset anyway')).toBeTruthy()
    expect(buttonNamed('Reset & reload')).toBeUndefined()
    expect(h.clearLocal).not.toHaveBeenCalled()
  })

  it('Cancel keeps the queued write', async () => {
    await queueStagedBill('B1')
    await openReset()

    await act(async () => buttonNamed('Cancel')!.click())
    await settle()

    expect(h.clearLocal).not.toHaveBeenCalled()
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('"Reset anyway" is the explicit choice to discard: it wipes', async () => {
    await queueStagedBill('B1')
    await openReset()

    await act(async () => buttonNamed('Reset anyway')!.click())
    await settle()

    expect(h.clearLocal).toHaveBeenCalledTimes(1)
  })

  it('"Sync now, then reset" sends the queue first and resets once nothing is unsent', async () => {
    await queueStagedBill('B1')
    await openReset()

    await act(async () => buttonNamed('Sync now, then reset')!.click())
    await settle()

    expect(cloud.submissionIds).toContain('SUB-B1')
    expect(await db.pending_mutations.count()).toBe(0)
    expect(h.clearLocal).toHaveBeenCalledTimes(1)
  })

  it('"Sync now, then reset" keeps the device when the queue could not be sent', async () => {
    await queueStagedBill('B1')
    await openReset()
    cloud.mode = 'transport'

    await act(async () => buttonNamed('Sync now, then reset')!.click())
    await settle()

    expect(h.clearLocal).not.toHaveBeenCalled()
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('review-5 C5.1: a reset keeps the device owned by the signed-in user', async () => {
    localStorage.setItem(KWENTA_LOCAL_USER_KEY, 'ME')
    h.clearLocal.mockImplementationOnce(async () => {
      localStorage.removeItem(KWENTA_LOCAL_USER_KEY)
    })
    await openReset()

    await act(async () => buttonNamed('Reset & reload')!.click())
    await settle()

    expect(h.clearLocal).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('ME')
  })

  it('with nothing unsent, the dialog is the plain reset', async () => {
    await openReset()

    expect(container.textContent).not.toContain('not uploaded yet')
    expect(buttonNamed('Reset & reload')).toBeTruthy()
  })
})
