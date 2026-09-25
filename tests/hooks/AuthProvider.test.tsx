import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { db } from '@/db/db'
import { KWENTA_LOCAL_USER_KEY } from '@/lib/clear-kwenta-local'
import { realtimeCursorKey } from '@/lib/kwenta-storage-keys'
import { useAppStore } from '@/store/app-store'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

/**
 * AuthProvider after the realignment (plan: Auth; H1.3, H1.4).
 *
 * Before: every open awaited a blocking account check before anything rendered, a transport
 * failure of that check signed the user out as "session expired", and a different user signing in
 * inherited the previous user's mirror. After: render first, gate in the background; only an
 * inactive answer signs out; a different user's mirror is wiped before the app renders, with a
 * warning first when the previous user has unsent changes.
 *
 * Supabase auth is mocked; the account gate is `kwenta_my_account_status` (H1.3). The legacy
 * `profiles` read answers the same status so the suite judges behaviour, not which call is made.
 */

type GateAnswer = { data: unknown; error: unknown }

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string }; expires_at?: number; access_token?: string },
  authCb: null as null | ((event: string, session: unknown) => void),
  gate: null as null | (() => Promise<{ status: string } | { transport: true }>),
  signOut: vi.fn(),
  refreshSession: vi.fn(),
  rpcNames: [] as string[],
  cancelDrainRetry: vi.fn(),
}))

// The real queue, with its retry-timer cancel observed (review H5.1).
vi.mock('@/sync/write-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/sync/write-queue')>()
  return {
    ...real,
    cancelScheduledDrainRetry: () => {
      h.cancelDrainRetry()
      real.cancelScheduledDrainRetry()
    },
  }
})

vi.mock('@/sync/sync-manager', () => ({ triggerSync: vi.fn(), requestSyncNow: vi.fn() }))

vi.mock('@/lib/supabase', () => {
  async function answer(asRow: boolean): Promise<GateAnswer> {
    const r = await (h.gate ? h.gate() : Promise.resolve({ status: 'active' }))
    if ('transport' in r) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }
    if (!asRow) return { data: r.status, error: null }
    const uid = h.session?.user.id ?? 'unknown'
    return {
      data: {
        id: uid,
        email: `${uid}@example.com`,
        display_name: uid,
        avatar_url: null,
        user_type: 'user',
        account_status: r.status,
        is_local: false,
        linked_profile_id: null,
        owner_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        is_deleted: false,
        device_id: 'd',
      },
      error: null,
    }
  }
  const chain = () => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.maybeSingle = () => answer(true)
    c.single = () => answer(true)
    return c
  }
  return {
    authRedirectUrl: (p: string) => p,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: h.session }, error: null }),
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          h.authCb = cb
          return { data: { subscription: { unsubscribe: () => {} } } }
        },
        signOut: h.signOut,
        refreshSession: h.refreshSession,
        updateUser: vi.fn(async () => ({ data: {}, error: null })),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        resetPasswordForEmail: vi.fn(),
      },
      from: () => chain(),
      rpc: async (fn: string) => {
        h.rpcNames.push(fn)
        if (fn === 'kwenta_my_account_status') return answer(false)
        return { data: null, error: null }
      },
    },
  }
})

import { AuthProvider } from '@/hooks/AuthProvider'
import { useAuth } from '@/hooks/useAuth'

type Seen = { userId: string | null; loading: boolean; billsAtFirstRender?: Promise<number> }

let container: HTMLDivElement
let root: Root
let seen: Seen[]
let releaseGate: (() => void) | null = null

function Probe() {
  const { user, loading } = useAuth()
  const userId = user?.id ?? null
  const entry: Seen = { userId, loading }
  // The first render as a given user starts a Dexie read; if the wipe has not run yet, it sees rows.
  if (userId && !seen.some((s) => s.userId === userId)) entry.billsAtFirstRender = db.bills.count()
  seen.push(entry)
  return <div data-testid="app">{userId ?? 'signed-out'}</div>
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function waitFor(check: () => boolean, ms = 1500) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) return false
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  return true
}

const rendered = (uid: string) => seen.some((s) => s.userId === uid && !s.loading)
const buttonByText = (text: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)

function sessionFor(uid: string, expired = false) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    user: { id: uid, email: `${uid}@example.com` },
    access_token: 'token',
    expires_at: expired ? nowSec - 3600 : nowSec + 3600,
  }
}

function queueEntry(actor: string) {
  const ts = '2026-09-20T00:00:00.000Z'
  return {
    id: `pm-${actor}`,
    actor_user_id: actor,
    operation: 'createBill',
    entity_type: 'bill',
    entity_id: `b-${actor}`,
    payload_json: '{}',
    status: 'pending',
    retry_count: 0,
    last_error: null,
    submission_id: `sub-${actor}`,
    seq: 1,
    push: { bills: [] },
    row_keys: [`bills:b-${actor}`],
    next_attempt_at: null,
    last_error_kind: null,
    created_at: ts,
    updated_at: ts,
  } as never
}

