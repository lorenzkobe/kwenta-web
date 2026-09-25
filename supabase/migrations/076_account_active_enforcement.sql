-- 076_account_active_enforcement.sql
--
-- WHAT BROKE: `profiles.account_status` (025) was enforced only by the CLIENT. AuthProvider read
-- the caller's status at app open and signed an inactive or unconfirmed account out. Nothing on
-- the server looked at it, so any account holding a valid JWT — a deactivated user, an account an
-- admin never approved, a stale token on an old install — could read and write everything its RLS
-- allowed straight through PostgREST. The gate was also the only thing standing between app open
-- and the first paint, so every open waited on it.
--
-- THE SHAPE NOW: three server-side gates, one per door, all answering "is auth.uid() active?".
--
--   1. Rows (reads, including Realtime): a RESTRICTIVE `FOR SELECT ... TO authenticated` policy on
--      the nine synced tables plus `kwenta_user_events`, `kwenta_notifications` and
--      `kwenta_write_submissions`. RESTRICTIVE is ANDed with the existing permissive policies, so
--      nothing an active user can read changes. Realtime evaluates the same policies per
--      subscriber, so an inactive account's event stream simply stops. The policy calls the
--      helper as `(SELECT public.kwenta_caller_is_active())`: an uncorrelated sub-select is an
--      InitPlan, evaluated ONCE per query rather than once per row. `profiles` also admits
--      `id = auth.uid()`, so an inactive account can still read its own row (and its status).
--
--   2. Writes: a statement-level `BEFORE INSERT OR UPDATE OR DELETE` trigger,
--      `kwenta_enforce_caller_active`, on the nine synced tables and `kwenta_notifications`. A
--      trigger rather than a policy because the write RPCs (`kwenta_write`, `kwenta_sync`, the
--      `kwenta_push_*` validators) are SECURITY DEFINER and run as the table owner, where RLS does
--      not apply — but a trigger fires for the owner too, and `auth.uid()` inside a DEFINER
--      function is still the caller (DEFINER changes the role, never the JWT GUCs). Statement
--      level, so it costs one primary-key lookup per statement, and it fires even for a statement
--      that touches zero rows — a push is refused at its first validator. It raises SQLSTATE 42501
--      with the message `kwenta_account_inactive:<status>`, which the client parses to keep its
--      separate 'unconfirmed' and 'inactive' copy.
--
--   3. Endpoints: the read RPCs are SECURITY DEFINER and read base tables, so neither gate above
--      reaches them. `kwenta_pre_request()` is installed as PostgREST's `db_pre_request` hook: it
--      runs before every API request and raises the same 42501 / `kwenta_account_inactive:<status>`
--      for an inactive caller, which PostgREST returns as HTTP 403. The one exemption is
--      `/rpc/kwenta_my_account_status` (matched exactly, not by prefix), the new status read the
--      client's background account gate calls — without it the gate could not tell 'unconfirmed'
--      from 'inactive', because every request would 403 before it could ask.
--
-- `auth.uid()` NULL is ALWAYS allowed: signup (`handle_new_user`), the email-confirmation trigger,
-- the prune jobs (073), admin/service_role maintenance and every migration run with no JWT. The
-- gate is about a signed-in caller, not about whose rows are touched — a server job may update an
-- inactive account's rows.
--
-- The hook is installed with `ALTER ROLE authenticator SET pgrst.db_pre_request` only when the
-- `authenticator` role exists and has NO pre-request hook yet; an existing different hook is never
-- overwritten (a WARNING says so, and the endpoints are then NOT gated until the two are merged by
-- hand). `NOTIFY pgrst, 'reload config'` makes a running PostgREST pick it up. `kwenta_pre_request`
-- is granted to `anon` as well as `authenticated`: PostgREST runs the hook as the request role, so
-- without EXECUTE every anonymous call (sign-in pages, the landing page) would fail.
--
-- VERIFY ON A BRANCH DATABASE (the SQL harness has no PostgREST and no GoTrue, so it cannot):
--   * `SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator'` lists
--     `pgrst.db_pre_request=public.kwenta_pre_request`;
--   * an inactive account gets 403 `kwenta_account_inactive:inactive` from an RPC and a table GET,
--     while `/rpc/kwenta_my_account_status` still answers — i.e. PostgREST sets `request.path` to
--     `/rpc/kwenta_my_account_status` behind Supabase's `/rest/v1` gateway (the match also
--     accepts a prefixed path);
--   * signing in still works: GoTrue's `on_auth_user_email_confirmed` UPDATE of `profiles` must
--     run with `auth.uid()` NULL, or every sign-in of a not-yet-active account would be refused.
--
-- APPLY: any time. An older client is unaffected while its account is active; an inactive one gets
-- 403s where it used to get data, which it already reports as an expired session.

