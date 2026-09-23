-- 070_balance_endpoints_set_based.sql
--
-- WHAT BROKE: nothing returned a wrong number — the balance endpoints were slow, and got slower
-- with every user of the whole app, not just with the viewer's own data.
--
--   1. `kwenta_pairwise_personal` (052) began from EVERY non-deleted personal bill in the
--      database, joined all their items and splits, and only then filtered to bills touching the
--      viewer. Settlements had no index on `from_user_id` / `to_user_id`, so the settlement leg
--      was a full scan too. People (057), Home (058) and the settled map (065) run it once per
--      contact per request, so a screen cost P x (every personal bill in the app).
--   2. `kwenta_pairwise_breakdown` (053) recomputed the WHOLE `kwenta_group_pairwise` of every
--      shared group for every contact it was asked about. People, Home and the Bills list's
--      settled flags each call it once per contact, so one 6-person group shared with 20
--      contacts was recomputed 20 times per screen load.
--   3. `kwenta_balances_overview` (058) additionally computed `kwenta_pairwise_personal` a
--      second time per contact, although the breakdown it also calls carries the same numbers
--      under `personal`.
--   4. `kwenta_groups_with_balances` (059) called `kwenta_group_pairwise` twice per group — once
--      for `totalToReceive`, once for `totalToPay`.
--
-- THE SHAPE NOW:
--   * `kwenta_pairwise_personal_many(p_viewer, p_peers[])` answers the personal net for many
--     people in ONE pass over the VIEWER's bills: the viewer's live personal bills, their live
--     items and every live split on them are read once, by index, and each peer's answer is a
--     join against that set. 052's `relevant_bills` only ever kept bills the viewer pays or holds
--     a live split on, so nothing outside that set can change an answer. Cost is the viewer's
--     own bills plus the peers, not (peers x viewer's bills) and not anyone else's bills. Each
--     lookup is written as `= ANY(<id array>)` so it is an index probe however badly the planner
--     guesses the set sizes (with 1000-row function estimates it hash-joined whole tables).
--     `kwenta_pairwise_personal` is a one-peer call of it — one implementation (rule 8).
--   * `kwenta_pairwise_breakdown_many(p_viewer, p_peers[])` answers the breakdown for many
--     people in ONE statement: the personal legs come from `_personal_many`, and a group's
--     pairwise nets are computed once and shared by every peer — and only for a group at least
--     one requested peer is on, as 053 did, so the one-peer callers (Bill detail per
--     counterparty, `kwenta_bill_settled` per participant, the Person page) do no more group
--     work than before. The per-peer objects are aggregated with one GROUP BY each, not a scan
--     per peer. `kwenta_pairwise_breakdown` is a one-peer call of it.
--   * People, Home and the settled map ask `_many` once for all their peers; the Groups list
--     computes each group once.
--   * `kwenta_expand_identity` gets `ROWS 5` (`ALTER FUNCTION`, signature and ACL unchanged):
--     its default estimate of 1000 rows made every `IN (SELECT id FROM expand(...))` look like a
--     thousand ids, and the planner chose full-table hash joins over the indexes below.
--     A later `CREATE OR REPLACE` of that function resets ROWS to 1000: it must restate `ROWS 5`
--     (the 070 suite asserts it).
--
-- EQUIVALENCE, stated so it can be checked: every rule of the replaced bodies is kept —
-- identity expansion (067), first matching split per side per item (lowest split id), payer
-- precedence (viewer first), settlement precedence (from-other-to-me first), a currency row for
-- every relevant bill with a live item even when it nets to zero, the per-site epsilons, the
-- roster resolution (first ACTIVE member by id among the peer's identity), the group net keyed
-- on the viewer's LITERAL id, rounding. The only difference in output is the ORDER of a
-- breakdown's `groups[]`, which the old loop never defined (no ORDER BY) and which is now name,
-- then id. Pinned by supabase/tests/sql/070_balance_endpoints_set_based against verbatim copies
-- of the old bodies, key for key, for every viewer and profile in a fixture that hits each rule;
-- every earlier suite still passes unchanged.
--
-- INDEXES: added on the columns these functions filter by and never had one. They are built
-- WITHOUT `CONCURRENTLY` on purpose: Supabase runs a migration inside a transaction, where
-- `CREATE INDEX CONCURRENTLY` is refused. Each build holds a SHARE lock on its table, so writes
-- to settlements, bills, profiles and item_splits wait for the build — seconds at today's size.
-- `idx_item_splits_item (item_id)` is dropped: `idx_item_splits_item_user (item_id, user_id)`
-- serves every lookup it served (it is the leading column), nothing depends on it (no
-- constraint uses it), and keeping both only costs every split write a second index update.
--
-- GRANTS: Supabase's default privileges can grant EXECUTE on new public functions to `anon` and
-- `authenticated`, which the `REVOKE ... FROM PUBLIC` in 052-065 does not undo (see the note in
-- 068). The internal money helpers take the acting user as an ARGUMENT (rule 5), so on a database
-- where those default grants took effect, any signed-in user could ask for any two people's
-- balances. This migration revokes them from `anon` and `authenticated` explicitly — by name,
-- and by `kwenta_revoke_acting_user_helpers()`, a sweep over every public `kwenta_*` function
-- with an acting-user INPUT argument. The sweep only covers functions that exist when it runs,
-- so a later migration that adds such a helper must end with
-- `SELECT public.kwenta_revoke_acting_user_helpers();`. Harmless where nothing was granted.
--
-- APPLY: no client change depends on it and no jsonb shape changes, so it can be applied at any
-- time. Apply it to a branch database first and run the grant query in the PR notes against it.

-- ---------------------------------------------------------------------------------------------
-- 1. Indexes, and a realistic row estimate for identity expansion
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_settlements_from_user ON public.settlements (from_user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_to_user   ON public.settlements (to_user_id);
CREATE INDEX IF NOT EXISTS idx_bills_paid_by         ON public.bills (paid_by);
CREATE INDEX IF NOT EXISTS idx_profiles_owner_id     ON public.profiles (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_item_splits_item_user ON public.item_splits (item_id, user_id);
DROP INDEX IF EXISTS public.idx_item_splits_item;

-- An account plus the contacts linked to it; not 1000.
ALTER FUNCTION public.kwenta_expand_identity(uuid, uuid) ROWS 5;

-- ---------------------------------------------------------------------------------------------
-- 2. Personal pairwise net, for many people over the viewer's bills only
-- ---------------------------------------------------------------------------------------------
/**
 * One row per (peer, currency): exactly what `kwenta_pairwise_personal(p_viewer, peer)` (052)
 * returned for that peer. A peer with no personal history has no rows. Server-internal (rule 5).
 */
CREATE OR REPLACE FUNCTION public.kwenta_pairwise_personal_many(p_viewer uuid, p_peers uuid[])
RETURNS TABLE (peer uuid, currency text, net numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me AS MATERIALIZED (
    SELECT ARRAY(SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)) AS ids
  ),
  peer_ids AS MATERIALIZED (
    SELECT p.peer, x.id
    FROM (SELECT DISTINCT unnest(p_peers) AS peer) p
    CROSS JOIN LATERAL public.kwenta_expand_identity(p.peer, p_viewer) x
  ),
  -- The viewer's live personal bills: payer, or a live split on a live item. 052's
  -- `relevant_bills` keeps nothing else, so nothing below needs another user's bills.
  -- The id arrays make each step an index lookup whatever the planner guesses about sizes.
  my_bills AS MATERIALIZED (
    SELECT b.id, b.currency, b.paid_by
    FROM public.bills b
    WHERE b.group_id IS NULL
      AND b.is_deleted IS FALSE
      AND (
        b.paid_by = ANY ((SELECT ids FROM me)::uuid[])
        OR b.id = ANY (ARRAY(
          SELECT bi.bill_id
          FROM public.bill_items bi
          WHERE bi.is_deleted IS FALSE
            AND bi.id = ANY (ARRAY(
              SELECT sp.item_id
              FROM public.item_splits sp
              WHERE sp.user_id = ANY ((SELECT ids FROM me)::uuid[])
                AND sp.is_deleted IS FALSE
            ))
        ))
      )
  ),
  items AS MATERIALIZED (
    SELECT bi.id AS item_id, bi.bill_id
    FROM public.bill_items bi
    WHERE bi.bill_id = ANY (ARRAY(SELECT id FROM my_bills))
      AND bi.is_deleted IS FALSE
  ),
  -- Every live split on those items: the whole participant set of the viewer's bills.
  splits AS MATERIALIZED (
    SELECT sp.id, sp.user_id, sp.computed_amount, sp.item_id
    FROM public.item_splits sp
    WHERE sp.item_id = ANY (ARRAY(SELECT item_id FROM items))
      AND sp.is_deleted IS FALSE
  ),
  -- The FIRST matching split on each item per side, never a sum (052, rule 2).
  my_first AS (
    SELECT DISTINCT ON (s.item_id) s.item_id, s.computed_amount
    FROM splits s
    WHERE s.user_id = ANY ((SELECT ids FROM me)::uuid[])
    ORDER BY s.item_id, s.id
  ),
  peer_splits AS MATERIALIZED (
    SELECT pi.peer, s.id, s.item_id, s.computed_amount
    FROM splits s
    JOIN peer_ids pi ON pi.id = s.user_id
  ),
  other_first AS (
    SELECT DISTINCT ON (ps.peer, ps.item_id) ps.peer, ps.item_id, ps.computed_amount
    FROM peer_splits ps
    ORDER BY ps.peer, ps.item_id, ps.id
  ),
  -- 052's relevant_bills per peer: the viewer's bills the peer pays or holds a live split on.
  relevant AS (
    SELECT pi.peer, mb.id AS bill_id
    FROM my_bills mb
    JOIN peer_ids pi ON pi.id = mb.paid_by
    UNION
    SELECT ps.peer, it.bill_id
    FROM peer_splits ps
    JOIN items it ON it.item_id = ps.item_id
  ),
  bill_net AS (
    SELECT
      r.peer,
      mb.currency,
      SUM(
        CASE
          WHEN mb.paid_by = ANY ((SELECT ids FROM me)::uuid[])
            THEN COALESCE(ofs.computed_amount, 0)
          WHEN payer.id IS NOT NULL
            THEN -COALESCE(mf.computed_amount, 0)
          ELSE 0
        END
      ) AS net
    FROM relevant r
    JOIN my_bills mb ON mb.id = r.bill_id
    JOIN items it ON it.bill_id = r.bill_id
    LEFT JOIN peer_ids payer ON payer.peer = r.peer AND payer.id = mb.paid_by
    LEFT JOIN my_first mf ON mf.item_id = it.item_id
    LEFT JOIN other_first ofs ON ofs.peer = r.peer AND ofs.item_id = it.item_id
    GROUP BY r.peer, mb.currency
  ),
  my_settlements AS MATERIALIZED (
    SELECT s.id, s.currency, s.amount, s.from_user_id, s.to_user_id,
           s.from_user_id = ANY ((SELECT ids FROM me)::uuid[]) AS from_me,
           s.to_user_id   = ANY ((SELECT ids FROM me)::uuid[]) AS to_me
    FROM public.settlements s
    WHERE s.group_id IS NULL
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (s.from_user_id = ANY ((SELECT ids FROM me)::uuid[]) OR s.to_user_id = ANY ((SELECT ids FROM me)::uuid[]))
  ),
  peer_settlements AS (
    SELECT pi.peer, ms.id FROM my_settlements ms JOIN peer_ids pi ON pi.id = ms.from_user_id
    UNION
    SELECT pi.peer, ms.id FROM my_settlements ms JOIN peer_ids pi ON pi.id = ms.to_user_id
  ),
  settlement_net AS (
    SELECT
      ps.peer,
      ms.currency,
      SUM(
        CASE
          -- Same precedence as 052: from-other-to-me is tested first.
          WHEN f.id IS NOT NULL AND ms.to_me THEN -ms.amount
          WHEN ms.from_me AND t.id IS NOT NULL THEN ms.amount
          ELSE 0
        END
      ) AS net
    FROM peer_settlements ps
    JOIN my_settlements ms ON ms.id = ps.id
    LEFT JOIN peer_ids f ON f.peer = ps.peer AND f.id = ms.from_user_id
    LEFT JOIN peer_ids t ON t.peer = ps.peer AND t.id = ms.to_user_id
    WHERE (f.id IS NOT NULL AND ms.to_me) OR (ms.from_me AND t.id IS NOT NULL)
    GROUP BY ps.peer, ms.currency
  ),
  combined AS (
    SELECT peer, currency, net FROM bill_net
    UNION ALL
    SELECT peer, currency, net FROM settlement_net
  )
  SELECT c.peer, c.currency, public.kwenta_round_money(SUM(c.net))
  FROM combined c
  GROUP BY c.peer, c.currency;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pairwise_personal(p_viewer uuid, p_other uuid)
RETURNS TABLE (currency text, net numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pm.currency, pm.net
  FROM public.kwenta_pairwise_personal_many(p_viewer, ARRAY[p_other]) pm;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The breakdown, for many people at once
-- ---------------------------------------------------------------------------------------------
/**
 * `{personal, groups[], total}` per peer — the same object `kwenta_pairwise_breakdown` (053)
 * returned for one peer, with the group work done ONCE for all of them.
 *
 * Rules carried over from 053, deliberately:
 *   - groups are the viewer's active memberships across their whole identity, deleted groups out;
 *   - a peer is found on a roster through their identity (first ACTIVE member by membership id),
 *     but the net itself is the group pairwise keyed on the viewer's LITERAL id (053 header);
 *   - a group leg whose net is within half a cent is omitted;
 *   - total = personal + the kept group nets, per currency, rounded like 053's running sum.
 * One row per DISTINCT peer passed in. Server-internal (rule 5): it takes the viewer as an
 * argument.
 */
CREATE OR REPLACE FUNCTION public.kwenta_pairwise_breakdown_many(p_viewer uuid, p_peers uuid[])
RETURNS TABLE (peer uuid, breakdown jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  peers AS (SELECT DISTINCT x AS peer FROM unnest(p_peers) AS x),
  viewer_groups AS MATERIALIZED (
    SELECT DISTINCT gr.id AS group_id, gr.name, gr.currency
    FROM public.group_members gm
    JOIN public.groups gr ON gr.id = gm.group_id AND gr.is_deleted IS FALSE
    WHERE gm.user_id IN (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer))
      AND gm.is_deleted IS FALSE
  ),
  peer_ids AS MATERIALIZED (
    SELECT p.peer, x.id
    FROM peers p
    CROSS JOIN LATERAL public.kwenta_expand_identity(p.peer, p_viewer) x
  ),
  -- Each peer on each shared roster: the first ACTIVE membership by id among their identity.
  roster AS MATERIALIZED (
    SELECT DISTINCT ON (pi.peer, gm.group_id) pi.peer, gm.group_id, gm.user_id
    FROM peer_ids pi
    JOIN public.group_members gm ON gm.user_id = pi.id AND gm.is_deleted IS FALSE
    JOIN viewer_groups vg ON vg.group_id = gm.group_id
    ORDER BY pi.peer, gm.group_id, gm.id
  ),
  -- A group's pairwise nets, once per group some requested peer is actually on — never for a
  -- group no peer shares (053 skipped those before computing anything).
  group_nets AS MATERIALIZED (
    SELECT rg.group_id, gp.member_user_id, gp.net
    FROM (SELECT DISTINCT group_id FROM roster) rg
    CROSS JOIN LATERAL public.kwenta_group_pairwise(rg.group_id, p_viewer) gp
  ),
  kept_legs AS MATERIALIZED (
    SELECT r.peer, vg.group_id, vg.name, vg.currency, COALESCE(gn.net, 0) AS net
    FROM roster r
    JOIN viewer_groups vg ON vg.group_id = r.group_id
    LEFT JOIN group_nets gn ON gn.group_id = r.group_id AND gn.member_user_id = r.user_id
    WHERE ABS(COALESCE(gn.net, 0)) > 0.005
  ),
  personal AS MATERIALIZED (
    SELECT pm.peer, pm.currency, pm.net
    FROM public.kwenta_pairwise_personal_many(p_viewer, p_peers) pm
  ),
  group_sums AS (
    SELECT k.peer, k.currency, SUM(k.net) AS net FROM kept_legs k GROUP BY k.peer, k.currency
  ),
  personal_json AS (
    SELECT ps.peer, jsonb_object_agg(ps.currency, ps.net) AS j FROM personal ps GROUP BY ps.peer
  ),
  groups_json AS (
    SELECT k.peer,
           jsonb_agg(jsonb_build_object(
             'groupId',   k.group_id,
             'groupName', k.name,
             'currency',  k.currency,
             'net',       public.kwenta_round_money(k.net)
           ) ORDER BY k.name, k.group_id) AS j
    FROM kept_legs k
    GROUP BY k.peer
  ),
  totals_json AS (
    -- A currency with no group leg keeps its personal value as is; one with group legs is
    -- rounded, as 053's running `round(prev + net)` did.
    SELECT t.peer, jsonb_object_agg(t.currency, t.net) AS j
    FROM (
      SELECT COALESCE(ps.peer, gs.peer) AS peer,
             COALESCE(ps.currency, gs.currency) AS currency,
             CASE WHEN gs.peer IS NULL THEN ps.net
                  ELSE public.kwenta_round_money(COALESCE(ps.net, 0) + gs.net) END AS net
      FROM personal ps
      FULL JOIN group_sums gs ON gs.peer = ps.peer AND gs.currency = ps.currency
    ) t
    GROUP BY t.peer
  )
  SELECT
    p.peer,
    jsonb_build_object(
      'personal', COALESCE(pj.j, '{}'::jsonb),
      'groups',   COALESCE(gj.j, '[]'::jsonb),
      'total',    COALESCE(tj.j, '{}'::jsonb)
    )
  FROM peers p
  LEFT JOIN personal_json pj ON pj.peer = p.peer
  LEFT JOIN groups_json   gj ON gj.peer = p.peer
  LEFT JOIN totals_json   tj ON tj.peer = p.peer;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_pairwise_breakdown(p_viewer uuid, p_other uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT bm.breakdown
  FROM public.kwenta_pairwise_breakdown_many(p_viewer, ARRAY[p_other]) bm;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The endpoints that loop over people: one breakdown call for all of them
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_contacts_with_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_peers uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_peers := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(v_uid));

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'peerId',      p.id,
      'displayName', public.kwenta_peer_display_name(v_uid, p.id),
      'subtitle',    public.kwenta_peer_subtitle(p.id),
      'net',         bm.breakdown -> 'total'
    ) ORDER BY p.ord)
    FROM unnest(v_peers) WITH ORDINALITY AS p(id, ord)
    JOIN public.kwenta_pairwise_breakdown_many(v_uid, v_peers) bm ON bm.peer = p.id
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_balances_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Strict comparison, as in 058.
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  v_peers uuid[];
  bm record;
  r record;
  personal_receive jsonb := '{}'::jsonb;
  personal_pay     jsonb := '{}'::jsonb;
  combined_receive jsonb := '{}'::jsonb;
  combined_pay     jsonb := '{}'::jsonb;
  group_receive    jsonb := '{}'::jsonb;
  group_pay        jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_peers := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(v_uid));

  FOR bm IN SELECT * FROM public.kwenta_pairwise_breakdown_many(v_uid, v_peers) LOOP
    -- personal-only: the breakdown's `personal` IS kwenta_pairwise_personal's answer, which 058
    -- computed a second time here.
    FOR r IN
      SELECT key AS currency, value::text::numeric AS net FROM jsonb_each(bm.breakdown -> 'personal')
    LOOP
      IF r.net > EPS THEN
        personal_receive := personal_receive || jsonb_build_object(
          r.currency, COALESCE((personal_receive ->> r.currency)::numeric, 0) + r.net);
      ELSIF r.net < -EPS THEN
        personal_pay := personal_pay || jsonb_build_object(
          r.currency, COALESCE((personal_pay ->> r.currency)::numeric, 0) + ABS(r.net));
      END IF;
    END LOOP;

    -- combined (personal + every shared group)
    FOR r IN
      SELECT key AS currency, value::text::numeric AS net FROM jsonb_each(bm.breakdown -> 'total')
    LOOP
      IF r.net > EPS THEN
        combined_receive := combined_receive || jsonb_build_object(
          r.currency, COALESCE((combined_receive ->> r.currency)::numeric, 0) + r.net);
      ELSIF r.net < -EPS THEN
        combined_pay := combined_pay || jsonb_build_object(
          r.currency, COALESCE((combined_pay ->> r.currency)::numeric, 0) + ABS(r.net));
      END IF;
    END LOOP;
  END LOOP;

  -- Group bucket: every active membership, bucketed in that group's own currency (058).
  FOR r IN
    SELECT g.currency,
           SUM(GREATEST(gp.net, 0))       AS to_receive,
           SUM(GREATEST(-gp.net, 0))      AS to_pay
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_deleted IS FALSE
    CROSS JOIN LATERAL public.kwenta_group_pairwise(gm.group_id, v_uid) gp
    WHERE gm.user_id = v_uid
      AND gm.is_deleted IS FALSE
    GROUP BY gm.group_id, g.currency
  LOOP
    IF r.to_receive > 0 THEN
      group_receive := group_receive || jsonb_build_object(
        r.currency, COALESCE((group_receive ->> r.currency)::numeric, 0) + r.to_receive);
    END IF;
    IF r.to_pay > 0 THEN
      group_pay := group_pay || jsonb_build_object(
        r.currency, COALESCE((group_pay ->> r.currency)::numeric, 0) + r.to_pay);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'personalReceive', personal_receive,
    'personalPay',     personal_pay,
    'combinedReceive', combined_receive,
    'combinedPay',     combined_pay,
    'groupReceive',    group_receive,
    'groupPay',        group_pay
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_bills_settled_map(
  p_bill_ids uuid[],
  p_viewer uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  EPS AS (SELECT 0.005::numeric AS v),
  subject AS (
    SELECT b.id, b.currency, b.paid_by, b.is_deleted
    FROM public.bills b
    WHERE b.id = ANY(p_bill_ids)
  ),
  live AS (SELECT * FROM subject WHERE is_deleted IS FALSE),
  participants AS (
    SELECT l.id AS bill_id, l.paid_by AS uid
    FROM live l
    WHERE l.paid_by IS NOT NULL AND l.paid_by <> p_viewer
    UNION
    SELECT bi.bill_id, sp.user_id
    FROM public.bill_items bi
    JOIN live l ON l.id = bi.bill_id
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE bi.is_deleted IS FALSE
      AND sp.user_id IS NOT NULL
      AND sp.user_id <> p_viewer
  ),
  -- Every distinct counterparty's tab in ONE breakdown call (065 made it one call per peer).
  peer_totals AS MATERIALIZED (
    SELECT bm.peer AS uid, bm.breakdown -> 'total' AS totals
    FROM public.kwenta_pairwise_breakdown_many(
      p_viewer, ARRAY(SELECT DISTINCT p.uid FROM participants p)
    ) bm
  ),
  unsettled AS (
    SELECT DISTINCT p.bill_id
    FROM participants p
    JOIN peer_totals pt ON pt.uid = p.uid
    JOIN live l ON l.id = p.bill_id
    WHERE ABS(COALESCE((pt.totals ->> l.currency)::numeric, 0)) > (SELECT v FROM EPS)
  )
  SELECT COALESCE(
    jsonb_object_agg(
      s.id::text,
      s.is_deleted IS TRUE
        OR NOT EXISTS (SELECT 1 FROM unsettled u WHERE u.bill_id = s.id)
    ),
    '{}'::jsonb
  )
  FROM subject s;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Groups list: each group's pairwise once, not twice
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_groups_with_balances()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'groupId',        t.group_id,
      'name',           t.name,
      'currency',       t.currency,
      'memberCount',    t.member_count,
      'updatedAt',      t.updated_at,
      'totalToReceive', public.kwenta_round_money(t.to_receive),
      'totalToPay',     public.kwenta_round_money(t.to_pay)
    ) ORDER BY t.name, t.group_id
  ), '[]'::jsonb)
  FROM (
    SELECT
      g.id AS group_id,
      g.name,
      g.currency,
      g.updated_at,
      (SELECT COUNT(*) FROM public.group_members m
        WHERE m.group_id = g.id AND m.is_deleted IS FALSE) AS member_count,
      nets.to_receive,
      nets.to_pay
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_deleted IS FALSE
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(GREATEST(gp.net, 0)), 0)  AS to_receive,
             COALESCE(SUM(GREATEST(-gp.net, 0)), 0) AS to_pay
      FROM public.kwenta_group_pairwise(g.id, auth.uid()) gp
    ) nets
    WHERE gm.user_id = auth.uid()
      AND gm.is_deleted IS FALSE
  ) t;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------------------------
