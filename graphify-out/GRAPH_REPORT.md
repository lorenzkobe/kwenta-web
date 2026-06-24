# Graph Report - .  (2026-06-24)

## Corpus Check
- 242 files · ~152,952 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 973 nodes · 1507 edges · 92 communities (78 shown, 14 thin omitted)
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 234 edges (avg confidence: 0.8)
- Token cost: 334,292 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_DB Operations Layer|DB Operations Layer]]
- [[_COMMUNITY_Client Metrics|Client Metrics]]
- [[_COMMUNITY_Project Dependencies|Project Dependencies]]
- [[_COMMUNITY_People & Balance Helpers|People & Balance Helpers]]
- [[_COMMUNITY_DB Test Fixtures|DB Test Fixtures]]
- [[_COMMUNITY_Landing Demo & Itemized Splits|Landing Demo & Itemized Splits]]
- [[_COMMUNITY_Cloud-First Mutation Sync|Cloud-First Mutation Sync]]
- [[_COMMUNITY_CSV Export|CSV Export]]
- [[_COMMUNITY_Groups Rework SDD Tasks|Groups Rework SDD Tasks]]
- [[_COMMUNITY_Dexie Schema & Hooks|Dexie Schema & Hooks]]
- [[_COMMUNITY_Landing Page Sections|Landing Page Sections]]
- [[_COMMUNITY_TS App Config|TS App Config]]
- [[_COMMUNITY_Runtime Flags & Realtime Events|Runtime Flags & Realtime Events]]
- [[_COMMUNITY_TS Node Config|TS Node Config]]
- [[_COMMUNITY_Domain Type Definitions|Domain Type Definitions]]
- [[_COMMUNITY_Bill & Settlement Dialogs|Bill & Settlement Dialogs]]
- [[_COMMUNITY_Current User & Bill Navigation|Current User & Bill Navigation]]
- [[_COMMUNITY_Kwenta Notifications|Kwenta Notifications]]
- [[_COMMUNITY_Confirm & Member Picker Dialogs|Confirm & Member Picker Dialogs]]
- [[_COMMUNITY_Landing Demo Persistence|Landing Demo Persistence]]
- [[_COMMUNITY_Settlement History|Settlement History]]
- [[_COMMUNITY_App Routing|App Routing]]
- [[_COMMUNITY_Cloud Sync & Auth Bootstrap (docs)|Cloud Sync & Auth Bootstrap (docs)]]
- [[_COMMUNITY_Route Guards|Route Guards]]
- [[_COMMUNITY_OfflineRealtime Banners|Offline/Realtime Banners]]
- [[_COMMUNITY_Confirm Dialog Hook & Person Detail|Confirm Dialog Hook & Person Detail]]
- [[_COMMUNITY_App Shell & Nav|App Shell & Nav]]
- [[_COMMUNITY_Apply General Credit Dialog|Apply General Credit Dialog]]
- [[_COMMUNITY_Add Bill Dialog|Add Bill Dialog]]
- [[_COMMUNITY_Lump-Sum Group Payments|Lump-Sum Group Payments]]
- [[_COMMUNITY_Creator-Only Member Mgmt (docs)|Creator-Only Member Mgmt (docs)]]
- [[_COMMUNITY_Bill Split Computation|Bill Split Computation]]
- [[_COMMUNITY_Supabase Client|Supabase Client]]
- [[_COMMUNITY_Social Icon Sprite|Social Icon Sprite]]
- [[_COMMUNITY_App Store State|App Store State]]
- [[_COMMUNITY_Global Search|Global Search]]
- [[_COMMUNITY_Bill Export Card|Bill Export Card]]
- [[_COMMUNITY_Bill Categories|Bill Categories]]
- [[_COMMUNITY_Export Image Dialog|Export Image Dialog]]
- [[_COMMUNITY_Group Export Card|Group Export Card]]
- [[_COMMUNITY_Person Export Card|Person Export Card]]
- [[_COMMUNITY_Auth Provider & ensureProfile|Auth Provider & ensureProfile]]
- [[_COMMUNITY_Admin Users Page|Admin Users Page]]
- [[_COMMUNITY_Bills Page|Bills Page]]
- [[_COMMUNITY_Groups Page|Groups Page]]
- [[_COMMUNITY_Landing Hero Illustration|Landing Hero Illustration]]
- [[_COMMUNITY_Initial App Loader|Initial App Loader]]
- [[_COMMUNITY_Settle Up Dialog|Settle Up Dialog]]
- [[_COMMUNITY_Group Member Export Card|Group Member Export Card]]
- [[_COMMUNITY_Duplicate Identity Detection|Duplicate Identity Detection]]
- [[_COMMUNITY_PWA Icon 192|PWA Icon 192]]
- [[_COMMUNITY_PWA Icon 512|PWA Icon 512]]
- [[_COMMUNITY_Stale-Pull Indicator (docs)|Stale-Pull Indicator (docs)]]
- [[_COMMUNITY_Realtime Events Tests|Realtime Events Tests]]
- [[_COMMUNITY_Badge UI|Badge UI]]
- [[_COMMUNITY_Button UI|Button UI]]
- [[_COMMUNITY_Select UI|Select UI]]
- [[_COMMUNITY_Install Prompt|Install Prompt]]
- [[_COMMUNITY_Export Data Dialog|Export Data Dialog]]
- [[_COMMUNITY_Auth Context|Auth Context]]
- [[_COMMUNITY_Clear Local Data|Clear Local Data]]
- [[_COMMUNITY_App Favicon|App Favicon]]
- [[_COMMUNITY_TS Root Config|TS Root Config]]
- [[_COMMUNITY_Group Payments Tests|Group Payments Tests]]
- [[_COMMUNITY_Input UI|Input UI]]
- [[_COMMUNITY_Switch UI|Switch UI]]
- [[_COMMUNITY_Textarea UI|Textarea UI]]
- [[_COMMUNITY_Vercel Config|Vercel Config]]

