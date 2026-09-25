import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * C28 — a 403 carrying `kwenta_account_inactive` from ANY request signs the user out.
 *
 * Migration 076 enforces account status on the server; PostgREST's pre-request hook answers every
 * endpoint for an inactive caller with 403 and a message `kwenta_account_inactive:<status>`
 * (skeptic amendment H1.3). The client learns it through the fetch the Supabase client uses, so
 * the test captures the `global.fetch` option handed to `createClient` and drives it directly —
 * no assumption about what the wrapper is called.
 */

const h = vi.hoisted(() => ({
  options: null as null | { global?: { fetch?: typeof fetch } },
  signOut: vi.fn<(opts?: { scope?: string }) => Promise<{ error: null }>>(async () => ({ error: null })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: typeof h.options) => {
    h.options = options
    return {
      auth: { signOut: h.signOut, getSession: async () => ({ data: { session: null } }) },
      from: vi.fn(),
      rpc: vi.fn(),
    }
  },
}))

const realFetch = globalThis.fetch

function inactive403(status = 'inactive') {
  return new Response(
    JSON.stringify({ code: '42501', message: `kwenta_account_inactive:${status}`, details: null, hint: null }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

async function wrappedFetch(): Promise<typeof fetch> {
  vi.resetModules()
  await import('@/lib/supabase')
  const f = h.options?.global?.fetch
  expect(f, 'createClient must be given a global.fetch wrapper').toBeTypeOf('function')
  return f as typeof fetch
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  h.options = null
  h.signOut.mockClear()
  sessionStorage.clear()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('Supabase fetch wrapper — inactive account', () => {
  it('C28: a 403 with kwenta_account_inactive:inactive signs the user out', async () => {
    globalThis.fetch = vi.fn(async () => inactive403('inactive')) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/rpc/kwenta_contacts', { method: 'POST' })
    await settle()

    expect(h.signOut).toHaveBeenCalled()
  })

  // review-2 C2.2: a response may only sign THIS device out. The default 'global' scope revokes the
  // account's refresh tokens everywhere, which a single 403 must never be able to do.
  it('C28: the sign-out is local to this device', async () => {
    globalThis.fetch = vi.fn(async () => inactive403('inactive')) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/rpc/kwenta_contacts', { method: 'POST' })
    await settle()

    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('C28: the reported status is kept for the login notice', async () => {
    globalThis.fetch = vi.fn(async () => inactive403('unconfirmed')) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/bills?select=*')
    await settle()

    expect(sessionStorage.getItem('kwenta_show_inactive_account_on_login')).toBe('unconfirmed')
  })

  it('C28: an unconfirmed account is signed out the same way', async () => {
    globalThis.fetch = vi.fn(async () => inactive403('unconfirmed')) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/bills?select=*')
    await settle()

    expect(h.signOut).toHaveBeenCalled()
  })

  it('C28: the caller still receives the original 403 with a readable body', async () => {
    globalThis.fetch = vi.fn(async () => inactive403('inactive')) as typeof fetch
    const f = await wrappedFetch()

    const res = await f('https://x.supabase.co/rest/v1/rpc/kwenta_write', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(await res.text()).toContain('kwenta_account_inactive:inactive')
  })

  it('C28 refused side: a 403 WITHOUT the marker (an RLS/permission error) does not sign out', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: '42501', message: 'permission denied for table bills' }), {
          status: 403,
        }),
    ) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/bills?select=*')
    await settle()

    expect(h.signOut).not.toHaveBeenCalled()
  })

  // review-2 C2.2: only 076's exact error shape counts. A 403 that merely CONTAINS the marker text
  // elsewhere (echoed input, a details field, another service) must not sign anyone out.
  it('C28 refused side: a 403 carrying the marker outside a 42501 message does not sign out', async () => {
    const bodies = [
      { code: '42501', message: 'permission denied for table bills', details: 'kwenta_account_inactive:inactive' },
      { code: 'P0001', message: 'kwenta_account_inactive:inactive' },
      { code: '42501', message: 'note: kwenta_account_inactive:inactive' },
    ]
    for (const body of bodies) {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 403 })) as typeof fetch
      const f = await wrappedFetch()
      await f('https://x.supabase.co/rest/v1/bills?select=*')
      await settle()
    }
    globalThis.fetch = vi.fn(async () => new Response('kwenta_account_inactive:inactive', { status: 403 })) as typeof fetch
    const f = await wrappedFetch()
    await f('https://x.supabase.co/storage/v1/object/x')
    await settle()

    expect(h.signOut).not.toHaveBeenCalled()
  })

  it('C28 refused side: a 200 whose body merely mentions the marker does not sign out', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify([{ note: 'kwenta_account_inactive:inactive' }]), { status: 200 }),
    ) as typeof fetch
    const f = await wrappedFetch()

    await f('https://x.supabase.co/rest/v1/bills?select=*')
    await settle()

    expect(h.signOut).not.toHaveBeenCalled()
  })

  it('C28 refused side: a transport failure propagates and does not sign out', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const f = await wrappedFetch()

    await expect(f('https://x.supabase.co/rest/v1/bills')).rejects.toThrow('Failed to fetch')
    await settle()

    expect(h.signOut).not.toHaveBeenCalled()
  })
})
