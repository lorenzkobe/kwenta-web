import { beforeEach, describe, expect, it } from 'vitest'
import { captureMetric, withMetric } from '@/lib/client-metrics'

const STORAGE_KEY = 'kwenta_client_metrics'
const readBuckets = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')

describe('captureMetric', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('creates a bucket on first capture', () => {
    captureMetric('sync', true, 120)
    const b = readBuckets().sync
    expect(b.count).toBe(1)
    expect(b.ok).toBe(1)
    expect(b.err).toBe(0)
    expect(b.totalMs).toBe(120)
  })

  it('accumulates ok/err counts and duration across captures', () => {
    captureMetric('sync', true, 100)
    captureMetric('sync', false, 50)
    const b = readBuckets().sync
    expect(b.count).toBe(2)
    expect(b.ok).toBe(1)
    expect(b.err).toBe(1)
    expect(b.totalMs).toBe(150)
  })

  it('clamps negative durations to zero and rounds', () => {
    captureMetric('sync', true, -10)
    captureMetric('sync', true, 9.6)
    expect(readBuckets().sync.totalMs).toBe(10)
  })
})

describe('withMetric', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('records success and returns the value', async () => {
    const result = await withMetric('op', () => 42)
    expect(result).toBe(42)
    expect(readBuckets().op.ok).toBe(1)
  })

  it('records failure and rethrows', async () => {
    await expect(
      withMetric('op', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(readBuckets().op.err).toBe(1)
  })

  it('awaits async actions', async () => {
    const result = await withMetric('op', async () => 'done')
    expect(result).toBe('done')
    expect(readBuckets().op.count).toBe(1)
  })
})
