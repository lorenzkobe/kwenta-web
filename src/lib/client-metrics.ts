type MetricFields = Record<string, number | string | boolean | null | undefined>

type MetricBucket = {
  count: number
  ok: number
  err: number
  totalMs: number
  lastAt: string
}

const STORAGE_KEY = 'kwenta_client_metrics'

function readBuckets(): Record<string, MetricBucket> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, MetricBucket>
  } catch {
    return {}
  }
}

function writeBuckets(next: Record<string, MetricBucket>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // best-effort metrics only
  }
}

export function captureMetric(name: string, ok: boolean, durationMs: number, fields?: MetricFields) {
  const buckets = readBuckets()
  const prev = buckets[name] ?? { count: 0, ok: 0, err: 0, totalMs: 0, lastAt: new Date(0).toISOString() }
  const next: MetricBucket = {
    count: prev.count + 1,
    ok: prev.ok + (ok ? 1 : 0),
    err: prev.err + (ok ? 0 : 1),
    totalMs: prev.totalMs + Math.max(0, Math.round(durationMs)),
    lastAt: new Date().toISOString(),
  }
  buckets[name] = next
  writeBuckets(buckets)

  if (import.meta.env.DEV) {
    console.info('[metric]', name, { ok, durationMs: Math.round(durationMs), ...fields })
  }
}

export async function withMetric<T>(
  name: string,
  action: () => T | PromiseLike<T>,
  fields?: MetricFields,
): Promise<Awaited<T>> {
  const t0 = performance.now()
  try {
    const result = await action()
    captureMetric(name, true, performance.now() - t0, fields)
    return result as Awaited<T>
  } catch (error) {
    captureMetric(name, false, performance.now() - t0, fields)
    throw error
  }
}

