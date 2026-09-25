/**
 * A fake write server for tests of the cloud-first write path.
 *
 * Operations submit their rows to the server and mirror only what comes back, so a stub that
 * returns `null` reads as "the server stored nothing" and every write correctly refuses. This
 * echoes the push back together with migration 044's `applied` map, which is what the client
 * treats as proof a row was stored.
 *
 * Answers BOTH write RPCs, because the client must work against either server generation:
 *   - `kwenta_write` (migration 066) — the current path. Echoes only the submitted rows and
 *     carries `reads`.
 *   - `kwenta_sync` — the fallback for a database without 066, which returns a pull bundle.
 * The stored-row semantics are identical; only the response envelope differs.
 *
 * Use via `vi.hoisted` so the state is available inside the hoisted `vi.mock` factory:
 *
 *   const cloud = vi.hoisted(() => ({ mode: 'ok', refuse: new Set<string>(), calls: 0 }))
 *   vi.mock('@/lib/supabase', () => ({ supabase: makeSupabaseCloudMock(cloud) }))
 */

export const SYNC_TABLES = [
  'profiles',
  'groups',
  'group_members',
  'bills',
  'bill_items',
  'item_splits',
  'settlements',
  'activity_log',
  'profile_peer_links',
] as const

export type CloudMockMode =
  | 'ok'
  /** Legacy: an error with a message and no code or status. Reads as a doubtful failure. */
  | 'error'
  /** Accepts the call but stores nothing, so the client's `applied` check reports NOT_STORED. */
  | 'drop'
  /** A real server refusal: a Postgres error code (`errorCode`, default P0001), nothing stored. */
  | 'reject'
  /** The request never reached the server: supabase-js's fetch-failure shape, `status` 0 by default. */
  | 'transport'
  /** The server APPLIES the push, then the client sees a transport failure (response lost). */
  | 'lost'
  /** 076's refusal for a caller whose account is not active: 42501 + `kwenta_account_inactive:<status>`. */
  | 'inactive'

export type CloudMockState = {
  mode?: CloudMockMode
  /** HTTP status for 'transport' / 'lost' (0 = no response, 502/503/504 = gateway). */
  status?: number
  /** Postgres error code for 'reject'. */
  errorCode?: string
  /**
   * HTTP status for 'reject' (default 400). With a PostgREST server-state code (PGRST000-003) and a
   * 5xx this is the answer of a server that never ran the call — which the client must replay.
   */
  errorStatus?: number
  /** Account status carried by 'inactive'. */
  inactiveStatus?: string
  /** Any push carrying a row with one of these ids is refused as 'reject' would, whatever the mode. */
  rejectIds?: Set<string>
  /** The fake server's stored rows per table, keyed by id, when a test needs to count them. */
  server?: Map<string, Map<string, unknown>>
  /** What `kwenta_reconcile_user_event` answers (a pull-bundle-shaped object). */
  reconcilePayload?: Record<string, unknown> | null
  /** Every `kwenta_reconcile_user_event` argument object, in order. */
  reconcileCalls?: Record<string, unknown>[]
  /** Rows inserted through `from(table).insert(...)`, per call. */
  inserts?: { table: string; rows: unknown }[]
  /** Tables the fake server refuses to store, to simulate a partial server-side drop. */
  refuse?: Set<string>
  /** Incremented per kwenta_sync round trip, so tests can assert one submission per mutation. */
  calls?: number
  /** Each push payload received, in order. */
  pushes?: Record<string, { id: string }[]>[]
  /** Submission ids seen, in order (undefined when the client did not send one). */
  submissionIds?: (string | undefined)[]
  /** Simulate a server WITHOUT migration 050: reject any call carrying p_submission_id. */
  rejectSubmissionId?: boolean
  /**
   * Simulate a server WITHOUT migration 066, so the client falls back to `kwenta_sync`.
   * Implied by `rejectSubmissionId`: a database that predates 050 cannot have 066 either.
   */
  rejectWriteRpc?: boolean
  /** Submission ids already applied, so a replay returns the original outcome. */
  seen?: Map<string, Record<string, string[]>>
  /** Payload the fake server returns per requested read key. */
  readPayloads?: Record<string, unknown>
  /** Every `p_reads` array received, in order. */
  readSpecs?: Record<string, unknown>[][]
  /** Every RPC name called, in order — including reads, so a test can prove one did NOT happen. */
  rpcNames?: string[]
  /** While set, `kwenta_write` does not answer until it resolves (a write still in flight). */
  hold?: Promise<void> | null
  /** When set, `hold` applies only to a push carrying a row with one of these ids. */
  holdIds?: Set<string> | null
}

const MISSING_FUNCTION = { code: 'PGRST202', message: 'Could not find the function' }

/** supabase-js/postgrest-js answer to a fetch that threw: empty code, status 0. */
function transportFailure(status: number | undefined) {
  const s = status ?? 0
  if (s === 0) {
    return {
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
      status: 0,
      statusText: '',
    }
  }
  return {
    data: null,
    error: { message: 'Service Unavailable', details: '', hint: '', code: '' },
    status: s,
    statusText: 'Service Unavailable',
  }
}

function rejection(code: string | undefined, status?: number) {
  return {
    data: null,
    error: {
      message: 'kwenta_write refused rows: bills:x',
      details: '',
      hint: '',
      code: code ?? 'P0001',
    },
    status: status ?? 400,
    statusText: status && status >= 500 ? 'Service Unavailable' : 'Bad Request',
  }
}

