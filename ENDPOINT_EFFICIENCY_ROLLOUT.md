# Endpoint Efficiency Rollout

## Runtime flags

Use localStorage overrides for guarded rollout:

- `kwenta_flag:dedupeSyncEnabled`
- `kwenta_flag:realtimeCatchupSingleRun`
- `kwenta_flag:notificationPushOnlyMode`
- `kwenta_flag:targetedRealtimeReconcile`

Set to `1` (enable) or `0` (disable), then reload.

## Baseline metrics

Client-side counters are stored in localStorage key:

- `kwenta_client_metrics`

Capture baseline before enabling new behavior for:

1. app open
2. create/edit bill
3. bill detail open
4. notifications read flow

## Key metrics to compare

- `sync.kwentaSyncRpc`
- `sync.fullSync`
- `sync.pullChanges`
- `realtime.catchUp`
- `realtime.fetch.reconcileEvent`
- `realtime.event.process`
- `notifications.fetchList`
- `notifications.markRead`
- `notifications.realtime.status`

## Rollout order

1. Enable `dedupeSyncEnabled` + `realtimeCatchupSingleRun`
2. Enable `notificationPushOnlyMode`
3. Enable `targetedRealtimeReconcile`

Promote each stage only if:

- request volume does not increase,
- sync/notification correctness stays intact,
- no stale-data regressions for bill/group membership updates.

## Regression checks

- Bill created by user A appears for included users without manual refresh.
- Group member add/remove updates affected users quickly.
- Settlement changes reflect on both sides for personal and group contexts.
- Notification badge/list updates via realtime without focus/visibility polling.
- Offline -> online reconnect catches up missed changes once.

## Cloud-first verification (manual)

- Online mutation success path: create/edit/delete bill and settlement, verify no conflict cards created.
- Online mutation failure path (simulate server/RPC failure): verify error toast appears and a Not applied card is created.
- Offline mutation path: create/edit while offline, verify pending mutations exist and replay on reconnect.
- Replay conflict path: when replay fails, verify card appears in Settings > Not applied changes.
- Conflict recovery path: use View current, Apply again, Dismiss, and verify successful manual save auto-resolves matching card.

No new test framework is introduced in this phase; use existing build/lint plus focused manual scenarios.