-- ---------------------------------------------------------------------------------------------
-- 1. The one predicate
-- ---------------------------------------------------------------------------------------------
/** True when there is no signed-in caller, or the caller's account is 'active'. */
CREATE OR REPLACE FUNCTION public.kwenta_caller_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NULL
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.account_status = 'active');
$$;

/** The caller's own account_status; null when not signed in. The pre-request hook lets an inactive
    caller reach this one endpoint, so the client can say WHY it is being signed out. */
CREATE OR REPLACE FUNCTION public.kwenta_my_account_status()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.account_status FROM public.profiles p WHERE p.id = auth.uid();
$$;

/** Raises 42501 `kwenta_account_inactive:<status>` when a signed-in caller is not active. A missing
    profile reports 'unknown' rather than passing. */
CREATE OR REPLACE FUNCTION public.kwenta_assert_caller_active()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  SELECT p.account_status INTO v_status FROM public.profiles p WHERE p.id = v_uid;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'kwenta_account_inactive:' || COALESCE(v_status, 'unknown');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Writes
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_enforce_caller_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.kwenta_assert_caller_active();
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'groups', 'group_members', 'bills', 'bill_items', 'item_splits',
                           'settlements', 'activity_log', 'profile_peer_links', 'kwenta_notifications'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS kwenta_enforce_caller_active ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER kwenta_enforce_caller_active BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.kwenta_enforce_caller_active()', t);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Reads (and Realtime, which evaluates the same policies)
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['groups', 'group_members', 'bills', 'bill_items', 'item_splits',
                           'settlements', 'activity_log', 'profile_peer_links', 'kwenta_user_events',
                           'kwenta_notifications', 'kwenta_write_submissions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS kwenta_caller_active ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY kwenta_caller_active ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      'USING ((SELECT public.kwenta_caller_is_active()))', t);
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS kwenta_caller_active ON public.profiles;
CREATE POLICY kwenta_caller_active ON public.profiles
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT public.kwenta_caller_is_active()) OR id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- 4. Endpoints: PostgREST's pre-request hook
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_pre_request()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  -- Exact endpoint, optionally behind a gateway prefix (`/rest/v1`); `..._status_x` is not it.
  IF COALESCE(current_setting('request.path', true), '') ~ '(^|/)rpc/kwenta_my_account_status/?$' THEN
    RETURN;
  END IF;
  PERFORM public.kwenta_assert_caller_active();
END;
$$;

DO $$
DECLARE
  v_existing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RAISE NOTICE '076: no authenticator role (not a Supabase database); pre-request hook not installed';
    RETURN;
  END IF;

  SELECT substr(cfg, length('pgrst.db_pre_request=') + 1) INTO v_existing
  FROM pg_db_role_setting s
  CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
  WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'authenticator')
    AND cfg LIKE 'pgrst.db_pre_request=%'
  LIMIT 1;

  IF v_existing IS NULL THEN
    ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.kwenta_pre_request';
  ELSIF v_existing NOT IN ('public.kwenta_pre_request', 'kwenta_pre_request') THEN
    RAISE WARNING '076: authenticator already has pgrst.db_pre_request = %; NOT overwritten. '
      'Endpoints are not gated on account_status until that hook also calls public.kwenta_pre_request().',
      v_existing;
    RETURN;
  END IF;

  PERFORM pg_notify('pgrst', 'reload config');
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Grants. Since 073 a new function starts closed, so each client-facing one is granted here.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.kwenta_caller_is_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_caller_is_active() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kwenta_my_account_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_my_account_status() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kwenta_pre_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_pre_request() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.kwenta_assert_caller_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_assert_caller_active() TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_enforce_caller_active() FROM PUBLIC, anon, authenticated;

SELECT public.kwenta_revoke_acting_user_helpers();
