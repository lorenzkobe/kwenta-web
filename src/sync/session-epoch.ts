/**
 * Which local session a response belongs to.
 *
 * `clearKwentaLocalData` (sign-out, account switch) wipes the mirror while requests of the ending
 * session can still be in flight. When one of them resolves afterwards, mirroring it would put the
 * previous account's rows into the next account's empty mirror. Every Dexie write driven by a
 * response captures the epoch before its request and checks it before writing.
 */

let epoch = 0

export function currentSessionEpoch(): number {
  return epoch
}

/** Called by the wipe, BEFORE it deletes anything, so a write racing the wipe already sees it. */
export function bumpSessionEpoch(): void {
  epoch++
}

export function isSessionEpochCurrent(captured: number): boolean {
  return captured === epoch
}

/** The session that issued the request ended before its response could be applied. */
export class SessionEndedError extends Error {
  constructor() {
    super('The session ended before this response arrived; nothing was applied.')
    this.name = 'SessionEndedError'
  }
}

export function assertSessionEpoch(captured: number): void {
  if (captured !== epoch) throw new SessionEndedError()
}
