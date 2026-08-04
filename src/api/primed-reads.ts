/**
 * The channel that lets a write answer the screen it came from.
 *
 * A mutation moves money, and money is computed in SQL (CLAUDE.md rule 8) — so the new balance is
 * not derivable on the client from the rows the write echoes back. Before `066` the only way to
 * show it was to fetch the screen again, which is a second round trip for a number the server had
 * just recomputed while applying the write.
 *
 * `kwenta_write` now takes the endpoints that are on screen and returns their recomputed payloads
 * alongside the stored rows. This module is the two halves of that:
 *
 *   - which endpoints are mounted, and the RPC spec for each, so the write knows what to ask for;
 *   - the answers it came back with, so the re-read triggered by `bumpDataVersion` is served from
 *     memory instead of the network.
 *
 * A primed payload is the RAW rpc response, never a mapped one: it is handed to the same mapper
 * the normal fetch path uses, so there is exactly one implementation of every endpoint's shape
 * rules. A second copy of those would drift, and they encode real invariants — `numeric` arriving
 * as a string, a null total that must be dropped rather than read as a zero balance.
 */

/** One entry of `kwenta_write`'s `p_reads`. Shaped like the SQL argument so nothing translates. */
export type ReadSpec = {
  /** The api cache key this answers, e.g. `overview`, `group:<uuid>`. */
  key: string
  /** The RPC name. The server whitelists these; an unknown one is dropped, never dispatched. */
  fn: string
  /**
   * Name of the RPC's uuid parameter (`p_bill_id`, `p_group_id`, `p_person_id`).
   *
   * Declared at the call site rather than looked up from `fn`, so there is no table of parameter
   * names to keep in step with the SQL. `kwenta_read` takes the id positionally and does not need
   * this; only the direct PostgREST call does.
   */
  argName?: string
  id?: string
  limit?: number
  /**
   * Arguments the direct RPC call needs that `p_reads` cannot express — `kwenta_read` dispatches
   * on one uuid or one limit, nothing else. A spec carrying these is never sent to the server for
   * recomputation, which is correct: the only such endpoint is the member-breakdown guard, which
   * is deliberately outside `kwenta_read`'s whitelist and must never be served from anywhere but a
   * live call.
   */
  extraArgs?: Record<string, unknown>
}

/** The PostgREST argument object for a spec. */
export function rpcArgs(spec: Omit<ReadSpec, 'key'>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...spec.extraArgs }
  if (spec.argName && spec.id !== undefined) args[spec.argName] = spec.id
  if (spec.limit !== undefined) args.p_limit = spec.limit
  return args
}

/**
 * How long a primed payload may be served.
 *
 * It exists to satisfy the ONE re-read that `bumpDataVersion` triggers immediately after the write,
 * and it is consumed by that read. The expiry is the backstop for the case where the screen
 * unmounted in between: without it a leftover could be served to a manual refresh minutes later,
 * which would show the user a stale answer under a fresh timestamp.
 *
 * Measured with `performance.now()`, so a device clock that jumps cannot extend or void it.
 */
const PRIME_TTL_MS = 5_000

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

const specsByKey = new Map<string, ReadSpec>()
/** Refcounted: two components may render the same endpoint, and the last one out clears it. */
const mountedKeys = new Map<string, number>()
const primed = new Map<string, { raw: unknown; at: number }>()

/**
 * How many endpoint specs to remember.
 *
 * Per-entity keys (`bill:<id>`, `group:<id>`, `person:<id>`) mint a new one for every row the user
 * opens, so without a bound this map would grow for the life of the tab. Only MOUNTED keys are
 * ever read from it, and there are a handful of those; evicting an old entry costs nothing worse
 * than that endpoint not being recomputed by the next write, which then fetches normally.
 */
const MAX_REMEMBERED_SPECS = 64

/** Called on every fetch, so the spec for a key is known without a second key→RPC table. */
export function rememberReadSpec(spec: ReadSpec): void {
  // Re-insert so the Map's insertion order is a true recency order for the eviction below.
  specsByKey.delete(spec.key)
  specsByKey.set(spec.key, spec)
  if (specsByKey.size <= MAX_REMEMBERED_SPECS) return
  for (const key of [...specsByKey.keys()]) {
    if (specsByKey.size <= MAX_REMEMBERED_SPECS) break
    // Never evict something on screen — that is the only set a write actually asks for.
    if (mountedKeys.has(key)) continue
    specsByKey.delete(key)
  }
}

export function markReadMounted(key: string): void {
  mountedKeys.set(key, (mountedKeys.get(key) ?? 0) + 1)
}

export function markReadUnmounted(key: string): void {
  const n = (mountedKeys.get(key) ?? 0) - 1
  if (n > 0) mountedKeys.set(key, n)
  else mountedKeys.delete(key)
}

/**
 * The specs a write should ask the server to recompute: the endpoints currently on screen that
 * have been fetched at least once, so their RPC and arguments are known.
 */
export function mountedReadSpecs(): ReadSpec[] {
  const out: ReadSpec[] = []
  for (const key of mountedKeys.keys()) {
    const spec = specsByKey.get(key)
    if (spec && !spec.extraArgs) out.push(spec)
  }
  return out
}

/**
 * Store the payloads a write returned.
 *
 * Replaces rather than merges: anything left from an earlier write was already superseded by this
 * one, and serving it afterwards would be serving a value the server has since changed.
 */
export function primeReads(reads: Record<string, unknown> | null | undefined): void {
  primed.clear()
  if (!reads || typeof reads !== 'object') return
  const at = monotonicNow()
  for (const [key, raw] of Object.entries(reads)) {
    // A key the server declined to answer comes back as JSON null. Priming that would render an
    // empty screen as if it were the truth; leaving it out makes the client fetch normally.
    if (raw === null || raw === undefined) continue
    primed.set(key, { raw, at })
  }
}

/** Take the primed payload for `key`, if there is a fresh one. One-shot by design. */
export function consumePrimedRead(key: string): { raw: unknown } | undefined {
  const hit = primed.get(key)
  if (!hit) return undefined
  primed.delete(key)
  if (monotonicNow() - hit.at > PRIME_TTL_MS) return undefined
  return { raw: hit.raw }
}

/**
 * Drop everything. Called on sign-out beside the Dexie wipe and the api cache clear — a primed
 * payload is another user's data once the session changes.
 */
export function clearPrimedReads(): void {
  primed.clear()
  specsByKey.clear()
  mountedKeys.clear()
}
