# App shell

What: `src/components/layout/AppShell.tsx`: sticky header (`AppHeader`), bottom nav under
`lg`, offline banner, top loading bar.

Reach: any `/app` route.

Drive: load `/app`; read `getComputedStyle(document.querySelector('header'))` for
`backgroundColor` (solid white) and `backdropFilter` (`none`). Refresh button in the header
shows "Updating…" and the loading bar (`data-testid="top-loading-bar"`) while fetches run.
Offline banner: DevTools offline is not available through the extension; cover it in Vitest.

Proves it: header solid, nav visible at phone width, no console errors on load.

Gotchas: `env(safe-area-inset-*)` is 0 in desktop Chrome; padding classes are asserted by name.