async function mount() {
  await act(async () =>
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    ),
  )
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.setState({ isOnline: online })
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  sessionStorage.clear()
  seen = []
  h.session = null
  h.authCb = null
  h.gate = null
  h.rpcNames = []
  h.cancelDrainRetry.mockReset()
  h.signOut.mockReset()
  h.signOut.mockImplementation(async () => {
    h.session = null
    h.authCb?.('SIGNED_OUT', null)
    return { error: null }
  })
  h.refreshSession.mockReset()
  h.refreshSession.mockImplementation(async () => ({ data: { session: h.session }, error: null }))
  setOnline(true)
  useAppStore.setState({ currentUserId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  // AuthProvider dedupes the gate per user in MODULE state: a gate left pending would be joined by
  // the next test's sign-in, so release it and let it settle.
  if (releaseGate) {
    releaseGate()
    releaseGate = null
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }
  await act(async () => root.unmount())
  container.remove()
  setOnline(true)
})

async function seedReturningUser(uid: string) {
  localStorage.setItem(KWENTA_LOCAL_USER_KEY, uid)
  await db.profiles.add(makeProfile({ id: uid }))
  await db.bills.add(makeBill({ id: `b-${uid}`, created_by: uid, paid_by: uid }))
}

describe('AuthProvider — background account gate (C23)', () => {
  it('C23: the app renders before the account gate returns', async () => {
    await seedReturningUser('ME')
    h.session = sessionFor('ME')
    const gate = deferred<{ status: string }>()
    h.gate = () => gate.promise
    releaseGate = () => gate.resolve({ status: 'active' })

    await mount()
    const ok = await waitFor(() => rendered('ME'))

    expect(ok).toBe(true)
    expect(useAppStore.getState().currentUserId).toBe('ME')
  })

  it('C23: an inactive answer signs out and keeps the same user’s offline copy', async () => {
    await seedReturningUser('ME')
    h.session = sessionFor('ME')
    h.gate = async () => ({ status: 'inactive' })

    await mount()
    await waitFor(() => h.signOut.mock.calls.length > 0)

    expect(h.signOut).toHaveBeenCalled()
    expect(await db.profiles.get('ME')).toBeTruthy()
    expect(await db.bills.get('b-ME')).toBeTruthy()
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('ME')
  })

  it('C23: a transport failure of the gate keeps the user signed in', async () => {
    await seedReturningUser('ME')
    h.session = sessionFor('ME')
    h.gate = async () => ({ transport: true })

    await mount()
    await waitFor(() => rendered('ME'))
    await waitFor(() => false, 200)

    expect(h.signOut).not.toHaveBeenCalled()
    expect(seen[seen.length - 1].userId).toBe('ME')
  })
})

