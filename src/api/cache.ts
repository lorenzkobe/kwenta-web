/**
 * Last-known-good response per endpoint, so a screen still renders offline.
 *
 * This is a CACHE, never a source of truth: when online the server response is the answer, and
 * the cache is only read when the network is unavailable. Nothing infers "this row was deleted"
 * from its absence here — that inference is what made the old local-mirror design unsafe once
 * reads became scoped.
 */
const PREFIX = 'kwenta_api_cache_v1:'

export type CachedResponse<T> = {
  data: T
  /** When the cached copy was fetched, for the "showing saved data" line. */
  fetchedAt: string
}

function key(endpoint: string, userId: string): string {
  return `${PREFIX}${userId}:${endpoint}`
}

export function readCache<T>(endpoint: string, userId: string): CachedResponse<T> | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key(endpoint, userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedResponse<T>
    if (!parsed || typeof parsed.fetchedAt !== 'string') return null
    return parsed
  } catch {
    // A corrupt or unreadable entry must degrade to "no cache", never throw into a render.
    return null
  }
}

/**
 * How many cached responses to keep.
 *
 * Per-entity endpoints (`bill:<id>`, `group:<id>`, `person:<id>`, `statement:<id>`) mint a new
 * key for every row the user opens, so without a cap the cache grows for the life of the install
 * and eventually fills the origin's storage. The failure that causes is quiet and bad: writes
 * start throwing, the catch below swallows them, and the offline copy silently stops updating —
 * so the screens the user actually visits keep showing older and older numbers while the space is
 * held by bills they opened once months ago.
 */
const MAX_ENTRIES = 60

/**
 * How many of our keys are in storage, without parsing any of them.
 *
 * The cap check runs on EVERY successful write, and a screen fires several. Reading it via
 * `entriesOldestFirst()` meant `JSON.parse`-ing all ~60 cached payloads — some of them whole
 * group-detail bundles — on the main thread per fetch, roughly 180 parses per navigation and
 * again after every mutation's `bumpDataVersion`. Counting keys needs no parse at all; the sort
 * is only paid when the cache has actually overflowed.
 */
function countEntries(): number {
  let n = 0
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(PREFIX)) n++
  }
  return n
}

/** Every cache key with its fetch time, oldest first. Unparseable entries sort first (evict them). */
function entriesOldestFirst(): { key: string; fetchedAt: string }[] {
  const out: { key: string; fetchedAt: string }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k?.startsWith(PREFIX)) continue
    let fetchedAt = ''
    try {
      const parsed = JSON.parse(localStorage.getItem(k) ?? '') as { fetchedAt?: unknown }
      if (typeof parsed?.fetchedAt === 'string') fetchedAt = parsed.fetchedAt
    } catch {
      /* leave empty so it sorts first and is evicted first */
    }
    out.push({ key: k, fetchedAt })
  }
  out.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
  return out
}

function evictOldest(count: number): number {
  const victims = entriesOldestFirst().slice(0, Math.max(count, 0))
  for (const v of victims) localStorage.removeItem(v.key)
  return victims.length
}

export function writeCache<T>(endpoint: string, userId: string, data: T, fetchedAt: string): void {
  if (typeof localStorage === 'undefined') return
  const k = key(endpoint, userId)
  try {
    localStorage.setItem(k, JSON.stringify({ data, fetchedAt }))
  } catch {
    // Quota exhausted or storage blocked (Safari private mode). Make room and try once more —
    // the entry being written is the one the user is looking at, so it is the one worth keeping.
    try {
      if (evictOldest(10) > 0) {
        localStorage.setItem(k, JSON.stringify({ data, fetchedAt }))
      }
    } catch {
      // Storage is genuinely unavailable. Losing the offline copy is a degraded experience;
      // failing the write would be a broken screen.
      return
    }
  }

  try {
    const overflow = countEntries() - MAX_ENTRIES
    if (overflow > 0) evictOldest(overflow)
  } catch {
    /* best effort — a full cache is not worth failing a render over */
  }
}

/** Drop every cached response. Called on sign-out alongside the Dexie wipe. */
export function clearApiCache(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* best effort */
  }
}
