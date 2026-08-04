-- Minimal stand-in for the parts of Supabase the migrations depend on.
--
-- The migrations reference exactly three things Postgres does not provide: the `authenticated`
-- and `service_role` roles, an `auth.users` table, and `auth.uid()`. Everything else is plain
-- Postgres. This file supplies those so migrations 001-051 can be applied to a bare cluster and
-- exercised by `npm run test:sql`.
--
-- FIDELITY — read before trusting a green run.
-- This approximates Supabase; it is not Supabase. In particular:
--   * `auth.uid()` here reads the same GUCs PostgREST sets, but nothing verifies a JWT. Tests
--     assume an identity rather than proving one.
--   * The tests below connect as the OWNER of the objects, so `SECURITY DEFINER` behaves as it
--     does in production but ROW LEVEL SECURITY does NOT apply unless a test explicitly switches
--     to a non-owner role (see `test.as_user`, which does exactly that). A test that forgets to
--     switch proves nothing about RLS.
--   * `service_role` here is an ordinary role, not a BYPASSRLS superuser-ish role.
-- So: RLS conclusions still need a check against a real branch database before shipping. What
-- this harness proves reliably is the *logic* — predicates, aggregation, money arithmetic.

-- Roles the migrations GRANT to. NOLOGIN: tests reach them via SET ROLE, never by connecting.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Only the columns the migrations actually touch: 025/035 read `email`, `email_confirmed_at`
-- and `raw_user_meta_data` in the on-signup trigger; 030/040/050 reference `id`.
CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY,
  email               text,
  email_confirmed_at  timestamptz,
  raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Mirrors Supabase's own definition, including the two-GUC fallback: PostgREST sets
-- `request.jwt.claim.sub` on older versions and a whole `request.jwt.claims` JSON on newer ones.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$;

-- The realtime publication. Migrations 012 and 018 add tables to it, guarded against its
-- absence — creating it here exercises the real branch instead of the fallback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;
