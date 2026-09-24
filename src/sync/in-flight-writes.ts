/**
 * Cloud writes this device has sent and not yet seen settle.
 *
 * The realtime path uses this to tell its own echoes apart: a write's events can arrive before the
 * write's response has been mirrored, and until then the mirror cannot recognise them. Waiting for
 * the write turns that race into a skip instead of a reconcile or a full round trip.
 */
const inFlight = new Set<Promise<unknown>>()

/** Registers `write` until it settles and returns it unchanged (a rejection still reaches the caller). */
export function trackCloudWrite<T>(write: Promise<T>): Promise<T> {
  inFlight.add(write)
  const forget = () => {
    inFlight.delete(write)
  }
  write.then(forget, forget)
  return write
}

/**
 * Resolves true once every write in flight when called has settled (fulfilled or rejected), or
 * false after `timeoutMs`. Never rejects: the realtime batch waiting on it has already left the
 * queue, so a throw would lose it and a hang would stall every later event.
 */
export async function waitForInFlightCloudWrites(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([Promise.allSettled([...inFlight]).then(() => true as const), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
