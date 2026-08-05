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
- Coverage inventory:
  - `tests/lib/` pure logic: `splits`, `utils` (incl. `roundMoney`/`isEffectivelyZero`/`MONEY_EPSILON`), `amount-input`, `bill-split-form`, `bill-navigation`, `account-gate-messages`, `export-utils`, `bill-categories`, `auth-session-flags`, `runtime-flags`, `client-metrics`, `payment-method` (blank/whitespace/null all collapse to `null`, so "no method" is one value rather than four)
  - `tests/lib/` DB-backed: `people` (identity expansion, participant union, canonical peers), `clear-kwenta-local`, `export-csv`
  - `tests/lib/settlement.test.ts` is now ONLY `buildMovementChains` — the last pure transform in that module. Everything else it covered moved into SQL with the code (053/061/064).
  - `tests/lib/` with mocked deps: `kwenta-notifications` (outbox/senders/flush/dead-letter), `cloud-first-mutations` (pending-mutation + conflict tracking)
  - `tests/db/`: `operations` (createBill/updateBill/deleteBill, createGroup, addGroupMember, removeGroupMember split redistribution, createSettlement, linkProfileToRemote id rewrites, deleteGroup cascade, getBillWithDetails). The write-path guards mock `@/api/balances` and pin how each DEGRADES when the server cannot answer: the payment cap is skipped (overpaying is legal), member removal is refused. Payment tests assert the ROWS written, not a recomputed balance — that arithmetic is SQL's. `updateSettlement`/`updateBundledPaymentDetails` pin the `method` write path: an OMITTED key preserves the stored value (a caller predating the field must not erase one someone recorded), an explicit null or blank clears it, and a bundle update reaches every ACTIVE leg.
  - `tests/lib/` storage: `kwenta-storage-keys` (refresh marker + legacy-cursor migration, incl. failing storage writes)
  - `tests/sync/`: `sync-service` helpers (`getMillisecondsSinceLastRefresh`, `hasUnsyncedLocalDataForUser` incl. RLS push-filter, `shouldApplyPulledRow`, `compareTimestamps`); `sync-round-trip` (complete-bundle guarantees, echo guard, push stamping); `sync-manager` (navigation refresh: throttle, release, backoff isolation, monotonic clock); `pull-pagination` (PostgREST max-rows paging in the fallback path); `realtime-batch` (burst coalescing + `latestEventCreatedAt`, the server-clock cursor source)
  - `tests/api/primed-reads.test.ts` + `tests/sync/write-returns-reads.test.ts`: the 066 client contract — a write asks for exactly the mounted endpoints and for nothing when no screen is up; the returned payload is served to the next read with NO request, through the endpoint's own mapper (so `numeric`-as-string still becomes a number), reported fresh rather than as a saved copy, consumed once, and discarded by the next write; a rejected write primes nothing; the mirror-refresh marker is NOT stamped on the `kwenta_write` path but IS on the `kwenta_sync` fallback; and the full fallback chain against a pre-066 and a pre-050 database
  - `tests/db/cloud-first-write.test.ts`: the cloud-first write contract (accept / transport error / silent server-side drop / partial drop; rejected update and delete leave the original intact; multi-leg payment is all-or-nothing; a retry after rejection makes exactly one bill)
  - `tests/sync/cloud-write-idempotency.test.ts`: submission ids (replay reports the original outcome; fallback and probe-caching against a pre-`050` server)
  - `tests/api/`: `cache` (per-user scoping, corrupt entries, quota failure + evict-and-retry, the 60-entry cap, `clearApiCache`). **Injecting a storage failure needs `Object.defineProperty` on the `localStorage` INSTANCE** — plain assignment is swallowed by happy-dom's proxy and `vi.spyOn(Storage.prototype, …)` is never consulted, so either one makes a "survives a failing write" test pass without the failure path running; `balances` (the RPC mappers for every endpoint — overview, contacts, person summary, groups, personal bills, recent bills — PostgREST returns `numeric` as a STRING, and a null total must be DROPPED rather than coerced to a real zero balance; cache fallback, offline, and cross-user isolation); `settlement-history` (the 064 mappers — bundled item shape, legs kept distinct from recipients, a null `groupName` becoming an ABSENT key rather than the string "null", null-vs-empty group history, that the two GUARD loaders never serve a cached answer, and that `method` survives the mapper while a MISSING key — what a pre-069 server sends — becomes `null` rather than `undefined` or `""`)
  - `tests/lib/kwenta-data-repair`: the CLIENT contract only (asks, never decides; mirrors; surfaces a failed mirror). The repair RULES are SQL — see below.
  - `tests/lib/staged-rows`: rows this device wrote and has not pushed — the only thing that makes an offline write visible now that a list IS the server response. Pins that a staged bill is never reported `settled`, carries no pairwise nets, and reports a NULL share when the viewer is not on it; and that a confirmed row is never served from here (the endpoint stays authoritative).
  - `tests/lib/local-search`: the offline fallback for global search (substring/case, email match, deletions and the viewer excluded, per-kind cap keeping the newest). Authoritative search is `kwenta_search`; this can only ever be NARROWER.
  - `tests/hooks/useServerData.test.tsx`: **the one hook test in the suite**, driven by React's own `act` + `react-dom/client` (no testing-library dependency; `vitest.config.ts` sets `esbuild.jsx: 'automatic'` for it). It pins what a pure function cannot express: a subject change (`/app/people/alice` → `/bob`) clears `data`, `error` and `fromCache` so one person's balance never renders under another's name, while an invalidation TICK keeps the current data so a mutation does not blank the screen.
  - Remaining gaps (network-orchestration heavy, lower ROI): `realtime-events` subscriptions, `export-pdf` (jsPDF rendering).
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
  the survivor tiebreak is `created_at`) must insert the rows directly.
