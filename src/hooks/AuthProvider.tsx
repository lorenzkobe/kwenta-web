import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { authRedirectUrl, supabase } from '@/lib/supabase'
import {
  consumeVoluntarySignOut,
  INACTIVE_ACCOUNT_MESSAGE_KEY,
  markVoluntarySignOut,
  SESSION_EXPIRED_MESSAGE_KEY,
} from '@/lib/auth-session-flags'
import { messageForAccountNotActive } from '@/lib/account-gate-messages'
import { withMetric } from '@/lib/client-metrics'
import { claimDeviceFor, deviceOwner, ensureDeviceOwnedBy } from '@/lib/device-owner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { db } from '@/db/db'
import { renameSelf } from '@/db/operations'
import { useAppStore } from '@/store/app-store'
import { triggerSync } from '@/sync/sync-manager'
import { currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
import { cancelScheduledDrainRetry } from '@/sync/write-queue'
import { ACCOUNT_INACTIVE_MARKER } from '@/sync/write-errors'
import type { Profile, ProfileAccountStatus, ProfileUserType } from '@/types'
import { getDeviceId, now } from '@/lib/utils'
import type { AuthContextValue } from '@/hooks/auth-context'
import { AuthContext } from '@/hooks/auth-context'

/**
 * Seed Dexie with the server profile when possible. Avoid inserting a local stub before the first
 * sync: kwenta_sync applies pushes before pulls, and a stub would overwrite Postgres display_name.
 * Uses put() so parallel callers don't race on add(). A returning user's row is already here, so
 * this reads nothing from the network.
 */
async function ensureProfile(userId: string, email: string) {
  const cacheKey = `${userId}:${email}`
  if (ensureProfileInFlight.has(cacheKey)) {
    await ensureProfileInFlight.get(cacheKey)
    return
  }

  const nickname = pendingSignupNickname.get(userId)

  const task = (async () => {
    const existing = await db.profiles.get(userId)
    if (existing) {
      pendingSignupNickname.delete(userId)
      return
    }

    const epoch = currentSessionEpoch()
    const { data: remote, error } = await withMetric(
      'auth.ensureProfile.fetch',
      () => supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    )

    if (error) {
      console.warn('[auth] could not load profile from cloud', error)
    }

    if (!isSessionEpochCurrent(epoch)) return
    if (remote) {
      const r = remote as Profile
      await db.profiles.put({
        ...r,
        synced_at: r.updated_at,
      })
      return
    }

    pendingSignupNickname.delete(userId)
    const timestamp = now()
    await db.profiles.put({
      id: userId,
      email,
      display_name: nickname || email.split('@')[0] || 'User',
      avatar_url: null,
      user_type: 'user',
      account_status: 'active',
      is_local: false,
      linked_profile_id: null,
      owner_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      synced_at: null,
      is_deleted: false,
      device_id: getDeviceId(),
    })
    triggerSync()
  })()

  ensureProfileInFlight.set(cacheKey, task)
  try {
    await task
  } finally {
    ensureProfileInFlight.delete(cacheKey)
  }
}

const ensureProfileInFlight = new Map<string, Promise<void>>()
const pendingSignupNickname = new Map<string, string>()

type AccountGateResult =
  | { kind: 'status'; status: string | null }
  | { kind: 'transport' }
  | { kind: 'expired' }

const accountGateInFlight = new Map<string, Promise<AccountGateResult>>()

const INACTIVE_STATUS = new RegExp(`${ACCOUNT_INACTIVE_MARKER}:([a-z_]+)`)

function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')
}

/**
 * The caller's `account_status`. `kwenta_my_account_status` (076) is the one endpoint the
 * pre-request hook still answers for an inactive caller, so the gate can say WHY it signs out;
 * against a database without 076 the `profiles` row answers instead.
 */
