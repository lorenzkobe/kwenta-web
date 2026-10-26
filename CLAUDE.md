# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript check + Vite production build
npm run lint       # Run ESLint
npm run preview    # Preview production build locally
npm test           # Run unit tests once (Vitest)
npm run test:watch # Run unit tests in watch mode
npm run test:sql   # Run the SQL suite against a throwaway local Postgres (see below)
```

**How work ships here is not optional.** Before writing code, read **Feature Lifecycle**,
**Coding Rules**, **Post-task cleanup checklist** and **Verification** at the bottom of this
file. The first two sections below (plans, testing) are the two rules broken most often, so
they lead.

## Plans & Specs (do not commit)

Design specs and implementation plans (e.g. files under `docs/superpowers/specs/`) are **not** saved in the repo. Write them to disk for review, but **never `git add`/`git commit` them** — leave them untracked. If a skill instructs you to commit the design doc, skip that step for this project.

## Testing Policy (required)

Tests are **mandatory** for this project — we create tests and run testing as part of every change, not as an afterthought.

- The test runner is **Vitest** (`vitest.config.ts`, `happy-dom` environment, `@` alias). Tests live in the top-level **`tests/`** folder, mirroring the source tree: `tests/lib/*.test.ts` for `src/lib/*`, `tests/db/*.test.ts` for `src/db/*`, `tests/sync/*.test.ts` for `src/sync/*`. Import the code under test via the `@` alias (e.g. `@/lib/splits`); import shared test helpers by relative path (e.g. `../helpers/db`).
- `tests/setup.ts` (registered as `setupFiles`) imports `fake-indexeddb/auto` so any module that touches `@/db/db` can open the DB. For Dexie-backed functions, use the factories + `resetDb()` in `tests/helpers/db.ts` (call `resetDb()` in `beforeEach`).
- **Mocking Supabase / sync side-effects:** modules that import `@/lib/supabase` or fire sync/notifications (e.g. `operations.ts`, `kwenta-notifications.ts`, `sync-service.ts`) are tested by `vi.mock`-ing the network/side-effect deps and asserting Dexie/localStorage state. Use `vi.hoisted` to share controllable mock state with the hoisted `vi.mock` factory (see `tests/lib/kwenta-notifications.test.ts`, `tests/lib/cloud-first-mutations.test.ts`, `tests/db/operations.test.ts`). A benign `@/lib/supabase` stub (`rpc → {data:null,error:null}`) keeps `fetchRemoteProfileIntoDexie` offline.
- When adding or changing behavior, add/extend unit tests that cover it. Prefer the pure-logic modules (`src/lib/splits.ts`, `src/lib/utils.ts`, `src/lib/bill-split-form.ts`, etc.). DB-coupled modules (`people.ts`, `operations.ts`) are tested against `fake-indexeddb`.
- Run `npm test` before considering any change complete — **it must pass in full**.
  - No count is pinned here on purpose. A hard-coded total goes stale the moment anyone adds a test file, and a stale figure is worse than none: the next contributor sees a different number and cannot tell whether they broke something or fixed it. A green suite is the signal.
  - What the number was really guarding is worth stating directly instead: **never delete a test, weaken an assertion, or skip a case to make a change pass.** If a test is genuinely wrong, say so and why in the change itself. (This is not hypothetical — a batch of repair-rule tests was dropped when those rules moved into SQL, and `npm test` stayed green while the behaviour went uncovered.)
- **Coverage inventory: `docs/testing-coverage.md`** lists what every Vitest and SQL suite pins — read it before
  changing a covered behaviour, and update it in the same change.
  - **SQL is covered by `npm run test:sql`, not by Vitest.** Vitest has no Postgres, so anything living in SQL — the `kwenta_repair_settlements` rules, the read/write predicate split in `049`, `relevant_bill_ids_for_user` (a wrong set here is a cross-account leak, not a slow query) — used to be untestable, and a batch of repair-rule tests once vanished without `npm test` noticing. See the SQL Test Harness section below. **Both suites must pass.**

## SQL Test Harness (`npm run test:sql`)

`scripts/sql-test.sh` creates a **throwaway** Postgres cluster (port 55432, data dir under
`$TMPDIR`), applies `supabase/tests/harness/000_supabase_shim.sql` + every file in
`supabase/migrations/` in lexical order, then runs each `supabase/tests/sql/*.test.sql` in its own
always-rolled-back transaction. It never touches your Supabase project and never touches an
existing local cluster.

- Requires Postgres 14 (`brew install postgresql@14`), or set `KWENTA_PG_BIN`.
- `npm run test:sql -- --keep` leaves the DB up; `-- --shell` drops you into `psql` on it.
- Assertions live in `supabase/tests/harness/001_test_helpers.sql`: `test.assert_eq`,
  `assert_money` (compares integer cents), `assert_ids` (order-insensitive), `assert_bundle_eq`
  (sorts each bundle array by id, then reports the first differing key), plus fixtures
  `test.new_account / new_contact / new_group / add_member / new_bill / new_settlement /
  new_bundle`. The last two take an optional trailing `p_method` (069); it is **last** so every
  existing positional call keeps working. Note `new_settlement` sets `created_at` and `updated_at`
  to the SAME value — a test that needs them to differ (068 does: the family key is `updated_at`,
  the survivor tiebreak is `created_at`) must insert the rows directly. `new_account` creates an
  ACTIVE account (076 would otherwise refuse every read and write of the fixture); pass the
  optional trailing `p_status` for an inactive or unconfirmed one.
- `test.as_user(uid)` sets `auth.uid()` **and** drops to the `authenticated` role so RLS applies.
  Fixture setup runs as the owner, where RLS does not — **a test that forgets `as_user` proves
  nothing about RLS.** The helper schema is granted to `authenticated` at the end of
  `001_test_helpers.sql`; without that the first `assert_*` after `as_user` dies with "permission
  denied for schema test", which is why the pre-`058` suites all set `request.jwt.claim.sub` alone
  and stayed the owner (auth.uid() set, RLS off, missing GRANTs undetectable).

What each SQL suite covers is listed in **`docs/testing-coverage.md`**.

The shim emulates Supabase's **default privileges** as production had them before `073` (every
new public table, sequence and function granted to `anon` and `authenticated`), so a grant
assertion here fails the way production would. Once `073` has run, a new function defaults to
`service_role` only, in the harness as in production. Before this emulation existed, eleven
server-only functions stayed open in production while every grant test passed.

**Fidelity limit, stated plainly:** the shim approximates Supabase (`auth.users`, `auth.uid()`,
the `authenticated`/`service_role` roles). Nothing verifies a JWT, and `service_role` is an
ordinary role here. What this suite proves reliably is **logic** — predicates, aggregation, money
arithmetic. RLS conclusions still need a check against a real branch database before shipping.

The fixtures must match what the app actually writes, or a test exercises impossible states:
local contacts use `email: ''` (not NULL), equal splits carry `split_value = 1`, settlements have
no `settled_at` column and a NOT NULL `label`.

After every edit, run `npm run build` to confirm no TypeScript errors. If the build reports `TS1127: Invalid character`, the Edit tool introduced Unicode curly quotes (`'`, `'`, `"`, `"`) into string literals. Fix with:

```bash
python3 -c "
with open('PATH', 'rb') as f: content = f.read()
content = content.replace(b'\xe2\x80\x98', b\"'\").replace(b'\xe2\x80\x99', b\"'\").replace(b'\xe2\x80\x9c', b'\"').replace(b'\xe2\x80\x9d', b'\"')
with open('PATH', 'wb') as f: f.write(content)
"
```

---

## Tech Stack

- **Frontend**: React 19 + TypeScript, Vite 7
- **Routing**: React Router v7 (all page routes are lazy-loaded)
- **State**: Zustand v5 — `src/store/app-store.ts`
- **UI**: Radix UI primitives + shadcn-style local components (`src/components/ui/`), Tailwind CSS v4
- **Local DB**: Dexie v4 (IndexedDB) — `src/db/`
- **Cloud**: Supabase (PostgreSQL + Auth + Realtime) — `src/lib/supabase.ts`
- **PWA**: vite-plugin-pwa, injectManifest strategy, service worker at `src/sw.ts`

---

## Product Model

**Personal bills** (`group_id = null`): always "you paid." The app is the current user's ledger. Do not design flows that assume someone else paid on a personal bill.

**Group bills**: collaborative — any member can add expenses attributed to whoever paid. `bills.paid_by` records the actual payer (may differ from `bills.created_by`). If someone outside this user's Kwenta paid for something, they record it on their own account.

When writing copy, defaults, or UX: personal = "you paid"; group = collaborative.

---

## Architecture

### Data Flow Summary

```
User action
  → operations.ts builder (rows in memory, Dexie untouched)
  → commitCloudFirstWrite (src/sync/cloud-write.ts)
      online:  kwenta_write (066/078) → mirror the server's rows → bumpDataVersion
      offline / transport failure: stage rows + queue entry (same submission id) → 'queued'
  → primed reads serve the re-fetch → UI re-renders
Queue: drainWriteQueue (src/sync/write-queue.ts) replays entries in seq order through kwenta_write
```

Realtime path (another device/user changes something):
```
DB trigger → kwenta_user_events → Supabase Realtime
  → realtime-events.ts: debounce (150 ms, 1 s cap) → echo skip → groupByEntity
  → one kwenta_reconcile_user_event per entity (>10 entities or a link/DELETE/unknown event → one fullSync)
  → upsert into Dexie (a staged row only when the server copy is strictly newer) → ONE bumpDataVersion per batch
```

That last `bumpDataVersion` is load-bearing and was missing: screens read SQL endpoints, not
Dexie, so upserting a bundle changes nothing they observe. `notifyServerDataChanged()` fires once
per applied unit of work — one event (`processEventSafely`), one coalesced batch, or one bulk
catch-up — never per upserted row, since each bump costs every mounted screen a round trip.
Mirror changes from any `syncRoundTrip` are bumped inside `syncRoundTrip` itself (`changed > 0`), so callers bump only for their own reasons (a push, a user-requested refresh). A realtime unit bumps only when it **moved a row** (new, or a different `updated_at`; for a round
trip, `pushed > 0 || changed > 0`) or ran a fallback pull. The author of a write receives its own
echo (one event per bill/item/split row), and those rows are already mirrored by
`commitCloudFirstWrite`, so bumping on them refetched every mounted screen after the write's
primed reads were spent. The cursor still advances on every event.

**Echoes cost nothing since `072`.** Each event carries `row = {table, id, updated_at}`; an event
whose row Dexie already holds at exactly that version (and synced) is dropped before a batch
chooses between one reconcile and a round trip. `processBatch` first waits (bounded, never
throwing) for this device's in-flight cloud writes (`src/sync/in-flight-writes.ts`), because an
echo can beat its own write's response. Never skip on an id alone: a different version is someone
else's edit. Versions compare with `sameInstant` (microseconds), not `compareTimestamps` (ms).

### Cloud-First Mutations

The server is the writer of record. Dexie is a **mirror**, not the source of truth.

Every operation in `src/db/operations.ts` is split into a **builder** (pure — returns the
complete rows the mutation implies) and a **commit** through `commitCloudFirstWrite`
(`src/sync/cloud-write.ts`):

1. Build the rows in memory. Nothing touches Dexie yet.
2. **Online:** `submitCloudWrite` hands the rows to `kwenta_write` as `p_push` **directly**
   (`kwenta_sync` against a pre-066 server), confirms the server stored them and mirrors the
   server's returned rows into Dexie. A **refusal** (`classifyWriteFailure` in
   `src/sync/write-errors.ts`: `rejected`, or `inactive` for 076) throws and **Dexie is left
   untouched**.
3. **Offline, or a transport failure** (status 0, timeout — 20 s `AbortSignal.timeout` — 5xx,
   PostgREST's server-state codes PGRST000-003, an expired token; anything doubtful counts as
   transport): `enqueueWrite` stages the rows and
   the queue entry in ONE transaction and returns `'queued'` without throwing. The entry keeps the
   exact rows (`push`) and the SAME submission id, so a replay after a lost response returns the
   original outcome instead of a second bill. The app stays fully usable offline.
4. **Older pending entries first:** a save while `pending` entries exist drains them (bounded,
   10 s) before submitting, else queues behind them — edits to the same rows never reorder. A
   refused (`conflict`) entry never holds a new save back.

**The write queue** (`src/sync/write-queue.ts`, Dexie v15 `pending_mutations`). `drainWriteQueue`
is single-flight (`navigator.locks` across tabs), replays in `seq` order, one `kwenta_write` per
entry, never skipping past the earliest pending entry, and bumps `dataVersion` once per drain.
Transport failure → per-entry backoff that holds everything behind it (head-of-line), plus the
queue's own retry timer at the head's `next_attempt_at` (`cancelScheduledDrainRetry` on a wipe);
Refresh drains with `ignoreBackoff`. Rejection → the entry becomes `conflict` (a Settings "not
applied" row) and later entries sharing its `row_keys` become `blocked_by_earlier`; their queued
notifications are dropped. Only refused entries can be dismissed (`dismissQueuedWrite`, online, and
refused while a `pending` entry still shares their rows: never-synced rows it created are evicted,
edited rows restored from `kwenta_reconcile_user_event`) or retried (`retryQueuedWrite`, same
submission id). A network blip no longer marks anything "not applied". Legacy entries from v14
(`push = null`) keep the row-scan `fullSync` safety net.

**A wipe never silently drops unsent work.** Sign-out and Reset local data warn via
`hasUnsentWrites` (a queue entry in any status, or a row only a full sync sends) and their "sync
first" paths call `sendUnsentWritesBeforeWipe` (drain with `ignoreBackoff`, then `fullSync`), wiping
only when nothing is left unsent.

Why the submit path is separate from `syncRoundTrip`: that function builds its push payload by
*scanning Dexie for unsynced rows*, so a write had to be committed locally before it could be
sent. That is the structural reason the old design could not be cloud-first, and why reordering
calls would not have fixed it.

**Do not reintroduce write-then-sync.** The previous flow committed the Dexie transaction first
and called the cloud afterwards without rolling back, so a rejected write stayed on screen and
still moved balances. The user, looking at a filled form and an error toast, pressed Save again
— minting a *new* row id — and the next background sync pushed both. That is the duplicate-bill
bug; `tests/db/cloud-first-write.test.ts` pins it closed.

**Base versions (081).** A device no longer lets its clock decide a conflict. `commitCloudFirstWrite` attaches `_base_updated_at` (the mirror copy's `updated_at`) to each pushed row whose mirror copy is synced (before submit AND enqueue, so a queued replay is checked too; staged rows and new rows get none); the drain rebases a later queued edit of a row to the version the earlier entry's echo returned. `kwenta_write` locks the stored rows, refuses the WHOLE call when a base differs from the stored version (P0001 "This was changed on another device. Refresh and try again.", nothing stored, no marker), and otherwise stamps `updated_at = GREATEST(now(), stored + 1us)` itself; both client-only keys are stripped before the validators, and a replay skips the check. Rows without a base keep the client timestamp and 021b (older installs; 044 records why a blanket server stamp was reverted), and `kwenta_sync` is unchanged. Retry of a refused entry ("apply mine") sends `_overwrite: true` instead (server-stamped, no check). Edit forms load the bill fresh and `updateBill` bases the save on the version the form loaded. A contact link sends only the profile row and 045 rewrites splits, payers, payments and memberships in the same transaction (081 gives that rewrite the 048 stamp so future-dated rows do not discard it). Detail: migration `081`'s header.

**Atomicity.** One RPC is one Postgres transaction, so a mutation's rows land together. Cascades
and multi-leg writes use a `MutationRowCollector`: sub-operations contribute rows instead of
writing them, and the parent submits once. This covers bundled payments (one transfer split
across contexts), `deletePerson`, `deleteGroup`, and `linkProfileToRemote` (the link plus every
id rewrite it implies). Collecting rather than staging avoids compensating deletes — an undo
that itself fails would leave exactly the corruption it was meant to prevent.

**`activity_log` is exempt from the stored-confirmation check.** It is an audit trail, not
money; failing a bill because its log line could not be confirmed would turn a cosmetic gap
into a lost write.

**Submission ids** (migration `050`): every write carries one, so replaying the *same*
submission returns the original outcome instead of applying twice. This covers the case the
inversion cannot — the request lands, the row is stored, and the response is lost. The client
falls back to the two-argument RPC if `050` has not been applied. Since `078` `kwenta_write` is
all-or-nothing: one refused non-`activity_log` row rolls back the whole call, marker included,
so a corrected retry under the same id applies afresh.

**Session epoch** (`src/sync/session-epoch.ts`). `clearKwentaLocalData` bumps it before it deletes
anything; every Dexie write driven by a response captures it before the request and checks it
(`assertSessionEpoch`) before writing, so a response that lands after a sign-out or account switch
never writes the previous account's rows into the next one's mirror. Checked in `submitCloudWrite`,
the drain, `syncRoundTrip` (rows, push stamps, the refresh marker), realtime upserts and cursors,
`loadBillIntoMirror`, `fetchRemoteProfileIntoDexie` and the API cache (`writeCache` takes the
epoch its request started in).

**Guests** (unauthenticated): Dexie only, no sync.

### Pull Bundle Scope — Critical Privacy Boundary

`kwenta_build_pull_bundle` controls what each user receives on pull. Profiles are scoped:
```sql
WHERE p.id = uid
   OR (p.is_local IS TRUE AND p.owner_id = uid)
   OR (p.is_local IS TRUE AND p.linked_profile_id = uid AND p.is_deleted IS FALSE)
```
A user does **not** receive another user's local contacts merely because they share a group. The single exception (migration `049`) is a contact explicitly **linked to you** — a row that already asserts "this contact IS your account". Without it, `049`'s identity-routed settlements arrive referencing a profile id the receiving device can never resolve, so `expandProfileIdsForSplitMatching` cannot match them and the payment stays invisible on the device the widening exists to reach.

Consequence: `db.profiles.get(userId)` returns `undefined` for local contacts owned by someone else. **Always fall back to `group_members.display_name` when resolving names in a group context:**
```typescript
const profile = await db.profiles.get(userId)
let name = profile?.display_name
if (!name && groupId) {
  const member = await db.group_members
    .where('[group_id+user_id]').equals([groupId, userId]).first()
  name = member?.display_name
}
```
This pattern is applied in `getBillWithDetails` (`src/db/operations.ts`) and the bills query in `GroupDetailPage.tsx`.

### Soft Deletes and Pull Filter Gaps

All entities use `is_deleted: true` for soft deletes. **A critical constraint:** pull filters must include rows for groups the user was *ever* a member of, not just currently active ones. If a filter requires `gm.is_deleted IS FALSE`, deletion events will never reach former members — their membership row is also soft-deleted simultaneously. The groups and settlements pull in `kwenta_build_pull_bundle` intentionally use all membership rows (any `is_deleted` state) to allow `is_deleted = TRUE` records to propagate to all former members.

### Profile Types

Three profile flavors in Dexie (`src/types/index.ts`):
- **Own profile** — `is_local: false, owner_id: null` — the signed-in user
- **Local contact** — `is_local: true, owner_id: creatorId` — phonebook entry, only visible to its creator
- **Linked contact** — local contact with `linked_profile_id` set to a remote Supabase profile UUID

`membershipUserIdForProfile(p)` (`src/db/operations.ts:44`) returns `p.linked_profile_id ?? p.id` — rewrites `group_members.user_id` to the remote UUID when a contact is linked, so Postgres RLS and sync match `auth.uid()`. Split rows may reference either the local id or the remote id; `expandProfileIdsForSplitMatching` (`src/lib/people.ts`) builds the full set for balance queries (account link + optional `viewerUserId`-scoped `profile_peer_links` cluster).

### Realtime Subscriptions

**`kwenta_notifications`** — `NotificationsBell.tsx` subscribes via `postgres_changes`.
- Subscription deps must be `[userId, isOnline]` only — never include `loadList` or other callbacks, as this tears down and recreates the channel on every reference change, causing missed INSERT events
- Use a `loadListRef` ref to call the latest `loadList` in error-recovery paths
- Fresh unread count is loaded via a dedicated `useEffect([isOnline, userId])` on mount, not from the SUBSCRIBED callback

**`kwenta_user_events`** — `realtime-events.ts` subscribes for entity change events.
- INSERT only, and a payload without a string `id`/`created_at` is dropped: the 073 prune job hard-deletes rows, and Supabase sends DELETE changes to every subscriber unfiltered with `new = {}` — queued, that wrote an `undefined` cursor (pinned in `realtime-echo.test.ts`)
- A burst is debounced (150 ms trailing, 1 s cap), deduped, echo-skipped (072), then grouped by
  entity with the pure `groupByEntity` (`src/sync/realtime-batch.ts`): a bill with its items and
  splits, a group with its members, a settlement, a profile, a peer link. Each entity costs ONE
  `kwenta_reconcile_user_event` (at most 3 concurrent); more than 10 entities, a `linked_profile_id`
  (034) payload, a DELETE or an unknown table → one `fullSync` instead. Exactly one
  `bumpDataVersion` per batch (`syncRoundTrip` takes `{ invalidate: false }` there). A reconcile
  applies `shouldApplyPulledRow`: a staged (unsynced) local row is overwritten — and marked synced —
  only when the server copy is strictly newer; Dismiss's restore is the one forced write.
- Catch-up (reconnect, SUBSCRIBED, or a newer event seen by the startup/focus probe via
  `requestRealtimeCatchUp`) reads at most 51 missed events: up to 50 go through the batch path;
  more → one `fullSync`, then the cursor moves to the newest server `created_at` read BEFORE it.
- With no events at all for the user, the cursor initialises to `PULL_SINCE_EPOCH` (a server-safe
  floor), so "no cursor" never recurs.
- The cursor always advances to the max **server-supplied** `created_at` drained. Never stamp it
  from the device clock: a fast clock writes a cursor into the future and `.gt('created_at',
  cursor)` then filters out every event the server creates until real time catches up, permanently.
- Since `077`, contact/account renames and deletes (`profiles`) and merges (`profile_peer_links`)
  emit events too, so they no longer wait for a periodic full refresh.

---

## Dexie Schema (`src/db/db.ts`)

Current version: **16** (v16 added the foreign-currency fields, null-backfilled: `bills.original_currency/exchange_rate/rate_source/original_total`, `bill_items.original_amount`, `item_splits.original_amount`. v15 turned `pending_mutations` into the ordered write queue: `seq`, `submission_id`, the exact `push` rows, multi-entry `row_keys`, `next_attempt_at`, `last_error_kind`, index `[actor_user_id+status+seq]`; the upgrade backfills legacy entries with `push = null`, `seq` by `created_at`. A rolled-back v14 build cannot open a v15 database. v14 added optional `settlements.method`). All tables extend sync fields: `id` (UUID PK), `created_at`, `updated_at`, `synced_at` (null = unsynced), `is_deleted`, `device_id`. Versions 9+ added compound indexes (e.g. `[group_id+is_deleted]`) for query performance.

| Table | Key Indexes | Purpose |
|-------|---------|---------|
| `profiles` | `id, email, owner_id, linked_profile_id, synced_at, is_deleted, [owner_id+is_deleted]` | User accounts + local contacts |
| `groups` | `id, created_by, invite_code, synced_at, is_deleted, [created_by+is_deleted]` | Expense groups |
| `group_members` | `id, group_id, user_id, [group_id+user_id], synced_at, is_deleted, [group_id+is_deleted], [user_id+is_deleted]` | Memberships; composite index prevents duplicates; stores `display_name` |
| `bills` | `id, group_id, created_by, paid_by, created_at, synced_at, is_deleted, [created_by+group_id], [group_id+is_deleted]` | Expense records; `paid_by` tracks the actual payer (may differ from `created_by` in groups); `category` optional enum |
| `bill_items` | `id, bill_id, synced_at, is_deleted, [bill_id+is_deleted]` | Line items within a bill |
| `item_splits` | `id, item_id, user_id, synced_at, is_deleted, [item_id+is_deleted], [user_id+is_deleted]` | Per-person allocations; `split_type`, `split_value`, `computed_amount` |
| `settlements` | `id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted, [group_id+is_deleted], [bill_id+is_deleted], [from_user_id+to_user_id]` | Payments; `bundle_id` groups multiple recipients into one logical payment |
| `activity_log` | `id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted, [user_id+created_at]` | Audit trail |
| `profile_peer_links` | `id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id], [owner_user_id+is_deleted]` | Manual “same person” edges (local anchor → peer); server-backed sync |
| `pending_mutations` | `id, actor_user_id, status, entity_type, entity_id, created_at, updated_at, seq, submission_id, *row_keys, [actor_user_id+status+seq]` | The ordered write queue (v15); applied entries are deleted |
| `not_applied_changes` | `id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id` | Failed mutations surfaced to user |

**Split types:** `'equal' | 'percentage' | 'custom'`
**Mutation statuses:** `'pending' | 'applied' | 'conflict' | 'dismissed'`
**Change resolutions:** `'pending' | 'dismissed' | 'reapplied' | 'auto_resolved'`

---

## Sync System

### Key Files
- `src/sync/sync-service.ts` — `syncRoundTrip`, `fullSync`, push/pull logic
- `src/sync/sync-manager.ts` — orchestration, debounce, backoff, backup timer
- `src/sync/cloud-write.ts` — `commitCloudFirstWrite` / `submitCloudWrite`
- `src/sync/write-queue.ts` — the ordered write queue (enqueue, drain, dismiss, retry)
- `src/sync/write-errors.ts` — `classifyWriteFailure` (`transport | rejected | inactive`)
- `src/sync/cloud-first-mutations.ts` — queue-entry and "not applied" record helpers
- `src/sync/session-epoch.ts` — the guard against responses landing after a wipe
- `src/sync/group-mirror.ts` — loads a group and its whole roster into the mirror on a miss (`kwenta_fetch_group_bundle`)
- `src/sync/settlement-mirror.ts` — `applySettlementBundle` (shared with realtime) and `loadSettlementIntoMirror`: one `kwenta_fetch_settlement` for a payment the device lacks
- `src/sync/realtime-events.ts` — Supabase Realtime subscription + per-entity reconcile

### syncRoundTrip vs fullSync

- **`syncRoundTrip(userId)`** — atomic: single `kwenta_sync` RPC call, applies push payload server-side, returns pull bundle; updates `synced_at` on both sides. Its push EXCLUDES rows owned by any queue entry (pending, conflict or blocked) — only legacy/untracked unsynced rows ride `kwenta_sync`; the queue sends the rest
- **`fullSync(userId)`** — dedup wrapper around `syncRoundTrip`; if `dedupeSyncEnabled` flag is on, concurrent calls share one in-flight Promise

### Reads: a server-sourced mirror, computed locally

**Every displayed money number comes from a SQL endpoint** (migrations 052-064), fetched via
`src/api/balances.ts` and `useServerData`. No balance is computed from Dexie any more. The local
mirror still backs the offline cache and the descriptive rows an export needs, and it is what
contact discovery reads — but it is never asked what something is worth.

The accepted trade-off is stated in rule 8: **balances do not move offline.** A queued write shows
an explicit "unsent changes" state rather than a silently stale number.

**A row this device has not pushed is still shown.** `src/lib/staged-rows.ts` surfaces unsent
personal bills (Bills list + Bill detail) and unsent local contacts (People). That is not a
violation of rule 7: `synced_at === null` is a fact about THIS device, not an inference about what
the server holds, and nothing there decides a server row is absent. It exists because the read
migration made an offline save invisible, which users read as "it failed" — and re-entering the
bill is exactly the duplicate path cloud-first writes were built to close. Staged rows carry no
money: `settled` is false and pairwise nets are empty, because the server has never seen the row.

**A cached answer must look different from a fresh one.** `fetchEndpoint` returns
`fromCache`/`fetchedAt`; every screen that renders server money shows `SavedCopyNotice`
(`src/components/common/SavedCopyNotice.tsx`) when it is serving one. An authorization failure is
NOT served from cache at all — losing access must not read as staleness.

**Screens paint their saved copy first (stale-while-revalidate).** `useServerData` seeds its first
render — and every subject change — from `readCache(endpointKey, currentUserId)` and fetches
behind it; `revalidating` is true meanwhile. The revalidation is marked in the header, not on the
page: every online `useServerData` fetch holds one pair on the store's `screenLoadCount`, and
`useScreenLoading` (true after 200 ms of continuous load, false the moment it ends) drives both
`TopLoadingBar` and the Refresh button's "Updating…" — a per-page chip pushed each list down on
every revisit. `SavedCopyNotice` stays reserved for `fromCache && !revalidating` (the FINAL answer
was the saved copy).
An access-lost `ApiError` or `ServerDeclinedError` clears the seeded copy. The seed is chosen
during render, so a subject change never paints the previous subject for a frame.

**Payloads are kept small (083, 085, 086, 087).** Six rules, detail in migrations `083`'s, `085`'s, `086`'s and `087`'s headers:
- `kwenta_group_detail.rawDebts` is already **netted**: one `{from, to, amount}` per unordered pair of literal ids, in integer cents, zero nets dropped, ordered by from, to — never one edge per split. `buildDebtGraph` over it is a no-op (same pair nets); the order is what keeps the greedy `buildSuggestedPayers` stable across loads. Do not add a per-split list back.
- The **Bills page pages on the server**: `kwenta_personal_bills_page` (shares `kwenta_personal_bills()`'s one row builder, `kwenta_personal_bill_rows`, which 084 runs only for the returned page's bills) returns 20 rows per tab with server-side filter, category, sort and counts (`{rows, matching, mine, shared, categories}`); Paging is keyset: `p_after` = the last loaded row's `{id, createdAt, title}` returns the next 20 after that position (compared on key values, so a deleted cursor row still works), with no 500-row ceiling on the walk. Export fetches the full list (`fetchPersonalBills`) on tap. The page endpoint is never primed by a write: `kwenta_read` dispatches only `fn`/`id`/`limit`, so the page refetches the pages it holds after a write. The full endpoint stays for Export and installed older builds.
- The **group bill list pages on the server** (085): the group screen reads `kwenta_group_detail_paged(p_group_id, p_limit)` (key `group:<id>`, 20 newest bills plus `billCount` and `billPayers` over every live bill, primed by writes because `kwenta_read` dispatches it with the spec's limit) and walks the rest, or one payer's bills, through `kwenta_group_bills_page(p_group_id, p_limit, p_payer, p_after)` (`{rows, matching}`, keyset on `{id, createdAt}`, never primed). Both share one bill-row builder and one membership gate with `kwenta_group_detail(uuid)`, which stays untouched, with no new key, for installed builds and for any `kwenta_read` spec without a `limit`. CSV/PDF export and the member share card fetch the full list on tap under their own key `group-full:<id>`, so a full fetch never replaces the page's mounted read spec.
- The **Person statement pages on the server** (086): the screen reads `kwenta_person_statement_page(p_person_id, p_limit, p_kind, p_before)` (key `statement-page:<id>`, 20 newest events as `{events, matching, latestPersonalCurrency}`, primed by writes because `kwenta_read` dispatches it with the spec's limit and kind `all`) and walks older events, or the Payments filter, with a `{createdAt, id}` keyset cursor (never primed, never cached past the first page). Each event carries `runningNet` and `prevRunning`, the per-currency cumulative sum over ALL the pair's events in (created_at, id) order, computed BEFORE the kind filter and the cursor, so a row deep in history or under Payments shows the number the full history implies. A page whose oldest row is a payment leg extends down to its bundle's oldest leg (taking every event of the kind in between), because `collapsePaymentLegs` merges only adjacent legs. `latestPersonalCurrency` (newest live personal bill, whole history) is what the payment dialog defaults to. `kwenta_person_statement(uuid)` stays byte-identical for installed builds; PDF/CSV, the export's personal-bill list and card fetch it whole on tap under `statement-full:<id>`, so a full fetch never replaces the page's mounted read spec.
- **Payment history pages on the server** (087): the group screen reads `kwenta_group_settlement_history_page(p_group_id, p_limit, p_before)` (key `group-payments-page:<id>`, `{items, matching, totals}`, 20 newest items, primed by writes because `kwenta_read` dispatches it with the spec's limit and no cursor) and walks older items with a `{createdAt, id}` keyset cursor where `id` is the item's primary leg `settlementIds[0]` (compared as timestamptz and uuid, never primed). The page is cut from `kwenta_group_settlement_history`'s items, so there is one item shape and one membership gate. **`totals` (per payer + currency, over the WHOLE history) is the only source of "Total paid"**: a sum over the loaded page would be wrong money. The Person page no longer downloads its payment history on mount: the statement's payment rows read edit target, method and note from `kwenta_person_payment_items(p_person_id, p_settlement_ids)` (items of `kwenta_person_settlement_history` whose legs intersect the ids, at most 500 per call, never primed, one lookup over the loaded leg ids that the client chunks). The client saves each answer per person under `person-payment-items:<personId>` (merged, de-duplicated by item id, newest 500) and serves it flagged as a saved copy offline or on a transport failure so statement payment rows keep their edit/note/method; a NULL or permission answer empties it and it is never served. Group and person exports and cards fetch the full histories on tap (`group-payments-full:<id>`, `person-payments-full:<id>`), so a full fetch never replaces a mounted page spec; the old history endpoints stay untouched for installed builds.
- **Scoped refresh.** A write skips refreshing screens it provably cannot change: a new bill skips the payment-history families (`group-payments`, `group-payments-page`, `bill-payments`, `person-payments`, `person-payment-items`), a payment-only write skips `group-spending`; `updateBill`/`deleteBill` and every mixed payload skip nothing. `readsUnaffectedBy` (`src/api/read-scope.ts`) decides; `commitCloudFirstWrite` drops those families from `p_reads` and the store records per-family skipped-bump counts, which `useServerData` subtracts (`relevantDataVersion`) so coalesced bumps never lose a real invalidation. Queued/offline writes and every non-write bump (realtime, sync, Refresh) invalidate everything.

What is left in TypeScript is pure transforms of bounded input, each with its Vitest coverage:
`computeSplits`, `buildSuggestedPayers` (`settlement-suggestions.ts`), `buildMovementChains`
(`settlement.ts`), `collapsePaymentLegs` + the `buildMoneyFlowRows` mapper (`money-flow.ts`),
`allocatePersonPayment` (`payment-allocation.ts`), `roundMoney`/`isEffectivelyZero`.

### Reads are always fresh (no pull cursor)

**Every pull requests the COMPLETE bundle** — `p_since` is always `PULL_SINCE_EPOCH` (`sync-service.ts`), never a stored timestamp. The cloud is the truth and Dexie is a mirror of it; a complete bundle is a true snapshot because nothing is ever hard-deleted (soft-deleted rows are still sent), so absence from the bundle means nothing and no local pruning exists.

The old incremental cursor (`kwenta_last_pull`) was stamped from the **device clock** after the query ran, so clock skew or a row written mid-round-trip was skipped permanently, and any server-side change that did not bump the client-written `updated_at` could never reach a device — the only cure was wiping local data. Do not reintroduce it (guarded by a test on `PULL_SINCE_EPOCH`).

`kwenta_last_refresh` in `localStorage` records the last successful refresh. It is **display/scheduling only** (staleness chip, backup-timer skip, initial-hydration gate) and never filters a query; `readLastRefreshAt()` migrates the legacy `kwenta_last_pull` key once. Mirror-refresh triggers: app start, tab activation (one handler for `focus` + `visibilitychange`, rate-limited to 5s) and the 5-minute backup tick — all three through ONE gated `refreshIfNeeded` (below) — plus realtime events and the Refresh button, which awaits a queue drain (`ignoreBackoff`) and then always runs a full sync.

**Startup, tab activation and the backup tick share one gate** *(2026-09-25; time away stopped
forcing the bundle 2026-10-15)*. `refreshIfNeeded` (`sync-manager.ts`) starts a write-queue drain in
the BACKGROUND alongside the gate (a full sync never pushes queue-owned rows, so the two cannot
reorder a write); held notifications are flushed only after a drain that applied something.
`decideRefresh` runs a full sync only when: there is no refresh marker (first sign-in — the
hydration splash stays); the server last vouched for this copy **25 days** ago or more
(`EVENT_LOG_TRUST_MS`: 073 prunes events at 30 days, so past this the log may have holes — pinned
against 073 by `tests/build/event-log-retention.test.ts`; that sync reads the newest event first and
moves the realtime cursor to it, so the catch-up does not replay the backlog as a second bundle);
the BACKUP tick finds the last full refresh **24 h** old (`MIRROR_SAFETY_REFRESH_MS`, the bound on
anything that emits no event; also run once a minute after a start that finds it that old); a
realtime apply failed; there is no realtime cursor; legacy unsynced rows exist (`mayHaveStagedRows`
— index counts, queue-owned rows excluded); or an unconfirmed notification is queued. Otherwise ONE
probe, however long the device was away: `newestUserEventSince` (an indexed `LIMIT 1`, failing
open); a newer event goes to the realtime catch-up (per entity, or one full sync past 50 events),
none stamps `kwenta_last_checked`. **The backup tick's sync is quiet**: no loading bar, and a failure
sets no error and no retry (the next tick is the retry); Refresh pressed during it shows
"Refreshing…" at once and re-runs as the user's sync. An activation while a sync is in flight does
not queue a second one. A failure is cleared only by a sync that started after it
(`realtimeHealthToken`), a marker dated in the future reads as stale, and the realtime cursor is
only ever a SERVER timestamp.

**`kwenta_last_checked`** records when the server last confirmed this copy current WITHOUT a full
refresh (a probe that found nothing newer, a catch-up that drained cleanly). Like
`kwenta_last_refresh` it is display/scheduling only; the header's staleness and "Updated X ago" read
the newer of the two (`readLastUpToDateAt`), and a wipe removes both.

**Route changes do NOT sync** *(removed 2026-08-04)*. Opening a screen fetches that screen's own scoped endpoint, which IS server truth (rule 7), so pulling the whole bundle per route change bought nothing and cost 213 kB a tap. A write no longer refreshes the mirror either: `kwenta_write` (066) returns only its own rows and deliberately does not stamp `kwenta_last_refresh`.

**`dataVersion` is bumped only when a sync actually moved something** — `pushed > 0 || changed > 0`, where `changed` counts rows written to Dexie. Bumping unconditionally made every mounted screen fetch on mount and then again when the concurrent sync resolved: the duplicated request pairs. `pulled` cannot gate it, because every bundle is complete and so is large on a round trip that changed nothing.

Pushed rows are stamped `synced_at` only for ids the server reports in `applied` (migration 044). Two guards protect an offline write from the full bundle: `shouldApplyPulledRow` (never clobber a newer unsynced local row) and a refusal to apply any echo of a row **older than what this round trip pushed** (a silently dropped push must not be overwritten by the server's stale copy).

### Sync Manager Lifecycle

- `startSyncManager()` initializes on `useSync` hook mount; `useSync` restarts it on reconnect
  (there is no separate `online` handler)
- **Online state** (`src/lib/online-status.ts`): the store's `isOnline` (banner, sync manager, realtime,
  Refresh, outbox) mirrors `navigator.onLine`, re-read at the app root on mount, `online`/`offline`,
  `visibilitychange`, `pageshow`, `focus` and after any server answer. Listening to events alone left
  it stuck "offline" (sync and realtime off) after a transition on /login or a resume with no event.
  Offline-session recovery follows the flag's false→true transition, not the raw event.
- Startup, activation and the 5-minute backup tick go through `refreshIfNeeded` (above)
- `triggerSync` (400 ms debounce, drains in the background, then a full sync) is called only by
  `ensureProfile` for a new-account stub; operations no longer trigger a sync — a write is
  `commitCloudFirstWrite` plus the queue
- On error: exponential backoff (30s → 5 min); the retry drains the queue (keeping its backoff)
  along with its sync

### Push Payload RLS Filtering

Before pushing, `buildPushFilterContext` determines what the user is allowed to push. Per-table rules mirror Supabase RLS:
- **profiles**: own profile OR owned local contacts
- **profile_peer_links**: `owner_user_id` is current user (anchor must be an owned local contact)
- **groups**: created by user
- **group_members**: creator of group OR the member row belongs to user
- **bills**: created by user OR member of the bill's group
- **item_splits**: `user_id` is rewritten to `linked_profile_id` immediately in Dexie during `linkProfileToRemote`; `resolveSplitUserIdForPush` provides a server-side safety net for any remaining stale rows
- **settlements**: `from/to_user_id` may be rewritten to linked account ids

### Pending Mutations (the write queue)

`pending_mutations` IS the write queue (see Cloud-First Mutations). Statuses: `pending` (unsent —
the header reads "Waiting to sync"), `conflict` (the server refused it — a `NotAppliedChange` row
in Settings, the header reads "Changes not applied"), `blocked_by_earlier` (shares rows with a
refused entry). Only real server refusals become `conflict`; a transport failure only backs off.
Settings offers **Dismiss** (online, refused entries only: discards the local change) and
**Retry** (same submission id). Applied entries are deleted. The header counts these from the
`[actor_user_id+status+seq]` index — never a table scan (`RefreshButton`).

Known gap (021b, legacy rows only): since 081 a queued edit of a synced row carries its base
version and is refused ("not applied") when another device saved first. Rows sent WITHOUT a base
still fall to 021b: `kwenta_sync`'s replay of unsynced rows no queue entry owns (pre-v15 leftovers,
legacy `push = null` entries) and older installs that send no bases. Such an older change is
dropped without an error and the next pull replaces the local copy with the newer server row.

---

## Notification System (`src/lib/kwenta-notifications.ts`)

### Kinds
- `'profile_linked'` — local contact linked to their account
- `'bill_participant'` — added to a bill
- `'payment_recorded'` — payment recorded against them
- `'added_to_group'` — added to a group

### Outbox Pattern
Notifications are queued in `localStorage` (`kwenta_notification_outbox_v1`) and flushed after the mutation syncs, not during. This ensures notifications only go out after cloud data is confirmed. `flushQueuedKwentaNotifications` runs a `syncRoundTrip` first (unless `assumeCloudAck`), then inserts rows into `kwenta_notifications`. Each outbox entry records `confirmed` — whether the write it describes was accepted by the server (`commitCloudFirstWrite` mode `'cloud'`, passed as `cloudConfirmed`). When every entry for the actor is confirmed the flush skips that `syncRoundTrip`; a staged (offline) entry, or a legacy entry without the field, keeps the sync gate. Before this every bill/payment/member write triggered a full-bundle sync just to send its notification. An entry for a QUEUED write carries its `submissionId`: it is held while that queue entry is still in `pending_mutations` and dropped (`dropQueuedKwentaNotifications`) if the entry is refused or blocked — it describes a write that did not happen.

### Recipient Resolution
`resolveRecipientProfileIdForNotify(splitUserId)` — returns the Kwenta account id to notify:
- If linked: return `linked_profile_id`
- If not local and has email: return own id
- Else: `null` (local-only contact, can't notify)

---

## People / Profile Resolution (`src/lib/people.ts`)

### Key Functions

**`resolveProfileDisplay(profileId, viewerUserId?)`** — display name + subtitle for UI. READ-ONLY: it runs inside `useLiveQuery`, where a Dexie write throws and blanks the screen. `getBillWithDetails` is read-only for the same reason. A caller outside a live query loads what it needs first with `loadProfilesIntoMirror(ids)`
- Follows `linked_profile_id` chain
- Falls back to `resolveSharedGroupMemberFallbackIdentity` if profile is missing/deleted
- Returns `{ displayName: 'Unknown' }` as last resort

**`resolveSharedGroupMemberFallbackIdentity(viewerUserId, profileId)`** — finds a shared group to get the display_name from group_members when the profile itself isn't accessible

**`expandProfileIdsForSplitMatching(profileId, viewerUserId?)`** — returns `Set<string>`: the connected component of `profileId` over `linked_profile_id` edges (both directions) plus, when `viewerUserId` is set, that owner's `profile_peer_links` merges. Split rows may use either the local or linked id. **Both edge kinds are closed over together** — following one from the anchor only made the answer depend on the starting id, which is the duplicate-People bug (migration `067`). The invariant: `y ∈ expand(x)` implies `expand(y) = expand(x)`, which is what keying a person by `MIN(cluster)` assumes. The SQL twin is `kwenta_expand_identity` (052, closed in `067`); the two must agree.

**`findRemoteProfileIdForLinking(input)`** — accepts UUID or email; looks up locally, then calls `kwenta_lookup_profile_id_by_email` RPC if needed

**`fetchRemoteProfileIntoDexie(profileId)`** — returns `'present' | 'not_found' | 'unreachable'` (offline, a failed request or a wipe mid-fetch is `unreachable`, never "gone"); fetches via `kwenta_fetch_profile_for_linking` RPC and upserts into Dexie (RPC allows co-members’ rows, including `is_local`, when you share a group — see migration `029`)

**`listCanonicalRelatedProfileIds(meId)`** — the contact picker's phonebook: one row per real
person, deduped across local contact, linked account and manual merges. Deliberately still LOCAL
— a local contact exists only on the device that created it, and picking who to split with has to
work offline because creating a bill does. Its SQL twin is `kwenta_canonical_peer_ids` (054/055);
the two must agree, and `tests/lib/people.test.ts` plus `055`'s suite keep them honest.

**`personalPickerIdFor(meId, profileId)`** — the picker id a STORED personal-bill id hydrates to.
`item_splits.user_id`/`bills.paid_by` hold the canonical ACCOUNT id, while the picker lists that
same person under the owned LOCAL contact id, so an edit form must translate before it can select
anything. Group bills translate the same way through `resolveGroupMemberUserId` (roster id)
instead. Either translation can still miss — a contact deleted from the phonebook, a member
removed from the group — and that id is surfaced rather than dropped: `mergeUnlistedParticipants`
(`src/lib/bill-split-form.ts`) appends it as an `unlisted` option so the edit form still shows and
can remove it, instead of silently keeping (and re-saving) a selection nothing renders.

### Balance Computation

Balance between two people is a **plain signed sum**, per currency: (Σ pairwise bill shares,
personal + each group) − (Σ payments). `+` = they owe me. Overpayment flips the sign — there is
**no "general credit"** concept (removed 2026-07-11).

**This arithmetic lives in SQL only** — see `docs/migrations.md`. The client fetches numbers; it
does not derive them.

**Exports are handed the screen's payload, never a recomputation.** `exportBillsToCSV`,
`exportGroupToCSV`, `exportPersonToCSV`, `generateBillsPDF`, `generateGroupPDF`,
`generateBillDetailPDF` and `generatePersonPDF` all take the server data the page already holds.
An export that recomputed its own money could disagree with the screen it was exported from —
and did, once reads became server-side. Descriptive rows (item names, per-member share matrices)
still come from the local mirror: those are records, not derived money.

**Statement:** the Person page timeline is server events (`062`, paged by `086`) with the running balance computed in SQL: `runningNet` and `prevRunning` per event, a per-currency window sum over the pair's whole history. The client holds one page, so it cannot walk the list; `buildMoneyFlowRows` (`src/lib/money-flow.ts`) is a mapper over those numbers (`balanceDelta` = `runningNet - prevRunning`, the note). The newest event's running number must equal the hero — pinned in SQL (`086`'s suite, with the walk's rules), not TS.

**Payments:** `recordPersonPayment` (`operations.ts`) writes one atomic payment; multi-context allocations share a `bundle_id` (partition the total, never duplicate). "Settle up" = a `RecordPaymentDialog` prefilled to the full balance. The Person page statement (server running numbers via `buildMoneyFlowRows` + `collapsePaymentLegs` + `PersonStatement.tsx`) is the running-balance timeline (the standalone `/ledger` route is retired).

**Splitting one payment across contexts** (`RecordPaymentDialog`, three modes over
`allocatePersonPayment`): the **typed amount is authoritative** in every mode — the boxes never
redefine it. `Auto` clears each context in turn, `%` and `Custom` are hand-driven, and the excess
of an overpayment lands on the FIRST context and flips it. Bucket order is Personal, then groups by
name: `sequential` makes the order decide where money lands and `kwenta_pairwise_breakdown` (053)
returns groups with no `ORDER BY`, so an unsorted list is not reproducible between two loads.

**Data repair:** decided **on the server** by `kwenta_repair_settlements(p_dry_run)` (migration `048`) — orphans, exact duplicates, and party-id canonicalization, self-scoped by `auth.uid()` over the **identity set** (account + contacts linked to it, so the scope matches what `049` delivers). Classification lives in one place, `kwenta_repair_settlement_plan`, so the dry run and the apply cannot disagree. `src/lib/kwenta-data-repair.ts` (`previewSettlementRepair` / `repairSettlementsViaServer`, surfaced in Settings via `RepairDataPanel` as check → apply) only calls the RPC and mirrors the result back via `fullSync`; it holds **no** delete authority, and it throws when the mirror fails rather than reporting a repair that never reached this device. `maybeAutoRepairData` runs it **once per session after a successful sync** (wired in `sync-manager.ts`; fire-and-forget, never throws, deduped by a module-scoped guard that `clearKwentaLocalData` releases on sign-out). The earlier client-side plan/apply judged existence from a cache that is incomplete by design and deleted real payments — see the "Deletion is server-authoritative" note under Supabase Migrations.

Two ordering rules the SQL depends on: orphan detection resolves each party through `kwenta_settlement_party_id` **before** asking whether a live profile exists (judging the literal id soft-deletes payments filed under a contact deleted from the phonebook after being linked), and every UPDATE stamps `GREATEST(now(), updated_at + 1us)` rather than a bare `now()` (the `021b` server-wins trigger returns OLD on a client clock ahead of the server, which silently voided the repair while the counts still reported success).

---

## Settlement Logic

Group balances are SQL (`kwenta_group_pairwise` 053, `kwenta_group_detail` 061). The settle-up
decomposition stays in TypeScript — `buildSuggestedPayers` (`src/lib/settlement-suggestions.ts`)
over the directed debt graph 061 returns — because it is a pure transform of bounded input, and
porting it would create a second greedy algorithm that could disagree by a transfer.

`src/lib/settlement.ts` is now view-model types plus **`buildMovementChains`**, which turns one
payment's bookkeeping legs into readable paths ("You → Cha → Yumi").

**`bundle_id`** — several settlement rows (different recipients) share one `bundle_id` and render
as ONE payment. `recipients` collapses those rows by recipient; `legs` keeps one entry per stored
row. The two differ exactly when money moved through an intermediary, which is what
`buildMovementChains` consumes — never collapse them together.

**`method`** (how the money moved) is free text with preset chips, not an enum — see
`src/lib/payment-method.ts` for the one normalizer and `PaymentMethodField` for the one control,
shared by the record and edit dialogs. Blank, whitespace and null all mean "not recorded" and
collapse to `null`, so `method IS NULL` is a reliable test and no empty tag ever renders. Every
leg of a bundle carries the SAME method; the server picks one by the first-non-blank rule `label`
already uses (`069`).

On the Person statement a group payment renders a `Users` pill; personal rows carry **no** context
line at all, so group provenance stands out by contrast. The pill is gated on `groupId !== null`,
never on the context label reading `"Personal"` — a group with that name would otherwise disguise
itself. A payment row also shows its **note and method**, which a `062` statement event does not
carry: both are read from the `SettlementHistoryItem` the leg belongs to, via the
`paymentsByLegId` map the page already builds for editability. Since 087 that map is built from
`kwenta_person_payment_items` for the legs on the loaded statement pages, not from the pair's whole
history, so a leg with no item (the statement and the history scope a group payment differently)
shows no note, method or Edit, as before.

---

## Bill Split Logic (`src/lib/splits.ts`)

Split types computed at write time and stored as `computed_amount`:
- **`equal`**: floor division with remainder to first split
- **`percentage`**: `amount × (splitValue / 100)`, rounded to 2 decimal places
- **`custom`**: explicit amounts; remainder distributed evenly to unassigned rows

### Foreign-currency bills (079)

A bill can be typed in another currency ("Paid in" on both bill forms) and is converted at save with
a rate that is then **locked**. **Invariant: every money column (`total_amount`, `bill_items.amount`,
`item_splits.computed_amount`) stays in the BALANCE currency (`bills.currency`: the chosen one, or
the group's), so no SQL money function changes; the `original_*` columns are a record of what was
typed, never an input to a balance.** A bill is converted only when `isConvertedBill`
(`src/lib/currency-conversion.ts`) says so (the bill has `original_currency` AND every live item has
`original_amount`); anything else hydrates as plain, so a re-save can never convert twice. The rate
prefill comes from `fetchExchangeRate` (open.er-api.com, cached 12 h, never throws, never on the
save path); "Refresh rate" re-asks past the cache (`force`), and only a field still showing the previous
live rate follows the answer; editing keeps the saved rate and offers today's as "Use this". Editing a group bill keeps
the bill's own stored currency as target. Detail: migration `079`'s header.

---

## Operations Layer (`src/db/operations.ts`)

All operations: build the rows (activity_log line included) in memory → ONE `commitCloudFirstWrite` → queue notifications in the outbox. IDs and timestamps are generated locally. Offline staging is generic (`enqueueWrite`), not per operation.

Key operations:
- `createBill / updateBill / deleteBill` — `createBill` accepts `paidBy` (defaults to `createdBy`); `updateBill` accepts `paidBy` patch
- `createGroup / addGroupMember / removeGroupMember / deleteGroup`
- `createSettlement / recordSettlement` (supports bundled multi-recipient)
- `linkProfileToRemote(localProfileId, remoteProfileId, actorUserId)` — sets `linked_profile_id`; rewrites `group_members.user_id`, `item_splits.user_id`, `bills.paid_by`, and `settlements.from/to_user_id` from local contact id to remote profile id; notifies remote user
- `getBillWithDetails(billId)` — returns bill + items + splits with resolved display names; uses `group_members.display_name` fallback for local contacts
- `renameSelf(userId, name)` — the account's own profile row plus its live roster rows, one cloud-first write (it replaced AuthProvider's write-then-sync `updateDisplayName`)

**Group writes judge membership and existence from a mirror that may lag.** `createBill` checks its people against the Dexie roster and, only on a miss, refreshes the roster once (`refreshGroupIntoMirror`, `src/sync/group-mirror.ts`; unreachable → submit and let the server decide, still missing after a successful refresh → the non-member error). `updateGroup`, `removeGroupMember` and `addExistingGroupMembers` load the group first (`ensureGroupInMirror`) and throw rather than return silently; a cascade (`collect`) never fetches. `deleteGroup` is the server's: online it calls `kwenta_delete_group(p_group_id)` (082), which soft-deletes the group, every membership, every bill with its items and splits (leftovers under already-deleted bills too) and every payment in one transaction and returns the touched rows to mirror, so it needs no mirror copy of the group and cannot miss a bill this device never held; offline it refuses (a server cascade cannot be queued). `deletePerson` runs a `fullSync` first for the same reason (its cascade is still built client-side). Migration `080` makes `kwenta_write` refuse a group bill that ADDS someone with no membership row in that group (people a bill already named are not re-judged).

**No operation returns silently on a device miss: it loads what it lacks or throws a message that says which.** A group (`addGroupMember`, `createBundledGroupSettlement`, `recordDecomposedSettlement`: `ensureGroupInMirror`, and a held group's roster refreshes only when a payment's party is not on it), a payment (`updateSettlement`: one `kwenta_fetch_settlement` through `settlement-mirror.ts`; a NULL answer is "couldn't load", never "gone", because 013 misses payments filed under a linked contact) and picked people (`buildExistingMemberRows` fetches the profiles the device lacks first; unreachable → a connection message, gone → a count; nothing is sent) are loaded; `updateBundledPaymentDetails`, `removeProfilePeerLink`, `mergeProfileIdentity` and `renameSelf` throw on every early exit. "Offline" and "unreachable" read as a connection problem, "the server said no" as gone. After the write queue applies a `link_profile` entry it runs ONE background `fullSync`: 045's server-side id rewrite is in rows no `kwenta_write` response returns. The group, bill-popup, notification-tap and person screens ask the server online (roster, `loadBillIntoMirror` fresh, `refreshGroupIntoMirror`, the person fetch) and keep the device copy only offline or on an unreachable answer.

**A group bill is writable only by its creator** (082), while they are an active member: another member's edit, re-payer or delete is refused, as is the group creator's edit. Two narrow exceptions keep older clients working: the group's creator may write a soft-delete of another member's bill, items and splits only once the group row itself is deleted and only changing `is_deleted` (an old `deleteGroup` cascade, a queued delete), and an active member may re-point `paid_by` / a split's `user_id` at `kwenta_canonical_user_id(stored)` with nothing else changed, the server choosing the version (a pre-081 contact link). No live bill, item, split or payment can be written into a deleted group (`kwenta_group_open` locks the group row `FOR SHARE`, so it also serialises with a concurrent delete), and marking a group deleted by ANY path (`kwenta_write`, a `kwenta_sync` replay, `kwenta_delete_group`) fires a trigger that sweeps every live child and membership. Personal bills are creator-only, as before.

---

## Auth Flow (`src/hooks/AuthProvider.tsx`)

`AuthProvider` wraps the app. On session change (`applySession`):
1. **Device owner** (`ensureDeviceOwnedBy`, `src/lib/device-owner.ts`; owner key
   `kwenta_local_user_id`). Same user → keep the mirror and its unsent changes. A different user →
   wipe (`clearKwentaLocalData`: Dexie, API cache, primed reads, realtime cursors, repair stamps,
   session epoch) BEFORE the first render as the new user; when the previous user has unsent
   changes, a Continue/Cancel warning first (Cancel signs out, keeping them). No key (upgraded
   device) → adopt when every unsent change on it is this user's; otherwise wipe if the mirror
   provably belongs to someone else (a foreign queue entry, a foreign unlinked contact, or an
   account row neither mine nor linked from my contacts — checked even when my own row is present).
2. `ensureProfile(userId, email)` — Dexie first; only a first sign-in fetches the profile row.
3. Render. The **account gate runs in the background** (`kwenta_my_account_status`, 076; the
   `profiles` row on an older server): inactive/unconfirmed → sign out keeping this user's offline
   copy (the login page shows the status-specific copy); a transport failure stays signed in and
   asks again on reconnect; an auth failure tries one refresh, then signs out as expired.
4. **Offline session mode**: offline with an expired token and a device owned by this user → open
   with sync and realtime off (`authReady` false); on reconnect refresh the session, sign out if the
   refresh token is rejected. A stored session for anyone else does not open offline.

Server-side (076) an inactive caller gets 403 `kwenta_account_inactive:<status>` from every
endpoint; the Supabase client's `global.fetch` wrapper (`src/lib/supabase.ts`) signs THIS device
out (`scope: 'local'`) on the first one it sees — only a PostgREST JSON error with code `42501`
and a message starting with the marker counts. Voluntary sign-out (Settings) still wipes the device and sets the voluntary flag
(`src/lib/auth-session-flags.ts`); an expiry or deactivation sign-out does not wipe.

---

## Supabase Migrations (`supabase/migrations/`)

Migrations are numbered; there are two `021_` files. The per-migration index (what each one changed and why, and whether it must ship before the
client) is **`docs/migrations.md`**. Read the migration's own header before relying on it.

**Two write RPCs, one set of validators.** `kwenta_write` (066) is the mutation path: it applies the push and returns ONLY the rows it stored plus the recomputed payloads for the screens that were on display. `kwenta_sync` is the mirror-refresh and offline-replay path, and the fallback for a database without 066: it applies the push and returns the complete pull bundle for `p_since` (the client always passes the epoch — see "Reads are always fresh"). Both go through the same `kwenta_push_*` validators, which enforce the same RLS rules the client filters apply. **A validator must judge the STORED row in its `ON CONFLICT ... DO UPDATE ... WHERE`, not only the incoming one** — the incoming columns are the caller's to forge (075).

**Deletion is server-authoritative.** A device is sent only its own profile plus its own local contacts, so it cannot judge whether a person, bill or group exists — a client that soft-deletes from its cache will eventually delete real data (it did: personal payments between two accounts with no shared group). `kwenta_repair_settlements` (048) makes that decision server-side; `src/lib/kwenta-data-repair.ts` only calls it and mirrors the result. Never reintroduce client-side soft-deletes driven by "I can't find X".

---

## App Store & Runtime Flags

**`src/store/app-store.ts`** (Zustand):
```typescript
{
  isOnline: boolean           // initialised from navigator.onLine
  syncStatus: 'idle' | 'syncing' | 'error'
  syncRetryAt: number | null  // unix ms for next retry
  currentUserId: string | null
  realtimeNotice: { message: string; at: number } | null
  screenLoadCount: number     // online useServerData fetches in flight (beginScreenLoad/endScreenLoad, floored at 0)
  runtimeFlags: {
    dedupeSyncEnabled: boolean         // default true — prevent concurrent fullSync
    realtimeCatchupSingleRun: boolean  // default true — dedupe catch-up RPC
    notificationPushOnlyMode: boolean  // default true — counter relies on realtime INSERTs
    targetedRealtimeReconcile: boolean // default true — use reconcile RPC vs full pull
    coalesceRealtimeBatch: boolean     // default true — drain realtime queue per burst; ≥2 fresh events → one syncRoundTrip instead of one reconcile RPC per event
  }
}
```

**`src/lib/runtime-flags.ts`** — `isRuntimeFlagEnabled(key)` checks `localStorage` override (`kwenta_flag:{key}` = `'1'`/`'0'`) before falling back to store default. `setRuntimeFlagOverride` persists to both.

---

## Routing

- `/` — Public landing page (`src/landing/`), guest-only: a signed-in visitor is redirected to `/app` (`RequireGuest`)
- `/login` — Auth page
- `/app/*` — Authenticated shell (lazy routes):
  - `/app` — Home (dashboard stats, **to receive / to pay** rollups with personal vs group breakdown, quick actions, recent bills)
  - `/app/bills` — Bills list
  - `/app/bills/new` — Add bill
  - `/app/bills/:billId` — Bill detail
  - `/app/groups` — Groups list
  - `/app/groups/:groupId` — Group detail (members, bills, balances, settlements)
  - `/app/people` — Contacts
  - `/app/people/:personId` — Person detail (pairwise net, shared bills, settlements)
  - `/app/balances` — Redirects to `/app` (legacy bookmark)
  - `/app/settings` — Profile + app settings
  - `/app/users` — Admin users (admin only)

---

## Key Directories

| Path | Purpose |
|------|---------|
| `src/db/db.ts` | Dexie schema + version migrations |
| `src/db/operations.ts` | All write operations (create/update/delete/link) |
| `src/sync/sync-service.ts` | `syncRoundTrip`, `fullSync`, push/pull logic |
| `src/sync/sync-manager.ts` | Orchestration: debounce, backoff, backup timer |
| `src/sync/cloud-first-mutations.ts` | Queue-entry and "not applied" record helpers |
| `src/sync/write-queue.ts` | The ordered write queue: enqueue, drain, dismiss, retry |
| `src/lib/device-owner.ts` | Whose mirror this device holds; the account-switch wipe |
| `src/sync/realtime-events.ts` | Supabase Realtime subscription + event processing |
| `src/api/balances.ts` | Every server-computed read (balances, lists, detail screens, history) |
| `src/api/primed-reads.ts` | Which endpoints are on screen, and the payloads a write already answered |
| `src/hooks/useServerData.ts` | Fetch + `dataVersion` invalidation for server-backed screens |
| `src/lib/people.ts` | Profile display, linking, identity expansion, contact discovery |
| `src/lib/settlement.ts` | Settlement view-model types + `buildMovementChains` |
| `src/lib/splits.ts` | Split amount computation (equal/percentage/custom) |
| `src/lib/kwenta-notifications.ts` | Notification outbox, senders, recipient resolution |
| `src/lib/supabase.ts` | Supabase client (PKCE auth, session persistence) |
| `src/lib/utils.ts` | `cn`, `generateId`, `getDeviceId`, `now`, `formatCurrency`, `timeAgo` |
| `src/store/app-store.ts` | Zustand: online status, sync status, runtime flags |
| `src/hooks/` | `useAuth`, `useCurrentUser`, `useSync`, `useRealtime`, `useOnlineStatusTracking` |
| `src/pages/` | Route-level page components |
| `src/components/` | Shared UI: common dialogs, layout, notifications bell, landing |
| `supabase/migrations/` | All DB schema, RLS policies, sync RPCs |

---

## PWA

- Service worker: `src/sw.ts` (Workbox, `injectManifest`)
- Precaches all build artifacts, handles SKIP_WAITING for updates
- Vendor code the entry always loads is split into stable chunks (`react`, `supabase`, `dexie`) by `vendorChunkFor` (`vendor-chunks.ts`, pinned by `tests/build/vendor-chunks.test.ts`), so a release that changes only app code re-downloads a ~183 kB entry (plus any changed lazy chunks) instead of a ~745 kB one. The landing route now costs a first-time visitor one extra round trip (entry, then its chunk) behind the page spinner — accepted, since signed-in starts are the common case. **Never add a lazy-only library there** (jspdf, html2canvas, the Radix select): a manual chunk loads with whatever imports it, so it would move onto the first load. The landing page is a lazy route like the others (`tests/app/landing-lazy.test.tsx`)
- App name: "Kwenta — Bill Splitter", display: `standalone`, theme: `#1f2937`; manifest in `pwa-manifest.ts` (pinned by `tests/build/pwa-manifest.test.ts`). An installed app launches into **`/app`** (scope `/`; `id: '/'` keeps the identity existing installs got from the old `start_url`, or Chrome would ignore the update); `src/sw.ts` serves the precached `index.html` for every navigation, which is what lets that launch — and a reload of any deep link — work offline. It also means an installed app keeps its OLD build across relaunches until its user taps Refresh, so "deployed" is not "every client runs it" (why 073's prune jobs are scheduled by hand, later)
- Installable on iOS/Android/desktop; works fully offline via Dexie + SW cache

---

## Feature Lifecycle (follow strictly)

The bar for every change: **correct, private, and cheap to run**. This is a money app
with a hard privacy boundary and an offline mirror — a wrong balance, a leaked row, or a
duplicated payment is not a cosmetic bug. Three phases; the Phase-1 gate is mandatory,
not polish.

### Phase 0 — Understand & align

- Read the actual code paths first and write down how they behave **today**. You cannot
  tell whether you broke something if you never established what "working" looked like.
  Trace the full flow: operation → builder → `commitCloudFirstWrite` → `kwenta_sync` →
  pull bundle → Dexie → `bumpDataVersion` → `useServerData`. The first relevant file is never the whole
  behaviour.
- **Ask before building — even for small calls.** If a requirement is ambiguous, a
  trade-off is open, or you have any concern about the direction, ask (`AskUserQuestion`)
  first. A feature built in the wrong direction is the most expensive bug. When there is
  an obvious conventional default, take it and say so.
- Summarize before editing: current behaviour, desired behaviour, what changes, what must
  stay, likely files, risks, assumptions, open questions.

### Phase 1 — Data, privacy & cost plan (MANDATORY before writing code)

For any change touching data (Dexie, SQL, sync, notifications, balances), write this out
in chat **before implementing**:

1. **Reads** — list every Dexie query and every RPC the path will make. A per-contact or
   per-bill loop that re-queries items/splits is a design error, not a slow path: fix it
   *now*: a screen fetches ONE scoped endpoint, and money is never aggregated per contact on
   the client at all (rule 8).
2. **Writes** — which builder produces the rows, and which single `commitCloudFirstWrite`
   submits them. Cascades and multi-leg writes contribute to a `MutationRowCollector` and
   the **parent submits once** — never a chain of separate submits with compensating
   deletes.
3. **Privacy** — does the change read or return rows for a user other than `auth.uid()`?
   If a server read is involved it must select from the `kwenta_pull_rows_<table>`
   functions (migration `051`), never an inlined `WHERE` over a base table. State which
   identity set the rows are scoped to, and whether a linked contact widens it.
4. **Schema** — new Dexie fields/indexes need a **new Dexie version** in `src/db/db.ts`
   (never mutate an existing version). New SQL needs a **new migration number** with a
   header (see rule 3), plus RLS and grants.
5. **Cost surface** — every new RPC call, realtime subscription, notification send and
   background timer. Prefer piggybacking `kwenta_sync`, the existing `kwenta_user_events`
   channel and the 5-minute backup timer over adding anything new.
6. **Blast radius** — the shared files/tables/RPCs/components touched and the adjacent
   flows that must be regression-tested (this list feeds Phase 3). Grep for callers before
   assuming something is unused.

If the plan surfaces an open trade-off, stop and ask (Phase 0) before coding.

### Phase 2 — Build

Smallest complete change. Clear over clever. Follow the existing patterns; search for an
existing helper before writing a new one. TDD is the default: failing test → implement →
green → refactor.

| Don't | Do | Canonical example |
| --- | --- | --- |
| write Dexie then call the cloud | build rows → `commitCloudFirstWrite` → mirror server response | `src/db/operations.ts` + `src/sync/cloud-write.ts` |
| several submits for one logical mutation | `MutationRowCollector`, parent submits once | `deletePerson`, `deleteGroup`, `linkProfileToRemote` |
| soft-delete because "I can't find X" locally | server decides — `kwenta_repair_settlements` | `src/lib/kwenta-data-repair.ts` |
| fetching the whole dataset to render one screen | a scoped read endpoint; cache the rows for offline | rule 7 |
| stamp a realtime cursor from the device clock | max **server-supplied** `created_at` of drained events | `src/sync/realtime-batch.ts` |
| re-query bills/items/splits per contact | one scoped SQL endpoint for the screen | `kwenta_person_summary` |
| `db.profiles.get(id)` alone in a group context | fall back to `group_members.display_name` | `getBillWithDetails` |
| aggregating money over every bill on the client | a SQL endpoint returns the number | rule 8 |
| a second copy of any money rule | one implementation — SQL aggregates, TS transforms | rule 8 |
| an inlined `WHERE` over a base table in a read RPC | select from `kwenta_pull_rows_<table>` | migration `051` |
| sending a notification during the mutation | queue in the outbox, flush after the sync confirms | `src/lib/kwenta-notifications.ts` |
| editing a past migration | new numbered migration with a header | `supabase/migrations/` |
| mutating an existing Dexie version | new version block in `src/db/db.ts` | v14 |
| polling / manual refetch loops | `useServerData` + `bumpDataVersion` + the existing refresh triggers | `src/hooks/useServerData.ts` |

### Phase 3 — Verify (before saying "done")

1. **Compare old vs new behaviour** — confirm the feature does what was asked, edge cases
   included. Re-derive the expected result from the requirements, not from your
   implementation.
2. **Regression-test the Phase-1 blast-radius list.**
3. **Adversarial pass** — think like a malicious user, a repeated tap, a lost response, a
   stale device, two devices at once, a half-applied bundle, an older client against a
   newer server (and the reverse). Ask of every assumption: what if it is false? Could
   this duplicate a payment, move a balance that was rejected, delete a real row, or show
   one user another user's data? Add tests for the realistic ones.
4. **Run the gates** (see Verification below). `npm test` **and** `npm run test:sql` must
   both pass, plus `npm run build` and `npm run lint`.
5. **Fresh-eyes review of the complete diff** as though someone else wrote it and it ships
   today — hunt for reasons it fails, not reassurance that it looks fine.

---

## Coding Rules

Each of these reflects a real past correction in this repo:

1. **Never reintroduce write-then-sync.** The Dexie transaction must not commit before the
   server confirms. That ordering is what minted duplicate bills.
2. **Deletion is server-authoritative.** A device is sent only its own profile plus its own
   local contacts, so it can never conclude that a person/bill/group does not exist. No
   client-side soft-delete driven by a missing row — ever.
3. **Migrations are append-only.** Next number: **`088`**. Never edit a past migration.
   **Every migration carries its own explanatory header** — what broke, why the shape is
   what it is, and whether it must be applied before the code that uses it ships. That
   header is the canonical record; read it rather than trusting any summary. A signature or
   return-type change to an existing function needs a `DROP` first plus a restated
   revoke/grant block.
4. **Dexie versions are append-only too** — add a version, never edit one that has shipped.
5. **A function that names its caller must not be callable by the caller.** Client-facing
   endpoints derive the viewer from `auth.uid()` and select from `kwenta_pull_rows_*`. Helpers
   that take the acting user as an ARGUMENT (`p_viewer`, `uid`) are `SECURITY DEFINER`, so that
   argument *is* the authorization decision — they must be `service_role` only. This was not
   hypothetical: `kwenta_build_pull_bundle` was never revoked from PUBLIC (Postgres grants
   EXECUTE to PUBLIC by default) and the `kwenta_push_*` validators were granted to
   `authenticated`, so any signed-in user could read another user's profile, private contacts,
   groups, memberships and settlements, and could write rows attributed to them. Fixed and
   pinned by a generic sweep in `065`'s suite; since `070`, a migration adding such a helper ends
   with `SELECT public.kwenta_revoke_acting_user_helpers();`. Since `073` a new function starts
   closed (no PUBLIC/anon/authenticated default), so a client endpoint needs its own `GRANT ...
   TO authenticated`, and the `073` suite's allowlist must name it. The money helpers in 052–054/057/063 read base
   tables rather than `kwenta_pull_rows_*`; that is safe *only* because of this rule.
6. **Always fall back to `group_members.display_name`** when resolving a name in a group
   context; a co-member's local contact row is not on this device by design.
7. **Reads are scoped server endpoints; Dexie is a cache.** *(Supersedes "every pull is the
   complete bundle", 2026-08-04.)* A screen fetches what that screen shows. **Online, the
   server response IS the list** — the cache exists for offline display and is never
   consulted to decide whether a row exists, so a scoped read can never be mistaken for a
   deletion. `kwenta_write` (066) is the **write** path and `kwenta_sync` the mirror refresh.
   A write returns the recomputed payloads for the mounted endpoints, so the re-read it triggers
   costs no request; those payloads run through the endpoint's normal mapper, never a second copy
   of its shape rules. Still forbidden: **stamping any sync
   cursor from the device clock** — the realtime cursor takes the max *server-supplied*
   `created_at`. A fast clock writes a cursor into the future and then silently filters out
   every later event, permanently.
8. **Money math lives in SQL, once.** *(Supersedes "money math lives in TypeScript",
   2026-08-04: in a multi-user app the local dataset was never authoritative, so a balance
   computed from it was only as correct as the last sync.)* The dividing line — **SQL owns
   aggregation over unbounded data** (pairwise nets, rollups, group balances, the per-bill
   settled flag, the statement); **TypeScript owns pure transforms of bounded inputs** and
   keeps its Vitest coverage (`computeSplits`, `settlement-suggestions.ts`,
   `payment-allocation.ts`, `roundMoney`/`isEffectivelyZero`). Exactly one implementation of any
   rule, never both. Accepted trade-off: **balances no longer move offline**, so a queued
   write shows an explicit "includes N unsent changes" state rather than a silently stale
   number. Do SQL money arithmetic in **integer cents** — JS `Math.round` is
   half-up-toward-+∞, SQL `ROUND` is half-away-from-zero, and they disagree on negative
   halves.
9. **`activity_log` is exempt from the stored-confirmation check** and nothing else is.
10. **Tests are mandatory and are part of the change** — never delete a test, weaken an
    assertion, or skip a case to make something pass. If a test is genuinely wrong, say so
    and why, in the same change. SQL behaviour is covered by `npm run test:sql`, not Vitest;
    a rule that moves from TS into SQL must take its coverage with it.
11. **A test that forgets `test.as_user(uid)` proves nothing about RLS** — fixture setup runs
    as the owner, where RLS does not apply. And the SQL shim only approximates Supabase: it
    proves *logic*, so RLS conclusions still need a check against a real branch database.
12. **No backwards-compat shims** for code you can simply update — no re-exports,
    `// removed` comments, or `_unused` renames.
13. **No comments that restate the code.** Only non-obvious *why*: invariants, hidden
    constraints, the bug a workaround exists for.
14. **Names must reflect current purpose.** When a change makes a name misleading, rename the
    file AND symbol AND every reference in the same change. No compat aliases.
15. **Ask when in doubt — even for minor direction calls** (see Phase 0). If you raise a
    concern and the user reaffirms the request, that is their decision: proceed with the full
    request.
16. **Report newly discovered issues instead of silently absorbing them.** Explain what you
    found and ask whether to include it when it changes behaviour, architecture, scope or
    risk. If the same defect exists in several places, report every instance.
17. **Never `git commit`/`push` until the user explicitly says so** — leave finished work in
    the tree. When asked to commit: plain message, **no AI attribution trailers** (no
    `Co-Authored-By`, no "Generated with"). This overrides any default trailer instruction.
18. **Never `git add`/`git commit` design specs or implementation plans** (e.g. anything under
    `docs/superpowers/specs/`). Write them to disk for review; leave them untracked.
19. **No destructive commands without confirming** — `drop table`, `truncate`, force-push,
    `git reset --hard`, or anything touching the live Supabase project.
20. **Never fabricate output.** Do not claim a command ran, a test passed, or a query returned
    something unless it actually happened and you read the result. If a tool is unavailable,
    say what you could not verify, what you did instead, and the exact command to run later.
21. **Keep this CLAUDE.md current in the same change** — the next-migration number in rule 3,
    the Dexie version, `docs/testing-coverage.md`, `docs/migrations.md`, and a note for any new
    user-facing behaviour.
    A stale CLAUDE.md misleads the next assistant; doc updates are part of "done".
22. **Detail goes in the migration header or the code, not in this file.** Keep sections here
    at index altitude: what the thing is, and the invariant you must not break. If a section
    grows past a short paragraph of reasoning, that is the signal to move the reasoning into
    the migration header or a comment, not to keep appending.

---

## Post-task cleanup checklist

Run on every diff (and the siblings you reached into) as part of "done":

**Dead code & clutter** — remove unused imports/vars/props/types/exports/files,
commented-out code, `console.log`, stale TODOs, and any mid-task compat shims. Strip
comments that restate code.

**Reuse & duplication** — before adding a helper/component/type, grep for an existing one
(`src/lib/`, `src/db/operations.ts`, `src/types/index.ts`). Where duplication is real and
represents the same responsibility, extract one small named helper, test it, and update the
other copies. Don't abstract merely because two things look similar — some local
duplication beats the wrong abstraction.

**Performance** — no per-contact/per-bill re-querying (one scoped endpoint per screen); no query
inside a render loop; bulk-load with one Dexie pass and memoize identity expansion; nothing
whose round-trip count grows with contact or group count.

**Correctness & privacy** — new SQL has RLS + grants and reads through
`kwenta_pull_rows_*`; new writes go through a builder + one `commitCloudFirstWrite`; new
Dexie fields have a new version; name resolution has the `group_members` fallback.

**Validation gate** — `npm test`, `npm run test:sql`, `npm run build`, `npm run lint` all
clean, and the complete diff re-read.

If a sweep finds nothing to remove or tighten, **say so explicitly** — silence shouldn't be
ambiguous with "I forgot to check."

---

## Verification

Run, in this order, and inspect each result:

```bash
npm test            # Vitest — must pass in full
npm run test:sql    # SQL suite against a throwaway Postgres — must pass in full
npm run build       # tsc -b + vite build (catches type errors)
npm run lint        # ESLint
```

Then re-read the complete diff and investigate every failure, warning and surprise.

Distinguish explicitly when reporting: **passed / failed / failed because of this change /
pre-existing failure / could not be run / not applicable.** Never say "everything passed"
when only a subset ran.

`npm run build` reporting `TS1127: Invalid character` means an edit introduced Unicode curly
quotes into a string literal — fix with the python snippet in the SQL Test Harness section.

---

## Final report

End every non-trivial task with these sections:

- **Understanding** — what the system did before, what was asked, what it does now,
  requirements clarified, assumptions remaining.
- **Changes made** — files and components changed, key decisions, helpers created,
  duplication removed, migrations or schema changes.
- **Tests** — added/updated, behaviours covered, edge and adversarial cases.
- **Verification** — the exact commands run and the result of each.
- **Final review** — issues found and fixed, minor cleanups, remaining concerns.
- **Production readiness** — exactly one of *Ready for production* / *Ready for production
  with noted limitations* / *Not ready for production*, based only on checks that actually
  ran.

Be honest about anything that could not be verified. Never guarantee that future issues are
impossible.

---

## When in doubt

- Read the closest sibling file's existing pattern before inventing a new one.
- For anything touching RLS, the pull bundle, the cloud-first write path, balance
  arithmetic, or data repair: propose the approach before editing.
- If a memory, a summary, or this document disagrees with the code, **trust the code** and
  update the doc in the same change.