- `test.as_user(uid)` sets `auth.uid()` **and** drops to the `authenticated` role so RLS applies.
  Fixture setup runs as the owner, where RLS does not — **a test that forgets `as_user` proves
  nothing about RLS.** The helper schema is granted to `authenticated` at the end of
  `001_test_helpers.sql`; without that the first `assert_*` after `as_user` dies with "permission
  denied for schema test", which is why the pre-`058` suites all set `request.jwt.claim.sub` alone
  and stayed the owner (auth.uid() set, RLS off, missing GRANTs undetectable).

SQL coverage so far (`supabase/tests/sql/`):
- `051_pull_row_functions` — the extracted row functions reproduce the 049 bundle exactly (pinned
  against a verbatim copy of the old body, three accounts, plus a future `p_since`); foreign local
  contacts / groups / bills stay out; 049's linked-contact exception still delivers; no
  `kwenta_pull_rows_*` is executable by `authenticated`.
- `052_money_identity_and_personal_net` — `kwenta_round_money` JS tie semantics incl. the negative
  half; identity expansion (forward link, siblings, reverse, soft-delete, missing profile,
  transitive+undirected+viewer-scoped peer clusters); personal pairwise net (sign, mirror,
  payment, overpayment flip, per-currency isolation, soft-deleted and unsettled exclusion,
  contact-id ↔ account-id routing, and **one split per side per item** so a linked duplicate
  counts once).
- `053_money_group_net_and_breakdown` — group pairwise net (sign, mirror, settled payment, zero
  rows for settled members, self-exclusion, currency drop vs empty-currency match, unsettled,
  deleted group, removed members keeping their roster name); the breakdown reconciling
  `total = personal + Σ groups` with effectively-zero groups omitted; `kwenta_person_summary`
  answering for `auth.uid()` and refusing an unauthenticated caller. **The invariant:** a
  viewer-private `profile_peer_links` merge never moves a shared group ledger — including when
  the viewer merges themselves with another member and those members then transact without them.