async function readAccountStatus(userId: string): Promise<AccountGateResult> {
  let { data, error, status } = (await supabase.rpc('kwenta_my_account_status')) as {
    data: unknown
    error: { code?: string; message?: string } | null
    status?: number
  }
  if (error && isMissingFunction(error)) {
    const legacy = await supabase.from('profiles').select('account_status').eq('id', userId).maybeSingle()
    data = (legacy.data as { account_status?: string } | null)?.account_status ?? null
    error = legacy.error as typeof error
    status = legacy.status
  }
  if (!error) return { kind: 'status', status: typeof data === 'string' ? data : null }
  const marked = INACTIVE_STATUS.exec(error.message ?? '')
  if (marked) return { kind: 'status', status: marked[1] }
  const code = error.code ?? ''
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') {
    return { kind: 'expired' }
  }
  // Anything else says nothing about the account: stay signed in and ask again later.
  return { kind: 'transport' }
}

/**
 * The account gate, deduped while in flight: `applySession` runs from the bootstrap
 * `getSession()` AND from `onAuthStateChange`'s `INITIAL_SESSION` / `SIGNED_IN` in the same tick.
 * Only concurrent calls share; a later `TOKEN_REFRESHED` asks again.
 */
function accountGate(userId: string): Promise<AccountGateResult> {
  const running = accountGateInFlight.get(userId)
  if (running) return running
  const task = withMetric('auth.accountGate', () => readAccountStatus(userId))
    .catch((): AccountGateResult => ({ kind: 'transport' }))
    .finally(() => accountGateInFlight.delete(userId))
  accountGateInFlight.set(userId, task)
  return task
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isExpired(session: Session): boolean {
  return typeof session.expires_at === 'number' && session.expires_at * 1000 <= Date.now()
}

/**
 * The persisted session, read directly. Offline, auth-js's `getSession()` tries to refresh an
 * expired token, fails, and answers `null` while KEEPING the session in storage — so without this
 * an offline open with an expired token reads as signed out even though nothing expired for real.
 */
function readStoredSession(): Session | null {
  const key = (supabase.auth as unknown as { storageKey?: string }).storageKey
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as Session) : null
    return parsed?.user?.id ? parsed : null
  } catch {
    return null
  }
}

/** A refresh that failed for a reason other than the network (the refresh token is dead). */
function isDefinitiveAuthFailure(error: { name?: string; status?: number } | null): boolean {
  if (!error) return false
  if (error.name === 'AuthRetryableFetchError') return false
  return typeof error.status === 'number' && error.status >= 400 && error.status < 500
}

type SwitchPrompt = { resolve: (proceed: boolean) => void }

