---
name: verify
description: Drive the Kwenta web app (React PWA, Vite dev server) in Chrome the way a user would, to prove a UI change works. Use for done-gate's driver step after any change under src/.
---

# verify: drive Kwenta in Chrome

Surface: web UI (an installable PWA). Driven with the Claude-in-Chrome tools. There is no
Playwright harness; Vitest + happy-dom covers components, this covers the real page.

## Launch

- Reuse a dev server only if it serves THIS checkout:
  `pid=$(lsof -tiTCP:5199 -sTCP:LISTEN); [ -n "$pid" ] && ps -o command= -p "$pid" || echo "nothing on 5199"`
  must print `.../kwenta-web/node_modules/.bin/vite --port 5199 --strictPort`. Vite hot-reloads
  edits, so a reused instance shows the current tree.
- Otherwise start one in the background (Bash `run_in_background: true`):
  `npx vite --port 5199 --strictPort`. Ready when `curl -s -o /dev/null -w '%{http_code}' http://localhost:5199/` prints `200`.
- Port 5199 is fixed on purpose: the Supabase session lives in that origin's localStorage, so
  a different port means a signed-out browser.
- Teardown: stop the server only if you started it (by its background task id or its PID
  from `lsof -tiTCP:5199`), never `pkill node`/`pkill vite`.

## Seed

There is no local backend: `.env` points at the user's LIVE Supabase project, and the drive
uses the user's own account and data.
- Sign-in: you may NOT type the password (it is a real account on a remote host). If
  `/app` redirects to `/login`, ask the user to sign in in the tab and wait.
- Never save anything during a drive: no "Save bill", "Record payment", "Delete", "Settle",
  invites or profile edits. Open forms, type, observe, then close or navigate away. If a
  feature can only be proven by a save, stop and ask the user first.
- Nothing to re-seed after `npm run test:sql`; that runs on a throwaway cluster.

## Doctor (read-only, before driving)

1. `lsof -tiTCP:5199 -sTCP:LISTEN` returns a PID whose command is this checkout's vite (above).
2. In the tab, `javascript_tool`: `location.pathname` after navigating to `http://localhost:5199/app`
   is `/app` (not `/login`) and `document.querySelector('header')` exists. On `/login`: run Seed.
3. Console clean of app errors: `read_console_messages` with pattern `error|Error|failed`.

## Drive

1. `tabs_context_mcp` (createIfEmpty), use a NEW tab unless the user handed you one.
2. `resize_window` 360x780 FIRST. Chrome clamps windows to about 500 px wide; confirm with
   `innerWidth` and state the real width in evidence. For true 360 px or `pointer: coarse`
   (touch-only CSS such as the iOS 16px input guard) Chrome-in-extension cannot emulate it:
   assert the rule instead (`getComputedStyle`, `matchMedia`) and say so.
3. Navigate, act through stable handles: routes below, `aria-label`s (`Search`,
   `Close search`), visible label text (`Paid by`, `Total amount`), placeholders
   (`Search bills, groups, people...`, `0.00`). Use `find` to get a ref, click by ref.
4. Read state with `javascript_tool` (`getComputedStyle`, class names, text) plus a
   screenshot at `scale: 0.5`. Watch `read_console_messages` for errors: a failed fetch
   renders like an empty list.
5. Then desktop: `resize_window` 1280x800 and repeat the key observation.
6. Background tabs run no animation frames: keep the tab in front when checking motion
   (skeleton pulse, loading bar).

iOS-only behaviour (focus zoom, Dynamic Island inset, backdrop-filter at the screen edge)
cannot be reproduced here; record what you asserted and leave the on-device check to the user.

Routes: `/app` home, `/app/bills`, `/app/bills/new` (add bill page), `/app/bills/:id`,
`/app/groups`, `/app/groups/:id` (Add bill opens `AddBillDialog`), `/app/people`,
`/app/people/:id` (Record payment), `/app/settings`.

## Evidence

The hooks log every browser call. Per feature add one
`gate decide driver "<what was driven>" "<why this path>" "<observed values / screenshot id>" "<result>"`.
Exercise the real user path (the header button, the form), never a test-only route.

## Cleanup

Close the tabs you created (`tabs_close_mcp`), stop only a server you started, keep the
transcript's screenshots as evidence.

Feature recipes: `features/README.md`.
