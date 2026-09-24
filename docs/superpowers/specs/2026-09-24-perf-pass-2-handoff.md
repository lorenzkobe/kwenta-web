# Kwenta perf pass 2 — handoff (do not commit)

The user approved doing ALL six items below, in a fresh session. Follow CLAUDE.md's Feature
Lifecycle (Phase 1 data/privacy/cost plan before code), the done-gate workflow, and these standing
rules from the user:

- **Production is live with real users.** Local dev (`npm run dev`) signs into the real Supabase
  project, so live checks must be READ-ONLY: navigate, open forms and modals without saving, and read
  network timings. Never save, delete, pay, merge or confirm. Prove write paths with unit/SQL tests.
- **Ask open decisions as AskUserQuestion multiple-choice with a "(Recommended)" option.** Don't
  list them as "not changed".
- **Never commit.** The user applies migrations and merges themselves.
- **SQL suite:** Postgres 14 is installed. To run the suite beside a kept benchmark DB, set
  `KWENTA_SQLTEST_PORT=<free port>` and `KWENTA_SQLTEST_PGDATA=<own dir>`, since both default to
  55432 and `$TMPDIR/kwenta-sqltest-pgdata`.

## Where things stand (2026-09-24)

Shipped and merged:
- **Pass 1 (client):**
  - Stale-while-revalidate screens (`useServerData` seeds from `readCache`, with an "Updating…" chip).
  - Realtime echo gating (refresh only when a row moved; `syncRoundTrip` refreshes on `changed > 0`).
  - The notification outbox `confirmed` flag, so a confirmed write skips the full sync.
  - Batched member adds and an atomic `createGroup`.
  - `ConfirmDialog` shows a `pendingLabel`.
  - Route chunk prefetch.
- **Leftovers:**
  - `loadBillIntoMirror` (`src/sync/bill-mirror.ts`).
  - `updateBill`/`deleteBill` throw instead of failing silently.
  - Auto-repair runs at most once a day.
  - Double-refresh gating, and the export-csv flake fixed.
- **Migration 070:**
  - Set-based balance endpoints (`kwenta_pairwise_personal_many`, `kwenta_pairwise_breakdown_many`).
  - New indexes, and `ROWS 5` on `kwenta_expand_identity`.
  - The `kwenta_revoke_acting_user_helpers()` sweep: it returned 38 in production, and the helpers
    now answer 42501 to signed-in users.

Live timings after 070 (dev build; StrictMode doubles every call):

| Endpoint | Time |
|---|---|
| overview | 200–380 ms |
| contacts | 210–360 ms |
| groups list | ~120 ms |
| recent bills | 160–260 ms |
| **personal_bills** | **~550 ms** |

The per-call floor is about 120–150 ms (network plus PostgREST).

## The six items, in the suggested order

### 1. Bills list: migration 071, rewrite `kwenta_personal_bills` (065:170-318)

What costs time today:
- `kwenta_pull_rows_bills('epoch', uid)` is evaluated twice. Once is inside
  `kwenta_bills_settled_map`'s id list, which re-runs `relevant_bill_ids_for_user` (a seq scan of all
  bills plus a per-row `is_group_member`). The bill_items and item_splits pull-rows then re-evaluate
  it again, so it runs about 4 times in total.
- `kwenta_expand_identity` is called once per (bill, participant) row, in `clustered`.
- `kwenta_peer_display_name` is called twice per pill (label and sort) plus once per row (payorName).

Plan:
- Materialise the visible bill set once (a MATERIALIZED CTE, or plpgsql arrays).
- Expand each DISTINCT participant id once.
- Resolve each distinct display name once.
- Pass the already-computed ids into the settled map.
- Keep reading through `kwenta_pull_rows_*` (051 privacy boundary). The rule is to select FROM the
  pull-rows functions and never inline a base-table WHERE for visibility.
- Possibly also fix `relevant_bill_ids_for_user`'s OR with a per-row function call (049:122). That
  changes a privacy predicate, so it needs the 051-style verbatim equality pin and an explicit
  proposal to the user first.

Equivalence and proof: copy the 070 pattern exactly.
- The test holds verbatim `test.old_*` copies and compares every viewer in a rich fixture.
- `mine`/`shared` are ordered by `created_at DESC`. Ties are possible, so check whether the old order
  was defined before comparing exactly.