- `054_money_contacts_and_rollups` — contact discovery and canonical peers (a linked contact and
  its account collapse to one row; settlement-only counterparties surface; no cross-account
  leakage); the roster display-name fallback; and the Home rollups (personal vs combined buckets,
  per-person netting BEFORE bucketing, effectively-zero bucketed nowhere).
  Includes the `055` fix: a manual merge collapses to ONE peer, transitive chains included, and
  the rollup no longer double-counts.
- `056_bill_settled_and_search` — the per-bill settled flag (derived from the PERSON-level tab,
  scoped to the bill's own currency; missing/deleted/solo bills are settled; epsilon boundary at
  half a cent; an unreadable bill returns null rather than a status that proves it exists) and
  global search (caller-scoped, case-insensitive, LIKE-wildcard-safe).
- `063_person_summary_group_pool_net` — the pairwise-vs-pool divergence on one leg (identical in
  a two-member group, different the moment a third member exists), 053's keys and totals
  preserved, settled groups still dropped, roster-resolved identity, and `kwenta_group_pool_net`
  not being client-callable.
- `062_person_statement` — event shape per context, payment phrasing and sign, and above all the
  RECONCILIATION invariant asserted against `kwenta_person_summary` (across personal + two groups
  + a payment, in the peer-linked duplicate case, and per currency). Plus exclusions: third-party
  payers, non-shared groups, deleted bills, unsettled payments, off-currency group bills, and
  chronological ordering.
- `061_group_detail` — shape and roster order, active-membership gating (non-member and former
  member both get null), deleted groups, the pairwise-vs-pool distinction (a member invisible to
  the viewer pairwise is still down against the pool), pool balances summing to zero, settled
  members staying on the roster at zero, the rawDebts edges (splits plus REVERSED settlement
  edges), currency drop, and removed members keeping their roster name.
- `060_bill_detail` — bill pairwise (sign, mirror, bill-tagged vs untagged payments, deleted
  bills, and the duplicated-identity-charged-once case) and the detail payload (own share,
  counterparties, self excluded, square parties omitted, `squareOverall` following the person tab
  and staying currency-scoped, roster names incl. removed members, unreadable → null).
- `059_list_pages` — group list rows (roster count, viewer standing, membership scoping, caller
  scoping) and the personal-bill buckets. Pinned hard: a bill is in **exactly one** bucket and
  never both; the shared bucket reaches a split filed under a linked contact; and one person is
  **one** participant pill whether they hold a contact id, an account id, or a manual merge.
  Includes the both-directions-nonzero group case ported here when
  `computeAllGroupPairwiseBalances` was deleted — a single net scalar per group cannot express it.
- `058_home_rollups_and_recent_bills` — the Home page's group bucket and its recent-bills list.
  The load-bearing case: the group bucket is **not** `combined - personal` (combined nets a person
  across personal and group before choosing a side), so it had to be ported rather than derived on
  the client. Also covers membership scoping (exact viewer id, active memberships only, deleted
  groups out) and `kwenta_recent_bills` (viewer-paid only, newest first, the cap keeps the newest,
  deletions honoured, caller-scoped).
- `057_contacts_subtitle` — the "Linked · <account>" / "Local contact" line the People page
  renders. Note `profiles.linked_profile_id` has a FK, so a dangling link cannot exist
  server-side: the client's "Loading their profile…" state is a SYNC phenomenon.
- `064_settlement_history_and_group_math` — the bundle rules that the UI depends on and that a
  Dexie iteration order could never make deterministic: a bundle is ONE item with MANY legs;
  `recipients` collapses by recipient while `legs` keeps every row (the input to
  `buildMovementChains`); a ONE-recipient bundle is NOT bundled ("You paid 1 people"); bill
  attribution only when every row agrees; first non-blank label wins; "Added by" from the activity
  log. Plus roster-first names across the privacy boundary, active-membership gating (a former
  member is still SENT the rows by 024 and must still be refused), the person list staying per-leg
  and identity-expanded, currency-scoped spending, breakdown signs with the subject-need-not-be-
  active case, and the owed cap in both directions.
