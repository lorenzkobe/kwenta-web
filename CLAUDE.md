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
```

## Plans & Specs (do not commit)

Design specs and implementation plans (e.g. files under `docs/superpowers/specs/`) are **not** saved in the repo. Write them to disk for review, but **never `git add`/`git commit` them** — leave them untracked. If a skill instructs you to commit the design doc, skip that step for this project.

## Testing Policy (required)

Tests are **mandatory** for this project — we create tests and run testing as part of every change, not as an afterthought.

- The test runner is **Vitest** (`vitest.config.ts`, `happy-dom` environment, `@` alias). Tests live in the top-level **`tests/`** folder, mirroring the source tree: `tests/lib/*.test.ts` for `src/lib/*`, `tests/db/*.test.ts` for `src/db/*`, `tests/sync/*.test.ts` for `src/sync/*`. Import the code under test via the `@` alias (e.g. `@/lib/splits`); import shared test helpers by relative path (e.g. `../helpers/db`).
- `tests/setup.ts` (registered as `setupFiles`) imports `fake-indexeddb/auto` so any module that touches `@/db/db` can open the DB. For Dexie-backed functions, use the factories + `resetDb()` in `tests/helpers/db.ts` (call `resetDb()` in `beforeEach`).
- **Mocking Supabase / sync side-effects:** modules that import `@/lib/supabase` or fire sync/notifications (e.g. `operations.ts`, `kwenta-notifications.ts`, `sync-service.ts`) are tested by `vi.mock`-ing the network/side-effect deps and asserting Dexie/localStorage state. Use `vi.hoisted` to share controllable mock state with the hoisted `vi.mock` factory (see `tests/lib/kwenta-notifications.test.ts`, `tests/lib/cloud-first-mutations.test.ts`, `tests/db/operations.test.ts`). A benign `@/lib/supabase` stub (`rpc → {data:null,error:null}`) keeps `fetchRemoteProfileIntoDexie` offline.
- When adding or changing behavior, add/extend unit tests that cover it. Prefer the pure-logic modules (`src/lib/splits.ts`, `src/lib/utils.ts`, `src/lib/bill-split-form.ts`, etc.). DB-coupled modules (`settlement.ts`, `people.ts`, `personal-bill-status.ts`, `operations.ts`) are tested against `fake-indexeddb`.
- Run `npm test` before considering any change complete — **it must pass in full**.
  - No count is pinned here on purpose. A hard-coded total goes stale the moment anyone adds a test file, and a stale figure is worse than none: the next contributor sees a different number and cannot tell whether they broke something or fixed it. A green suite is the signal.
  - What the number was really guarding is worth stating directly instead: **never delete a test, weaken an assertion, or skip a case to make a change pass.** If a test is genuinely wrong, say so and why in the change itself. (This is not hypothetical — a batch of repair-rule tests was dropped when those rules moved into SQL, and `npm test` stayed green while the behaviour went uncovered.)
- Coverage inventory:
  - `tests/lib/` pure logic: `splits`, `utils` (incl. `roundMoney`/`isEffectivelyZero`/`MONEY_EPSILON`), `amount-input`, `bill-split-form`, `bill-navigation`, `balance-rollups`, `db-query-helpers`, `account-gate-messages`, `export-utils`, `bill-categories`, `auth-session-flags`, `runtime-flags`, `client-metrics`
  - `tests/lib/` DB-backed: `settlement` (incl. `listSettlementHistoryForBill`), `people`, `personal-bill-status`, `clear-kwenta-local`, `export-csv`
  - `tests/lib/` with mocked deps: `kwenta-notifications` (outbox/senders/flush/dead-letter), `cloud-first-mutations` (pending-mutation + conflict tracking)
  - `tests/db/`: `operations` (createBill/updateBill/deleteBill, createGroup, addGroupMember, removeGroupMember split redistribution, createSettlement, linkProfileToRemote id rewrites, deleteGroup cascade, getBillWithDetails)
  - `tests/lib/` storage: `kwenta-storage-keys` (refresh marker + legacy-cursor migration, incl. failing storage writes)
  - `tests/sync/`: `sync-service` helpers (`getMillisecondsSinceLastRefresh`, `hasUnsyncedLocalDataForUser` incl. RLS push-filter, `shouldApplyPulledRow`, `compareTimestamps`); `sync-round-trip` (complete-bundle guarantees, echo guard, push stamping); `sync-manager` (navigation refresh: throttle, release, backoff isolation, monotonic clock); `pull-pagination` (PostgREST max-rows paging in the fallback path); `realtime-batch` (burst coalescing + `latestEventCreatedAt`, the server-clock cursor source)
  - `tests/db/cloud-first-write.test.ts`: the cloud-first write contract (accept / transport error / silent server-side drop / partial drop; rejected update and delete leave the original intact; multi-leg payment is all-or-nothing; a retry after rejection makes exactly one bill)
  - `tests/sync/cloud-write-idempotency.test.ts`: submission ids (replay reports the original outcome; fallback and probe-caching against a pre-`050` server)
  - `tests/lib/balance-snapshot.test.ts`: shared `BalanceSnapshot` — identical numbers with and without it, plus a query-count guard that fails if per-contact rescanning returns
  - `tests/lib/kwenta-data-repair`: the CLIENT contract only (asks, never decides; mirrors; surfaces a failed mirror). The repair RULES are SQL — see below.
  - Remaining gaps (network-orchestration heavy, lower ROI): `realtime-events` subscriptions, `export-pdf` (jsPDF rendering), `db/hooks.ts` (React `useLiveQuery`).
  - **Uncovered by design of the runner:** everything that lives in SQL — the `kwenta_repair_settlements` rules (which decide what gets soft-deleted), the read/write predicate split in `049`, and `relevant_bill_ids_for_user` (which gates what every user pulls, so a wrong set is a cross-account leak, not a slow query). Vitest has no Postgres. If you change any of them, verify against a branch database by hand; `npm test` cannot tell you they are wrong.

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
  → operations.ts (write Dexie + set synced_at = null)
  → notifySyncAfterMutation → finalizeMutationSync
  → syncRoundTrip (kwenta_sync RPC: push unsynced + pull changed)
  → Dexie updated with server response
  → useLiveQuery re-renders UI
```

Realtime path (another device/user changes something):
```
DB trigger → kwenta_user_events → Supabase Realtime
  → realtime-events.ts processes event
  → fetch bundle RPC (bill/group/settlement)
  → upsert into Dexie → useLiveQuery re-renders
```

### Cloud-First Mutations

The server is the writer of record. Dexie is a **mirror**, not the source of truth.

Every operation in `src/db/operations.ts` is split into a **builder** (pure — returns the
complete rows the mutation implies) and a **commit** through `commitCloudFirstWrite`
(`src/sync/cloud-write.ts`):

1. Build the rows in memory. Nothing touches Dexie yet.
2. **Online:** `submitCloudWrite` hands the rows to `kwenta_sync` as `p_push` **directly**, then
   confirms the server stored them and mirrors the server's returned rows into Dexie. On
   rejection it throws and **Dexie is left untouched**.
3. **Offline:** the rows are staged (`synced_at = null`) and queued in `pending_mutations`;
   the sync manager replays them on reconnect. The app stays fully usable offline.

Why the submit path is separate from `syncRoundTrip`: that function builds its push payload by
*scanning Dexie for unsynced rows*, so a write had to be committed locally before it could be
sent. That is the structural reason the old design could not be cloud-first, and why reordering
calls would not have fixed it.

**Do not reintroduce write-then-sync.** The previous flow committed the Dexie transaction first
and called the cloud afterwards without rolling back, so a rejected write stayed on screen and
still moved balances. The user, looking at a filled form and an error toast, pressed Save again
— minting a *new* row id — and the next background sync pushed both. That is the duplicate-bill
bug; `tests/db/cloud-first-write.test.ts` pins it closed.

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
falls back to the two-argument RPC if `050` has not been applied.

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
- On event: call targeted bundle fetch RPC (bill/group/settlement)
- On reconnect: catch up via `catchUpSince` from last-seen event id (localStorage)
- `catchUpSince` bulk path (>5 missed events): one `syncRoundTrip` instead of N per-event RPCs. It needs no profile-link special-casing any more — every pull is already a complete bundle — and it advances the cursor to the max `created_at` of the events it fetched, not `now()`
- `realtimeCatchupSingleRun` flag deduplicates concurrent catch-ups
- `targetedRealtimeReconcile` flag: use `kwenta_reconcile_user_event` RPC instead of full pull
- `coalesceRealtimeBatch` flag (default on): `flush()` drains the whole queue per burst and runs `planRealtimeBatch` (`src/sync/realtime-batch.ts`, pure/tested). A lone fresh event keeps the targeted reconcile; **≥2 fresh events collapse into one `syncRoundTrip`** instead of one reconcile RPC per event. A bundled settle-up fans out into one settlement event *per leg per member* (trigger `kwenta_on_settlement_changed` is `FOR EACH ROW`), so this turns N reconcile RPCs into a single round trip. The last-seen cursor always advances to the max **server-supplied** `created_at` of the events drained — on both the batch path and the bulk catch-up path. Never stamp it from the device clock: a fast clock writes a cursor into the future and `.gt('created_at', cursor)` then filters out every event the server creates until real time catches up, permanently. Profile-link events need no special handling any more (every pull is a complete bundle).

---

## Dexie Schema (`src/db/db.ts`)

Current version: **14** (v14 added optional `settlements.method` — cash/transfer/… payment audit). All tables extend sync fields: `id` (UUID PK), `created_at`, `updated_at`, `synced_at` (null = unsynced), `is_deleted`, `device_id`. Versions 9+ added compound indexes (e.g. `[group_id+is_deleted]`) for query performance.

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
| `pending_mutations` | `id, actor_user_id, status, entity_type, entity_id, created_at, updated_at` | Cloud-first conflict tracking |
| `not_applied_changes` | `id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id` | Failed mutations surfaced to user |

**Split types:** `'equal' | 'percentage' | 'custom'`
**Mutation statuses:** `'pending' | 'applied' | 'conflict' | 'dismissed'`
**Change resolutions:** `'pending' | 'dismissed' | 'reapplied' | 'auto_resolved'`

---

## Sync System

### Key Files
- `src/sync/sync-service.ts` — `syncRoundTrip`, `fullSync`, push/pull logic
- `src/sync/sync-manager.ts` — orchestration, debounce, backoff, backup timer
- `src/sync/cloud-first-mutations.ts` — `finalizeMutationSync`, pending mutation tracking
- `src/sync/realtime-events.ts` — Supabase Realtime subscription + reconcile

### syncRoundTrip vs fullSync

- **`syncRoundTrip(userId)`** — atomic: single `kwenta_sync` RPC call, applies push payload server-side, returns pull bundle; updates `synced_at` on both sides
- **`fullSync(userId)`** — dedup wrapper around `syncRoundTrip`; if `dedupeSyncEnabled` flag is on, concurrent calls share one in-flight Promise

### Reads: a server-sourced mirror, computed locally

The UI reads from Dexie, but Dexie is a mirror of a complete server bundle (see below), so a
read is *computed over server-sourced rows* rather than over an independent local truth.

Balance arithmetic stays in TypeScript deliberately. Moving it into SQL would freeze balances
offline — a payment recorded without a connection could not move any number until reconnect —
which is the opposite of the goal. Keeping it local also keeps ONE implementation of money
math, covered by `npm test`.

**Performance.** Pairwise balances take an optional `BalanceSnapshot` (`src/lib/people.ts`):
one bulk load of bills, items, splits and settlements, plus memos for identity expansion and
per-group summaries. Pass a single snapshot across a whole page. Without it, every contact
re-scanned every bill and re-queried its items and splits, and `computePairwiseNetBreakdown`
recomputed a whole group's balances once per contact per group — tens of thousands of
IndexedDB round trips per page load. `computeGroupPairwiseBalances` already worked this way;
the personal path simply never adopted it. `tests/lib/balance-snapshot.test.ts` asserts both
that the numbers are unchanged and that query counts do not grow with contact count.

Use `captureBalanceParitySnapshot` (`src/lib/balance-parity-snapshot.ts`) to diff every
displayed balance before and after a change against real data.

### Reads are always fresh (no pull cursor)

**Every pull requests the COMPLETE bundle** — `p_since` is always `PULL_SINCE_EPOCH` (`sync-service.ts`), never a stored timestamp. The cloud is the truth and Dexie is a mirror of it; a complete bundle is a true snapshot because nothing is ever hard-deleted (soft-deleted rows are still sent), so absence from the bundle means nothing and no local pruning exists.

The old incremental cursor (`kwenta_last_pull`) was stamped from the **device clock** after the query ran, so clock skew or a row written mid-round-trip was skipped permanently, and any server-side change that did not bump the client-written `updated_at` could never reach a device — the only cure was wiping local data. Do not reintroduce it (guarded by a test on `PULL_SINCE_EPOCH`).

`kwenta_last_refresh` in `localStorage` records the last successful refresh. It is **display/scheduling only** (staleness chip, backup-timer skip, initial-hydration gate) and never filters a query; `readLastRefreshAt()` migrates the legacy `kwenta_last_pull` key once. Refresh triggers: app start, focus/visibility, reconnect, route change (`useRefreshOnNavigation`, rate-limited to 5s), the 5-minute backup timer, realtime events, and after every mutation.

Pushed rows are stamped `synced_at` only for ids the server reports in `applied` (migration 044). Two guards protect an offline write from the full bundle: `shouldApplyPulledRow` (never clobber a newer unsynced local row) and a refusal to apply any echo of a row **older than what this round trip pushed** (a silently dropped push must not be overwritten by the server's stale copy).

### Sync Manager Lifecycle

- `startSyncManager()` initializes on `useSync` hook mount
- Initial sync on startup
- 5-minute backup timer for eventual consistency
- Debounced trigger (400ms) after each local mutation
- Online event triggers immediate sync
- On error: exponential backoff (30s → 5 min), schedules retry

Backup sync skips if no unsynced data, no new pull data expected, and no queued notifications.

### Push Payload RLS Filtering

Before pushing, `buildPushFilterContext` determines what the user is allowed to push. Per-table rules mirror Supabase RLS:
- **profiles**: own profile OR owned local contacts
- **profile_peer_links**: `owner_user_id` is current user (anchor must be an owned local contact)
- **groups**: created by user
- **group_members**: creator of group OR the member row belongs to user
- **bills**: created by user OR member of the bill's group
- **item_splits**: `user_id` is rewritten to `linked_profile_id` immediately in Dexie during `linkProfileToRemote`; `resolveSplitUserIdForPush` provides a server-side safety net for any remaining stale rows
- **settlements**: `from/to_user_id` may be rewritten to linked account ids

### Pending Mutations (Conflict Tracking)

1. `enqueuePendingMutation` creates a `pending` record before sync
2. On success: `markPendingMutationsApplied`
3. On failure: `markPendingMutationsConflict` → creates `NotAppliedChange` record
4. Failed mutations surface as conflict notices; user can retry or dismiss

---

## Notification System (`src/lib/kwenta-notifications.ts`)

### Kinds
- `'profile_linked'` — local contact linked to their account
- `'bill_participant'` — added to a bill
- `'payment_recorded'` — payment recorded against them
- `'added_to_group'` — added to a group

### Outbox Pattern
Notifications are queued in `localStorage` (`kwenta_notification_outbox_v1`) and flushed after the mutation syncs, not during. This ensures notifications only go out after cloud data is confirmed. `flushQueuedKwentaNotifications` runs a `syncRoundTrip` first (unless `assumeCloudAck`), then inserts rows into `kwenta_notifications`.

### Recipient Resolution
`resolveRecipientProfileIdForNotify(splitUserId)` — returns the Kwenta account id to notify:
- If linked: return `linked_profile_id`
- If not local and has email: return own id
- Else: `null` (local-only contact, can't notify)

---

## People / Profile Resolution (`src/lib/people.ts`)

### Key Functions

**`resolveProfileDisplay(profileId, viewerUserId?)`** — display name + subtitle for UI
- Follows `linked_profile_id` chain
- Falls back to `resolveSharedGroupMemberFallbackIdentity` if profile is missing/deleted
- Returns `{ displayName: 'Unknown' }` as last resort

**`resolveSharedGroupMemberFallbackIdentity(viewerUserId, profileId)`** — finds a shared group to get the display_name from group_members when the profile itself isn't accessible

**`expandProfileIdsForSplitMatching(profileId, viewerUserId?)`** — returns `Set<string>` including the id, its `linked_profile_id`, all other profiles pointing to the same remote id, and (when `viewerUserId` is set) every id in the same manual peer-link cluster for that owner. Used for balance queries since split rows may use either the local or linked id. **`expandAnchorProfileIds(anchorId, viewerUserId)`** aliases the same expansion for a local anchor.

**`findRemoteProfileIdForLinking(input)`** — accepts UUID or email; looks up locally, then calls `kwenta_lookup_profile_id_by_email` RPC if needed

**`fetchRemoteProfileIntoDexie(profileId)`** — returns `Promise<boolean>`; fetches via `kwenta_fetch_profile_for_linking` RPC and upserts into Dexie (RPC allows co-members’ rows, including `is_local`, when you share a group — see migration `029`)

**`getMemberSuggestions(currentUserId, query, limit)`** — returns ranked member suggestions (local contacts + online group members) for the add-member flow

### Balance Computation Helpers

Balance between two people is a **plain signed sum**, per currency: (Σ pairwise bill shares, personal + each group) − (Σ payments). `+` = they owe me. Overpayment flips the sign — there is **no "general credit"** concept (removed 2026-07-11; the old clamp/credit apparatus and `computePairwiseNet`/`buildPersonalReconcilePlan`/`applyGeneralCreditToSelection`/`settleUpPersonalBills` are gone).

- `computePairwiseNetPersonalOnly(meId, otherId)` — personal-only net (non-group bills + personal payments), plain signed, per currency
- `computePairwiseNetBreakdown(meId, otherId)` — `{ personal, groups[], total }`; `total` = personal + Σ group pairwise nets. Powers the Person page hero + "Right now" drill-down + `computePairwiseNetAllContexts`
- `computePairwiseNetAllContexts(meId, otherId)` — the combined tab (`= breakdown.total`); People list, hero, bill status, exports all read this
- `computePairwiseNetForBill(billId, meId, otherId)` — one bill's pairwise contribution (informational; bill "settled" status is derived from the person tab via `isPersonalBillFullySettled`, not per-bill)
- `computePersonalNetRollup(meId)` / `computeCombinedNetRollup(meId)` — personal-only / combined (personal+group) totals across contacts; Home uses the combined one for its headline

**Payments:** `recordPersonPayment` (`operations.ts`) writes one atomic payment; multi-context allocations share a `bundle_id` (partition the total, never duplicate). "Settle up" = a `RecordPaymentDialog` prefilled to the full balance. The Person page statement (`buildPersonMoneyFlow` + `PersonStatement.tsx`) is the running-balance timeline (the standalone `/ledger` route is retired).

**Data repair:** decided **on the server** by `kwenta_repair_settlements(p_dry_run)` (migration `048`) — orphans, exact duplicates, and party-id canonicalization, self-scoped by `auth.uid()` over the **identity set** (account + contacts linked to it, so the scope matches what `049` delivers). Classification lives in one place, `kwenta_repair_settlement_plan`, so the dry run and the apply cannot disagree. `src/lib/kwenta-data-repair.ts` (`previewSettlementRepair` / `repairSettlementsViaServer`, surfaced in Settings via `RepairDataPanel` as check → apply) only calls the RPC and mirrors the result back via `fullSync`; it holds **no** delete authority, and it throws when the mirror fails rather than reporting a repair that never reached this device. `maybeAutoRepairData` runs it **once per session after a successful sync** (wired in `sync-manager.ts`; fire-and-forget, never throws, deduped by a module-scoped guard that `clearKwentaLocalData` releases on sign-out). The earlier client-side plan/apply judged existence from a cache that is incomplete by design and deleted real payments — see the "Deletion is server-authoritative" note under Supabase Migrations.

Two ordering rules the SQL depends on: orphan detection resolves each party through `kwenta_settlement_party_id` **before** asking whether a live profile exists (judging the literal id soft-deletes payments filed under a contact deleted from the phonebook after being linked), and every UPDATE stamps `GREATEST(now(), updated_at + 1us)` rather than a bare `now()` (the `021b` server-wins trigger returns OLD on a client clock ahead of the server, which silently voided the repair while the counts still reported success).

---

## Settlement Logic (`src/lib/settlement.ts`)

**`computeGroupBalances(groupId, currentUserId)`**
1. Sum bill payer credits and split debits
2. Apply settled settlements (adjust net)
3. Return per-member `{ userId, displayName, amount }` entries
4. Also returns suggestions via `optimizeSettlements`

**`optimizeSettlements(balances, nameMap)`** — greedy debt simplification: matches biggest receivers with biggest payers, minimizing transfer count.

**`bundle_id`** — multiple settlement rows (different recipients) can share one `bundle_id`, representing one logical payment. Used in bundled payments UI and history.

---

## Bill Split Logic (`src/lib/splits.ts`)

Split types computed at write time and stored as `computed_amount`:
- **`equal`**: floor division with remainder to first split
- **`percentage`**: `amount × (splitValue / 100)`, rounded to 2 decimal places
- **`custom`**: explicit amounts; remainder distributed evenly to unassigned rows

---

## Operations Layer (`src/db/operations.ts`)

All operations: write to Dexie in a transaction → create activity_log entry → call `notifySyncAfterMutation` (which calls `finalizeMutationSync`). IDs and timestamps are generated locally.

Key operations:
- `createBill / updateBill / deleteBill` — `createBill` accepts `paidBy` (defaults to `createdBy`); `updateBill` accepts `paidBy` patch
- `createGroup / addGroupMember / removeGroupMember / deleteGroup`
- `createSettlement / recordSettlement` (supports bundled multi-recipient)
- `linkProfileToRemote(localProfileId, remoteProfileId, actorUserId)` — sets `linked_profile_id`; rewrites `group_members.user_id`, `item_splits.user_id`, `bills.paid_by`, and `settlements.from/to_user_id` from local contact id to remote profile id; notifies remote user
- `getBillWithDetails(billId)` — returns bill + items + splits with resolved display names; uses `group_members.display_name` fallback for local contacts

---

## Auth Flow (`src/hooks/useAuth.tsx`)

`AuthProvider` wraps the app. On session change:
1. Call `ensureProfile(userId, email)`:
   - Check Dexie first
   - Try fetch remote via `kwenta_fetch_profile_for_linking` RPC
   - If remote exists: insert with `synced_at = updated_at`
   - If not: create stub (`display_name = email prefix`, `synced_at = null`)
2. Update `store.currentUserId`
3. Start sync to push stub if needed

On sign-out: clear local Dexie data (`src/lib/clear-kwenta-local.ts`), set voluntary sign-out flag (`src/lib/auth-session-flags.ts`).

---

## Supabase Migrations (`supabase/migrations/`)

Migrations are numbered; there are two `021_` files. Core RPCs:

| Migration | What it adds |
|-----------|-------------|
| `001` | All base tables + RLS policies |
| `003` | `is_local`, `linked_profile_id`, `owner_id` on profiles; personal settlements |
| `008` | `kwenta_sync` RPC (push + pull in one call); push validators per table |
| `009` | `kwenta_notifications` table + RLS |
| `012` | `kwenta_user_events` table + triggers for realtime |
| `013` | Bundle fetch RPCs: `kwenta_fetch_bill_bundle`, `kwenta_fetch_group_bundle`, `kwenta_fetch_settlement`, `kwenta_reconcile_user_event` |
| `017` | Trigger: sync `group_members.display_name` when `profiles.display_name` changes |
| `018` | Enable Realtime publication for `kwenta_notifications` |
| `021` (server wins) | Guard: server `updated_at` always wins to prevent client clock skew |
| `021` (groups pull) | Pull groups when user's *own membership row* changed (not just group row) |
| `022` | Pull group_members including own deleted rows (so removals reach removed user) |
| `023` | `bundle_id` on settlements |
| `024` | Fix group deletion propagation: pull groups/settlements using all membership rows (any `is_deleted`), not just active |
| `028` | `profile_peer_links` table + RLS; `kwenta_push_profile_peer_links`; extend `kwenta_sync` / pull bundle / `kwenta_empty_reconcile_bundle` / `kwenta_reconcile_user_event` |
| `029` | `kwenta_fetch_profile_for_linking`: also return profiles you share a group with (including `is_local`), not only non-local accounts |
| `030` | Admin hard-delete RPC (`admin_delete_user`): explicit cascade cleanup before removing auth user |
| `031` | `category` column on bills (optional text, constrained to fixed enum values) |
| `032` | `paid_by` column on bills (uuid, non-null, defaults to `created_by`); update `kwenta_push_bills` to rewrite `paid_by` to linked profile id on push |
| `033` | Fix bill deletion fanout: remove `is_deleted` filter in `kwenta_fanout_personal_bill_participants` so deletion events reach all historical split participants |
| `034` | `kwenta_on_profile_linked` trigger: when `linked_profile_id` is set on a profile, emit a `profile_changed` user event to the remote user so they immediately pull historical data |
| `046` | `settlements.method` column; thread it through `kwenta_push_settlements` (pull bundle already uses `to_jsonb`) |
| `047` | `kwenta_repair_orphan_settlements()` RPC — server-authoritative soft-delete of orphaned settlements, self-scoped by `auth.uid()` (superseded by `048`) |
| `048` | `kwenta_repair_settlements(p_dry_run)` RPC — the whole repair (orphans + exact duplicates + party canonicalization) server-side, scoped to the caller's identity set, returns counts; `p_dry_run` powers the Settings preview. Also defines `kwenta_identity_ids` and `kwenta_settlement_party_id` (linked-account **and** group-roster resolution). The client no longer decides what to delete |
| `050` | `kwenta_write_submissions` + optional `p_submission_id` on `kwenta_sync`: a replayed submission returns its original `applied` map instead of re-applying. Optional argument, so an older client still works |
| `049` | Pull follows linked profiles: personal settlements, `bills_for_sync` / `relevant_bill_ids_for_user`, `kwenta_fetch_bill_bundle` and additive `FOR SELECT` policies route by identity, so a row that missed canonicalization still reaches the right account. **Reads only** — `user_is_participant_on_personal_bill` stays literal-id because it is the `USING` clause of the `FOR ALL` policies in `007` and the `WHERE` of the push validators in `044`; widening it granted the account behind a linked contact UPDATE/DELETE over the linker's bills. The widened read predicate is the separate `user_can_read_personal_bill`. |

The `kwenta_sync` RPC is the single entry point for all sync: accepts push payload, applies it server-side, returns the pull bundle for `p_since` (the client always passes the epoch — see "Reads are always fresh"). Push validators enforce the same RLS rules the client filters apply.

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

- `/` — Public landing page (`src/landing/`)
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
| `src/sync/cloud-first-mutations.ts` | `finalizeMutationSync`, pending mutation tracking |
| `src/sync/realtime-events.ts` | Supabase Realtime subscription + event processing |
| `src/lib/people.ts` | Profile display, linking, balance helpers, member suggestions |
| `src/lib/settlement.ts` | Group balance computation, settlement suggestions, history |
| `src/lib/splits.ts` | Split amount computation (equal/percentage/custom) |
| `src/lib/kwenta-notifications.ts` | Notification outbox, senders, recipient resolution |
| `src/lib/supabase.ts` | Supabase client (PKCE auth, session persistence) |
| `src/lib/utils.ts` | `cn`, `generateId`, `getDeviceId`, `now`, `formatCurrency`, `timeAgo` |
| `src/store/app-store.ts` | Zustand: online status, sync status, runtime flags |
| `src/hooks/` | `useAuth`, `useCurrentUser`, `useSync`, `useRealtime`, `useOnlineStatus` |
| `src/pages/` | Route-level page components |
| `src/components/` | Shared UI: common dialogs, layout, notifications bell, landing |
| `supabase/migrations/` | All DB schema, RLS policies, sync RPCs |

---

## PWA

- Service worker: `src/sw.ts` (Workbox, `injectManifest`)
- Precaches all build artifacts, handles SKIP_WAITING for updates
- App name: "Kwenta — Bill Splitter", display: `standalone`, theme: `#1f2937`
- Installable on iOS/Android/desktop; works fully offline via Dexie + SW cache