## God Nodes (most connected - your core abstractions)
1. `now()` - 32 edges
2. `notifySyncAfterMutation()` - 28 edges
3. `formatCurrency()` - 24 edges
4. `compilerOptions` - 22 edges
5. `cn()` - 21 edges
6. `makeProfile()` - 21 edges
7. `syncRoundTrip()` - 19 edges
8. `runSync()` - 18 edges
9. `makeMember()` - 18 edges
10. `seedSimpleBill()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `seedOutboxEntry()` --calls--> `notifyProfileLinked()`  [INFERRED]
  tests/lib/kwenta-notifications.test.ts → src/lib/kwenta-notifications.ts
- `Offline-First Behavior` --conceptually_related_to--> `Cloud Sync and Auth Bootstrap`  [INFERRED]
  README.md → AGENTS.md
- `runSearch()` --calls--> `formatCurrency()`  [INFERRED]
  src/components/common/GlobalSearchSheet.tsx → src/lib/utils.ts
- `SettleUpDialog()` --calls--> `formatCurrency()`  [INFERRED]
  src/components/common/SettleUpDialog.tsx → src/lib/utils.ts
- `GroupMemberExportCard()` --calls--> `formatCurrency()`  [INFERRED]
  src/components/export/GroupMemberExportCard.tsx → src/lib/utils.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Pairwise balance engine and its wrappers/consumers** — sdd_task_1_brief_computegrouppairwisebalances, sdd_task_2_brief_computegrouppairwisenet, sdd_fix_final_brief_computeallgrouppairwisebalances, sdd_task_11_brief_adapted_persondetailpage [INFERRED 0.85]
- **Legacy optimizer migration and removal flow** — sdd_task_12a_brief_migrate_export_surfaces, sdd_task_12b_brief_delete_optimizer, sdd_task_12_brief_optimizesettlements, sdd_task_12_brief_groupbalancesummary [EXTRACTED 0.80]
- **Creator-only member management (ops + UI)** — sdd_task_4_brief_creator_only_add_member, sdd_task_4_brief_addgroupmember, sdd_task_10_brief_creator_only_member_ui, sdd_task_10_brief_managemembersdialog [EXTRACTED 0.80]
- **Batch C: confirm-or-fail sync conflict integrity** — sdd_taskc1_report_migration_044, sdd_taskc2_report_confirm_or_fail, sdd_taskc3_report_mid_round_trip_overwrite, sdd_taskc4_report_apply_again_dismiss [INFERRED 0.85]
- **Group pairwise balances and payment flow** — sdd_task_5_brief_remove_group_member, sdd_task_6_brief_payment_caps, sdd_task_7_brief_group_page_pairwise, sdd_task_8_brief_pay_into_group_dialog [INFERRED 0.85]
- **Batch A: durable writes and surfaced failures** — sdd_taska1_report_atomic_delete_person, sdd_taska2_report_silently_dropped_writes, sdd_taska3_report_toast_handlers [INFERRED 0.80]
- **Offline-First Local-to-Cloud Sync Flow** — readme_offline_first, agents_cloud_sync_auth, agents_initial_hydration [INFERRED 0.75]
- **Brand & social media link icons** —  [INFERRED 0.85]

## Communities (92 total, 14 thin omitted)

### Community 0 - "DB Operations Layer"
Cohesion: 0.08
Nodes (60): addExistingGroupMember(), addGroupMember(), addProfilePeerLink(), applyGeneralCreditToPersonalBills(), applyGeneralCreditToSelection(), createBill(), CreateBillInput, createBundledGroupSettlement() (+52 more)

### Community 1 - "Client Metrics"
Cohesion: 0.08
Nodes (45): captureMetric(), MetricBucket, MetricFields, readBuckets(), withMetric(), writeBuckets(), clearRetryTimer(), isDatabaseClosedError() (+37 more)

### Community 2 - "Project Dependencies"
Cohesion: 0.04
Nodes (48): dependencies, class-variance-authority, clsx, dexie, dexie-react-hooks, html-to-image, jspdf, lucide-react (+40 more)

### Community 3 - "People & Balance Helpers"
Cohesion: 0.08
Nodes (46): BillWithContext, buildManualGeneralCreditApplyPlan(), buildManualGeneralCreditSelectionPlan(), buildManualGeneralCreditSelectionPlanForDirection(), buildManualGeneralCreditSelectionPlanResult(), buildPersonalBillAllocationPlan(), buildPersonalReconcilePlan(), collectRelatedProfileIds() (+38 more)

### Community 4 - "DB Test Fixtures"
Cohesion: 0.15
Nodes (29): seedJelloDuplicate(), seed3MemberGroup(), seedDebt(), seedGroupOwnedBy(), iOweThemBill(), theyOweMeBill(), makeBill(), makeGroup() (+21 more)

### Community 5 - "Landing Demo & Itemized Splits"
Cohesion: 0.07
Nodes (31): clampSplitInput(), computeItemizedUserTotals(), computePerUserAmounts(), CURRENCIES, ItemizedBill, ItemizedLine, LandingProductDemo(), LandingProductDemoProps (+23 more)

### Community 6 - "Cloud-First Mutation Sync"
Cohesion: 0.06
Nodes (42): Blast-radius scoping of pending mutations, finalizeMutationSync, hasUnsyncedLocalDataForUser (actor-global unsynced guard), isEntityUnsyncedForActor (entity-scoped unsynced check), computeAllGroupPairwiseBalances, groupReceivePayMapsFromSummaries, GroupsPage, Cross-surface pairwise consistency fix (+34 more)

### Community 7 - "CSV Export"
Cohesion: 0.11
Nodes (33): csvRow(), exportBillsToCSV(), exportGroupToCSV(), exportPersonToCSV(), resolveDisplayName(), section(), triggerDownload(), BODY (+25 more)

### Community 8 - "Groups Rework SDD Tasks"
Cohesion: 0.06
Nodes (37): Task 5: removeGroupMember settle-before-remove, computeGroupPairwiseBalances, Task 5 Report: removeGroupMember, Task 6: payment caps in settlement ops, createBundledGroupSettlement, createSettlement, owedInGroup, Task 6 Report: payment caps (+29 more)

### Community 9 - "Dexie Schema & Hooks"
Cohesion: 0.08
Nodes (15): db, KwentaDB, useGroupSettlementHistory(), buildPiePaths(), CURRENCY_OPTIONS, EditGroupDialog(), GroupDetailPage(), GroupOptionsMenu() (+7 more)

### Community 10 - "Landing Page Sections"
Cohesion: 0.11
Nodes (14): featureCards, LandingFeatures(), LandingFinalCta(), LandingFooter(), LandingHeader(), nav, LandingHero(), howItWorks (+6 more)

### Community 11 - "TS App Config"
Cohesion: 0.08
Nodes (24): compilerOptions, allowImportingTsExtensions, baseUrl, erasableSyntaxOnly, jsx, lib, module, moduleDetection (+16 more)

### Community 12 - "Runtime Flags & Realtime Events"
Cohesion: 0.17
Nodes (19): isRuntimeFlagEnabled(), RuntimeFlagKey, setRuntimeFlagOverride(), storageKey(), applyBillBundle(), applyGroupBundle(), applyReconcileBundle(), applySettlementBundle() (+11 more)

### Community 13 - "TS Node Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+11 more)

### Community 14 - "Domain Type Definitions"
Cohesion: 0.15
Nodes (19): ActivityAction, ActivityLog, Bill, BillItem, EntityType, Group, GroupMember, ItemSplit (+11 more)

### Community 15 - "Bill & Settlement Dialogs"
Cohesion: 0.12
Nodes (12): BillDetailModal(), BillDetails, EditSettlementDialog(), PayIntoGroupDialog(), RecordSettlementDialog(), useOverallBalanceRollups(), formatPairwiseSummary(), formatCurrency() (+4 more)

### Community 16 - "Current User & Bill Navigation"
Cohesion: 0.15
Nodes (13): useCurrentUser(), billDetailBackPath(), parseSafeAppPath(), withBillBackQuery(), AddBillPage(), BillMode, CURRENCIES, ItemDraft (+5 more)

### Community 17 - "Kwenta Notifications"
Cohesion: 0.18
Nodes (14): enqueueNotificationRows(), FlushOptions, flushQueuedKwentaNotifications(), hasQueuedKwentaNotifications(), KwentaNotificationKind, KwentaNotificationRow, NotificationInsertRow, NotificationOutboxEntry (+6 more)

### Community 18 - "Confirm & Member Picker Dialogs"
Cohesion: 0.12
Nodes (11): ConfirmDialog(), MemberMultiPicker(), MemberMultiPickerOption, MemberMultiPickerProps, SettlementHistoryList(), SplitMemberOption, SplitPersonSelector(), SplitPersonSelectorProps (+3 more)

### Community 19 - "Landing Demo Persistence"
Cohesion: 0.19
Nodes (14): DemoMode, isSplitType(), ItemizedBillJson, ItemizedLineJson, LANDING_DEMO_DEFAULTS, LandingDemoStateV1, parseItemizedBill(), parseItemizedLine() (+6 more)

### Community 20 - "Settlement History"
Cohesion: 0.18
Nodes (15): ActiveSettlementRow, BalanceEntry, buildHistoryItemsFromRows(), buildSettlementHistoryItem(), BundledSuggestionRecipient, computeAllGroupPairwiseBalances(), computeGroupPairwiseBalances(), computeGroupPairwiseNet() (+7 more)

### Community 21 - "App Routing"
Cohesion: 0.13
Nodes (13): AddBillPage, AdminUsersPage, App(), BillDetailPage, BillsPage, GroupDetailPage, GroupsPage, HomePage (+5 more)

### Community 22 - "Cloud Sync & Auth Bootstrap (docs)"
Cohesion: 0.14
Nodes (15): AuthProvider authReady Gate, Cloud Sync and Auth Bootstrap, Agent Engineering Workflow & Standards, Initial Hydration via syncRoundTrip, Profile Linking Side-Effects, Confirm Signup Email Template, App Shell Root HTML, PWA Meta Tags & Web App Capable (+7 more)

### Community 23 - "Route Guards"
Cohesion: 0.13
Nodes (8): RequireAdmin(), RequireAuth(), RequireGuest(), AccountBanner(), useAuth(), LoginPage(), Mode, SettingsPage()

### Community 24 - "Offline/Realtime Banners"
Cohesion: 0.18
Nodes (8): OfflineBanner(), RealtimeNoticeBanner(), useOnlineStatus(), useRealtime(), useSync(), AppShell(), NotificationsBell(), useAppStore

### Community 25 - "Confirm Dialog Hook & Person Detail"
Cohesion: 0.21
Nodes (9): ConfirmDialogOptions, ConfirmRequest, ConfirmVariant, useConfirmDialog(), LinkAccountSheet(), LinkPeerProfileSheet(), PersonDetailPage(), PersonOptionsMenu() (+1 more)

### Community 26 - "App Shell & Nav"
Cohesion: 0.24
Nodes (7): adminNavItem, AppHeader(), baseNavItems, adminNavItem, baseNavItems, BottomNav(), profileNavItem

### Community 27 - "Apply General Credit Dialog"
Cohesion: 0.33
Nodes (8): ApplyGeneralCreditDialog(), buildCappedCustomMap(), buildSplitState(), DestinationBucket, equalSplitExceedsBucketCaps(), splitAmountEqually(), lineSplitsValid(), isItemizedLineComplete()

### Community 28 - "Add Bill Dialog"
Cohesion: 0.29
Nodes (7): AddBillDialog(), AddBillDialogProps, BillMode, ItemDraft, MemberOption, newItem(), SPLIT_TYPE_LABEL

### Community 29 - "Lump-Sum Group Payments"
Cohesion: 0.36
Nodes (7): allocateLumpSum(), Allocation, capAt(), LumpSumMode, LumpSumResult, OwedParty, round2()

### Community 30 - "Creator-Only Member Mgmt (docs)"
Cohesion: 0.25
Nodes (8): Creator-only member management UI (Task 10), GroupDetailPage, ManageMembersDialog component, Task 10 creator-only member UI report, addExistingGroupMember operation, addGroupMember operation, Creator-only member add guard in operations (Task 4), Task 4 creator-only guard report

### Community 31 - "Bill Split Computation"
Cohesion: 0.48
Nodes (6): computeCustom(), computeEqual(), computePercentage(), computeQuantity(), computeSplits(), SplitInput

### Community 32 - "Supabase Client"
Cohesion: 0.33
Nodes (6): appOriginFromEnv, authRedirectUrl(), getAppOrigin(), supabase, supabaseKey, supabaseUrl

### Community 33 - "Social Icon Sprite"
Cohesion: 0.29
Nodes (7): Bluesky Icon, Discord Icon, Documentation Icon, GitHub Icon, Icon Sprite (Social & UI Icons), Social/Community Icon, X (Twitter) Icon

### Community 34 - "App Store State"
Cohesion: 0.29
Nodes (5): AppState, InitialCloudHydration, RuntimeFlagKey, RuntimeFlags, SyncStatus

### Community 35 - "Global Search"
Cohesion: 0.33
Nodes (4): runSearch(), SearchResult, TYPE_ICONS, TYPE_LABELS

### Community 36 - "Bill Export Card"
Cohesion: 0.40
Nodes (5): BillDetails, BillExportCard(), computePersonTotals(), PaymentEntry, Props

### Community 37 - "Bill Categories"
Cohesion: 0.33
Nodes (5): BILL_CATEGORIES, BillCategory, CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS

### Community 38 - "Export Image Dialog"
Cohesion: 0.40
Nodes (3): ExportImageDialog(), Props, useExportImage()

### Community 39 - "Group Export Card"
Cohesion: 0.40
Nodes (3): BillEntry, MemberEntry, Props

### Community 40 - "Person Export Card"
Cohesion: 0.40
Nodes (3): PersonBillEntry, PersonGroupEntry, Props

### Community 41 - "Auth Provider & ensureProfile"
Cohesion: 0.40
Nodes (3): AuthProvider(), ensureProfileInFlight, pendingSignupNickname

### Community 43 - "Bills Page"
Cohesion: 0.40
Nodes (4): BillFilter, BillSort, BillsPage(), EnrichedBill

### Community 44 - "Groups Page"
Cohesion: 0.40
Nodes (4): GroupFilter, GroupSort, GroupsPage(), myBalanceLine()

### Community 45 - "Landing Hero Illustration"
Cohesion: 0.67
Nodes (4): Kwenta Landing Hero Illustration, Landing Page Marketing Hero Purpose, Purple Gradient Brand Accent, Two Stacked Isometric Cards Motif

### Community 48 - "Group Member Export Card"
Cohesion: 0.50
Nodes (3): GroupMemberBillEntry, GroupMemberExportCard(), Props

### Community 50 - "Duplicate Identity Detection"
Cohesion: 0.67
Nodes (3): DuplicateIdentityCandidate, findDuplicateIdentityCandidates(), normalizeName()

### Community 51 - "PWA Icon 192"
Cohesion: 0.67
Nodes (4): Kwenta PWA Icon (192x192), Installable App Icon (PWA Manifest), Lightning Bolt Mark, Purple-to-Violet Gradient

### Community 52 - "PWA Icon 512"
Cohesion: 0.83
Nodes (4): Kwenta PWA App Icon (512x512), Installable / Splash App Icon Role, Stylized Lightning Bolt / Z Logomark, Purple-to-Blue Diagonal Gradient

### Community 53 - "Stale-Pull Indicator (docs)"
Cohesion: 0.50
Nodes (4): Task B2 Report: re-pull on tab focus/visibility, sync-manager.ts, app-store pullStale flag, Task B3 Report: data-may-be-behind stale-pull indicator

### Community 55 - "Badge UI"
Cohesion: 0.67
Nodes (3): Badge(), BadgeProps, badgeVariants

### Community 56 - "Button UI"
Cohesion: 0.50
Nodes (3): Button, ButtonProps, buttonVariants

### Community 57 - "Select UI"
Cohesion: 0.50
Nodes (3): SelectContent, SelectItem, SelectTrigger

### Community 64 - "App Favicon"
Cohesion: 0.67
Nodes (3): Zigzag Lightning Bolt Motif, Kwenta App Favicon (Lightning Bolt Logo), Purple/Violet Gradient Palette (#863bff)

## Ambiguous Edges - Review These
- `isEntityUnsyncedForActor (entity-scoped unsynced check)` → `Cross-surface pairwise consistency fix`  [AMBIGUOUS]
  .superpowers/sdd/fix-A2-scope-report.md · relation: conceptually_related_to

## Knowledge Gaps
- **326 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+321 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `isEntityUnsyncedForActor (entity-scoped unsynced check)` and `Cross-surface pairwise consistency fix`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `now()` connect `DB Operations Layer` to `Client Metrics`, `Runtime Flags & Realtime Events`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `formatCurrency()` connect `Bill & Settlement Dialogs` to `DB Operations Layer`, `Global Search`, `Bill Export Card`, `Landing Demo & Itemized Splits`, `Dexie Schema & Hooks`, `Groups Page`, `Settle Up Dialog`, `Group Member Export Card`, `Current User & Bill Navigation`, `Confirm & Member Picker Dialogs`, `Confirm Dialog Hook & Person Detail`, `Apply General Credit Dialog`, `Add Bill Dialog`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `cn()` connect `Confirm & Member Picker Dialogs` to `DB Operations Layer`, `Landing Demo & Itemized Splits`, `Dexie Schema & Hooks`, `Bills Page`, `Current User & Bill Navigation`, `Badge UI`, `Offline/Realtime Banners`, `Confirm Dialog Hook & Person Detail`, `App Shell & Nav`, `Apply General Credit Dialog`, `Add Bill Dialog`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Are the 30 inferred relationships involving `now()` (e.g. with `applyGeneralCreditToPersonalBills()` and `deleteBill()`) actually correct?**
  _`now()` has 30 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `notifySyncAfterMutation()` (e.g. with `finalizeMutationSync()` and `requestSyncNow()`) actually correct?**
  _`notifySyncAfterMutation()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 23 inferred relationships involving `formatCurrency()` (e.g. with `AddBillDialog()` and `ApplyGeneralCreditDialog()`) actually correct?**
  _`formatCurrency()` has 23 INFERRED edges - model-reasoned connections that need verification._