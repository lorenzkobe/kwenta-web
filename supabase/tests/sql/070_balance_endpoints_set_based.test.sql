-- 070_balance_endpoints_set_based.test.sql
--
-- Migration 070 is a PERFORMANCE change to the balance endpoints and must not move a single cent,
-- a single key or a single bucket. This file pins every rewritten function against a verbatim
-- copy of the body it replaced (test.old_*), over one fixture built to hit every rule those
-- bodies encode: a linked contact and its account, a manual peer merge, a third party's contact
-- linked to the same account, overpayment flipping the sign, several currencies, a deleted item,
-- an unsettled payment, a removed group member, an off-currency group bill, a deleted group, a
-- group the viewer is not in, and bills between users the viewer never meets (which the old
-- personal pairwise scanned and the new one must ignore without changing any answer).
--
-- A breakdown's groups[] (and the person summary's, built from it) is the one array whose order
-- the OLD body never defined (a loop with no ORDER BY): it is compared order-insensitively via
-- test.canon, and the NEW order (name, then id) is asserted directly. Everything else — the
-- contacts list included, whose order follows kwenta_canonical_peer_ids in both — is exact.
--
-- Do not "tidy" the test.old_* copies: their value is being an independent second opinion.

SET client_min_messages = notice;

-- verbatim from 052_money_identity_and_personal_net.sql (kwenta_pairwise_personal); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_pairwise_personal(p_viewer uuid, p_other uuid)
RETURNS TABLE (currency text, net numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids    AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  other_ids AS (SELECT id FROM public.kwenta_expand_identity(p_other,  p_viewer)),

  personal_bills AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  ),
  -- Active items and splits only, mirroring loadBalanceSnapshot's filters (people.ts:45-51).
  active_splits AS (
    SELECT sp.id, sp.user_id, sp.computed_amount, bi.id AS item_id, bi.bill_id
    FROM public.item_splits sp
    JOIN public.bill_items bi ON bi.id = sp.item_id
    JOIN personal_bills pb ON pb.id = bi.bill_id
    WHERE sp.is_deleted IS FALSE AND bi.is_deleted IS FALSE
  ),
  -- payer + everyone on an active split (people.ts:66-73)
  participants AS (
    SELECT pb.id AS bill_id, pb.paid_by AS user_id FROM personal_bills pb
    UNION
    SELECT a.bill_id, a.user_id FROM active_splits a
  ),
  -- profileSetTouchesBill (people.ts:803-810)
  relevant_bills AS (
    SELECT pb.*
    FROM personal_bills pb
    WHERE (
      EXISTS (SELECT 1 FROM participants pt JOIN me_ids m ON m.id = pt.user_id WHERE pt.bill_id = pb.id)
      OR pb.paid_by IN (SELECT id FROM me_ids)
    ) AND (
      EXISTS (SELECT 1 FROM participants pt JOIN other_ids o ON o.id = pt.user_id WHERE pt.bill_id = pb.id)
      OR pb.paid_by IN (SELECT id FROM other_ids)
    )
  ),
  -- Rule 2: the FIRST matching split on each item per side, never a sum.
  per_item AS (
    SELECT
      rb.currency,
      rb.paid_by,
      (SELECT a.computed_amount FROM active_splits a
        WHERE a.item_id = bi.id AND a.user_id IN (SELECT id FROM me_ids)
        ORDER BY a.id LIMIT 1) AS my_amount,
      (SELECT a.computed_amount FROM active_splits a
        WHERE a.item_id = bi.id AND a.user_id IN (SELECT id FROM other_ids)
        ORDER BY a.id LIMIT 1) AS other_amount
    FROM relevant_bills rb
    JOIN public.bill_items bi ON bi.bill_id = rb.id AND bi.is_deleted IS FALSE
  ),
  bill_net AS (
    SELECT
      pi.currency,
      SUM(
        CASE
          -- The viewer paid: the other side's share is owed to the viewer. `me` wins when an id
          -- is somehow in both sets, matching the if/else-if order in TS.
          WHEN pi.paid_by IN (SELECT id FROM me_ids)
            THEN COALESCE(pi.other_amount, 0)
          WHEN pi.paid_by IN (SELECT id FROM other_ids)
            THEN -COALESCE(pi.my_amount, 0)
          ELSE 0
        END
      ) AS net
    FROM per_item pi
    GROUP BY pi.currency
  ),
  settlement_net AS (
    SELECT
      s.currency,
      SUM(
        CASE
          -- Same precedence as TS: from-other-to-me is tested first.
          WHEN s.from_user_id IN (SELECT id FROM other_ids)
           AND s.to_user_id   IN (SELECT id FROM me_ids)    THEN -s.amount
          WHEN s.from_user_id IN (SELECT id FROM me_ids)
           AND s.to_user_id   IN (SELECT id FROM other_ids) THEN  s.amount
          ELSE 0
        END
      ) AS net
    FROM public.settlements s
    WHERE s.group_id IS NULL
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (
        (s.from_user_id IN (SELECT id FROM me_ids)    AND s.to_user_id IN (SELECT id FROM other_ids))
        OR
        (s.from_user_id IN (SELECT id FROM other_ids) AND s.to_user_id IN (SELECT id FROM me_ids))
      )
    GROUP BY s.currency
  ),
  combined AS (
    SELECT currency, net FROM bill_net
    UNION ALL
    SELECT currency, net FROM settlement_net
  )
  SELECT c.currency, public.kwenta_round_money(SUM(c.net)) AS net
  FROM combined c
  GROUP BY c.currency;
