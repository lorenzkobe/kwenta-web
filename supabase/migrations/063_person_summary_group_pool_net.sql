-- 063_person_summary_group_pool_net.sql
--
-- Adds the other person's GROUP-POOL net to each group leg of `kwenta_person_summary`.
--
-- APPLY AFTER 062. Replaces `kwenta_person_summary`, defined in 053.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND NUMBER PER GROUP
--
-- Each group leg already carries `net`: the PAIRWISE net between the viewer and that person in
-- that group — what they owe each OTHER, never involving a third member. The Person export card
-- shows something different: whether that person "receives" or "pays" IN THAT GROUP, which is
-- their standing against the whole pool. The two disagree the moment a third member is involved.
--
--   Bob fronts 90 for himself, Alice and Cara.
--   Pairwise (Alice's view of Bob):  Alice owes Bob 30.
--   Pool (Bob):                      Bob is +60 — he also carries Cara's 30.
--
-- The card said "receives 60"; the pairwise number would make it say "receives 30". Neither is
-- wrong, they answer different questions, and the card asks the pool one. This is the same
-- distinction the 061 header draws between `pairwise` and `memberBalances`, and it is why that
-- one could not simply be reused here.
--
-- `theirNet` is additive: a client built against 053 ignores it.
--
-- IDENTITY: the person is resolved to their id ON EACH ROSTER (expansion is used to FIND them,
-- never to compute), and the pool arithmetic then matches ids exactly — the shared-ledger
-- invariant from the 053 header.
-- ---------------------------------------------------------------------------

/**
 * That person's net against one group's pool: what they fronted minus what they consumed,
 * plus payments they made and minus payments they received. `+` the group owes them.
 *
 * Same arithmetic as the `memberBalances` block of `kwenta_group_detail` (061), for one member.
 */
CREATE OR REPLACE FUNCTION public.kwenta_group_pool_net(p_group_id uuid, p_member uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  g AS (SELECT * FROM public.groups WHERE id = p_group_id AND is_deleted IS FALSE),
  gb AS (
    SELECT b.* FROM public.bills b, g
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = g.currency)
  ),
  sp AS (
    SELECT gb.paid_by, s.user_id, s.computed_amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL
  ),
  gs AS (
    SELECT s.* FROM public.settlements s, g
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = g.currency)
  ),
  deltas AS (
    SELECT sp.computed_amount AS delta FROM sp WHERE sp.paid_by = p_member
    UNION ALL
    SELECT -sp.computed_amount FROM sp WHERE sp.user_id = p_member
    UNION ALL
    SELECT gs.amount FROM gs WHERE gs.from_user_id = p_member
    UNION ALL
    SELECT -gs.amount FROM gs WHERE gs.to_user_id = p_member
  )
  SELECT public.kwenta_round_money(COALESCE((SELECT SUM(delta) FROM deltas), 0));
$$;

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
  v_breakdown jsonb;
  v_groups jsonb := '[]'::jsonb;
  r record;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_breakdown := public.kwenta_pairwise_breakdown(v_uid, p_person_id);

  FOR r IN SELECT * FROM jsonb_array_elements(v_breakdown -> 'groups') AS e(leg) LOOP
    -- Resolve the person to their id on THIS roster before asking for a pool net.
    SELECT gm.user_id INTO v_member
    FROM public.group_members gm
    WHERE gm.group_id = (r.leg ->> 'groupId')::uuid
      AND gm.is_deleted IS FALSE
      AND gm.user_id IN (SELECT id FROM public.kwenta_expand_identity(p_person_id, v_uid))
    ORDER BY gm.id
    LIMIT 1;

    v_groups := v_groups || jsonb_build_array(
      r.leg || jsonb_build_object(
        'theirNet',
        CASE
          WHEN v_member IS NULL THEN 0
          ELSE public.kwenta_group_pool_net((r.leg ->> 'groupId')::uuid, v_member)
        END
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'personal', v_breakdown -> 'personal',
    'groups',   v_groups,
    'total',    v_breakdown -> 'total'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_group_pool_net(uuid, uuid) FROM PUBLIC;
-- Takes the member as an argument, so it stays server-internal.
REVOKE ALL ON FUNCTION public.kwenta_person_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_person_summary(uuid) TO authenticated;
