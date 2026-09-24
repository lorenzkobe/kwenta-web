import { describe, expect, it } from 'vitest'
import { trackCloudWrite, waitForInFlightCloudWrites } from '@/sync/in-flight-writes'

/**
 * The realtime path waits for this device's in-flight cloud writes before deciding whether an
 * event is an echo of one of them (the echo can arrive before the write's response has been
 * mirrored). That wait must never throw and never hang: the realtime batch it guards has already
 * been taken off the queue, so an exception loses it and a hang stalls every later event.
 */
describe('waitForInFlightCloudWrites', () => {
  it('resolves true at once when nothing is in flight', async () => {
    await expect(waitForInFlightCloudWrites(1_000)).resolves.toBe(true)
  })

  it('waits for a tracked write to settle, then resolves true', async () => {
    let release!: () => void
    const write = trackCloudWrite(new Promise<void>((r) => (release = r)))
    let done = false
    const waiting = waitForInFlightCloudWrites(1_000).then((v) => {
      done = true
      return v
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(done).toBe(false)
    release()
    await expect(waiting).resolves.toBe(true)
    await write
  })

  it('a rejected write still resolves true and never throws; the caller still sees the rejection', async () => {
    const failing = trackCloudWrite(Promise.reject(new Error('rejected by server')))
    await expect(waitForInFlightCloudWrites(1_000)).resolves.toBe(true)
    await expect(failing).rejects.toThrow('rejected by server')
  })

  it('a settled write is forgotten, so a later wait does not wait on it', async () => {
    let release!: () => void
    const write = trackCloudWrite(new Promise<void>((r) => (release = r)))
    release()
    await write
    await expect(waitForInFlightCloudWrites(1_000)).resolves.toBe(true)
  })

  // Last: the hung write stays tracked for the rest of this module.
  it('a write that never settles times out and resolves false', async () => {
    const hung = trackCloudWrite(new Promise<void>(() => {}))
    void hung
    await expect(waitForInFlightCloudWrites(20)).resolves.toBe(false)
  })
})