describe('AuthProvider — device owner (C24, C25)', () => {
  it('C24: a different user’s sign-in wipes the previous mirror before the app renders', async () => {
    await seedReturningUser('OLD')
    localStorage.setItem('kwenta_api_cache_v1:OLD:overview', JSON.stringify({ data: {}, fetchedAt: 'x' }))
    localStorage.setItem(realtimeCursorKey('OLD'), '2026-09-20T00:00:00.000000+00:00')
    h.session = sessionFor('NEW')

    await mount()
    await waitFor(() => rendered('NEW'))

    const first = seen.find((s) => s.userId === 'NEW')
    expect(first).toBeTruthy()
    expect(await first!.billsAtFirstRender).toBe(0)
    expect(await db.profiles.get('OLD')).toBeUndefined()
    expect(localStorage.getItem('kwenta_api_cache_v1:OLD:overview')).toBeNull()
    expect(localStorage.getItem(realtimeCursorKey('OLD'))).toBeNull()
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('NEW')
  })

  it('C24: with unsent changes it warns first; Cancel signs out and keeps the previous user’s data', async () => {
    await seedReturningUser('OLD')
    await db.pending_mutations.add(queueEntry('OLD'))
    h.session = sessionFor('NEW')

    await mount()
    const warned = await waitFor(() => !!buttonByText('Cancel') && !!buttonByText('Continue'))
    expect(warned).toBe(true)
    expect(seen.some((s) => s.userId === 'NEW')).toBe(false)

    await act(async () => buttonByText('Cancel')!.click())
    await waitFor(() => h.signOut.mock.calls.length > 0)

    expect(h.signOut).toHaveBeenCalled()
    expect(await db.bills.get('b-OLD')).toBeTruthy()
    expect(await db.pending_mutations.count()).toBe(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('OLD')
    expect(seen.some((s) => s.userId === 'NEW')).toBe(false)
  })

  it('C24: with unsent changes, Continue wipes and then renders the new user', async () => {
    await seedReturningUser('OLD')
    await db.pending_mutations.add(queueEntry('OLD'))
    h.session = sessionFor('NEW')

    await mount()
    await waitFor(() => !!buttonByText('Continue'))
    await act(async () => buttonByText('Continue')!.click())
    await waitFor(() => rendered('NEW'))

    const first = seen.find((s) => s.userId === 'NEW')
    expect(first).toBeTruthy()
    expect(await first!.billsAtFirstRender).toBe(0)
    expect(await db.pending_mutations.count()).toBe(0)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('NEW')
  })

  it('C25: the same user signing in again keeps the offline copy and unsent changes', async () => {
    await seedReturningUser('ME')
    await db.bills.add(makeBill({ id: 'b-unsent', created_by: 'ME', paid_by: 'ME', synced_at: null }))
    await db.pending_mutations.add(queueEntry('ME'))
    h.session = sessionFor('ME')

    await mount()
    await waitFor(() => rendered('ME'))

    expect(buttonByText('Continue')).toBeUndefined()
    expect(await db.bills.get('b-ME')).toBeTruthy()
    expect(await db.bills.get('b-unsent')).toBeTruthy()
    expect(await db.pending_mutations.count()).toBe(1)
    expect(localStorage.getItem(KWENTA_LOCAL_USER_KEY)).toBe('ME')
  })
})

describe('AuthProvider — offline session mode (C26)', () => {
  it('C26: offline with an expired token and a matching device owner opens the app without signing out', async () => {
    await seedReturningUser('ME')
    setOnline(false)
    h.session = sessionFor('ME', true)
    h.gate = async () => ({ transport: true })

    await mount()
    const ok = await waitFor(() => rendered('ME'))
    await waitFor(() => false, 200)

    expect(ok).toBe(true)
    expect(h.signOut).not.toHaveBeenCalled()
    expect(await db.bills.get('b-ME')).toBeTruthy()
    expect(h.refreshSession).not.toHaveBeenCalled()
  })

  it('C26: coming back online refreshes the session and signs out if the refresh fails', async () => {
    await seedReturningUser('ME')
    setOnline(false)
    h.session = sessionFor('ME', true)
    h.refreshSession.mockImplementation(async () => ({
      data: { session: null, user: null },
      error: { name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token' },
    }))

    await mount()
    await waitFor(() => rendered('ME'))

    setOnline(true)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => h.signOut.mock.calls.length > 0)

    expect(h.refreshSession).toHaveBeenCalled()
    expect(h.signOut).toHaveBeenCalled()
  })

  it('C26 refused side: offline with an expired token for a user who does NOT own the device does not open', async () => {
    await seedReturningUser('OTHER')
    setOnline(false)
    h.session = sessionFor('ME', true)

    await mount()
    await waitFor(() => false, 300)

    expect(seen.some((s) => s.userId === 'ME')).toBe(false)
  })
})

/**
 * review H5.1: the write queue's retry timer drains as the account that armed it, but its request
 * carries whatever JWT is current. A sign-out that does not wipe (expiry, inactive, Cancel at the
 * switch prompt) left it armed, so the next user's session could replay the previous user's
 * queued writes under the new user's authority. The timer must end with the account.
 */
describe('AuthProvider — the write queue retry timer ends with the account (H5.1)', () => {
  it('H5.1: a SIGNED_OUT event cancels the scheduled drain retry', async () => {
    await seedReturningUser('ME')
    h.session = sessionFor('ME')
    await mount()
    await waitFor(() => rendered('ME'))
    h.cancelDrainRetry.mockClear()

    await act(async () => {
      h.session = null
      h.authCb?.('SIGNED_OUT', null)
    })
    await waitFor(() => h.cancelDrainRetry.mock.calls.length > 0)

    expect(h.cancelDrainRetry).toHaveBeenCalled()
  })

  it('H5.1: a different user signing in cancels the retry before the switch prompt, with nothing wiped', async () => {
    await seedReturningUser('OLD')
    await db.pending_mutations.add(queueEntry('OLD'))
    h.session = sessionFor('NEW')

    await mount()
    await waitFor(() => !!buttonByText('Continue'))

    // The prompt is open: nothing was wiped, so only the user change can have cancelled the timer.
    expect(h.cancelDrainRetry).toHaveBeenCalled()
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('H5.1: the same user’s token refresh leaves the retry armed', async () => {
    await seedReturningUser('ME')
    h.session = sessionFor('ME')
    await mount()
    await waitFor(() => rendered('ME'))
    h.cancelDrainRetry.mockClear()

    await act(async () => {
      h.authCb?.('TOKEN_REFRESHED', h.session)
    })
    await waitFor(() => false, 100)

    expect(h.cancelDrainRetry).not.toHaveBeenCalled()
  })
})
