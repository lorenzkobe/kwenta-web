-- 071_bills_list_set_based.sql
--
-- WHAT BROKE: nothing returned a wrong row. The Bills list (`kwenta_personal_bills`, 065) was
-- the slowest endpoint left after 070 (~550 ms live), and the predicate behind it slows every
-- sync too.
--
--   1. `relevant_bill_ids_for_user()` (049) decides which bills a caller may pull. Its first arm
--      was `created_by = me OR (group_id IS NOT NULL AND is_group_member(group_id, me))`: an OR
--      with a per-row function call, which no index can serve, so every evaluation read the
--      WHOLE bills table and called `is_group_member` once per bill in the database. Every
--      `kwenta_sync` / `kwenta_write` pull evaluates it three times (pull_rows_bills, _bill_items,
--      _item_splits each call it).
--   2. `kwenta_personal_bills` evaluated `kwenta_pull_rows_bills` twice (once for the settled
--      map's id list, once for the list itself), so with the item and split pull-rows the
--      predicate above ran four times per request. It also expanded identity once per
--      (bill, participant) row, and resolved each display name twice per pill (label and sort
--      key) plus once per row for the payer.
--   3. `kwenta_related_profile_ids` (054) had the same shape of OR in `candidate_bills`
--      (`group_id IN my groups OR (group_id IS NULL AND created_by IN me)`), so contact discovery
--      scanned every bill on every People and Home load.
--
-- THE SHAPE NOW:
--   * `relevant_bill_ids_for_user()` is a UNION of three arms that can each use an index (the
--     planner may still pick a scan while a table is small):
--     `created_by = me` (idx_bills_created_by); the caller's ACTIVE memberships joined to their
--     groups' bills (idx_group_members_user, idx_bills_group) — `NOT gm.is_deleted` is exactly
--     `is_group_member`'s filter, so former members still lose group bills they did not create,
--     as before; and 049's personal-split arm, whose identity lookup becomes an index probe (see the
--     comment on it). Same signature.
--   * Its three readers — `bills_for_sync` (049) and `kwenta_pull_rows_bill_items/_item_splits`
--     (051) — keep their sets and filter by `= ANY(ARRAY(...))` instead of `IN (SELECT ...)`: the
--     planner guessed 1000 rows for the predicate and hash-joined the whole table against it.
--   * `kwenta_personal_bills` reads the visible bills ONCE, as whole rows, from
--     `kwenta_pull_rows_bills` into an array, and hands the ids to the settled map. Items and
--     splits still come from `kwenta_pull_rows_bill_items` / `_item_splits` — the 051 privacy
--     boundary decides visibility, nothing here re-decides it — each evaluated once. Identity is
--     expanded once per DISTINCT participant id and each display name resolved once per id.
--   * `kwenta_related_profile_ids` splits that OR into two disjoint arms (group bills vs personal
--     bills), each an index lookup. Its output is a set with no defined order, as before.
--
-- EQUIVALENCE, stated so it can be checked: every row, key, bucket, pill, label and flag is what
-- the replaced bodies returned. The one difference in output is ORDER on a created_at tie inside
-- a bucket: the old `ORDER BY created_at DESC` left ties undefined; they are now broken by id, so
-- the list no longer reorders between two loads. Pinned by
-- supabase/tests/sql/071_bills_list_set_based against verbatim copies of the three old bodies,
-- for every account in a fixture that hits each rule (linked contacts both ways, a third party's
-- contact linked to the viewer, a manual merge, a removed member, a deleted group / bill / item /
-- split, a blank profile name with a roster fallback), plus the pull_rows_* sets that ride the
-- predicate.
--
-- GRANTS: unchanged, except that `anon` is now revoked explicitly from the two client-callable
-- functions (Supabase's default privileges can grant it; with no auth.uid() it could only ever see
-- nothing). `CREATE OR REPLACE` keeps each ACL; the sweep runs at the end, as 070 requires.
--
-- APPLY: no client change depends on it and no jsonb shape changes, so it can be applied at any
-- time.

-- ---------------------------------------------------------------------------------------------
-- 1. The bill half of the pull privacy boundary, index-driven
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.relevant_bill_ids_for_user()
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.bills b
  WHERE b.created_by = (SELECT auth.uid())
  UNION
  -- Active membership only: the same filter as is_group_member (004).
  SELECT b.id
  FROM public.group_members gm
  JOIN public.bills b ON b.group_id = gm.group_id
  WHERE gm.user_id = (SELECT auth.uid())
    AND NOT gm.is_deleted
  UNION
  -- `= ANY(ARRAY(...))`, not `IN (SELECT ...)`: with kwenta_identity_ids' default 1000-row
  -- estimate the planner hash-joined the whole item_splits table instead of probing
  -- idx_item_splits_user for the caller's handful of ids. Same set (the ids are never NULL).
  SELECT bi.bill_id
  FROM public.bill_items bi
  JOIN public.item_splits ish ON ish.item_id = bi.id
  JOIN public.bills b2 ON b2.id = bi.bill_id
  WHERE b2.group_id IS NULL
    AND ish.user_id = ANY(ARRAY(SELECT i.id FROM public.kwenta_identity_ids((SELECT auth.uid())) AS i))
    AND NOT COALESCE(ish.is_deleted, false)
    AND NOT COALESCE(bi.is_deleted, false);