$$;

-- verbatim from 053_money_group_net_and_breakdown.sql (kwenta_pairwise_breakdown); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_pairwise_breakdown(p_viewer uuid, p_other uuid)
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
  FOR r IN SELECT currency, net FROM test.old_pairwise_personal(p_viewer, p_other) LOOP
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

-- verbatim from 057_contacts_subtitle.sql (kwenta_contacts_with_balances); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_contacts_with_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  out jsonb := '[]'::jsonb;
  peer uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  FOR peer IN SELECT id FROM public.kwenta_canonical_peer_ids(v_uid) LOOP
    out := out || jsonb_build_array(jsonb_build_object(
      'peerId',      peer,
      'displayName', public.kwenta_peer_display_name(v_uid, peer),
      'subtitle',    public.kwenta_peer_subtitle(peer),
      'net',         test.old_pairwise_breakdown(v_uid, peer) -> 'total'
    ));
  END LOOP;

  RETURN out;
END;
$$;

-- verbatim from 058_home_rollups_and_recent_bills.sql (kwenta_balances_overview); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_balances_overview()
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
    FOR r IN SELECT currency, net FROM test.old_pairwise_personal(v_uid, peer) LOOP
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
      FROM jsonb_each(test.old_pairwise_breakdown(v_uid, peer) -> 'total')
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

-- verbatim from 059_list_pages.sql (kwenta_groups_with_balances); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_groups_with_balances()
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
      COALESCE((SELECT SUM(GREATEST(gp.net, 0))
                FROM public.kwenta_group_pairwise(g.id, auth.uid()) gp), 0) AS to_receive,
      COALESCE((SELECT SUM(GREATEST(-gp.net, 0))
                FROM public.kwenta_group_pairwise(g.id, auth.uid()) gp), 0) AS to_pay
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_deleted IS FALSE
    WHERE gm.user_id = auth.uid()
      AND gm.is_deleted IS FALSE
  ) t;
$$;

