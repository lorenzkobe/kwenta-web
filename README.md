# Kwenta

Offline-first bill splitting for real-life groups.

Kwenta is a mobile-first PWA for tracking shared expenses, itemized bills, groups, and settlements; **home** shows your overall to receive / to pay with personal and group breakdown.

**Product model:** Personal bills (no group) are **your** expenses—you are treated as the payer. Group bills are where the group shares a ledger; if someone else paid for something in real life, they add it on **their** Kwenta account.
 It works locally without an account, then syncs to Supabase when the user signs in and has an internet connection.

## Features

- Add a bill as a total amount or as itemized entries
- Split each item by equal share, percentage, or custom logic
- Create groups and add members for shared expenses
- Use the app without an account through local browser storage
- Sync and back up data to Supabase when signed in
- Install as a PWA and continue using it offline
- See balance rollups on the home dashboard; settlement suggestions remain in group detail where relevant

## Tech Stack

- `React 19`
- `TypeScript`
- `Vite`
- `React Router`
- `Tailwind CSS v4`
- `Radix UI` primitives with local shadcn-style components
- `Dexie` for IndexedDB local persistence
- `Zustand` for app state
- `Supabase` for auth and cloud sync
- `vite-plugin-pwa` for installability and offline support

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment variables

Copy `.env.example` to `.env` and fill in your Supabase values:

```bash
cp .env.example .env
```

Required variables:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-publishable-key
VITE_APP_ORIGIN=https://your-production-domain
```

### 3. Run the app

```bash
npm run dev
```

### 4. Build for production

```bash
npm run build
```

### 5. Lint

```bash
npm run lint
```

## Supabase Setup

Apply the SQL migration in `supabase/migrations/001_initial_schema.sql` to your Supabase project before testing auth and sync.

This project expects:

- Supabase Auth for account sign-in
- Postgres tables for profiles, groups, bills, items, splits, settlements, and activity logs
- Row Level Security policies defined by the included migration

**Auth URLs (email confirmation and OAuth):** In the Supabase dashboard, open **Authentication → URL Configuration**. Set **Site URL** to your deployed app origin (for example `https://your-app.vercel.app`). Under **Redirect URLs**, add every origin you use, including the login route used after confirming email:

- `http://localhost:5173/login` (Vite dev)
- `https://your-production-domain/login`

Sign-up uses `emailRedirectTo` → `/login`, and reset-password uses `/app/settings`. These are built from `VITE_APP_ORIGIN` (fallback is `window.location.origin`). Set `VITE_APP_ORIGIN` per environment to avoid production emails pointing to localhost.

**Security notification emails** (for example “password changed”) must be **enabled in the Supabase project** (Authentication settings / notifications) or they will not be sent. HTML for the password-changed template lives in `supabase/email-templates/password-changed.html` for copy-paste into the dashboard.

## Offline-First Behavior

- Guests can use the app immediately with local IndexedDB storage
- Bills and groups remain available after refreshes and offline periods
- When a user signs in, the app can sync local and cloud data
- The app shows offline state and install prompts inside the app shell

## Project Structure

```text
src/
  components/    Shared UI, layout, and app shell pieces
  db/            Dexie schema, hooks, and local write operations
  hooks/         Auth, sync, online status, and current user hooks
  lib/           Utilities, split logic, settlement logic, Supabase client
  pages/         Route-level screens
  store/         Zustand app state
  sync/          Push/pull sync manager and service
  types/         Shared TypeScript types
supabase/
  migrations/    Database schema and RLS policies
```

## Deployment

This app is set up for static deployment on Vercel.

- `vercel.json` rewrites all routes to `index.html` for SPA routing
- PWA assets are generated during `npm run build`

## Notes

- The landing page is public, while the app itself is available under `/app`
- Sign-in is optional for first use, but recommended for backup and multi-device sync
- If you clear local browser data, guest-only data will be removed unless it has already been synced
