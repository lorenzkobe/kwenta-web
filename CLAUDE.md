# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript check + Vite production build
npm run lint       # Run ESLint
npm run preview    # Preview production build locally
```

No test suite is configured.

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

**Group bills**: collaborative — any member can add expenses attributed to whoever paid. If someone outside this user's Kwenta paid for something, they record it on their own account.

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

For authenticated users every write is **cloud-first**:
1. Write to Dexie immediately (local)
2. Call `finalizeMutationSync` (`src/sync/cloud-first-mutations.ts`)
3. `finalizeMutationSync` calls `syncRoundTrip` — a single RPC to `kwenta_sync` that pushes all unsynced local rows and returns the pull bundle
4. Pull bundle is applied back into Dexie
5. If sync fails: mutation is recorded in `pending_mutations` as a conflict

Cloud-first covers only the **write path**. The UI always reads from Dexie. Dexie is the source of truth; the cloud is kept in sync with it.

**Guests** (unauthenticated): Dexie only, no sync.

### Pull Bundle Scope — Critical Privacy Boundary

`kwenta_build_pull_bundle` controls what each user receives on pull. Profiles are scoped:
```sql
WHERE p.id = uid OR (p.is_local IS TRUE AND p.owner_id = uid)
```
A user **never** receives another user's local contacts, even when sharing a group. This is intentional.

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

`membershipUserIdForProfile(p)` (`src/db/operations.ts:44`) returns `p.linked_profile_id ?? p.id` — rewrites `group_members.user_id` to the remote UUID when a contact is linked, so Postgres RLS and sync match `auth.uid()`. Split rows may reference either the local id or the remote id; `expandProfileIdsForSplitMatching` (`src/lib/people.ts`) builds the full set for balance queries.

### Realtime Subscriptions

**`kwenta_notifications`** — `NotificationsBell.tsx` subscribes via `postgres_changes`.
- Subscription deps must be `[userId, isOnline]` only — never include `loadList` or other callbacks, as this tears down and recreates the channel on every reference change, causing missed INSERT events
- Use a `loadListRef` ref to call the latest `loadList` in error-recovery paths
- Fresh unread count is loaded via a dedicated `useEffect([isOnline, userId])` on mount, not from the SUBSCRIBED callback

**`kwenta_user_events`** — `realtime-events.ts` subscribes for entity change events.
- On event: call targeted bundle fetch RPC (bill/group/settlement)
- On reconnect: catch up via `catchUpSince` from last-seen event id (localStorage)
- `realtimeCatchupSingleRun` flag deduplicates concurrent catch-ups
- `targetedRealtimeReconcile` flag: use `kwenta_reconcile_user_event` RPC instead of full pull

---

## Dexie Schema (`src/db/db.ts`)

Current version: **6**. All tables extend sync fields: `id` (UUID PK), `created_at`, `updated_at`, `synced_at` (null = unsynced), `is_deleted`, `device_id`.

| Table | Indexes | Purpose |
|-------|---------|---------|
| `profiles` | `id, email, owner_id, linked_profile_id, synced_at, is_deleted` | User accounts + local contacts |
| `groups` | `id, created_by, invite_code, synced_at, is_deleted` | Expense groups |
| `group_members` | `id, group_id, user_id, [group_id+user_id], synced_at, is_deleted` | Memberships; composite index prevents duplicates; stores `display_name` |
| `bills` | `id, group_id, created_by, created_at, synced_at, is_deleted` | Expense records |
| `bill_items` | `id, bill_id, synced_at, is_deleted` | Line items within a bill |
| `item_splits` | `id, item_id, user_id, synced_at, is_deleted` | Per-person allocations; `split_type`, `split_value`, `computed_amount` |
| `settlements` | `id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted` | Payments; `bundle_id` groups multiple recipients into one logical payment |
| `activity_log` | `id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted` | Audit trail |
| `pending_mutations` | `id, actor_user_id, status, entity_type, entity_id, created_at, updated_at` | Cloud-first conflict tracking |
| `not_applied_changes` | `id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, pending_mutation_id` | Failed mutations surfaced to user |

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

Last pull timestamp stored in `localStorage` as `kwenta_last_pull` (ISO string). Passed as `p_since` to `kwenta_sync`; only rows with `updated_at > p_since` are returned.

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
- **groups**: created by user
- **group_members**: creator of group OR the member row belongs to user
- **bills**: created by user OR member of the bill's group
- **item_splits**: `user_id` may be rewritten to `linked_profile_id` via `resolveSplitUserIdForPush`
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

**`expandProfileIdsForSplitMatching(profileId)`** — returns `Set<string>` including the id, its `linked_profile_id`, and all other profiles pointing to the same remote id. Used for balance queries since split rows may use either the local or linked id.

**`findRemoteProfileIdForLinking(input)`** — accepts UUID or email; looks up locally, then calls `kwenta_lookup_profile_id_by_email` RPC if needed

**`fetchRemoteProfileIntoDexie(profileId)`** — fetches a remote profile via `kwenta_fetch_profile_for_linking` RPC and upserts into Dexie

**`getMemberSuggestions(currentUserId, query, limit)`** — returns ranked member suggestions (local contacts + online group members) for the add-member flow

### Balance Computation Helpers

- `computePairwiseNet(meId, otherId)` — net owed between two users across all shared bills and settled payments, keyed by currency
- `computePairwiseNetForBill(billId, meId, otherId)` — same but scoped to one bill
- `computePersonalNetRollup(meId)` — totals across all contacts
- `buildPersonalBillAllocationPlan(params)` — Phase B: determines which bills a payment should settle and in what amounts

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
- `createBill / updateBill / deleteBill`
- `createGroup / addGroupMember / removeGroupMember / deleteGroup`
- `createSettlement / recordSettlement` (supports bundled multi-recipient)
- `linkProfileToRemote(localProfileId, remoteProfileId, actorUserId)` — sets `linked_profile_id`, rewrites group_member user_ids, notifies remote user
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

The `kwenta_sync` RPC is the single entry point for all sync: accepts push payload, applies it server-side, returns pull bundle for `p_since`. Push validators enforce the same RLS rules the client filters apply.

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
  }
}
```

**`src/lib/runtime-flags.ts`** — `isRuntimeFlagEnabled(key)` checks `localStorage` override (`kwenta_flag:{key}` = `'1'`/`'0'`) before falling back to store default. `setRuntimeFlagOverride` persists to both.

---

## Routing

- `/` — Public landing page (`src/landing/`)
- `/login` — Auth page
- `/app/*` — Authenticated shell (lazy routes):
  - `/app/home` — Dashboard
  - `/app/bills` — Personal bills list
  - `/app/bills/add` — Add/edit bill
  - `/app/bills/:id` — Bill detail
  - `/app/groups` — Groups list
  - `/app/groups/:id` — Group detail (members, bills, balances, settlements)
  - `/app/people` — Contacts
  - `/app/people/:id` — Person detail (pairwise net, shared bills, settlements)
  - `/app/balances` — All group balances + settlement suggestions
  - `/app/settings` — Profile + app settings

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
