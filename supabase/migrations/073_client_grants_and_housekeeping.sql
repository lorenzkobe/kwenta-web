-- 073_client_grants_and_housekeeping.sql
--
-- WHAT BROKE: eleven functions meant for the server alone were callable by ANY client, signed in or
-- not, in production. Supabase's default privileges (pg_default_acl, schema public, role postgres)
-- give every new function an EXPLICIT EXECUTE grant to `anon` and `authenticated`; the migrations
-- that created these only ran `REVOKE ... FROM PUBLIC`, which does not touch explicit grants. 070's
-- sweep closed functions that take the acting user as an argument, by argument NAME, so these —
-- which take no user at all, because they act on EVERY user — slipped past it. None checks its
-- caller:
--   * `kwenta_identity_repair_apply` (043) rewrites split, bill and settlement party ids across all
--     accounts; `kwenta_identity_repair_report` returns every account's candidates;
--     `kwenta_repair_resolve_in_group` (043) is their helper and never had a grant block at all.
--   * `kwenta_collapse_legacy_credit_settlements` / `_plan` (068) — the global settlement sweep and
--     its plan, which lists every user's payment families.
--   * `kwenta_prune_write_submissions` (050). Deleting the markers removes the guarantee that a
--     replayed submission returns its original outcome instead of applying again.
--   * `kwenta_prune_user_events` (014) — deleting events drops realtime delivery for everyone.
--   * `kwenta_canonical_user_id` (042), `kwenta_settlement_party_id` (048) — id-resolution helpers
--     that answer for any id (which contact links to which account, who is on which roster).
--   * `kwenta_empty_reconcile_bundle` (028) — harmless, but server-internal, so it goes too.
--   * `kwenta_repair_orphan_settlements` (047) is self-scoped, but it is the superseded repair
--     that judges literal party ids and so soft-deletes real group payments — the bug 048 fixed.
--     No client calls it; any signed-in user could.
-- The local SQL harness could not see any of it: it did not emulate the default privileges, so
-- `REVOKE FROM PUBLIC` looked sufficient there. It does now (000_supabase_shim.sql).
--
-- THE SHAPE NOW:
--   1. Those eleven are service_role only.
--   2. `anon` (and PUBLIC, which anon inherits) loses EXECUTE on every function this role owns in
--      `public`, except the four that RLS policies call (`is_admin`, `is_group_member`, `user_can_read_personal_bill`,
--      `user_is_participant_on_personal_bill`): every policy is `TO public`, so an anon query on a
--      table evaluates them and would fail with a permission error instead of reading nothing.
--      Guests never call Supabase (Dexie only), and every endpoint derives the viewer from
--      auth.uid(), so anon could only ever get an error or nothing — this removes the surface, not
--      a feature. Trigger functions are skipped (they cannot be called directly), as are extension
--      members and functions owned by another role (Supabase's own, e.g. `rls_auto_enable`).
--   3. The default is reversed: postgres's new functions no longer get EXECUTE for PUBLIC (in any
--      schema) or for anon/authenticated (in public). A function a later migration creates
--      is closed until that migration GRANTs it — forgetting the grant now breaks a screen in
--      testing instead of opening a hole in production. **Every later client endpoint must
--      `GRANT EXECUTE ... TO authenticated` explicitly** (they all already do). Tables keep
--      Supabase's default grants; RLS is what guards them.
--   Pinned by supabase/tests/sql/073_client_grants_and_housekeeping as an ALLOWLIST of what
--   `authenticated` may execute, so the next function that should have been revoked fails there.
--
-- HOUSEKEEPING: `kwenta_user_events` had no cleanup (37k rows since March; 014's prune function
-- was never scheduled) and neither had `kwenta_write_submissions` (050). `kwenta_schedule_housekeeping()`
-- upserts two daily pg_cron jobs, both 30 days: events older than that can only matter to a device
-- offline that long, and every app start runs a complete sync anyway (the realtime cursor is a
-- convenience, not the source of truth); a submission marker only matters while a client might
-- still retry, and a retry re-pushes the same row ids, so a late replay cannot mint a duplicate.
-- The migration only DEFINES the scheduler; it does not run it. Once pg_cron is enabled AND the
-- INSERT-only realtime client has been live for a few days (CLIENT NOTE below; an installed PWA
-- keeps its old build until its user taps Refresh), run once as postgres:
--   SELECT public.kwenta_schedule_housekeeping();   -- true = both jobs registered
-- It reports `false` with a NOTICE when pg_cron is absent, and re-running it replaces the jobs.
-- The first run deletes the whole backlog (~31k events on 2026-09-24) in one statement.
--
-- BILLS LIST PILLS: a pill names one person per identity cluster on a bill, represented by the
-- viewer's own contact when one is on the bill and otherwise by the LOWEST id. When the lowest id
-- was another user's private contact linked to an account, the pill printed that user's nickname
-- for the person instead of the person's own account name. The representative is now: the
-- viewer's own live contact on the bill, else the live account reached from an id on the bill
-- (the id itself, or a contact's `linked_profile_id`), else the lowest id; the viewer's own "You"
-- pill keeps 071's id, since nothing but a React key reads it. A soft-deleted contact is outside
-- its account's identity cluster (067), which left it on a pill of its own printing its owner's
-- nickname; for pills only, it is keyed by the account it links to, so it folds into that
-- account's pill. Money is untouched: this changes grouping and labels, never a split. An
-- UNLINKED contact still shows its creator's label, as Bill detail does. `kwenta_personal_bills` is otherwise the 071
-- body verbatim; one extra join to `profiles` by primary key per participant row.
--
-- APPLY: no client change depends on it and no jsonb shape changes. Apply any time. Afterwards,
-- check on production that the allowlist holds (the query in the 073 suite's `test.executable_by`
-- run as `authenticated` and `anon`). The default-privilege change (section 5) applies to every
-- function postgres creates, in any schema; to undo it:
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
--
-- CLIENT NOTE: a prune job HARD-deletes `kwenta_user_events` rows, and Supabase delivers DELETE
-- changes to every subscriber unfiltered, with an empty `new`. The client subscribes to INSERT
-- only and ignores a payload without an id (src/sync/realtime-events.ts). Ship that client before
-- scheduling the jobs; an older client that sees a pruned DELETE writes an unusable realtime cursor
-- — which is why scheduling is a manual step and not part of this migration.

-- ---------------------------------------------------------------------------------------------
-- 1. Server-only functions
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.kwenta_identity_repair_report()                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_identity_repair_apply(boolean)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_repair_resolve_in_group(uuid, uuid, boolean)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_collapse_legacy_credit_plan()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_collapse_legacy_credit_settlements(boolean)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_prune_user_events(timestamptz)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_prune_write_submissions(interval)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_canonical_user_id(uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_settlement_party_id(uuid, uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_empty_reconcile_bundle()                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_repair_orphan_settlements()                       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.kwenta_identity_repair_report()                       TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_identity_repair_apply(boolean)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_resolve_in_group(uuid, uuid, boolean)   TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_collapse_legacy_credit_plan()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_collapse_legacy_credit_settlements(boolean)    TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_prune_user_events(timestamptz)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_prune_write_submissions(interval)              TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_canonical_user_id(uuid)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_settlement_party_id(uuid, uuid)                TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_empty_reconcile_bundle()                       TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_orphan_settlements()                    TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. anon keeps only what RLS policies call
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND p.proowner = current_user::regrole
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND p.proname NOT IN ('is_admin', 'is_group_member',
                            'user_can_read_personal_bill', 'user_is_participant_on_personal_bill')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                        AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Housekeeping
-- ---------------------------------------------------------------------------------------------
/**
 * Registers (or re-registers) the two daily prune jobs. Returns false, with a NOTICE, when pg_cron
 * is not installed. `cron.schedule(name, …)` replaces a job of the same name, so it is safe to run
 * again. Looked up by signature rather than pg_extension so the harness can stand in a stub.
 */
CREATE OR REPLACE FUNCTION public.kwenta_schedule_housekeeping()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF to_regprocedure('cron.schedule(text, text, text)') IS NULL THEN
    RAISE NOTICE 'pg_cron is not installed; kwenta housekeeping jobs were not scheduled';
    RETURN false;
  END IF;

  PERFORM cron.schedule('kwenta-prune-user-events', '17 3 * * *',
    $cmd$SELECT public.kwenta_prune_user_events(now() - interval '30 days')$cmd$);
  PERFORM cron.schedule('kwenta-prune-write-submissions', '27 3 * * *',
    $cmd$SELECT public.kwenta_prune_write_submissions(interval '30 days')$cmd$);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_schedule_housekeeping() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_schedule_housekeeping() TO service_role;

-- Deliberately NOT called here: see CLIENT NOTE in the header.

-- ---------------------------------------------------------------------------------------------
-- 4. The Bills list: pills name a person by their account
-- ---------------------------------------------------------------------------------------------
/**
 * The Bills page in one call. Bucketing rules from 059, payer name and settled map from 065.
 */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bills()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_bills public.bills[];
  v_bill_ids uuid[];
  v_settled jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- The visible personal bills, read once through the privacy boundary and reused below.
  v_bills := ARRAY(
    SELECT b
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  );
  v_bill_ids := ARRAY(SELECT vb.id FROM unnest(v_bills) vb);

  -- One pass for the whole list, so each counterparty's cross-context tab is computed once.
  v_settled := public.kwenta_bills_settled_map(v_bill_ids, v_uid);

  WITH
  me AS MATERIALIZED (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  visible_bills AS MATERIALIZED (SELECT vb.* FROM unnest(v_bills) vb),
  active_items AS MATERIALIZED (
    SELECT bi.id, bi.bill_id
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
    WHERE bi.is_deleted IS FALSE
  ),
  active_splits AS MATERIALIZED (
    SELECT ai.bill_id, sp.user_id
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.is_deleted IS FALSE
  ),
  -- Bills the viewer holds a live split on, once, rather than a scan of every split per bill.
  my_split_bills AS MATERIALIZED (
    SELECT DISTINCT s.bill_id FROM active_splits s WHERE s.user_id IN (SELECT id FROM me)
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = v_uid THEN 'mine'
             WHEN vb.id IN (SELECT bill_id FROM my_split_bills) THEN 'shared'
             ELSE NULL
           END AS bucket
    FROM visible_bills vb
  ),
  kept AS MATERIALIZED (SELECT * FROM bucketed WHERE bucket IS NOT NULL),
  participants AS MATERIALIZED (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  -- Identity is a property of the id, not of the bill: expand each distinct id once.
  -- A soft-deleted contact is outside its account's identity cluster (067), but on a pill it still
  -- names that account: key it by the account so it shares the account's pill (073).
  cluster_keys AS MATERIALIZED (
    SELECT u.uid,
           (SELECT MIN(e.id::text)::uuid
              FROM public.kwenta_expand_identity(
                     COALESCE((SELECT pr.linked_profile_id FROM public.profiles pr
                                WHERE pr.id = u.uid AND pr.is_local IS TRUE AND pr.is_deleted IS TRUE),
                              u.uid),
                     v_uid) e) AS cluster_key
    FROM (SELECT DISTINCT p.uid FROM participants p) u
  ),
  -- Own contact, else the person's live account, else the lowest id: another user's private
  -- contact must not name someone who has an account of their own (073).
  representative AS MATERIALIZED (
    SELECT p.bill_id,
           ck.cluster_key,
           COALESCE(
             MIN(p.uid::text) FILTER (
               WHERE pr.is_deleted IS FALSE AND pr.is_local IS TRUE AND pr.owner_id = v_uid
             ),
             -- The viewer's own pill reads "You" whatever represents it; its id stays as 071 chose.
             CASE WHEN NOT bool_or(p.uid IN (SELECT id FROM me)) THEN MIN(acct.id::text) END,
             MIN(p.uid::text)
           )::uuid AS rep,
           bool_or(p.uid IN (SELECT id FROM me)) AS is_me
    FROM participants p
    JOIN cluster_keys ck ON ck.uid = p.uid
    LEFT JOIN public.profiles pr ON pr.id = p.uid
    LEFT JOIN public.profiles acct
      ON acct.id = CASE WHEN pr.is_local IS TRUE THEN pr.linked_profile_id ELSE p.uid END
     AND acct.is_local IS FALSE
     AND acct.is_deleted IS FALSE
    GROUP BY p.bill_id, ck.cluster_key
  ),
  -- Every name this response prints, resolved once per id (pill labels, their sort key, payers).
  names AS MATERIALIZED (
    SELECT x.id, public.kwenta_peer_display_name(v_uid, x.id) AS name
    FROM (
      SELECT r.rep AS id FROM representative r WHERE NOT r.is_me
      UNION
      SELECT k.paid_by FROM kept k
    ) x
  ),
  pills AS (
    SELECT r.bill_id,
           jsonb_agg(
             jsonb_build_object(
               'id',    r.rep,
               'label', CASE WHEN r.is_me THEN 'You' ELSE n.name END
             )
             ORDER BY r.is_me DESC,
                      CASE WHEN r.is_me THEN '' ELSE n.name END,
                      r.rep
           ) AS pills
    FROM representative r
    LEFT JOIN names n ON n.id = r.rep
    GROUP BY r.bill_id
  ),
  item_counts AS (
    SELECT ai.bill_id, COUNT(*) AS n FROM active_items ai GROUP BY ai.bill_id
  ),
  rows AS (
    SELECT
      k.bucket,
      jsonb_build_object(
        'id',          k.id,
        'title',       k.title,
        'currency',    k.currency,
        'totalAmount', k.total_amount,
        'createdAt',   k.created_at,
        'createdBy',   k.created_by,
        -- Rule 6's roster fallback, via the same resolver as the pills (065). The viewer's own
        -- bills name the viewer here; only the PILL says "You".
        'payorName',   COALESCE(pn.name, 'Someone'),
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     COALESCE((v_settled ->> k.id::text)::boolean, true),
        'category',    k.category,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at,
      k.id
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
    LEFT JOIN names pn ON pn.id = k.paid_by
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. New functions start closed
-- ---------------------------------------------------------------------------------------------
-- Two layers grant a new function: Postgres's built-in default (EXECUTE to PUBLIC, which anon and
-- authenticated inherit) and Supabase's per-schema one (explicit anon, authenticated). A per-schema
-- entry can only ADD to the built-in default, so PUBLIC is removed without `IN SCHEMA`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

SELECT public.kwenta_revoke_acting_user_helpers();