-- Server-internal helpers (rule 5): never client-callable, whatever default privileges granted.
REVOKE ALL ON FUNCTION public.kwenta_pairwise_personal(uuid, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_pairwise_personal_many(uuid, uuid[])     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_group_pairwise(uuid, uuid)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_pairwise_breakdown(uuid, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_pairwise_breakdown_many(uuid, uuid[])    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_related_profile_ids(uuid)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_canonical_peer_ids(uuid)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_peer_display_name(uuid, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_peer_subtitle(uuid)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_bills_settled_map(uuid[], uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_group_pool_net(uuid, uuid)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_expand_identity(uuid, uuid)              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_personal(uuid, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_personal_many(uuid, uuid[])  TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_group_pairwise(uuid, uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_breakdown(uuid, uuid)        TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_breakdown_many(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_related_profile_ids(uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_canonical_peer_ids(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_peer_display_name(uuid, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_peer_subtitle(uuid)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_bills_settled_map(uuid[], uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_group_pool_net(uuid, uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_expand_identity(uuid, uuid)           TO service_role;

/**
 * The sweep: every public kwenta_* function with an INPUT argument that names the acting user
 * (`p_viewer`, `p_uid`, `uid`, `p_owner`) is made server-only. Only input arguments count — an
 * OUT or RETURNS TABLE column called `uid` says nothing about who may call the function, and
 * matching it would silently revoke a client endpoint. Returns how many functions it touched.
 *
 * It covers the functions that exist when it runs, and no more: a later migration that adds such
 * a helper must end with `SELECT public.kwenta_revoke_acting_user_helpers();`. Owner-run
 * (SECURITY DEFINER) because only a function's owner may change its grants.
 */
CREATE OR REPLACE FUNCTION public.kwenta_revoke_acting_user_helpers()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  f record;
  n integer := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname LIKE 'kwenta%'
      AND EXISTS (
        SELECT 1
        FROM generate_subscripts(p.proargnames, 1) AS i
        WHERE p.proargnames[i] IN ('p_viewer', 'p_uid', 'uid', 'p_owner')
          -- NULL proargmodes means every argument is IN.
          AND (p.proargmodes IS NULL OR p.proargmodes[i] IN ('i', 'b', 'v'))
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_revoke_acting_user_helpers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_revoke_acting_user_helpers() TO service_role;

-- Client endpoints: signed-in users only, never anon.
REVOKE ALL ON FUNCTION public.kwenta_contacts_with_balances() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_balances_overview()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_groups_with_balances()   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_contacts_with_balances() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_balances_overview()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_groups_with_balances()   TO authenticated;

-- Last, so it also covers every function this migration created.
SELECT public.kwenta_revoke_acting_user_helpers();
