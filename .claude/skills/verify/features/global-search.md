# Global search

What: full-screen sheet (`src/components/common/GlobalSearchSheet.tsx`) searching bills,
groups and people via `kwenta_search`; falls back to the local mirror offline.

Reach: any `/app` screen, header button `aria-label="Search"`.

Drive:
1. `find` "Search button in header", click the ref.
2. Input `placeholder^="Search bills"` has focus. Type 2+ characters of a known bill/person name.
3. Close with `aria-label="Close search"`; the input is gone from the DOM.

Proves it: results grouped under Bills / Groups / People headings; under 2 characters the
hint "Type at least 2 characters to search"; a no-match query shows "No results found".
Sheet root carries `pt-[env(safe-area-inset-top)]` (computes 0px on desktop).

Gotchas: results come from the live account, so pick a query from what the home screen
shows. A result link navigates and closes the sheet.
