# Kwenta Feature Behavior Map (Current App Behavior)

This document explains what the app does today, from top to bottom, in simple words.
It covers:

- What users do
- What the app checks
- What gets saved (local + cloud sync behavior)
- What users see next

It describes current behavior only (not proposed fixes).

## 1) App Entry and Navigation Map

### Public routes

- `/` -> Landing page
- `/login` -> Sign in / sign up / reset password

### Protected app routes (must be signed in)

- `/app` -> Home dashboard
- `/app/bills` -> Personal bills list
- `/app/bills/new` -> Add bill page (also used for edit via query param)
- `/app/bills/:billId` -> Bill detail
- `/app/groups` -> Groups list
- `/app/groups/:groupId` -> Group detail
- `/app/people` -> People list
- `/app/people/:personId` -> Person detail
- `/app/balances` -> Balances rollup
- `/app/settings` -> Profile/settings

Source: `src/App.tsx`

## 2) Global Behaviors (Always Running in App)

### Auth gate

- **When you do:** Open any `/app/`* page while signed out
- **The app checks:** Session/auth state
- **Then it saves:** Nothing new; it preserves where you were trying to go
- **Then you see:** Redirect to `/login`, and after successful sign-in it returns to your original target

Sources: `src/components/auth/RequireAuth.tsx`, `src/pages/LoginPage.tsx`, `src/hooks/useAuth.tsx`

### App shell, online status, sync, realtime

- **When you do:** Enter authenticated app pages
- **The app checks:** Online/offline and auth status
- **Then it saves:** Starts sync and realtime listeners in background
- **Then you see:** Header sync badge, offline banner when disconnected, bottom navigation

Sources: `src/components/layout/AppShell.tsx`, `src/components/layout/AppHeader.tsx`, `src/sync/sync-service.ts`

### Sync model (plain-language)

- Mutations are now tracked through cloud-first metadata tables (`pending_mutations`, `not_applied_changes`).
- Online writes immediately attempt cloud sync; if cloud sync fails, the mutation is marked as not applied and surfaced to the user.
- Offline writes remain available and are recorded as pending mutations for replay on reconnect.
- Reconciliation paths (pull, round-trip apply, realtime upsert) now use server-wins behavior.
- Server-side update guard prevents stale `updated_at` rows from overwriting newer server state.

Sources: `src/db/operations.ts`, `src/sync/sync-service.ts`, `src/sync/realtime-events.ts`

## 3) Auth and Session Flow

### Sign in / sign up / forgot password

- **When you do:** Submit login form
- **The app checks:** Email/password validity and auth provider response
- **Then it saves:** Session state; profile bootstrap in local DB (`ensureProfile`)
- **Then you see:** Success/errors inline; authenticated users move into app

Sources: `src/pages/LoginPage.tsx`, `src/hooks/useAuth.tsx`

### Session expires

- **When you do:** Return with expired session
- **The app checks:** Signed-out event reason
- **Then it saves:** Session-expired notice flag in session storage
- **Then you see:** Login message saying your local data is still on device

Sources: `src/hooks/useAuth.tsx`, `src/pages/LoginPage.tsx`

## 4) Home Dashboard (`/app`)

- **When you do:** Open Home
- **The app checks:** Current user id
- **Then it saves:** Nothing; reads local stats and recent bills
- **Then you see:** Totals, quick actions, recent bills

(COMMENT: Add a loader when loading data in the home page. Like a skeleton instead of default values)

Current behavior detail:

- Total bills and total spent are based on bills where `created_by === current user`.
- Recent bills also use bills created by the current user (including group bills).

Source: `src/pages/HomePage.tsx`

Status: Working as implemented, with a behavior mismatch noted later (creator-only counting).

## 5) Personal Bills (`/app/bills`)

- **When you do:** Open personal bills
- **The app checks:** Current user and bill status filters/sorts
- **Then it saves:** Nothing unless delete is confirmed
- **Then you see:** Only personal bills (`group_id == null`) that were created by you, with settled/open badge  
(COMMENT: Add a loader when loading data. Like a skeleton instead of like an empty page or empty results then loads the data after a while)

Delete flow:

- Confirming delete soft-deletes the bill, bill items, and item splits, and adds activity log.
- Sync is queued after mutation.