/**
 * Single source of truth for session + profile bootstrap. Must wrap any tree that calls `useAuth`.
 *
 * A sign-in renders as soon as the device's mirror is known to be this user's; the account check
 * runs behind it. Order matters for privacy: a different user's mirror is wiped (after a warning
 * when it holds unsent changes) BEFORE the first render as the new user.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userType, setUserType] = useState<ProfileUserType | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [switchPrompt, setSwitchPrompt] = useState<SwitchPrompt | null>(null)
  const setCurrentUserId = useAppStore((s) => s.setCurrentUserId)
  const prevAuthUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Each applySession call gets a generation; only the latest may commit state. On
    // rapid auth events (a sign-out arriving during a sign-in's profile fetch, or token
    // refresh interleaving) this stops a slower earlier event from overwriting
    // currentUserId with a stale id after a newer event already settled.
    let applyGeneration = 0
    // The user opened offline on an expired token; refreshed (or signed out) once back online.
    let offlineSessionUserId: string | null = null
    // The last gate could not reach the server; asked again once back online.
    let gateRetryUserId: string | null = null
    // One ownership decision per user at a time: the bootstrap and the auth events of one sign-in
    // must not wipe twice or stack two warnings.
    const ownershipInFlight = new Map<string, Promise<boolean>>()
    // The account whose session this tab last saw. The queue's retry timer drains as the account that
    // armed it, but the request carries whoever's JWT is current — so it must not outlive that account
    // (review H5.1: a sign-out without a wipe, then another user's sign-in, replayed A's writes as B).
    let sessionUserId: string | null = null

    function endPreviousAccountWork(nextUserId: string | null) {
      if (nextUserId === sessionUserId) return
      sessionUserId = nextUserId
      cancelScheduledDrainRetry()
    }

    function clearSessionState() {
      offlineSessionUserId = null
      gateRetryUserId = null
      setUser(null)
      setUserType(null)
      setAuthReady(false)
      setCurrentUserId(null)
    }

    /** Resolves false when the user chose to keep the previous account's unsent changes. */
    function claimDevice(userId: string): Promise<boolean> {
      const running = ownershipInFlight.get(userId)
      if (running) return running
      const task = (async () => {
        const ownership = await ensureDeviceOwnedBy(userId)
        if (ownership.outcome !== 'confirm_unsent') return true
        const proceed = await new Promise<boolean>((resolve) => setSwitchPrompt({ resolve }))
        if (proceed) await claimDeviceFor(userId)
        return proceed
      })().finally(() => ownershipInFlight.delete(userId))
      ownershipInFlight.set(userId, task)
      return task
    }

    async function signOutWith(flagKey: string, value: string) {
      try {
        sessionStorage.setItem(flagKey, value)
      } catch {
        /* best effort */
      }
      await supabase.auth.signOut()
    }

    async function runGate(userId: string) {
      const result = await accountGate(userId)
      if (cancelled || useAppStore.getState().currentUserId !== userId) return
      gateRetryUserId = result.kind === 'transport' ? userId : null
      if (result.kind === 'expired') {
        const { data, error } = await supabase.auth.refreshSession()
        if (!data?.session && isDefinitiveAuthFailure(error)) {
          await signOutWith(SESSION_EXPIRED_MESSAGE_KEY, '1')
        }
        return
      }
      // The same user's offline copy is kept: an inactive account is not a different person.
      if (result.kind === 'status' && result.status !== 'active') {
        await signOutWith(INACTIVE_ACCOUNT_MESSAGE_KEY, result.status ?? 'unknown')
      }
    }

    async function applySession(session: Session | null) {
      const myGeneration = ++applyGeneration
      endPreviousAccountWork(session?.user?.id ?? null)
      if (!session?.user) {
        clearSessionState()
        return
      }

      const u = session.user
      let offlineSession = false
      if (!isOnline() && isExpired(session)) {
        // Offline session mode: only for the account this device's mirror belongs to. Nothing can
        // verify the token until the network returns, so a stranger's stored session never opens.
        if (deviceOwner() !== u.id) {
          clearSessionState()
          return
        }
        offlineSession = true
      }

      const proceed = await claimDevice(u.id)
      if (!proceed) {
        markVoluntarySignOut()
        await supabase.auth.signOut()
        return
      }
      if (cancelled || myGeneration !== applyGeneration) return

      try {
        await ensureProfile(u.id, u.email ?? '')
      } catch (e) {
        console.warn('[auth] ensureProfile failed', e)
      }
      const profile = await db.profiles.get(u.id).catch(() => undefined)

      if (cancelled || myGeneration !== applyGeneration) return

      offlineSessionUserId = offlineSession ? u.id : null
      setUser(u)
      setUserType(profile?.user_type === 'admin' ? 'admin' : 'user')
      setCurrentUserId(u.id)
      // Sync and realtime stay off until the token is refreshed.
      setAuthReady(!offlineSession)
      if (!offlineSession) void runGate(u.id)
    }

    async function onBackOnline() {
      if (offlineSessionUserId) {
        const { data, error } = await supabase.auth.refreshSession()
        if (cancelled) return
        if (data?.session) {
          offlineSessionUserId = null
          await applySession(data.session)
        } else if (error && !isDefinitiveAuthFailure(error)) {
          // Still no reliable network: stay in offline session mode until the next reconnect.
        } else {
          await signOutWith(SESSION_EXPIRED_MESSAGE_KEY, '1')
        }
        return
      }
      if (gateRetryUserId) void runGate(gateRetryUserId)
    }

    /** Offline, an auth-js `null` may only mean "could not refresh"; fall back to the stored session. */
    const offlineFallback = (session: Session | null) => session ?? (isOnline() ? null : readStoredSession())

    void (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (cancelled) return
        await applySession(offlineFallback(session))
      } catch (e) {
        console.warn('[auth] session bootstrap failed', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const next = event === 'SIGNED_OUT' ? null : offlineFallback(session)
      const nextId = next?.user?.id ?? null
      const prevId = prevAuthUserIdRef.current
      prevAuthUserIdRef.current = nextId

      if (!nextId && prevId && event === 'SIGNED_OUT') {
        if (
          !sessionStorage.getItem(INACTIVE_ACCOUNT_MESSAGE_KEY) &&
          !consumeVoluntarySignOut()
        ) {
          sessionStorage.setItem(SESSION_EXPIRED_MESSAGE_KEY, '1')
        }
      }

      void applySession(next).then(() => {
        if (!cancelled) setLoading(false)
      })
    })

    const handleOnline = () => void onBackOnline()
    window.addEventListener('online', handleOnline)

    return () => {
      cancelled = true
      subscription.unsubscribe()
      window.removeEventListener('online', handleOnline)
    }
  }, [setCurrentUserId])

  const resolveSwitch = useCallback(
    (proceed: boolean) => {
      switchPrompt?.resolve(proceed)
      setSwitchPrompt(null)
    },
    [switchPrompt],
  )

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      return { error }
    }
    const sessionUser = data.session?.user
    if (!sessionUser) {
      return { error: new Error('Sign in failed. Try again.') }
    }

    const gate = await withMetric('auth.accountGate.signIn', () => readAccountStatus(sessionUser.id))

    if (gate.kind !== 'status') {
      await supabase.auth.signOut()
      return { error: new Error('Could not verify your account right now. Please try again.') }
    }

    if (gate.status !== 'active') {
      await supabase.auth.signOut()
      return { error: new Error(messageForAccountNotActive((gate.status ?? undefined) as ProfileAccountStatus | undefined)) }
    }

    // applySession still seeds Dexie + userType from the full profile payload.
    return { error: null }
  }, [])

  const signUp = useCallback(async (email: string, password: string, nickname: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Must match an entry under Supabase → Authentication → URL Configuration → Redirect URLs
        emailRedirectTo: authRedirectUrl('/login'),
        data: { display_name: nickname.trim() },
      },
    })
    if (error) {
      return { error, requiresEmailConfirmation: false }
    }

    const requiresEmailConfirmation = !data.session

    if (data.user) {
      pendingSignupNickname.set(data.user.id, nickname.trim())
    }

    // When a session is returned immediately, account gate + Dexie seed run in applySession.

    return { error: null, requiresEmailConfirmation }
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: authRedirectUrl('/app/settings'),
    })
    return { error }
  }, [])

  /** Cloud-first like every other write: throws when the server refuses, queues when it cannot answer. */
  const updateDisplayName = useCallback(async (displayName: string) => {
    const userId = useAppStore.getState().currentUserId
    const trimmed = displayName.trim()
    if (!userId || !trimmed) return
    await renameSelf(userId, trimmed)
    void supabase.auth.updateUser({ data: { display_name: trimmed } }).catch(() => {
      /* optional metadata; ignore */
    })
  }, [])

  const value: AuthContextValue = {
    user,
    userType,
    authReady,
    loading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    resetPassword,
    updateDisplayName,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={switchPrompt !== null}
        onOpenChange={(open) => {
          if (!open) resolveSwitch(false)
        }}
        title="Unsent changes on this device"
        description="The account that last used this device has changes that never reached the cloud. Continuing deletes them from this device. Cancel signs you out so that account can sign in and send them."
        confirmLabel="Continue"
        pendingLabel="Clearing…"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => resolveSwitch(true)}
      />
    </AuthContext.Provider>
  )
}
