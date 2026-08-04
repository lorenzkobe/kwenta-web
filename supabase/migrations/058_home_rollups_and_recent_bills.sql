-- 058_home_rollups_and_recent_bills.sql
--
-- The two reads the Home page still made against the local mirror.
--
-- APPLY AFTER 054 (it replaces `kwenta_balances_overview`, defined there) and BEFORE the Home
-- page code that reads `groupReceive` / `groupPay` or calls `kwenta_recent_bills`.
--
-- ---------------------------------------------------------------------------
-- 1. WHY THE OVERVIEW NEEDED A THIRD BUCKET
--
-- 054 returns the personal and the combined buckets. Home renders a third line under each
-- headline — "Group" — and it is NOT `combined - personal`. The combined bucket nets a person's
-- personal and group standings together BEFORE deciding whether they land in receive or pay
-- (someone who owes you 50 personally and is owed 30 in a group is one +20 receive row). The
-- group line is bucketed PER GROUP, unnetted against anything personal. Subtracting one from the
-- other produces a number that is not any quantity the user was ever shown.
--
-- So this ports the actual source: computeAllGroupPairwiseBalances (src/lib/settlement.ts:800)
-- feeding groupReceivePayMapsFromSummaries (src/lib/balance-rollups.ts:13).
--
-- Two parity details that look arbitrary and are not:
--   * Membership is matched on the viewer's EXACT id, not their expanded identity. The TS reads
--     `group_members.where('user_id').equals(userId)`, and the group ledger is exact-id by
--     design (see the 053 header — a viewer-private merge must never move a shared ledger).
--   * The bucket test is `> 0`, not `> EPS`. The per-member nets are already cent-rounded by
--     `kwenta_round_money`, and the TS rollup applies no epsilon at this step. Using EPS here
--     would silently drop a legitimate one-cent group balance that the old screen displayed.
--
-- The two new keys are ADDITIVE. A client built against 054 ignores them and keeps working.
--
-- 2. RECENT BILLS
--
-- Home listed the viewer's five most recent bills straight out of Dexie. That was the last read
-- on that page that could disagree with the server. It selects from `kwenta_pull_rows_bills`
-- rather than filtering `public.bills` directly (CLAUDE.md rule 5): those predicates are the
-- privacy boundary and there is to be exactly one copy of them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kwenta_balances_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Strict comparison, matching people.ts:537-540 / 567-570. See the 054 header on epsilon.
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  peer uuid;
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

  FOR peer IN SELECT id FROM public.kwenta_canonical_peer_ids(v_uid) LOOP
    -- personal-only
    FOR r IN SELECT currency, net FROM public.kwenta_pairwise_personal(v_uid, peer) LOOP
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
      SELECT key AS currency, value::text::numeric AS net
      FROM jsonb_each(public.kwenta_pairwise_breakdown(v_uid, peer) -> 'total')
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

  -- Group bucket: every active membership, bucketed in that group's own currency.
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

/**
 * The viewer's most recent bills for the Home list: the ones THEY paid, newest first.
 *
 * `paid_by` is matched on the exact viewer id, mirroring the Dexie query this replaces
 * (`db.bills.where('paid_by').equals(userId)`). Group name is resolved through the pull-row
 * function too, so a bill in a group the viewer cannot read renders without a name rather than
 * leaking one.
 */
CREATE OR REPLACE FUNCTION public.kwenta_recent_bills(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(row ORDER BY row ->> 'createdAt' DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'id',        b.id,
             'title',     b.title,
             'amount',    b.total_amount,
             'currency',  b.currency,
             'createdAt', b.created_at,
             'groupName', g.name
           ) AS row
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, auth.uid()) b
    LEFT JOIN public.kwenta_pull_rows_groups('epoch'::timestamptz, auth.uid()) g
           ON g.id = b.group_id AND g.is_deleted IS FALSE
    WHERE b.paid_by = auth.uid()
      AND b.is_deleted IS FALSE
    ORDER BY b.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 5), 0)
  ) t;
$$;

REVOKE ALL ON FUNCTION public.kwenta_recent_bills(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_recent_bills(integer) TO authenticated;

-- Restated because CREATE OR REPLACE above does not carry the 054 grant forward on a signature
-- change and re-stating is cheap insurance either way (CLAUDE.md rule 3).
REVOKE ALL ON FUNCTION public.kwenta_balances_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_balances_overview() TO authenticated;