Sources: `src/pages/BillsPage.tsx`, `src/db/operations.ts`

Status: Working as implemented.

## 6) Create/Edit Bill (`/app/bills/new`)

Supports:

- Simple mode (single line)
- Itemized mode (multiple lines)
- Split types (equal, percentage, custom)
- Optional group context via `groupId` query param
- Edit mode via `?edit=<billId>`

### Create bill flow

- **When you do:** Fill form and save
- **The app checks:** Title, amount, split validity, selected participants
- **Then it saves:** Bill + items + splits + activity locally; then sync; then participant notification
- **Then you see:** Redirect to personal bills page

### Edit bill flow

- **When you do:** Open edit from detail
- **The app checks:** Only creator can edit this route
- **Then it saves:** Rewrites bill items/splits (soft-delete old rows, add new rows), updates bill/activity, queues sync
- **Then you see:** Redirect back to bill detail

Sources: `src/pages/AddBillPage.tsx`, `src/db/operations.ts`

Status: Working as implemented.

## 7) Bill Detail (`/app/bills/:billId`)

### View/detail behavior

- **When you do:** Open bill detail
- **The app checks:** Bill exists locally; if missing, tries a sync and reload
- **Then it saves:** Nothing for viewing
- **Then you see:** Bill total, items/splits, note, creator info

### Edit/delete permissions

- **When you do:** Open someone else's bill
- **The app checks:** `bill.created_by === current user`
- **Then it saves:** Nothing
- **Then you see:** View-only mode (no edit/delete buttons)

### Settle on this bill

- **When you do:** Tap "Record payment" in settle rows
- **The app checks:** Pairwise net amount and participant eligibility for this bill
- **Then it saves:** Settlement row + activity log; sync queued
- **Then you see:** Updated settle rows and balances for this bill

Sources: `src/pages/BillDetailPage.tsx`, `src/components/common/RecordSettlementDialog.tsx`, `src/db/operations.ts`

Status: Working as implemented, with a split-display mismatch noted later.

## 8) Groups (`/app/groups` and `/app/groups/:groupId`)

### Groups list

- **When you do:** Open Groups page
- **The app checks:** Active memberships and groups
- **Then it saves:** New group if you create one
- **Then you see:** Group cards and summary values

Create group:

- Creates group + adds creator as first member + logs activity + queues sync.

Source: `src/pages/GroupsPage.tsx`, `src/db/operations.ts`

### Group detail

- **When you do:** Open a group
- **The app checks:** Group exists and you are an active member
- **Then it saves:** Nothing for viewing; mutations for member/bill/payment changes
- **Then you see:** Members, group balances, group bills, payment history, options dialogs

Includes:

- Add member (new local contact or existing profile)
- Add/edit group bill (modal flow)
- Record group payment
- Edit group name/currency and copy invite code
- Delete group (soft-delete group + members locally)

Sources: `src/pages/GroupDetailPage.tsx`, `src/components/common/AddBillDialog.tsx`, `src/db/operations.ts`

Status: Mostly working as implemented, with permission/sync mismatch noted later.

## 9) People (`/app/people` and `/app/people/:personId`)

- **When you do:** Open People
- **The app checks:** Related profile ids from personal/group interactions
- **Then it saves:** New local contacts if created
- **Then you see:** Per-person net summary across group + personal contexts

Person detail supports:

- Linked/unlinked profile context
- Pairwise bill/payment history
- Add payment with explicit type:
  - **General payment** reduces total pairwise balance only
  - **Distribute payment** applies to oldest unpaid personal bills first (FIFO), with overage saved as general after confirmation
- Manual action: **Apply available general credit to unpaid bills**
  - Credit is never auto-backfilled when new bills are added
  - User must explicitly confirm credit application
- Link local contact to remote profile
- Remove local contact

Sources: `src/pages/PeoplePage.tsx`, `src/pages/PersonDetailPage.tsx`, `src/lib/people.ts`, `src/db/operations.ts`

Status: Working as implemented.

## 10) Balances (`/app/balances`)

- **When you do:** Open Balances
- **The app checks:** Group balances + personal balances + settlement history
- **Then it saves:** Only when recording settlement from this screen
- **Then you see:** Combined "to receive" / "to pay" across currencies, plus per-group and personal breakdowns