- Run mutation checks (break a rule, confirm the suite fails).
- Benchmark on the synthetic data. The seed script is in the old session's scratchpad and may be
  gone: rebuild it with about 400 accounts, 8k personal bills, 40 groups and 3k settlements.
- End the migration with `SELECT public.kwenta_revoke_acting_user_helpers();` if it adds a helper
  with an acting-user argument (rule 5).

Target: `personal_bills` under about 200 ms live, including network.

### 2. App start: show saved screens before the network answers

- `src/hooks/AuthProvider.tsx:110-112,160,196-198`: `applySession` awaits `accountGate` (a network
  `profiles` select), then `ensureProfile`, before `setCurrentUserId`. Every screen's `userId` stays
  null until then, so cache seeding cannot happen.
- Option: set `currentUserId` from the persisted Supabase session straight away, and run the account
  gate in parallel. If the gate then refuses (disabled account), sign out and clear, which is the
  current behaviour, just later.
  - The privacy risk to think through: can a refused account see its own saved copy for a moment?
    The cache is per-user and holds only that user's data, but ask the user.
- `AppShell.tsx:25-30`: the full-screen loader until the initial `kwenta_sync` applies only to first
  sign-in or cleared storage. Leave it, or show server-backed screens immediately, since they no
  longer need the mirror.
- Tests: extend `tests/hooks/useServerData.test.tsx`; add an AuthProvider test if feasible.

### 3. Tab switching: stop the full `kwenta_sync` on every focus

- `src/sync/sync-manager.ts:101-112,248-249`: `onTabActivated` runs `runSync('online')`, throttled to
  5 s. That is a complete ~213 kB bundle plus `toArray()` over every Dexie table (`sync-service.ts`
  ~841-895).
- Idea: a cheap check first, then a pull only when something changed. For example, ask
  `kwenta_user_events` for anything newer than the realtime cursor (`LAST_SEEN_EVENT_KEY`), or add a
  tiny RPC returning max(updated_at).
- Screens already refetch their own endpoints on focus? Check this. Also check how the 5-minute
  backup timer interacts.
- Keep rule 7: never stamp a cursor from the device clock.
- Keep offline replay (pushing unsynced rows) working. It must still push when anything is staged.

### 4. Skip the reconcile RPC for this device's own write echoes

- Echo gating now avoids the refresh, but each echo event (one per bill, item and split row per
  member) still calls `kwenta_reconcile_user_event` (`realtime-events.ts` `processEvent`).
- Idea: `commitCloudFirstWrite` records the entity ids plus server `updated_at` it just mirrored. An
  event for such an entity is skipped only if Dexie already holds that exact row version.
- Do NOT skip on id alone: another member's concurrent edit would be missed. `kwenta_user_events`
  has no actor or updated_at column, so decide carefully, or add an `updated_at` to the event
  payload via a migration (a trigger change, so propose it first).

### 5. Bundle size

- `dist/assets/index-*.js` is about 727 kB minified.
- The landing page is imported eagerly (`src/App.tsx:5`), so lazy-load it.
- Consider `manualChunks` for vendors (react, radix, supabase, dexie).
- `jspdf` and `html2canvas` are already split.
- Measure before and after with `npm run build`.
- The service worker precaches `**/*.js`, so only first loads and updates benefit.

### 6. Small SQL leftovers (can ride along with 071)

- **`kwenta_related_profile_ids` (054:66):** its `candidate_bills` does a seq scan of all bills
  because of the `(group_id IN my_groups) OR (group_id IS NULL AND created_by IN me)` OR. Split it
  into a UNION so each arm can use an index. This is equality-sensitive (contact discovery), so pin
  it.
- **`kwenta_balances_overview` computes each group's pairwise twice:** once in
  `kwenta_pairwise_breakdown_many` and once in the group-bucket loop (070:461-471). It could reuse
  one materialised set, but that needs `_many` to expose its group nets, or a shared CTE.

## Verification that must pass before "done"

- `npm test`, `npm run test:sql` (on its own port and data dir), `npm run build`, `npm run lint`.
- An independent reviewer, plus reviewer-2 for SQL, money and privacy.
- A read-only live drive with timings via
  `performance.getEntriesByType('resource')`, filtering `/rest/v1/rpc/`.
- Update CLAUDE.md: the next migration number (072 after 071), the migrations table and the
  coverage list.
