-- 053_money_group_net_and_breakdown.sql
--
-- Second half of the balance move (CLAUDE.md rule 8): the group pairwise net, the personal +
-- per-group breakdown, and the FIRST client-facing money RPC.
--
-- APPLY AFTER 052 and BEFORE the client code that calls `kwenta_person_summary`.
--
-- ---------------------------------------------------------------------------
-- THE ASYMMETRY THIS MIGRATION EXISTS TO PRESERVE
--
-- The personal net (052) expands identities through the viewer's `linked_profile_id` and
-- `profile_peer_links`. The group net here does the OPPOSITE: it matches ids EXACTLY.
--
-- That is not an oversight, it is the invariant (src/lib/settlement.ts:355-366).
-- `linked_profile_id` lives only on the linking user's own local contacts and is never shared
-- across a group, and `profile_peer_links` is scoped to its owner. If group balances expanded
-- identity the way personal balances do, a viewer-private merge would collapse a roster id for
-- ONE member and not the others — so the same group would produce different balances, and
-- therefore different settle-up suggestions, for different people looking at it. Every member
-- must agree on a shared ledger. `supabase/tests/sql/053_...test.sql` pins this with two members
-- computing mirror-image numbers while one of them holds a private merge.
--
-- The other rule that reads like a bug and is not: the group net SUMS every matching split,
-- while the personal net takes only the FIRST per side per item (052 header, rule 2). Exact-id
-- matching means two rows for one person cannot occur here, so summing is right; under identity
-- expansion it would double-count.
--
-- Currency: a bill or settlement whose currency differs from the group's is DROPPED, never
-- converted. A null or empty currency counts as matching. There is no FX anywhere in Kwenta.
-- ---------------------------------------------------------------------------

/**
 * Pairwise net between `p_viewer` and every other member of one group, from the viewer's
 * perspective: `+` they owe the viewer, `-` the viewer owes them.
 *
 * Port of computeGroupPairwiseBalances (src/lib/settlement.ts:162-270). Returns no rows when the
 * group is missing or soft-deleted (the TS returns null). Active members appear even at net 0 —
 * "settled" is a real answer and the UI needs the row to say so.
 */
CREATE OR REPLACE FUNCTION public.kwenta_group_pairwise(p_group_id uuid, p_viewer uuid)
RETURNS TABLE (member_user_id uuid, display_name text, net numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  g AS (
    SELECT * FROM public.groups WHERE id = p_group_id AND is_deleted IS FALSE
  ),
  -- Joined to `g` so every downstream CTE is empty when the group is gone.
  members AS (
    SELECT gm.* FROM public.group_members gm, g WHERE gm.group_id = p_group_id
  ),
  -- Roster names come from ALL membership rows, including soft-deleted ones, so a removed member
  -- still renders their name instead of "Unknown".
  roster_name AS (
    SELECT m.user_id, NULLIF(BTRIM(m.display_name), '') AS name
    FROM members m
    WHERE NULLIF(BTRIM(m.display_name), '') IS NOT NULL
  ),
  group_bills AS (
    SELECT b.* FROM public.bills b, g
    WHERE b.group_id = p_group_id
      AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = g.currency)
  ),
  active_splits AS (
    SELECT gb.paid_by, sp.user_id, sp.computed_amount
    FROM group_bills gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL
  ),
  bill_deltas AS (
    -- viewer paid, someone else's share -> they owe the viewer
    SELECT s.user_id AS uid, s.computed_amount AS delta
    FROM active_splits s
    WHERE s.paid_by = p_viewer AND s.user_id <> p_viewer
    UNION ALL
    -- someone else paid, the viewer's share -> the viewer owes them
    SELECT s.paid_by AS uid, -s.computed_amount AS delta
    FROM active_splits s
    WHERE s.user_id = p_viewer AND s.paid_by <> p_viewer
  ),
  group_settlements AS (
    SELECT s.* FROM public.settlements s, g
    WHERE s.group_id = p_group_id
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = g.currency)
  ),
  settlement_deltas AS (
    SELECT s.to_user_id AS uid, s.amount AS delta
    FROM group_settlements s
    WHERE s.from_user_id = p_viewer AND s.to_user_id <> p_viewer
    UNION ALL
    SELECT s.from_user_id AS uid, -s.amount AS delta
    FROM group_settlements s
    WHERE s.to_user_id = p_viewer AND s.from_user_id <> p_viewer
  ),
  all_deltas AS (
    SELECT uid, delta FROM bill_deltas
    UNION ALL
    SELECT uid, delta FROM settlement_deltas
    UNION ALL
    SELECT m.user_id, 0 FROM members m WHERE m.is_deleted IS FALSE AND m.user_id <> p_viewer
  ),
  summed AS (
    SELECT d.uid, public.kwenta_round_money(SUM(d.delta)) AS net
    FROM all_deltas d
    WHERE d.uid IS NOT NULL AND d.uid <> p_viewer
    GROUP BY d.uid
  )
  SELECT
    s.uid,
    COALESCE(rn.name, NULLIF(BTRIM(p.display_name), ''), 'Unknown'),
    s.net
  FROM summed s
  LEFT JOIN roster_name rn ON rn.user_id = s.uid
  LEFT JOIN public.profiles p ON p.id = s.uid
  ORDER BY 2, 1;