This page exists as its own route, but is mainly discoverable from Profile/Settings.

Sources: `src/pages/BalancesPage.tsx`, `src/lib/settlement.ts`, `src/lib/people.ts`

Status: Working as implemented.

## 11) Profile/Settings (`/app/settings`)

### Profile and display name

- **When you do:** Edit your name
- **The app checks:** Non-empty value
- **Then it saves:** Updates local profile and group member display names; attempts cloud upsert; triggers sync
- **Then you see:** Updated profile name

### Sign out

- **When you do:** Sign out
- **The app checks:** Unsynced local data and online status
- **Then it saves:** Optional final sync; then signs out and clears local data
- **Then you see:** Redirect to login

### Other sections

- Linking instructions (email sharing for contact linking)
- Quick link to balances
- Settlement history and recent activity
- Not applied changes inbox (conflict recovery):
  - **Apply again** -> opens current record path and marks card as reapplied
  - **View current** -> opens latest server-backed record
  - **Dismiss** -> accepts server state and removes card
  - Cards auto-resolve after a successful manual save on the same entity

Source: `src/pages/SettingsPage.tsx`

Status: Working as implemented.

## 12) Notifications and Invite Links

### Notifications bell

- **When you do:** Open app header bell
- **The app checks:** Current user and unread state
- **Then it saves:** Reads/caches notification state, subscribes to updates
- **Then you see:** In-app notifications for relevant events

Sources: `src/components/notifications/NotificationsBell.tsx`, `src/lib/kwenta-notifications.ts`

Status: Working as implemented.

### Invite links

- **Decision:** Remove this feature completely for now.
- **Implementation direction:** Remove invite route/page and hide invite-based entry points.

## 13) Known Mismatches and Likely Bugs (Current Behavior)

1. Invite flow appears unfinished

- **Decision:** Remove invite feature completely for now.
- **Action:** Remove route/page and invite UI affordances.

1. Personal bill visibility mismatch

- Sync/RLS logic includes personal bills where user is participant, but Home and Personal Bills pages are creator-only.
- User may have related personal bill data that is not visible in those summaries.
- Evidence: `src/pages/BillsPage.tsx`, `src/pages/HomePage.tsx`, `src/sync/sync-service.ts`, `supabase/migrations/005_personal_bill_participants_sync.sql`
- **Decision:** Keep personal bills separated from groups, and add a dedicated "Shared with you" handling in personal bills (group bills remain in group views).

1. Group edit/delete permission mismatch

- Group detail UI exposes edit/delete options to members, and local operations do not enforce creator check.
- Sync push filtering for groups can reject non-creator group writes, so local changes may not persist to cloud and may later be overwritten by pull.
- Evidence: `src/pages/GroupDetailPage.tsx`, `src/db/operations.ts`, `src/sync/sync-service.ts`, `supabase/migrations/001_initial_schema.sql`
- **Decision:** Any member can add group bills; members can edit/delete only their own group bills; group settings CRUD stays creator-only.

1. "Your split" may be wrong for linked-profile cases

- Bill detail computes "Your split" by direct `split.user_id === userId`.
- Other pairwise logic uses canonical/expanded profile matching.
- In linked/local alias scenarios, displayed "Your split" can be missing or inaccurate.
- Evidence: `src/pages/BillDetailPage.tsx`, `src/lib/people.ts`
- **Decision:** Fix now by using identity-expanded matching.

1. Navigation discoverability gap for Balances

- Balances route exists but is not in top desktop nav or bottom mobile nav; primarily reached from Profile page.
- Evidence: `src/components/layout/AppHeader.tsx`, `src/components/layout/BottomNav.tsx`, `src/pages/SettingsPage.tsx`
- **Decision:** Add Balances to primary desktop and mobile navigation.

## 14) Practical Reading Notes For Refactor Planning

- Personal bills in this app are modeled as "you paid" records in your ledger.
- Group bills are collaborative and stored under each group context.
- Most writes are local-first, then synced, so permission drift between local behavior and cloud rules should be a top refactor priority.
- Any refactor should preserve user-visible simplicity while making permission and visibility rules consistent across pages.