-- verbatim from 065_list_settled_map_and_payor_names.sql (kwenta_bills_settled_map); only the name and the calls to its
-- sibling references are rewritten to point at the other test.old_* copies.
CREATE OR REPLACE FUNCTION test.old_bills_settled_map(
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
  -- The whole point of this function. DISTINCT must be taken BEFORE the call, not
  -- in the same SELECT as it — `SELECT DISTINCT uid, f(uid)` evaluates f per input
  -- row and dedupes afterwards, which is the N+1 all over again. MATERIALIZED stops
  -- the planner inlining the call back into the join below.
  peers AS (SELECT DISTINCT p.uid FROM participants p),
  peer_totals AS MATERIALIZED (
    SELECT pe.uid,
           test.old_pairwise_breakdown(p_viewer, pe.uid) -> 'total' AS totals
    FROM peers pe
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

-- verbatim from 063_person_summary_group_pool_net.sql (kwenta_person_summary); name and the
-- breakdown call rewritten only.
CREATE OR REPLACE FUNCTION test.old_person_summary(p_person_id uuid)
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

  v_breakdown := test.old_pairwise_breakdown(v_uid, p_person_id);

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

/** jsonb with every array sorted by element text, recursively: order-insensitive equality. */
CREATE OR REPLACE FUNCTION test.canon(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  out jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p)
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(c ORDER BY c::text), '[]'::jsonb) INTO out
      FROM (SELECT test.canon(e) AS c FROM jsonb_array_elements(p) e) s;
      RETURN out;
    WHEN 'object' THEN
      SELECT COALESCE(jsonb_object_agg(k, test.canon(v)), '{}'::jsonb) INTO out
      FROM jsonb_each(p) AS t(k, v);
      RETURN out;
    ELSE
      RETURN p;
  END CASE;
END;
$$;

/** Run a query returning one jsonb; an error becomes {"error": message} so "both refuse" compares. */
CREATE OR REPLACE FUNCTION test.try_json(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  out jsonb;
BEGIN
  EXECUTE p_sql INTO out;
  RETURN out;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_json_eq(p_actual jsonb, p_expected jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    PERFORM test.fail(p_what, COALESCE(p_expected::text, 'null'), COALESCE(p_actual::text, 'null'));
  END IF;
END;
$$;

/** A breakdown-shaped object with groups[] canonicalised and every other key left exact. */
CREATE OR REPLACE FUNCTION test.canon_groups(p jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) <> 'object' OR NOT (p ? 'groups') THEN p
              ELSE jsonb_set(p, '{groups}', test.canon(p -> 'groups')) END;
$$;

/** groups[] is ordered by groupName, then groupId. */
CREATE OR REPLACE FUNCTION test.groups_in_name_order(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p -> 'groups', '[]'::jsonb) = COALESCE((
    SELECT jsonb_agg(e ORDER BY e ->> 'groupName', (e ->> 'groupId')::uuid)
    FROM jsonb_array_elements(p -> 'groups') e
  ), '[]'::jsonb);
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO authenticated;

-- ---------------------------------------------------------------------------
-- Fixture + old-vs-new comparison for every viewer and every profile id
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a uuid; b uuid; c uuid; d uuid; e uuid;
  ca_b uuid; ca_l uuid; ca_l2 uuid; cb_a uuid; cd_b uuid;
  fs_bill uuid; fs_item uuid;
  g1 uuid; g2 uuid; g3 uuid; g4 uuid;
  bill uuid; s uuid; gm_d uuid;
  viewers uuid[];
  everyone uuid[];
  all_bills uuid[];
  v uuid; o uuid;
  n_pairs int := 0;
  n_multi_group int := 0;
  bd jsonb;
BEGIN
  a := test.new_account('p70-a@example.com', 'Alice');
  b := test.new_account('p70-b@example.com', 'Bob');
  c := test.new_account('p70-c@example.com', 'Cha');
  d := test.new_account('p70-d@example.com', 'Dan');
  e := test.new_account('p70-e@example.com', 'Eve');

  ca_b  := test.new_contact(a, 'Bee', b);        -- Alice's contact linked to Bob
  ca_l  := test.new_contact(a, 'Loco');          -- Alice's local-only contact
  ca_l2 := test.new_contact(a, 'Cee');           -- merged to Cha by hand below
  cb_a  := test.new_contact(b, 'Ay', a);         -- Bob's contact linked to Alice
  cd_b  := test.new_contact(d, 'Bobby', b);      -- a THIRD party's contact linked to Bob (067)

  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), a, ca_l2, c, now(), now(), now(), false, 'test');

  -- Personal bills
  PERFORM test.new_bill(a, a, NULL, 'dinner', 300, ARRAY[a, ca_b, ca_l]);
  PERFORM test.new_bill(b, b, NULL, 'taxi', 100, ARRAY[b, cb_a]);
  PERFORM test.new_bill(a, a, NULL, 'usd lunch', 50, ARRAY[a, b], 'USD');
  PERFORM test.new_bill(a, a, NULL, 'merged', 90, ARRAY[ca_l2, a]);
  PERFORM test.new_bill(c, c, NULL, 'coffee', 40, ARRAY[c, a]);
  PERFORM test.new_bill(a, a, NULL, 'both ids on one item', 60, ARRAY[a, ca_b, b]);
  PERFORM test.new_bill(a, ca_b, NULL, 'bob paid via contact', 80, ARRAY[a, ca_b]);
  bill := test.new_bill(a, a, NULL, 'deleted item', 999, ARRAY[a, ca_b]);
  UPDATE public.bill_items SET is_deleted = true WHERE bill_id = bill;
  bill := test.new_bill(a, a, NULL, 'deleted bill', 777, ARRAY[a, b]);
  UPDATE public.bills SET is_deleted = true WHERE id = bill;
  PERFORM test.new_bill(a, a, NULL, 'empty currency', 20, ARRAY[a, b], '');
  -- Paid for others only: the viewer is the payer and holds NO split. The scoped personal
  -- pairwise must still find this bill through `paid_by`, not only through the viewer's splits.
  PERFORM test.new_bill(a, a, NULL, 'treat for bob', 64, ARRAY[b]);
  PERFORM test.new_bill(b, b, NULL, 'bob treats alice', 26, ARRAY[a]);
  -- Strangers: must not change any of Alice's answers
  PERFORM test.new_bill(d, d, NULL, 'strangers', 70, ARRAY[d, e]);
  PERFORM test.new_bill(e, e, NULL, 'strangers 2', 33, ARRAY[e, d, b]);

  -- First split per side, by split id (052 rule 2). One person holds TWO live splits of
  -- DIFFERENT amounts on one item, under two of their ids; the LOWER split id carries 10.00 and
  -- the higher 25.00, so "first by id", "last by id" and "sum" all give different answers. The
  -- split ids are fixed on purpose: with random uuids which one is lower is a coin flip (the trap
  -- the 067 and 068 suites document). Each case has a currency of its own so the literal below
  -- reads this bill alone.
  --   JPY: Alice paid; Bob holds `b` (lower id, 10) and `ca_b` (25)  -> the other side's first.
  --   SGD: Bob paid; Alice holds `a` (lower id, 10) and `cb_a` (25)  -> the viewer's first.
  fs_bill := gen_random_uuid(); fs_item := gen_random_uuid();
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (fs_bill, NULL, a, a, 'two splits, one person (other side)', 35, 'JPY',
          now(), now(), now(), false, 'test');
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (fs_item, fs_bill, 'item', 35, now(), now(), now(), false, 'test');
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES ('00000000-0000-4000-8000-000000000701', fs_item, b,    'custom', 10, 10.00, now(), now(), now(), false, 'test'),
         ('ffffffff-ffff-4fff-bfff-000000000702', fs_item, ca_b, 'custom', 25, 25.00, now(), now(), now(), false, 'test');

  fs_bill := gen_random_uuid(); fs_item := gen_random_uuid();
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (fs_bill, NULL, b, b, 'two splits, one person (viewer side)', 35, 'SGD',
          now(), now(), now(), false, 'test');
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (fs_item, fs_bill, 'item', 35, now(), now(), now(), false, 'test');
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES ('00000000-0000-4000-8000-000000000703', fs_item, a,    'custom', 10, 10.00, now(), now(), now(), false, 'test'),
         ('ffffffff-ffff-4fff-bfff-000000000704', fs_item, cb_a, 'custom', 25, 25.00, now(), now(), now(), false, 'test');

  -- Personal settlements
  PERFORM test.new_settlement(b, a, 500);                       -- overpayment flips the sign
  PERFORM test.new_settlement(a, c, 10, NULL, NULL, 'USD');
  PERFORM test.new_settlement(ca_b, a, 5);                      -- filed under the contact id
  -- Bob's contact for Alice paying Alice: for the pair (a, cb_a) both ends are in BOTH identity
  -- sets, so the row matches "other -> me" AND "me -> other" and only the CASE order decides it.
  PERFORM test.new_settlement(cb_a, a, 7);
  s := test.new_settlement(c, a, 1000);
  UPDATE public.settlements SET is_settled = false WHERE id = s; -- unsettled: ignored
  s := test.new_settlement(c, a, 1000);
  UPDATE public.settlements SET is_deleted = true WHERE id = s;  -- deleted: ignored

  -- Group 1 (PHP): Alice, Bob, Cha, Alice's local contact, and Dan who is later removed
  g1 := test.new_group(a, 'Manila');
  PERFORM test.add_member(g1, a, 'Alice');
  PERFORM test.add_member(g1, b, 'Bob');
  PERFORM test.add_member(g1, c, 'Cha');
  PERFORM test.add_member(g1, ca_l, 'Loco');
  gm_d := test.add_member(g1, d, 'Dan');
  PERFORM test.new_bill(b, b, g1, 'hotel', 120, ARRAY[a, b, c]);
  PERFORM test.new_bill(a, a, g1, 'food', 60, ARRAY[a, ca_l]);
  PERFORM test.new_bill(c, c, g1, 'tour', 90, ARRAY[a, c]);
  PERFORM test.new_bill(d, d, g1, 'gas', 45, ARRAY[a, b, d]);
  PERFORM test.new_bill(a, a, g1, 'off currency', 999, ARRAY[a, b], 'EUR');
  PERFORM test.new_settlement(c, a, 20, g1);
  -- Bob on the roster TWICE: as his account and as Alice's contact linked to him. The breakdown
  -- resolves him to the FIRST active membership by id, and the two ids carry different nets, so
  -- picking the other row would change the answer.
  PERFORM test.add_member(g1, ca_b, 'Bee');
  PERFORM test.new_bill(a, a, g1, 'paid for Bee', 33, ARRAY[ca_b]);
  PERFORM test.new_settlement(a, b, 0.004, g1);                 -- effectively zero
  UPDATE public.group_members SET is_deleted = true WHERE id = gm_d;

  -- Group 2 (USD): Alice and Bob
  g2 := test.new_group(a, 'Trip', 'USD');
  PERFORM test.add_member(g2, a, 'Alice');
  PERFORM test.add_member(g2, b, 'Bob');
  PERFORM test.new_bill(a, a, g2, 'boat', 40, ARRAY[a, b], 'USD');

  -- Group 3: Bob and Cha only (Alice is not a member)
  g3 := test.new_group(b, 'Office');
  PERFORM test.add_member(g3, b, 'Bob');
  PERFORM test.add_member(g3, c, 'Cha');
  PERFORM test.new_bill(b, b, g3, 'lunch', 50, ARRAY[b, c]);

  -- Group 4: deleted, with a balance that must not count
  g4 := test.new_group(a, 'Gone');
  PERFORM test.add_member(g4, a, 'Alice');
  PERFORM test.add_member(g4, b, 'Bob');
  PERFORM test.new_bill(a, a, g4, 'ghost', 500, ARRAY[a, b]);
  UPDATE public.groups SET is_deleted = true WHERE id = g4;

  viewers  := ARRAY[a, b, c, d, e];
  everyone := ARRAY[a, b, c, d, e, ca_b, ca_l, ca_l2, cb_a, cd_b];
  all_bills := ARRAY(SELECT id FROM public.bills);

  FOREACH v IN ARRAY viewers LOOP
    -- Internal helpers, compared as the owner (they are not client-callable).
    FOREACH o IN ARRAY everyone LOOP
      n_pairs := n_pairs + 1;
      PERFORM test.assert_json_eq(
        (SELECT COALESCE(jsonb_object_agg(currency, net), '{}') FROM public.kwenta_pairwise_personal(v, o)),
        (SELECT COALESCE(jsonb_object_agg(currency, net), '{}') FROM test.old_pairwise_personal(v, o)),
        format('pairwise_personal(%s, %s)', v, o));
      bd := public.kwenta_pairwise_breakdown(v, o);
      PERFORM test.assert_json_eq(
        test.canon_groups(bd),
        test.canon_groups(test.old_pairwise_breakdown(v, o)),
        format('pairwise_breakdown(%s, %s)', v, o));
      PERFORM test.assert_true(test.groups_in_name_order(bd),
        format('pairwise_breakdown(%s, %s) lists groups by name, then id', v, o));
      IF jsonb_array_length(bd -> 'groups') > 1 THEN
        n_multi_group := n_multi_group + 1;
      END IF;
    END LOOP;

    -- The many-peer paths in ONE call, with every id at once: a contact and the account it is
    -- linked to, the viewer's own ids, a duplicate and a NULL. Each peer's answer must be what
    -- the old one-peer body gave for it, unaffected by the others in the same call.
    PERFORM test.assert_json_eq(
      (SELECT COALESCE(jsonb_object_agg(pm.peer::text || '/' || pm.currency, pm.net), '{}')
         FROM public.kwenta_pairwise_personal_many(v, everyone || ARRAY[everyone[1], NULL]) pm),
      (SELECT COALESCE(jsonb_object_agg(x.o::text || '/' || op.currency, op.net), '{}')
         FROM unnest(everyone) AS x(o)
         CROSS JOIN LATERAL test.old_pairwise_personal(v, x.o) op),
      format('pairwise_personal_many for %s', v));
    PERFORM test.assert_json_eq(
      (SELECT jsonb_object_agg(COALESCE(bm.peer::text, 'null'), test.canon_groups(bm.breakdown))
         FROM public.kwenta_pairwise_breakdown_many(v, everyone || ARRAY[everyone[1], NULL]) bm),
      (SELECT jsonb_object_agg(x.o::text, test.canon_groups(test.old_pairwise_breakdown(v, x.o)))
         FROM unnest(everyone) AS x(o))
      || jsonb_build_object('null', test.old_pairwise_breakdown(v, NULL)),
      format('pairwise_breakdown_many for %s', v));
    PERFORM test.assert_json_eq(
      public.kwenta_bills_settled_map(all_bills, v),
      test.old_bills_settled_map(all_bills, v),
      format('bills_settled_map for %s', v));

    -- Client endpoints, compared as the signed-in viewer.
    PERFORM test.as_user(v);
    PERFORM test.assert_json_eq(
      test.try_json('SELECT public.kwenta_balances_overview()'),
      test.try_json('SELECT test.old_balances_overview()'),
      format('balances_overview for %s', v));
    PERFORM test.assert_json_eq(
      test.try_json('SELECT public.kwenta_contacts_with_balances()'),
      test.try_json('SELECT test.old_contacts_with_balances()'),
      format('contacts_with_balances for %s', v));
    PERFORM test.assert_json_eq(
      test.try_json('SELECT public.kwenta_groups_with_balances()'),
      test.try_json('SELECT test.old_groups_with_balances()'),
      format('groups_with_balances for %s', v));
    FOREACH o IN ARRAY everyone LOOP
      PERFORM test.assert_json_eq(
        test.canon_groups(test.try_json(format('SELECT public.kwenta_person_summary(%L::uuid)', o))),
        test.canon_groups(test.try_json(format('SELECT test.old_person_summary(%L::uuid)', o))),
        format('person_summary(%s) for %s', o, v));
    END LOOP;
    PERFORM test.as_owner();
  END LOOP;

  -- The fixture must actually exercise money, or equality proves nothing.
  PERFORM test.assert_true(
    (SELECT count(*) FROM jsonb_object_keys(public.kwenta_pairwise_breakdown(a, b) -> 'total')) > 0,
    'fixture sanity: Alice and Bob have a non-empty tab');
  PERFORM test.assert_true(
    (SELECT jsonb_array_length(public.kwenta_pairwise_breakdown(a, c) -> 'groups') > 0),
    'fixture sanity: Alice and Cha share a group leg');
  -- First split per side, as literals and against the old body (see the JPY/SGD bills above).
  PERFORM test.assert_money(
    (SELECT net FROM public.kwenta_pairwise_personal(a, b) WHERE currency = 'JPY'), 10,
    'the other side''s FIRST split by id counts, not the later one or the sum (Alice viewing Bob)');
  PERFORM test.assert_money(
    (SELECT net FROM public.kwenta_pairwise_personal(a, b) WHERE currency = 'SGD'), -10,
    'the viewer''s FIRST split by id counts, not the later one or the sum (Alice viewing Bob)');
  PERFORM test.assert_money(
    (SELECT net FROM public.kwenta_pairwise_personal(b, a) WHERE currency = 'JPY'), -10,
    'the viewer''s FIRST split by id counts (Bob viewing Alice)');
  PERFORM test.assert_money(
    (SELECT net FROM public.kwenta_pairwise_personal(b, a) WHERE currency = 'SGD'), 10,
    'the other side''s FIRST split by id counts (Bob viewing Alice)');
  PERFORM test.assert_json_eq(
    (SELECT jsonb_object_agg(currency, net) FROM public.kwenta_pairwise_personal(a, b)
      WHERE currency IN ('JPY', 'SGD')),
    (SELECT jsonb_object_agg(currency, net) FROM test.old_pairwise_personal(a, b)
      WHERE currency IN ('JPY', 'SGD')),
    'first split per side agrees with the old body');

  PERFORM test.assert_true(n_multi_group > 0,
    'fixture sanity: some breakdown has two or more group legs, so the order check means something');

  PERFORM test.note(format('old == new across %s viewer/profile pairs', n_pairs));
END;
$$;

-- ---------------------------------------------------------------------------
-- Unauthenticated callers are still refused by every client endpoint
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_true(test.try_json('SELECT public.kwenta_balances_overview()') ? 'error',
    'overview refuses a caller with no auth.uid()');
  PERFORM test.assert_true(test.try_json('SELECT public.kwenta_contacts_with_balances()') ? 'error',
    'contacts refuses a caller with no auth.uid()');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: internal helpers are server-only; endpoints stay client-callable.
-- On real Supabase, default privileges can grant EXECUTE to `authenticated`/`anon` on new
-- functions, which REVOKE ... FROM PUBLIC does not undo — 070 revokes from both explicitly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.kwenta_pairwise_personal(uuid, uuid)',
    'public.kwenta_pairwise_personal_many(uuid, uuid[])',
    'public.kwenta_revoke_acting_user_helpers()',
    'public.kwenta_group_pairwise(uuid, uuid)',
    'public.kwenta_pairwise_breakdown(uuid, uuid)',
    'public.kwenta_pairwise_breakdown_many(uuid, uuid[])',
    'public.kwenta_related_profile_ids(uuid)',
    'public.kwenta_canonical_peer_ids(uuid)',
    'public.kwenta_peer_display_name(uuid, uuid)',
    'public.kwenta_peer_subtitle(uuid)',
    'public.kwenta_bills_settled_map(uuid[], uuid)',
    'public.kwenta_group_pool_net(uuid, uuid)',
    'public.kwenta_expand_identity(uuid, uuid)'
  ] LOOP
    PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'),
      fn || ' is not executable by authenticated');
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'),
      fn || ' is not executable by anon');
  END LOOP;
  FOREACH fn IN ARRAY ARRAY[
    'public.kwenta_balances_overview()',
    'public.kwenta_contacts_with_balances()',
    'public.kwenta_groups_with_balances()',
    'public.kwenta_person_summary(uuid)'
  ] LOOP
    PERFORM test.assert_true(has_function_privilege('authenticated', fn, 'EXECUTE'),
      fn || ' stays executable by authenticated');
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'),
      fn || ' is not executable by anon');
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- The sweep itself. The harness has no Supabase default privileges, so a helper here is never
-- granted to `authenticated`/`anon` in the first place and the assertions above could not fail
-- for the reason they exist. These probes ARE granted, so the sweep has to do the revoking.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.kwenta_probe_070(p_viewer uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT p_viewer $$;
GRANT EXECUTE ON FUNCTION public.kwenta_probe_070(uuid) TO PUBLIC, anon, authenticated;

-- A RETURNS TABLE column called `uid` is output, not an acting-user argument: must be left alone.
CREATE FUNCTION public.kwenta_probe_070_out(p_group_id uuid)
RETURNS TABLE (uid uuid) LANGUAGE sql STABLE AS $$ SELECT p_group_id $$;
REVOKE ALL ON FUNCTION public.kwenta_probe_070_out(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_probe_070_out(uuid) TO authenticated;

DO $$
DECLARE
  n int;
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_probe_070(uuid)', 'EXECUTE'),
    'precondition: the probe starts out executable by authenticated');
  PERFORM test.assert_true(has_function_privilege('anon', 'public.kwenta_probe_070(uuid)', 'EXECUTE'),
    'precondition: the probe starts out executable by anon');

  n := public.kwenta_revoke_acting_user_helpers();
  PERFORM test.assert_true(n > 0, 'the sweep reports the functions it touched');

  PERFORM test.assert_false(has_function_privilege('authenticated', 'public.kwenta_probe_070(uuid)', 'EXECUTE'),
    'the sweep revokes an acting-user helper from authenticated');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_probe_070(uuid)', 'EXECUTE'),
    'the sweep revokes an acting-user helper from anon');
  PERFORM test.assert_true(has_function_privilege('service_role', 'public.kwenta_probe_070(uuid)', 'EXECUTE'),
    'the sweep leaves the helper executable by service_role');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_probe_070_out(uuid)', 'EXECUTE'),
    'the sweep ignores an OUT/TABLE column named uid');
END;
$$;

-- ---------------------------------------------------------------------------
-- ROWS 5 on kwenta_expand_identity is what lets the planner use the 070 indexes. It is set by
-- ALTER FUNCTION, and a later CREATE OR REPLACE silently resets it to 1000 unless restated.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_eq(
    (SELECT p.prorows FROM pg_proc p
       WHERE p.oid = 'public.kwenta_expand_identity(uuid, uuid)'::regprocedure),
    5::real,
    'kwenta_expand_identity keeps ROWS 5 (restate it in any CREATE OR REPLACE)');
END;
$$;
