# Kwenta

Offline-first bill splitting for real-life groups.

Kwenta is a mobile-first PWA for tracking shared expenses, itemized bills, groups, balances, and settlements. It works locally without an account, then syncs to Supabase when the user signs in and has an internet connection.

## Features

- Add a bill as a total amount or as itemized entries
- Split each item by equal share, percentage, or custom logic
- Create groups and add members for shared expenses
- Use the app without an account through local browser storage
- Sync and back up data to Supabase when signed in
- Install as a PWA and continue using it offline
- Review balances and settlement suggestions

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