- `066_write_returns_reads` — the echo carries this submission's rows and NOT the caller's other
  bills (an echo is not a second pull bundle); `reads` already contains the bill just written and
  the overview total it moved; an unknown or refused read is dropped without failing the write; a
  replayed submission applies once but recomputes its reads; the push validators still refuse
  another user's contact so it can be neither stored nor echoed; and the 065-style grant sweep.
- `055_fix_merged_contact_double_count` — merging two contacts as the same person used to double
  the Home headline (one 100 bill split evenly showed 100 owed instead of 50). Canonical peers are
  now grouped on the whole identity **cluster** rather than resolved one hop at a time; one-hop
  resolution cannot collapse `a1<->a2<->a3`. Fixed in SQL **and** in `iterCanonicalPeerIds`
  (`src/lib/people.ts`) in the same change, so both implementations agree during the migration —
  covered by `tests/lib/people.test.ts` on the TS side.
- `065_list_settled_map_and_payor_names` — the four read-path defects the 051–064 review found
  (shared-bucket `payorName`, the set-wise settled map agreeing bill-for-bill with
  `kwenta_bill_settled`, `mySplitTotal` NULL-vs-zero, `category` on statement events), plus the
  **security** sweep and its two reproduced exploits: an authenticated caller could read another
  user's bundle via `kwenta_build_pull_bundle` and forge rows authored by them via
  `kwenta_push_*`. The sweep is generic on purpose — it catches the next viewer-argument function
  someone grants, which prose could not.
- `067_close_identity_cluster` — the duplicate-People bug: a contact merged to an account where a
  THIRD user also keeps a contact linked to that account. Asserts the property, not just the
  cases: **y ∈ expand(x) implies expand(y) = expand(x)**, which is what `kwenta_canonical_peer_ids`
  keying on `MIN(cluster)` silently assumes. Plus the preserved invariants (soft-deleted contact
  out from BOTH ends, missing profile → itself, peer links viewer-scoped and skipped when the
  viewer is NULL) and the rule-5 grants. **The id ordering is forced on purpose:** the key is the
  minimum of the cluster, so the two walks only diverge when the id the short walk misses is the
  smallest — with random fixture uuids this test would otherwise pass against the broken body
  about two runs in three, so the third party's contact is pinned to a low uuid and a precondition
  assertion fails loudly if that ever stops holding.
- `068_collapse_legacy_credit_settlements` — the one-time sweep. Before/after EQUALITY of
  `kwenta_person_summary`, `kwenta_group_detail` (rawDebts compared as a set — it has no stable
  order) and `kwenta_bill_settled_for_me`; the survivor keeping the OLDEST `created_at` (the
  original payment date); a group row changed in label ONLY; a plain payment left byte-identical;
  the label→method step incl. the ambiguous labels it must NOT touch; idempotence (a second run
  must not double the survivor); and **each of the four skip guards firing**, the load-bearing one
  being a two-recipient bundle that would otherwise move 70 from Cha to Bob. **Fixture rows are
  inserted directly, not via `test.new_settlement`:** the family key is `updated_at` (shared) while
  the survivor tiebreak is `created_at` (staggered), and the fixture ties the two together — with
  both equal the "oldest" row falls through to a random uuid and the test passes half the time.
  The skip blocks run LAST because skipped rows stay in scope for later blocks.
- `069_settlement_history_method` — `method` from all three endpoints; first-non-blank across a
  bundle (and one leg losing its method not blanking the payment); unset arriving as JSON `null`
  rather than `""` or the string `"null"`; whitespace reading as unset; `064`'s guarantees intact
  incl. active-membership gating; and the rule-5 grants.

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
  → operations.ts (write Dexie + set synced_at = null)
  → notifySyncAfterMutation → finalizeMutationSync
  → syncRoundTrip (kwenta_sync RPC: push unsynced + pull changed)
  → Dexie updated with server response
  → bumpDataVersion → useServerData re-fetches → UI re-renders
```

Realtime path (another device/user changes something):
```
DB trigger → kwenta_user_events → Supabase Realtime
  → realtime-events.ts processes event
  → fetch bundle RPC (bill/group/settlement)
  → upsert into Dexie → bumpDataVersion → useServerData re-fetches
