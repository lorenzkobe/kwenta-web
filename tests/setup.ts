// Provide an in-memory IndexedDB so Dexie (`@/db/db`) can open in unit tests.
// Must run before any module that instantiates the DB is imported.
import 'fake-indexeddb/auto'

import { vi } from 'vitest'

// vi.waitFor gives up after 1 s by default. A condition that is merely slow on a loaded machine (CI,
// parallel suites) then fails as if it were false; 5 s keeps the wait a wait. A call that passes its
// own timeout keeps it.
const waitFor = vi.waitFor
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: 5_000, ...options })) as typeof vi.waitFor
