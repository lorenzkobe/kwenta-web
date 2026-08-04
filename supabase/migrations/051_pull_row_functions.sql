-- 051_pull_row_functions.sql
--
-- One source of truth for "which rows may this user see".
--
-- Context. The read path is moving from a single complete-bundle pull to a set of scoped,
-- server-computed endpoints (balances, contacts, per-person, per-bill, per-group, search).
-- Each of those needs the same visibility predicates the pull bundle already encodes. If every
-- new endpoint copies its own `WHERE`, the predicates drift — and these predicates ARE the
-- privacy boundary, so drift is a cross-account leak, not a slow query. Migration 049 had just
-- finished consolidating them; fanning them back out would undo that.
--
-- So: this migration lifts each table's row set out of `kwenta_build_pull_bundle` (049:233-326)
-- into a `kwenta_pull_rows_<table>(p_since, uid)` function, and rewrites the bundle as a thin
-- wrapper over those. Behaviour is unchanged — the bodies are verbatim, the bundle's shape and
-- ordering are untouched — and every future read endpoint selects from these functions.
--
-- THE RULE, for whoever adds the next endpoint:
--   Every predicate deciding what a user may read lives in a `kwenta_pull_rows_*` function and
--   nowhere else. A read endpoint must not inline a WHERE clause over a base table. A reviewer
--   can check this mechanically: no `FROM public.<base table>` inside a read RPC body.
--
-- SECURITY. These take `uid` as an argument, so a caller who could execute them directly could
-- read any user's rows by passing someone else's id. They are therefore NOT granted to
-- `authenticated` — exactly like `kwenta_identity_ids` (048:59-61). Every caller is SECURITY
-- DEFINER and runs as the owner, so the grants below are sufficient.
--
-- Two inherited quirks are reproduced deliberately rather than "fixed", because changing them
-- would change what users receive and this migration must be a no-op:
--   * `bills_for_sync(p_since)` and `relevant_bill_ids_for_user()` resolve the caller through
--     `auth.uid()` internally and ignore the `uid` argument. That is safe only because every
--     caller passes `uid := auth.uid()` (`kwenta_sync` at 044:489 / 050:44). The `uid` parameter
--     is kept on the bills/bill_items/item_splits wrappers for signature symmetry, and is
--     deliberately unused. Do not add a caller that passes a different uid.
--   * `relevant_bill_ids_for_user()` is still evaluated independently by bills, bill_items and
--     item_splits. Materialising it once would mean inlining the three predicates into a single
--     statement, which is exactly what this migration exists to prevent.

-- ---------------------------------------------------------------------------
-- Per-table row sets. Bodies verbatim from 049:233-326.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_profiles(p_since timestamptz, uid uuid)
RETURNS SETOF public.profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.*
  FROM public.profiles p
  WHERE p.updated_at > p_since
    AND (
      p.id = uid
      OR (p.is_local IS TRUE AND p.owner_id = uid)
      OR (p.is_local IS TRUE AND p.linked_profile_id = uid AND p.is_deleted IS FALSE)
    );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_groups(p_since timestamptz, uid uuid)
RETURNS SETOF public.groups
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.*
  FROM public.groups g
  WHERE g.id IN (
      SELECT gm.group_id FROM public.group_members gm
      WHERE gm.user_id = uid
    )
    AND (
      g.updated_at > p_since
      OR EXISTS (
        SELECT 1 FROM public.group_members gm2
        WHERE gm2.group_id = g.id
          AND gm2.user_id = uid
          AND gm2.updated_at > p_since
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_group_members(p_since timestamptz, uid uuid)
RETURNS SETOF public.group_members
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gm.*
  FROM public.group_members gm
  WHERE gm.updated_at > p_since
    AND (
      gm.user_id = uid
      OR gm.group_id IN (
        SELECT m.group_id FROM public.group_members m
        WHERE m.user_id = uid AND m.is_deleted IS FALSE
      )
    );
$$;

-- `uid` unused: bills_for_sync resolves the caller via auth.uid(). See the header note.
CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_bills(p_since timestamptz, uid uuid)
RETURNS SETOF public.bills
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.* FROM public.bills_for_sync(p_since) AS b;
$$;

-- `uid` unused: relevant_bill_ids_for_user resolves the caller via auth.uid().
CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_bill_items(p_since timestamptz, uid uuid)
RETURNS SETOF public.bill_items
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT bi.*
  FROM public.bill_items bi
  WHERE bi.updated_at > p_since
    AND bi.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user());
$$;

-- `uid` unused: relevant_bill_ids_for_user resolves the caller via auth.uid().
CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_item_splits(p_since timestamptz, uid uuid)
RETURNS SETOF public.item_splits
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ish.*
  FROM public.item_splits ish
  WHERE ish.updated_at > p_since
    AND ish.item_id IN (
      SELECT bi2.id FROM public.bill_items bi2
      WHERE bi2.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())
    );
$$;

-- Group arm deliberately uses ALL membership rows (any is_deleted state) so a deletion still
-- reaches former members — see 024. The personal arm routes by identity set, not literal id — 049.
CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_settlements(p_since timestamptz, uid uuid)
RETURNS SETOF public.settlements
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.*
  FROM public.settlements s
  WHERE s.updated_at > p_since
    AND s.group_id IS NOT NULL
    AND s.group_id IN (
      SELECT gm.group_id FROM public.group_members gm
      WHERE gm.user_id = uid
    )
  UNION ALL
  SELECT s2.*
  FROM public.settlements s2
  WHERE s2.updated_at > p_since
    AND s2.group_id IS NULL
    AND (
      s2.from_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
      OR s2.to_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
    );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_activity_log(p_since timestamptz, uid uuid)
RETURNS SETOF public.activity_log
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT al.*
  FROM public.activity_log al
  WHERE al.updated_at > p_since
    AND (
      al.user_id = uid
      OR (
        al.group_id IS NOT NULL
        AND al.group_id IN (
          SELECT gm.group_id FROM public.group_members gm
          WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pull_rows_profile_peer_links(p_since timestamptz, uid uuid)
RETURNS SETOF public.profile_peer_links
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ppl.*
  FROM public.profile_peer_links ppl
  WHERE ppl.updated_at > p_since
    AND ppl.owner_user_id = uid;
$$;

-- Not callable by clients: the uid argument would otherwise let any authenticated user read any
-- other user's rows. Internal SECURITY DEFINER callers run as the owner and are unaffected.
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_profiles(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_groups(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_group_members(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_bills(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_bill_items(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_item_splits(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_settlements(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_activity_log(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pull_rows_profile_peer_links(timestamptz, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_profiles(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_groups(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_group_members(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_bills(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_bill_items(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_item_splits(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_settlements(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_activity_log(timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pull_rows_profile_peer_links(timestamptz, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The bundle, now a wrapper. Same signature, same keys, same shape as 049.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_build_pull_bundle(p_since timestamptz, uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profiles',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_profiles(p_since, uid) t),
    'groups',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_groups(p_since, uid) t),
    'group_members',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_group_members(p_since, uid) t),
    'bills',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_bills(p_since, uid) t),
    'bill_items',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_bill_items(p_since, uid) t),
    'item_splits',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_item_splits(p_since, uid) t),
    'settlements',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_settlements(p_since, uid) t),
    'activity_log',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_activity_log(p_since, uid) t),
    'profile_peer_links',
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_profile_peer_links(p_since, uid) t)
  );
$$;