```

That last `bumpDataVersion` is load-bearing and was missing: screens read SQL endpoints, not
Dexie, so upserting a bundle changes nothing they observe. `notifyServerDataChanged()` fires once
per applied unit of work — one event (`processEventSafely`), one coalesced batch, or one bulk
catch-up — never per upserted row, since each bump costs every mounted screen a round trip.

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

What is left in TypeScript is pure transforms of bounded input, each with its Vitest coverage:
`computeSplits`, `buildSuggestedPayers` (`settlement-suggestions.ts`), `buildMovementChains`
(`settlement.ts`), `buildMoneyFlowRows` (`money-flow.ts`), `roundMoney`/`isEffectivelyZero`.

### Reads are always fresh (no pull cursor)

**Every pull requests the COMPLETE bundle** — `p_since` is always `PULL_SINCE_EPOCH` (`sync-service.ts`), never a stored timestamp. The cloud is the truth and Dexie is a mirror of it; a complete bundle is a true snapshot because nothing is ever hard-deleted (soft-deleted rows are still sent), so absence from the bundle means nothing and no local pruning exists.

The old incremental cursor (`kwenta_last_pull`) was stamped from the **device clock** after the query ran, so clock skew or a row written mid-round-trip was skipped permanently, and any server-side change that did not bump the client-written `updated_at` could never reach a device — the only cure was wiping local data. Do not reintroduce it (guarded by a test on `PULL_SINCE_EPOCH`).

`kwenta_last_refresh` in `localStorage` records the last successful refresh. It is **display/scheduling only** (staleness chip, backup-timer skip, initial-hydration gate) and never filters a query; `readLastRefreshAt()` migrates the legacy `kwenta_last_pull` key once. Mirror-refresh triggers: app start, tab activation (one handler for `focus` + `visibilitychange`, rate-limited to 5s), reconnect, the 5-minute backup timer, realtime events, and an offline write replaying.

**Route changes do NOT sync** *(removed 2026-08-04)*. Opening a screen fetches that screen's own scoped endpoint, which IS server truth (rule 7), so pulling the whole bundle per route change bought nothing and cost 213 kB a tap. A write no longer refreshes the mirror either: `kwenta_write` (066) returns only its own rows and deliberately does not stamp `kwenta_last_refresh`.

**`dataVersion` is bumped only when a sync actually moved something** — `pushed > 0 || changed > 0`, where `changed` counts rows written to Dexie. Bumping unconditionally made every mounted screen fetch on mount and then again when the concurrent sync resolved: the duplicated request pairs. `pulled` cannot gate it, because every bundle is complete and so is large on a round trip that changed nothing.

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

**`expandProfileIdsForSplitMatching(profileId, viewerUserId?)`** — returns `Set<string>`: the connected component of `profileId` over `linked_profile_id` edges (both directions) plus, when `viewerUserId` is set, that owner's `profile_peer_links` merges. Split rows may use either the local or linked id. **Both edge kinds are closed over together** — following one from the anchor only made the answer depend on the starting id, which is the duplicate-People bug (migration `067`). The invariant: `y ∈ expand(x)` implies `expand(y) = expand(x)`, which is what keying a person by `MIN(cluster)` assumes. The SQL twin is `kwenta_expand_identity` (052, closed in `067`); the two must agree.

**`findRemoteProfileIdForLinking(input)`** — accepts UUID or email; looks up locally, then calls `kwenta_lookup_profile_id_by_email` RPC if needed

**`fetchRemoteProfileIntoDexie(profileId)`** — returns `Promise<boolean>`; fetches via `kwenta_fetch_profile_for_linking` RPC and upserts into Dexie (RPC allows co-members’ rows, including `is_local`, when you share a group — see migration `029`)

**`listCanonicalRelatedProfileIds(meId)`** — the contact picker's phonebook: one row per real
person, deduped across local contact, linked account and manual merges. Deliberately still LOCAL
— a local contact exists only on the device that created it, and picking who to split with has to
work offline because creating a bill does. Its SQL twin is `kwenta_canonical_peer_ids` (054/055);
the two must agree, and `tests/lib/people.test.ts` plus `055`'s suite keep them honest.

### Balance Computation

Balance between two people is a **plain signed sum**, per currency: (Σ pairwise bill shares,
personal + each group) − (Σ payments). `+` = they owe me. Overpayment flips the sign — there is
**no "general credit"** concept (removed 2026-07-11).

**This arithmetic lives in SQL only** — see the migrations table. The client fetches numbers; it
does not derive them.

**Exports are handed the screen's payload, never a recomputation.** `exportBillsToCSV`,
`exportGroupToCSV`, `exportPersonToCSV`, `generateBillsPDF`, `generateGroupPDF`,
`generateBillDetailPDF` and `generatePersonPDF` all take the server data the page already holds.
An export that recomputed its own money could disagree with the screen it was exported from —
and did, once reads became server-side. Descriptive rows (item names, per-member share matrices)
still come from the local mirror: those are records, not derived money.

**Statement:** the Person page timeline is server events (`062`) walked by `buildMoneyFlowRows`
(`src/lib/money-flow.ts`). Its last running number must equal the hero — pinned in SQL, not TS.

**Payments:** `recordPersonPayment` (`operations.ts`) writes one atomic payment; multi-context allocations share a `bundle_id` (partition the total, never duplicate). "Settle up" = a `RecordPaymentDialog` prefilled to the full balance. The Person page statement (`buildPersonMoneyFlow` + `PersonStatement.tsx`) is the running-balance timeline (the standalone `/ledger` route is retired).

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
`paymentsByLegId` map the page already builds for editability.

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
| `051` | **One source of truth for visibility.** Lifts each table's row set out of `kwenta_build_pull_bundle` into `kwenta_pull_rows_<table>(p_since, uid)`; the bundle becomes a thin wrapper over them. Pure refactor — pinned against a verbatim copy of the 049 body in `supabase/tests/sql/051_pull_row_functions.test.sql`. **Every read endpoint must select from these functions and must not inline a `WHERE` over a base table** — these predicates are the privacy boundary, and twelve endpoints with twelve copies is twelve chances to leak. Not granted to `authenticated`: they take `uid` as an argument, so a client-callable version would let any user read any other user's rows |
| `058` | `kwenta_balances_overview` gains `groupReceive`/`groupPay` (additive keys — an older client ignores them) and `kwenta_recent_bills` replaces the Home page's Dexie bill query. The group bucket is bucketed **per group** and is not derivable from the other two buckets; see the header |
| `059` | `kwenta_groups_with_balances` + `kwenta_personal_bills` — the Groups and Bills lists as one call each. Two deliberate departures from the TS they replace (both in the header): the participant representative is picked by lowest id rather than by Dexie iteration order, and the "shared with me" bucket is identity-routed rather than literal-id. Neither list carries a per-row `pending` flag — that is a fact about one device, so the client merges its own unsent ids |
| `060` | `kwenta_bill_detail` — the Bill detail screen in one call (bill, items, splits with roster-first names, the viewer's own share, one row per counterparty). Adds `kwenta_bill_pairwise` (per-item FIRST match per side, so a duplicated identity is charged once) and `kwenta_bill_participant_name`. `squareOverall` comes from the PERSON tab, currency-scoped, because a bill-tagged payment is the exception rather than the rule (only `RecordSettlementDialog` sets `settlements.bill_id`), so a per-bill net usually cannot reach zero on its own. **`kwenta_bill_pairwise` DOES read `settlements.bill_id`** — it is the one money function that does, which is why clearing that column in `068` changes this screen and nothing else. The bill's settlement HISTORY list is deliberately not included; those are records, not derived money |
| `061` | `kwenta_group_detail` — the Group detail screen in one call. Returns AGGREGATES, not suggestions: the settle-up decomposition stays in TypeScript (`buildSuggestedPayers`, rule 8), so the endpoint hands back the directed debt graph. Two balance views that are NOT the same quantity: `pairwise` (what each member owes the viewer) and `memberBalances` (each member against the group pool). Gated on ACTIVE membership — the pull bundle still delivers rows to former members by design (`024`), so absence from the bundle cannot be the check |
| `062` | `kwenta_person_statement` — the Person page statement's EVENTS. The running-balance walk stays in TypeScript (`buildMoneyFlowRows`, rule 8). The invariant the header exists for: per currency the event deltas SUM to `kwenta_person_summary`'s total, because that total is the hero on the same screen. Personal bills take ONE split per side per item (expanded ids); group bills SUM every matching split (exact ids) — the same asymmetry as `052`/`053` |
| `063` | `kwenta_person_summary` group legs gain `theirNet` — that person's net against the group POOL, which is NOT the leg's pairwise `net`. The Person export card asks the pool question ("receives"/"pays" in this group); with a third member the two diverge (Bob fronting 90 for three is +60 to the pool but only +30 against you). Adds server-internal `kwenta_group_pool_net` |
| `064` | **The last client-side money.** `kwenta_{bill,group,person}_settlement_history` (payment history, replacing three Dexie scans — one of which read the entire `settlements` table), `kwenta_group_spending` (the Total Spending pie; now currency-scoped, where the client version summed every currency and labelled it with the group's), `kwenta_group_member_breakdown` and `kwenta_owed_in_group`. The last two feed the two write-path guards, which stay CLIENT-side policy on purpose — see the header: `enforceCap` is opt-in because personal overpayment is legal, and the removal check is opt-out via `force` for the `deletePerson` cascade, so an unconditional server rule would break both, and one keyed off a client-supplied flag would not be enforcement. Internal helpers `kwenta_settlement_history_build`, `kwenta_settlement_party_name`, `kwenta_is_active_group_member` are not granted to `authenticated` |
| `065` | **Apply first — it closes a live privacy hole.** `kwenta_build_pull_bundle` was never REVOKEd from PUBLIC and the `kwenta_push_*` validators were granted to `authenticated`; all take the acting user as an argument, so any signed-in client could read another user's profile/contacts/groups/settlements and write rows attributed to them (both reproduced in the 065 suite). Also: `payorName` in the shared bill bucket resolves through `kwenta_peer_display_name` instead of a pull-rows join that can never see another account (every shared row read "Paid by Someone"); `kwenta_bills_settled_map` computes each counterparty's tab ONCE for a whole list instead of once per bill (`kwenta_bill_settled` kept unchanged as the single-bill answer); `kwenta_bill_detail.mySplitTotal` is NULL again when the viewer holds no split, not `0`; `kwenta_person_statement` events carry `category` |
| `066` | **A write stops downloading the dataset, and answers the screen.** `kwenta_sync` did two unrelated jobs — apply a push, and return the caller's complete row set — so saving a bill pulled ~213 kB to confirm one row, and the screen then fetched AGAIN because the balance a write moves is computed in SQL and is not derivable from the echoed rows. `kwenta_write(p_push, p_submission_id, p_reads)` returns the same envelope (nine table keys + `applied`, so the client's confirm/mirror loop is unchanged) carrying ONLY this submission's rows, read back through `kwenta_pull_rows_*`, plus `reads`: the payloads for the endpoints the caller named, recomputed AFTER the push in the same transaction. `kwenta_read` is the dispatch — a **whitelist**, because a client that could name any function would have a remote procedure call primitive; it is SECURITY INVOKER and adds no authority. `kwenta_write_echo` takes the acting user as an argument and is service_role only (rule 5). A failing or non-whitelisted read is dropped, never fatal to the write. Replay returns the stored `applied` but RECOMPUTES `reads` — a read is a view of current state, not an outcome |
| `067` | **One human, two People rows, permanently.** `kwenta_expand_identity` (052) walks two kinds of edge — `profiles.linked_profile_id` (plus siblings and reverse) and the viewer's `profile_peer_links` merges — but only ever CLOSED over the second: the profile-link arms sat in the non-recursive `seed` block, so they applied to the ANCHOR and nothing else. A cluster reachable by MIXING both kinds therefore depended on where you started, so `expand(contact) = {contact, account}` while `expand(account)` also reached another user's contact linked to that same account. `kwenta_canonical_peer_ids` keys a person by `MIN(expand(id))`, which is only a stable key if expand() is closed — two sets meant two keys meant two rows. Now one recursive closure over both edge kinds. **It moves money** (this function backs split/settlement matching): a widening, but every id it adds was already reachable from the other end, so it makes the two ends agree rather than inventing a relationship. 055 fixed the same CLASS of bug for one-hop resolution and left the mixed-edge case open. The TS twin `expandProfileIdsForSplitMatching` had the identical asymmetry and is fixed with it |
| `068` | **72 settlement rows that were really 14 payments.** The removed "apply general credit" / "pay from available credit" features wrote one row PER BILL a credit touched, plus mutual "offset" legs that cancel. Balances were never wrong (every endpoint sums the rows and the split was conservative); the HISTORY was unreadable. `kwenta_collapse_legacy_credit_settlements(p_dry_run)` collapses each family to its oldest row carrying the total, drops the cancelling offset legs, and blanks the label; **group-tagged rows are relabelled only** — a shared ledger is not rewritten by a sweep no other member asked for. Four guards refuse a whole family rather than guess (multi-recipient bundle, non-cancelling offsets, offset-only, bundle spanning both ledgers), and a before/after signed-sum post-condition ABORTS the transaction if money would move. Also moves method-like labels (`Cash`/`GCash`/`GoTyme`/`BDO`, exact matches) into `method`. **The one visible change:** clearing `bill_id` moves `kwenta_bill_pairwise`, so per-counterparty amounts inside Bill detail change on affected bills — intended, and asserted in the suite. service_role only (a global sweep, rule 5); backup table is RLS-enabled and REVOKEd from `anon`/`authenticated`, which the shim cannot prove — check on a branch DB |
| `069` | `method` reaches the settlement-history payload. The column existed from `046` and `RecordPaymentDialog` wrote it, but no read path returned it, so a saved method was unreachable forever — which is why production labels held `GCash`/`GoTyme`/`BDO`. Only `kwenta_settlement_history_build` and `kwenta_person_settlement_history` change; the bill and group endpoints just delegate and inherit it. A bundle resolves to ONE method by the same first-non-blank rule `label` uses. Apply before or with the client |
| `049` | Pull follows linked profiles: personal settlements, `bills_for_sync` / `relevant_bill_ids_for_user`, `kwenta_fetch_bill_bundle` and additive `FOR SELECT` policies route by identity, so a row that missed canonicalization still reaches the right account. **Reads only** — `user_is_participant_on_personal_bill` stays literal-id because it is the `USING` clause of the `FOR ALL` policies in `007` and the `WHERE` of the push validators in `044`; widening it granted the account behind a linked contact UPDATE/DELETE over the linker's bills. The widened read predicate is the separate `user_can_read_personal_bill`. |

**Two write RPCs, one set of validators.** `kwenta_write` (066) is the mutation path: it applies the push and returns ONLY the rows it stored plus the recomputed payloads for the screens that were on display. `kwenta_sync` is the mirror-refresh and offline-replay path, and the fallback for a database without 066: it applies the push and returns the complete pull bundle for `p_since` (the client always passes the epoch — see "Reads are always fresh"). Both go through the same `kwenta_push_*` validators, which enforce the same RLS rules the client filters apply.

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
3. **Migrations are append-only.** Next number: **`070`**. Never edit a past migration.
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
   pinned by a generic sweep in `065`'s suite. The money helpers in 052–054/057/063 read base
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
   `group-payments.ts`, `roundMoney`/`isEffectivelyZero`). Exactly one implementation of any
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
    the Dexie version, the coverage inventory, and a note for any new user-facing behaviour.
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
