# Test coverage inventory

What each suite pins. The rules for writing tests are in `CLAUDE.md` (Testing Policy, SQL Test
Harness); keep this file current in the same change that adds or changes a suite (rule 21).

## Vitest (`npm test`)

- `tests/lib/` pure logic: `splits`, `utils` (incl. `roundMoney`/`isEffectivelyZero`/`MONEY_EPSILON`), `amount-input`, `bill-split-form` (incl. `remapLineSplits` — stored ids -> picker ids, dedupe first-row-wins; `mergeUnlistedParticipants` — appends participants the picker cannot list as `unlisted` options; `resolveBillEditIds` — the Dexie-free half of the edit-load effect shared by AddBillPage/AddBillDialog: resolves every distinct stored id once via an injected resolver and derives `billParticipants`), `bill-navigation`, `account-gate-messages`, `export-utils`, `bill-categories`, `auth-session-flags`, `runtime-flags`, `client-metrics`, `payment-method` (blank/whitespace/null all collapse to `null`, so "no method" is one value rather than four)
- `tests/lib/` DB-backed: `people` (identity expansion, participant union, canonical peers, `personalPickerIdFor` — the picker id a stored account id hydrates to), `clear-kwenta-local`, `export-csv`
- `tests/lib/settlement.test.ts` is now ONLY `buildMovementChains` — the last pure transform in that module. Everything else it covered moved into SQL with the code (053/061/064).
- `tests/lib/payment-allocation.test.ts` (was `group-payments`): BOTH split policies, which differ on whether a payment may exceed what is owed — `allocateLumpSum` caps (a group write refuses the excess), `allocatePersonPayment` does not (overpaying flips the tab; there is no credit). Plus `rebalanceCustomAmounts`, the rule that keeps the hand-typed boxes summing to the typed total: the box being edited wins and the one touched longest ago gives way, so no entry sequence can strand the difference. Before this, the per-context boxes REDEFINED the total — typing 4,000 and then splitting by hand recorded something else.
- `tests/lib/money-flow.test.ts`: the running-balance walk, plus `collapsePaymentLegs` — the legs of one bundle merge into one statement row carrying a `parts` entry per context. Pinned hard: a personal-first split no longer reports the whole payment as personal (it kept only the FIRST leg's context, so group money rendered as personal money).
- `tests/lib/` with mocked deps: `kwenta-notifications` (outbox/senders/flush/dead-letter, and the `confirmed` flag: a confirmed-only outbox flushes with no `syncRoundTrip`, a staged or legacy entry keeps it; an entry for a queued write held while it is pending and dropped when it is refused), `cloud-first-mutations` (queue-entry + "not applied" records; the deleted `finalizeMutationSync`'s behaviour is covered by `write-queue.test.ts`)
- `tests/db/`: `operations` (createBill/updateBill/deleteBill, createGroup, addGroupMember, removeGroupMember split redistribution, deletePerson redistributing only on personal bills YOU created (075), createSettlement, linkProfileToRemote id rewrites, deleteGroup cascade, getBillWithDetails). The write-path guards mock `@/api/balances` and pin how each DEGRADES when the server cannot answer: the payment cap is skipped (overpaying is legal), member removal is refused. Payment tests assert the ROWS written, not a recomputed balance — that arithmetic is SQL's. `updateSettlement`/`updateBundledPaymentDetails` pin the `method` write path: an OMITTED key preserves the stored value (a caller predating the field must not erase one someone recorded), an explicit null or blank clears it, and a bundle update reaches every ACTIVE leg.
- `tests/lib/` storage: `kwenta-storage-keys` (refresh marker + legacy-cursor migration, incl. failing storage writes)
- `tests/sync/realtime-echo.test.ts` pins that the channel subscribes to INSERTs only and that a DELETE-shaped payload (`new = {}`) makes no request and leaves the cursor alone (073's prune job). It also pins the `072` echo skip: a lone echo and a save's whole echo burst make no RPC, no round trip and no re-read; a burst with one foreign event reconciles only that one; a different (or one-microsecond-newer) version, a pre-072 payload, an unsynced or missing row, and a DELETE are never skipped; an echo that beats its write response waits for the write; a timed-out or throwing wait loses nothing (and still skips what IS mirrored); a batch whose wait outlives sign-out does nothing; the one-at-a-time and catch-up paths skip too; the membership `groups` refresh is matched by its `row.table`. `tests/db/cloud-first-write.test.ts` pins that a save registers itself for that wait while its RPC is pending. `tests/sync/in-flight-writes.test.ts` pins the wait (never throws, times out, forgets settled writes); `realtime-batch.test.ts` pins `eventRowVersion` and `sameInstant`.
- `tests/sync/sync-manager.test.ts` also pins the shared startup/activation/backup gate (`refreshIfNeeded`: queue drained first, no full bundle on a quiet returning-user open, no duplicate sync from a focus during the startup sync, a newer event requesting the realtime catch-up) and the tab-focus probe: one probe and no sync when nothing is newer; a sync for a newer event, a staged write or queued notification (without probing), no cursor, no refresh marker, a refresh at least 60 min old, or a failed realtime apply (cleared only by a SUCCESSFUL sync); the cheap checks before the Dexie scan before the network; the throttle window claimed by a probe-only activation. `user-events-probe.test.ts` pins the query shape (newest first, one row) and fail-open; `sync-service.test.ts` pins `mayHaveStagedRows` (index counts, no `toArray`) and the future-marker rule; `realtime-health.test.ts` the flag; `realtime-echo.test.ts` that a failed fallback pull or round trip marks it, and that the cursor is never stamped from the device clock (server-initialised, not written on dispose); `kwenta-storage-keys.test.ts` the cursor helpers.
- `tests/sync/`: `sync-service` helpers (`getMillisecondsSinceLastRefresh`, `hasUnsyncedLocalDataForUser` incl. the push filter mirroring 075 — someone else's personal bill, a group after removal, a deleted group's cascade for its creator, a foreign-authored log line, a linked account row, `shouldApplyPulledRow`, `compareTimestamps`); `sync-round-trip` (complete-bundle guarantees, echo guard, push stamping); `sync-manager` (navigation refresh: throttle, release, backoff isolation, monotonic clock); `pull-pagination` (PostgREST max-rows paging in the fallback path); `realtime-batch` (burst coalescing + `latestEventCreatedAt`, the server-clock cursor source)
- `tests/api/primed-reads.test.ts` + `tests/sync/write-returns-reads.test.ts`: the 066 client contract — a write asks for exactly the mounted endpoints and for nothing when no screen is up; the returned payload is served to the next read with NO request, through the endpoint's own mapper (so `numeric`-as-string still becomes a number), reported fresh rather than as a saved copy, consumed once, and discarded by the next write; a rejected write primes nothing; the mirror-refresh marker is NOT stamped on the `kwenta_write` path but IS on the `kwenta_sync` fallback; and the full fallback chain against a pre-066 and a pre-050 database
- `tests/db/cloud-first-write.test.ts`: the cloud-first write contract (accept / transport error / silent server-side drop / partial drop; rejected update and delete leave the original intact; multi-leg payment is all-or-nothing; a retry after rejection makes exactly one bill)
- `tests/sync/write-queue.test.ts`: the ordered write queue — `seq` order, head-of-line blocking and backoff on a transport failure, a lost response replayed into exactly one bill, a refusal marking the entry `conflict` and its row-sharing dependents `blocked_by_earlier`, Dismiss (refused entries only, online, refused while a pending entry shares rows) and Retry (sent before its dependents even when retried during the drain that refused it), the retry timer at `next_attempt_at`, `ignoreBackoff`, the session-epoch guard. `tests/sync/write-errors.test.ts`: `classifyWriteFailure` (`transport | rejected | inactive`; doubtful → transport, an expired token → transport, PGRST000-003 and any PGRST code on a 5xx → transport). `tests/sync/sync-manager.test.ts` pins that Refresh awaits a drain with `ignoreBackoff` before its full sync (and a throwing drain does not stop it) while the gate, a retry and `triggerSync` drain in the background. `tests/db/db-v15.test.ts`: the v14 → v15 upgrade backfill. `cloud-first-write.test.ts` also pins that a transport failure stages + queues with the same submission id and does not throw (the old "transport → throw, nothing staged" test was reversed on purpose), and `tests/helpers/cloud-sync-mock.ts` has `reject | transport | lost | inactive` modes.
- `tests/sync/session-epoch.test.ts`: a `kwenta_write` response that lands after `clearKwentaLocalData` writes nothing to Dexie (driven through `createBill` with the RPC held open).
- `tests/lib/device-owner.test.ts`: `ensureDeviceOwnedBy` per branch — same owner keeps, a different owner wipes (or asks when unsent), and with NO owner key each H1.4 rule (adopt an empty device, the same user's mirror, another user's contact linked to me; wipe for a foreign queue entry, a foreign unlinked contact, an unreferenced foreign account) plus the review H2.3 rule: a previous user's mirror whose contacts all link to me is wiped even with my row hydrated, and unsent work that is all mine is adopted despite a stray account. `tests/hooks/AuthProvider.test.tsx`: renders before the background account gate; inactive signs out keeping the copy; a transport failure stays signed in; a different user's mirror is gone before the first render; the Continue/Cancel warning; offline session mode (opens for the device owner, refreshes on reconnect, signs out when the refresh is rejected, never opens for anyone else). `tests/lib/supabase-fetch.test.ts`: the `global.fetch` wrapper signs out (local scope, status kept for the login notice) only on a 403 PostgREST 42501 error whose message starts with `kwenta_account_inactive:` — not a plain 403, the marker in another field or code, a 200 mentioning it, or a transport failure — and hands the caller the original response. `tests/pages/SettingsPage.signout.test.tsx`: sign-out and Reset local data warn about a queued write (any status) the row scan ignores, and their "sync first" paths drain the queue and keep the device when it could not be sent. Session-epoch cases beyond `session-epoch.test.ts`: `tests/sync/sync-round-trip.test.ts` (a late response writes no row, stamps no push, does not mark refreshed), `tests/api/cache.test.ts` + `tests/api/balances.test.ts` (a late response is not cached), `tests/lib/people-remote-profile.test.ts` (`fetchRemoteProfileIntoDexie`). `tests/lib/clear-kwenta-local.test.ts` also pins realtime cursors, repair stamps and queued writes being dropped. `tests/components/RefreshButton.pending.test.tsx`: the header's unsent / not-applied state from index counts against a real Dexie (no synced-table `toArray`). `tests/build/claude-md.test.ts`: this file's next migration number, Dexie version, migration rows and coverage entries.
- `tests/sync/cloud-write-idempotency.test.ts`: submission ids (replay reports the original outcome; fallback and probe-caching against a pre-`050` server)
- `tests/api/`: `cache` (per-user scoping, corrupt entries, quota failure + evict-and-retry, the 60-entry cap, `clearApiCache`). **Injecting a storage failure needs `Object.defineProperty` on the `localStorage` INSTANCE** — plain assignment is swallowed by happy-dom's proxy and `vi.spyOn(Storage.prototype, …)` is never consulted, so either one makes a "survives a failing write" test pass without the failure path running; `balances` (the RPC mappers for every endpoint — overview, contacts, person summary, groups, personal bills, recent bills — PostgREST returns `numeric` as a STRING, and a null total must be DROPPED rather than coerced to a real zero balance; cache fallback, offline, and cross-user isolation); `settlement-history` (the 064 mappers — bundled item shape, legs kept distinct from recipients, a null `groupName` becoming an ABSENT key rather than the string "null", null-vs-empty group history, that the two GUARD loaders never serve a cached answer, and that `method` survives the mapper while a MISSING key — what a pre-069 server sends — becomes `null` rather than `undefined` or `""`)
- `tests/lib/kwenta-data-repair`: the CLIENT contract only (asks, never decides; mirrors; surfaces a failed mirror), plus the auto-repair throttle: at most once per 24h per user per device (`kwenta_auto_repair_at:<userId>`), a future stamp counts as expired, a failed run does not stamp, unreadable storage runs rather than skips. The repair RULES are SQL — see below.
- `tests/lib/staged-rows`: rows this device wrote and has not pushed — the only thing that makes an offline write visible now that a list IS the server response. Pins that a staged bill is never reported `settled`, carries no pairwise nets, and reports a NULL share when the viewer is not on it; and that a confirmed row is never served from here (the endpoint stays authoritative).
- `tests/lib/local-search`: the offline fallback for global search (substring/case, email match, deletions and the viewer excluded, per-kind cap keeping the newest). Authoritative search is `kwenta_search`; this can only ever be NARROWER.
- `tests/hooks/useServerData.test.tsx`: a hook test driven by React's own `act` + `react-dom/client` (no testing-library dependency; `vitest.config.ts` sets `esbuild.jsx: 'automatic'` for it). It pins what a pure function cannot express: a subject change (`/app/people/alice` → `/bob`) clears `data`, `error` and `fromCache` so one person's balance never renders under another's name, while an invalidation TICK keeps the current data so a mutation does not blank the screen.
- `useServerData.test.tsx` also pins the cache seed: saved copy on the first render with `revalidating`, replaced by the fetch; no seed without a cache or signed-in user, never another user's entry; access loss clears the seed while a transport failure keeps it.
- `useServerData.test.tsx` also pins the screen-load counter: one pair per in-flight ONLINE fetch, released on resolve, reject, access loss, unmount and going offline; a subject change or invalidation tick mid-fetch keeps ONE pair; offline fetches never count; a page does not re-render when the counter moves. `tests/store/app-store.test.ts` pins the counter's floor at 0; `tests/hooks/useScreenLoading.test.tsx` the 200 ms continuous-load debounce and the immediate drop; `tests/components/TopLoadingBar.test.tsx` the bar (screen load past the delay, or a sync); `tests/components/RefreshButton.test.tsx` "Updating…" on the same signal — spinning, `aria-busy`, still pressable, kept out of the live region, outranked by offline and syncing — and no reserved label width below `sm`; `tests/lib/refresh-status.test.ts` the `updating` rung and the `not-applied` rung (a refused queued write: below error, above pending-upload and stale); `tests/components/SavedCopyNotice.test.tsx` that the per-page chip is gone.
- `tests/pages/SettingsPage.rename.test.tsx`: a refused rename toasts the reason and keeps the editor open with the typed name. `tests/pages/LoginPage.inactive-notice.test.tsx` + `tests/lib/account-gate-messages.test.ts` (`inactiveNoticeFromFlag`): the inactive sign-out flag carries the status, so 'unconfirmed' and 'inactive' read differently and the legacy '1' keeps the generic notice.
- `tests/app/root-route.test.tsx`: a signed-in visitor to `/` lands on `/app`; a signed-out one still sees the landing page, and neither shows while auth bootstraps.
- `tests/components/ConfirmDialog.test.tsx`: the pending state — spinner plus `pendingLabel` (default `${confirmLabel}…`), no double fire.
- `tests/sync/realtime-echo.test.ts`: `processEvent` reports whether it moved a row; an echo of rows Dexie already holds does not bump `dataVersion` (cursor still advances); a batch/catch-up bumps only when the round trip pushed or changed something; fallback pulls still bump.
- `tests/db/group-members-batch.test.ts`: `addExistingGroupMembers` is ONE submit for N members (skips active members by local or account id, dedupes picks resolving to one account, nothing to add → no submit, rejection → Dexie untouched) and `createGroup(..., memberUserIds)` lands group + creator + members atomically.
- `tests/components/BillDetailModal.test.tsx`: a failed delete toasts the error and leaves the modal open; success closes it; a bill that could not be LOADED says so ("check your connection") and never reads as "not found".
- `tests/db/bill-load-missing.test.ts`: `loadBillIntoMirror` (`src/sync/bill-mirror.ts`) fetches a bill this device has not received (`kwenta_fetch_bill_bundle`), adds only rows the device lacks (an unsynced edit is never overwritten), and distinguishes `not_found` from `unreachable`. `updateBill` refuses a bill missing locally (the edit form never loaded it — saving would overwrite real items with a blank form), `deleteBill` loads it first, both THROW for a non-creator instead of returning silently, and a cascade (`collect`) never fetches or throws.
- `tests/lib/bill-offset-notice.test.ts`: `announceBillOffset` (the post-create "offset / now even" toast, `src/lib/bill-offset-notice.ts`) returns without waiting on its fetch, so Save never blocks on it; no claim from a cached answer.
- `tests/sync/sync-round-trip.test.ts` also pins that `syncRoundTrip` bumps `dataVersion` exactly when the mirror moved (`changed > 0`) — the ONE place a changed mirror invalidates screens, whoever called the sync (repair, conflict replay, notification flush, Settings).
- `tests/components/SplitPersonSelector.test.tsx`: the second React `act` + `react-dom/client` test in the suite. Pins the `unlisted` option contract — a participant the picker cannot list (deleted contact, removed member) still renders as a muted, removable chip with a "not in contacts/group" hint, keeps its value row, drops out of the dropdown once deselected, and is excluded from "Select all".
- `tests/lib/settlement-suggestions.test.ts` also pins `coveredByOtherSettleUps` — the part of a member's "owes you" that OTHER members' settle-ups record (a cut-out middle person), shown on the Group member row and in the Settle dialog so a correct settle-up's leftover does not read as a bug. It reports only what legs carry: a cycle through the viewer rides on nobody's legs, so the copy says "of this". On the live Manila Sept numbers the member's own leg plus the covered amount equals the pairwise balance. `tests/components/GroupSettleUpDialog.test.tsx` pins the note and that a middle person is named via `suggestionPartyName` (shared with `balance-share.ts`), never shown as an id.
- `tests/lib/balance-share.test.ts` + `tests/components/SelectionExportCards.test.tsx` + `tests/hooks/useSelection.test.tsx`: the multi-select "share balances as one image" (Group detail members, People list). Group rows are the selected members' POOL balance (`memberBalances`), their `buildSuggestedPayers` transfers, and a why line — a transfer that cut out a middle person names its path via `buildMovementChains`. People rows take only VISIBLE, synced rows (a staged contact has no server balance). A cached answer is stamped "Saved copy" on the image; the selection resets on a subject change. No money is computed here.
- Remaining gaps (network-orchestration heavy, lower ROI): `realtime-events` subscriptions, `export-pdf` (jsPDF rendering).

## SQL (`npm run test:sql`, `supabase/tests/sql/`)

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
- `070_balance_endpoints_set_based` — a PERFORMANCE migration pinned for exact equality: verbatim
  copies of the replaced bodies (`test.old_*`) are compared with the new ones for every viewer and
  profile in a fixture hitting each rule (linked contact + account, manual merge, a third party's
  linked contact, payer-only bills, a member on one roster under two ids, overpayment, currencies,
  deleted/unsettled rows, a removed member, a deleted group, strangers' bills, one person holding two
  splits of DIFFERENT amounts on one item under fixed ids). Contacts are compared exactly, order
  included; only a breakdown's `groups[]` (old order undefined) goes through `test.canon`, and the
  new name-then-id order is asserted. Mutation-checked: breaking the epsilon, the roster order, the
  payer scoping, the viewer's literal id, the first-split order (either side), the settlement
  direction precedence or `ROWS 5` each fails it. The grant sweep is tested with a probe function
  granted to `anon`/`authenticated`, so that assertion can actually fail.
- `071_bills_list_set_based` — a PERFORMANCE migration pinned like 070: verbatim `test.old_*` copies
  of `relevant_bill_ids_for_user` (compared as a SET for every account — a wrong set is a leak or a
  vanished bill), `kwenta_personal_bills` (exact, order included, on distinct `created_at`; then a
  tie block compared as multisets with the new id tiebreak asserted) and `kwenta_related_profile_ids`
  (a set), plus the `kwenta_pull_rows_bills/_bill_items/_item_splits` sets that ride the predicate.
  The fixture covers a removed member keeping only the group bills they created, a third party's
  contact linked to the viewer, a deleted split, a manual merge rendering as ONE pill and a blank
  profile name, plus three bills that must stay INVISIBLE (a removed member's live split on a group
  bill; a group split under a contact linked to someone off the roster; a roster row under a contact
  linked to someone off the roster) — without them, widening the predicate passed every suite —
  and a pill that must be the VIEWER's own contact where another user's private contact sorts lower. The
  tie block uses FIXED ids inserted out of id order. Mutation-checked (12 mutations, all caught): the
  active-membership filter, both widenings above, the identity arm, the shared-bucket identity
  match, the local-contact representative (inverted or owner filter dropped), the tiebreak, the related personal arm, the
  deleted-item filter, and dropping the predicate from `bills_for_sync` / `_pull_rows_bill_items`.
- `072_event_row_version` — every row trigger's payload carries the version of the row that fired
  it, checked against the stored row (to_jsonb, so the client's string compare is exact): item and
  split events name their own table, both events of a membership change carry the member row, a
  hard DELETE carries none (the item/split triggers report op `UPDATE` even then), and recipients
  and existing keys are unchanged (a soft-deleted split still reaches its holder, 033).
- `073_client_grants_and_housekeeping` — the ALLOWLIST of functions `authenticated` may execute
  (a new client endpoint is added there on purpose), `anon` limited to the four RLS-policy helpers
  while an anon table read still evaluates its policies, a function created later starting closed,
  the housekeeping scheduler (no-op without pg_cron; with a `cron.schedule` stub it upserts exactly
  two jobs whose commands run), and Bills-list pills naming a foreign linked contact by the account
  (a low-sorting nickname contact, both ids on one bill, an unlinked contact keeping its label, a
  soft-deleted contact never mapped). Mutation-checked.
- `074_caller_scoped_rls_helpers` — the membership probe closed: the two-argument helpers are server-only, the wrappers answer only for the caller (anon: false), and no policy passes a user id. **RLS equivalence:** for eight accounts (member, creator, removed member, other-group owner, the account behind a linked contact, a stranger, and two whose only link to a bill was soft-deleted) the rows each reads from all seven tables under RLS equal the PRE-074 predicates restated verbatim and evaluated as owner; an UPDATE through an ALL policy is allowed for a member and refused for a stranger (UPDATE is re-granted inside that block's rollback, since 075 revoked direct writes); and every wrapper agrees with its helper for every account and object. The fixture includes a soft-deleted split and a split on a soft-deleted item (under the account and under a linked contact), so each filter in the copies is exercised. Mutation-checked: narrowed or widened policies, and a wrapper dropping any of its filters (removed members, identity routing, either soft-delete).
- `075_write_path_authorization` — every validator judges the STORED row: a write the caller may
  not make is absent from `applied` AND leaves the stored row byte-identical (`test.assert_refused`).
  Covers the four reported cross-account writes, a participant refused on a creator's personal
  bill (while still tagging a payment to it), an account profile that cannot be linked or re-owned
  through `kwenta_write` OR a direct `profiles` UPDATE, every frozen key column, a removed member
  refused everywhere, and — as ACCEPTED — each write shape the client produces (createBill
  personal/group, a member editing another member's group bill, roster changes, createGroup, the
  deleteGroup cascade incl. a bill-tagged payment, deletePerson with a peer link anchored on the
  contact, linkProfileToRemote's rewrites, payments, renaming yourself, replay). Plus the
  direct-write revoke. Mutation-checked: each validator reverted alone, the creator arm, the
  no-resurrect guard, the participant arm, the account-link check, the profiles trigger, both
  new-row-only liveness checks, and the participant's payment tag.
- `076_account_active_enforcement` — an inactive (and an unconfirmed) account under `as_user` reads
  0 rows from every gated table except its own profile; `kwenta_write`, `kwenta_sync` and direct
  `profiles` writes are refused with the stored rows byte-identical; active accounts and
  `auth.uid()`-NULL writers (signup, prune jobs) are unaffected; the RESTRICTIVE + `(SELECT …)`
  policy form; the pre-request hook's exemption of exactly `kwenta_my_account_status`.
- `077_profile_and_peer_link_events` — recipients (contact owner; the account and owners of live
  contacts linked to it; the peer link's owner) including the negatives (strangers, co-members,
  soft-deleted contacts, a no-op update, an account insert), the row version in the payload, and no
  `linked_profile_id` key.
- `078_kwenta_write_all_or_nothing` — a refused split stores no bill and records no submission, so
  a retry under the same id applies; an `activity_log` refusal alone does not fail the write;
  accepted writes are unchanged; `kwenta_sync` stays partial; an inactive caller's replay is
  refused.
- `069_settlement_history_method` — `method` from all three endpoints; first-non-blank across a
  bundle (and one leg losing its method not blanking the payment); unset arriving as JSON `null`
  rather than `""` or the string `"null"`; whitespace reading as unset; `064`'s guarantees intact
  incl. active-membership gating; and the rule-5 grants.
