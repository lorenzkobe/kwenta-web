// Provide an in-memory IndexedDB so Dexie (`@/db/db`) can open in unit tests.
// Must run before any module that instantiates the DB is imported.
import 'fake-indexeddb/auto'