$$;

/**
 * The full pairwise standing with one person: the personal net plus their net in every shared
 * group. `total` is a plain signed sum of the parts.
 *
 * Port of computePairwiseNetBreakdown (src/lib/people.ts:414-452). Shape:
 *   { "personal": {"PHP": 50}, "groups": [{groupId,groupName,currency,net}], "total": {"PHP": 70} }
 *
 * Groups whose net is within rounding noise are omitted (MONEY_EPSILON = 0.005,
 * src/lib/utils.ts:55) — an effectively-zero group is not a line item.
 */
CREATE OR REPLACE FUNCTION public.kwenta_pairwise_breakdown(p_viewer uuid, p_other uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Matches MONEY_EPSILON in src/lib/utils.ts:55. Amounts are cent-rounded, so a real
  -- obligation is >= 0.01 and anything under half a cent is rounding noise.
  EPS constant numeric := 0.005;
  personal jsonb := '{}'::jsonb;
  total    jsonb := '{}'::jsonb;
  groups   jsonb := '[]'::jsonb;
  r        record;
  v_net    numeric;
  v_other  uuid;
  v_prev   numeric;
BEGIN
  FOR r IN SELECT currency, net FROM public.kwenta_pairwise_personal(p_viewer, p_other) LOOP
    personal := personal || jsonb_build_object(r.currency, r.net);
    total    := total    || jsonb_build_object(r.currency, r.net);
  END LOOP;

  FOR r IN
    SELECT DISTINCT gr.id AS group_id, gr.name, gr.currency
    FROM public.group_members gm
    JOIN public.groups gr ON gr.id = gm.group_id AND gr.is_deleted IS FALSE
    WHERE gm.user_id IN (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer))
      AND gm.is_deleted IS FALSE
  LOOP
    -- Resolve the other person to their id ON THIS ROSTER. Identity expansion is used to FIND
    -- them (a linked contact and the account are the same person); the balance itself is then
    -- computed with exact ids, per the header.
    SELECT gm.user_id INTO v_other
    FROM public.group_members gm
    WHERE gm.group_id = r.group_id
      AND gm.is_deleted IS FALSE
      AND gm.user_id IN (SELECT id FROM public.kwenta_expand_identity(p_other, p_viewer))
    ORDER BY gm.id
    LIMIT 1;

    CONTINUE WHEN v_other IS NULL;

    SELECT gp.net INTO v_net
    FROM public.kwenta_group_pairwise(r.group_id, p_viewer) gp
    WHERE gp.member_user_id = v_other;

    v_net := COALESCE(v_net, 0);
    CONTINUE WHEN ABS(v_net) <= EPS;

    groups := groups || jsonb_build_array(jsonb_build_object(
      'groupId',   r.group_id,
      'groupName', r.name,
      'currency',  r.currency,
      'net',       public.kwenta_round_money(v_net)
    ));

    v_prev := COALESCE((total ->> r.currency)::numeric, 0);
    total := total || jsonb_build_object(
      r.currency, public.kwenta_round_money(v_prev + v_net)
    );
  END LOOP;

  RETURN jsonb_build_object('personal', personal, 'groups', groups, 'total', total);
END;
$$;

-- ---------------------------------------------------------------------------
-- Client-facing surface. The viewer is auth.uid(), never an argument, so a caller can only ever
-- ask about their OWN standing. The p_viewer-taking functions above stay server-internal.
-- ---------------------------------------------------------------------------

/** The Person page hero + its "Right now" drill-down, in one round trip. */
CREATE OR REPLACE FUNCTION public.kwenta_person_summary(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  RETURN public.kwenta_pairwise_breakdown(v_uid, p_person_id);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_group_pairwise(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pairwise_breakdown(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_group_pairwise(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_breakdown(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_person_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_person_summary(uuid) TO authenticated;