function inactive(status: string | undefined) {
  return {
    data: null,
    error: {
      message: `kwenta_account_inactive:${status ?? 'inactive'}`,
      details: '',
      hint: '',
      code: '42501',
    },
    status: 403,
    statusText: 'Forbidden',
  }
}

export function makeSupabaseCloudMock(state: CloudMockState) {
  /** Shared by both RPCs: what the fake server stores, and what it says it stored. */
  function applyPush(
    push: Record<string, { id: string }[]>,
    submissionId: string | undefined,
  ): { applied: Record<string, string[]>; storedRows: Record<string, { id: string }[]> } {
    const applied: Record<string, string[]> = {}
    const storedRows: Record<string, { id: string }[]> = {}
    for (const t of SYNC_TABLES) storedRows[t] = []
    if (state.mode !== 'drop') {
      for (const t of SYNC_TABLES) {
        if (state.refuse?.has(t)) continue
        const rows = push[t] ?? []
        storedRows[t] = rows
        if (rows.length > 0) applied[t] = rows.map((r) => r.id)
        if (state.server) {
          let byId = state.server.get(t)
          if (!byId) {
            byId = new Map()
            state.server.set(t, byId)
          }
          for (const r of rows) byId.set(r.id, r)
        }
      }
    }
    if (submissionId !== undefined && state.mode !== 'drop') state.seen?.set(submissionId, applied)
    return { applied, storedRows }
  }

  /** The non-'ok' answers shared by both write RPCs; null means "proceed normally". */
  function failureFor(push: Record<string, { id: string }[]>) {
    if (state.rejectIds && state.rejectIds.size > 0) {
      for (const t of SYNC_TABLES) {
        if ((push[t] ?? []).some((r) => state.rejectIds!.has(r.id))) return rejection(state.errorCode, state.errorStatus)
      }
    }
    if (state.mode === 'reject') return rejection(state.errorCode, state.errorStatus)
    if (state.mode === 'inactive') return inactive(state.inactiveStatus)
    if (state.mode === 'transport') return transportFailure(state.status)
    return null
  }

  function emptyTables(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const t of SYNC_TABLES) out[t] = []
    return out
  }

  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'ME' } } } }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        gt: () => b,
        order: () => b,
        limit: () => Promise.resolve({ data: [], error: null }),
        insert: (rows: unknown) => {
          state.inserts?.push({ table, rows })
          return Promise.resolve({ data: rows, error: null })
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
        data: [],
        error: null,
      }
      return b
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcNames?.push(fn)

      if (fn === 'kwenta_reconcile_user_event') {
        state.reconcileCalls?.push(args ?? {})
        return { data: state.reconcilePayload ?? null, error: null }
      }

      if (fn === 'kwenta_write') {
        // A server predating 066 has no such function at all.
        if (state.rejectWriteRpc || state.rejectSubmissionId) {
          return { data: null, error: MISSING_FUNCTION }
        }

        // The client sends `null` rather than omitting the argument; normalise so assertions read
        // the same on both paths.
        const submissionId = (args?.p_submission_id ?? undefined) as string | undefined
        const reads = (args?.p_reads ?? []) as Record<string, unknown>[]
        state.readSpecs?.push(reads)

        state.calls = (state.calls ?? 0) + 1
        const push = (args?.p_push ?? {}) as Record<string, { id: string }[]>
        state.pushes?.push(push)
        state.submissionIds?.push(submissionId)
        if (
          state.hold &&
          (!state.holdIds || SYNC_TABLES.some((t) => (push[t] ?? []).some((r) => state.holdIds!.has(r.id))))
        ) {
          await state.hold
        }

        if (state.mode === 'error') return { data: null, error: { message: 'network unreachable' } }
        const refusal = failureFor(push)
        if (refusal) return refusal

        const answered: Record<string, unknown> = {}
        for (const spec of reads) {
          const key = String(spec.key ?? '')
          if (key && state.readPayloads && key in state.readPayloads) {
            answered[key] = state.readPayloads[key]
          }
        }

        if (submissionId !== undefined && state.seen?.has(submissionId)) {
          return {
            data: {
              ...emptyTables(),
              applied: state.seen.get(submissionId),
              replayed: true,
              reads: answered,
            },
            error: null,
          }
        }

        const { applied, storedRows } = applyPush(push, submissionId)
        if (state.mode === 'lost') return transportFailure(state.status)
        return { data: { ...emptyTables(), ...storedRows, applied, reads: answered }, error: null }
      }

      if (fn !== 'kwenta_sync') return { data: null, error: null }

      const submissionId = args?.p_submission_id as string | undefined

      // A server predating migration 050 has no three-argument overload.
      if (state.rejectSubmissionId && submissionId !== undefined) {
        return { data: null, error: MISSING_FUNCTION }
      }

      state.calls = (state.calls ?? 0) + 1
      const push = (args?.p_push ?? {}) as Record<string, { id: string }[]>
      state.pushes?.push(push)
      state.submissionIds?.push(submissionId)

      if (state.mode === 'error') return { data: null, error: { message: 'network unreachable' } }
      const refusal = failureFor(push)
      if (refusal) return refusal

      // Replay: return the original outcome without applying anything again.
      if (submissionId !== undefined && state.seen?.has(submissionId)) {
        return {
          data: { ...emptyTables(), applied: state.seen.get(submissionId), replayed: true },
          error: null,
        }
      }

      const { applied, storedRows } = applyPush(push, submissionId)
      if (state.mode === 'lost') return transportFailure(state.status)
      return { data: { ...emptyTables(), ...storedRows, applied }, error: null }
    },
  }
}