$$;

-- The three readers of that predicate. Same sets as 049/051; the only change is `= ANY(ARRAY(...))`
-- in place of `IN (SELECT ...)`: the predicate is a SECURITY DEFINER function the planner cannot
-- see into, so it guessed 1000 rows and hash-joined the WHOLE bills / bill_items table against
-- it. An array of the caller's ids turns each into primary-key / bill_id index probes.
CREATE OR REPLACE FUNCTION public.bills_for_sync(p_since timestamptz)
RETURNS SETOF public.bills
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.*
  FROM public.bills b
  WHERE b.updated_at > p_since
    AND b.id = ANY(ARRAY(SELECT r.id FROM public.relevant_bill_ids_for_user() AS r));
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
    AND bi.bill_id = ANY(ARRAY(SELECT id FROM public.relevant_bill_ids_for_user()));
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
    AND ish.item_id = ANY(ARRAY(
      SELECT bi2.id FROM public.bill_items bi2
      WHERE bi2.bill_id = ANY(ARRAY(SELECT id FROM public.relevant_bill_ids_for_user()))
    ));
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The Bills list
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
  cluster_keys AS MATERIALIZED (
    SELECT u.uid,
           (SELECT MIN(e.id::text)::uuid FROM public.kwenta_expand_identity(u.uid, v_uid) e) AS cluster_key
    FROM (SELECT DISTINCT p.uid FROM participants p) u
  ),
  representative AS MATERIALIZED (
    SELECT p.bill_id,
           ck.cluster_key,
           COALESCE(
             MIN(p.uid::text) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM public.profiles pr
                 WHERE pr.id = p.uid AND pr.is_deleted IS FALSE
                   AND pr.is_local IS TRUE AND pr.owner_id = v_uid
               )
             ),
             MIN(p.uid::text)
           )::uuid AS rep,
           bool_or(p.uid IN (SELECT id FROM me)) AS is_me
    FROM participants p
    JOIN cluster_keys ck ON ck.uid = p.uid
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
-- 3. Contact discovery: one index lookup per bill kind instead of a scan of every bill
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_related_profile_ids(p_viewer uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  my_groups AS (
    SELECT DISTINCT gm.group_id
    FROM public.group_members gm
    WHERE gm.user_id = p_viewer AND gm.is_deleted IS FALSE
  ),
  owned_locals AS (
    SELECT p.id FROM public.profiles p
    WHERE p.owner_id = p_viewer AND p.is_deleted IS FALSE
  ),
  co_members AS (
    SELECT gm.user_id AS id
    FROM public.group_members gm
    JOIN my_groups g ON g.group_id = gm.group_id
    WHERE gm.is_deleted IS FALSE
      AND gm.user_id NOT IN (SELECT id FROM me_ids)
  ),
  -- Two disjoint arms (group bills, personal bills): an OR across them defeated both indexes.
  candidate_bills AS (
    SELECT b.* FROM public.bills b
    WHERE b.is_deleted IS FALSE
      AND b.group_id IN (SELECT group_id FROM my_groups)
    UNION ALL
    SELECT b.* FROM public.bills b
    WHERE b.is_deleted IS FALSE
      AND b.group_id IS NULL
      AND b.created_by IN (SELECT id FROM me_ids)
  ),
  bill_participants AS (
    SELECT cb.id AS bill_id, cb.paid_by AS user_id FROM candidate_bills cb
    UNION
    SELECT bi.bill_id, sp.user_id
    FROM candidate_bills cb
    JOIN public.bill_items bi ON bi.bill_id = cb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
  ),
  -- Only bills the viewer actually takes part in contribute their other participants.
  my_bills AS (
    SELECT DISTINCT bp.bill_id
    FROM bill_participants bp
    WHERE bp.user_id IN (SELECT id FROM me_ids)
  ),
  bill_people AS (
    SELECT bp.user_id AS id
    FROM bill_participants bp
    JOIN my_bills mb ON mb.bill_id = bp.bill_id
    WHERE bp.user_id NOT IN (SELECT id FROM me_ids)
  ),
  settlement_people AS (
    SELECT s.from_user_id AS id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.to_user_id IN (SELECT id FROM me_ids)
      AND s.from_user_id NOT IN (SELECT id FROM me_ids)
    UNION
    SELECT s.to_user_id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.from_user_id IN (SELECT id FROM me_ids)
      AND s.to_user_id NOT IN (SELECT id FROM me_ids)
  )
  SELECT DISTINCT x.id FROM (
    SELECT id FROM owned_locals
    UNION SELECT id FROM co_members
    UNION SELECT id FROM bill_people
    UNION SELECT id FROM settlement_people
  ) x
  WHERE x.id IS NOT NULL;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.relevant_bill_ids_for_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.relevant_bill_ids_for_user() TO authenticated;

REVOKE ALL ON FUNCTION public.kwenta_personal_bills() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills() TO authenticated;

REVOKE ALL ON FUNCTION public.kwenta_related_profile_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_related_profile_ids(uuid) TO service_role;

SELECT public.kwenta_revoke_acting_user_helpers();
