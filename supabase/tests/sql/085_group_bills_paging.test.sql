-- Migration 085: the group bill list, one page at a time.
--
-- Group detail was 16-29 kB for a 59-bill group and almost all of it was the bill list, which grew
-- with every bill. 085 is ADDITIVE: installed apps keep calling kwenta_group_detail(p_group_id) and
-- must keep receiving every bill, byte for byte; the new client reads kwenta_group_detail_paged
-- (the N newest bills plus counts) and walks the rest through kwenta_group_bills_page by keyset.
-- Pinned here, written from the requirements (not from 085's body):
--
--   C1  kwenta_group_detail(uuid) is untouched: one signature, output jsonb-identical to a FROZEN
--       copy of 083's body (converted bill, removed member, payments, tie on created_at), no
--       billCount / billPayers key; kwenta_read with no limit (an old app's mounted spec) too.
--   C2  kwenta_group_detail_paged(g, n): every key but `bills` equals kwenta_group_detail's, `bills`
--       is the first n of its list (created_at DESC, id ASC), billCount counts every live bill,
--       billPayers = [{userId, count}] over every live bill (count DESC, userId), n clamped 1..500,
--       NULL = 20.
--   C3  kwenta_group_bills_page walks every bill once, newest first, rows jsonb-identical to group
--       detail's; p_payer filters on paid_by; matching counts the filtered set; a deleted cursor row
--       still continues; a malformed cursor raises; clamp 1..500, NULL = 20.
--   C4  both endpoints: NULL for a non-member, a removed member and a deleted group (as group
--       detail); 'not authenticated' with no auth.uid(); another group's bills never appear.
--   C5  kwenta_read dispatches kwenta_group_detail_paged with its limit and kwenta_read_is_allowed
--       admits it, so a kwenta_write naming it returns the 20-bill payload already including the
--       write; kwenta_group_bills_page cannot be named there (it takes payer/cursor arguments).
--   C23 (SQL half) a removed member's bills still count in billCount and billPayers.
--   C27 both endpoints authenticated only (not anon, not PUBLIC), one overload each.
--
-- Hand-made rows (everything else comes from the 001 fixtures new_account / new_group /
-- add_member / new_bill / new_settlement):
--   * created_at and is_deleted are UPDATEd onto new_bill rows (now() is constant inside the test
--     transaction, so dates and ties must be set by hand), as 083's and 084's suites do;
--   * one converted bill: bill_items / item_splits .original_amount, then 079's four bill columns,
--     by UPDATE in the order the stale-conversion trigger allows (084's fixture order);
--   * a removed member: their group_members row soft-deleted by UPDATE after their bills were filed;
--   * C2/C3 clamp: 501 bills in new_bill's exact column shape (one item, one equal split,
--     split_value = 1) via generate_series;
--   * C5: one group-bill push in the shape 066's suite sends (test.bill_push), plus group_id.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 083's kwenta_group_detail, copied verbatim from 083_smaller_screen_payloads.sql:91-293 with only
-- its name changed. Do not "tidy" it: its value is being the pre-085 answer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.group_detail_083_reference(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group public.groups%ROWTYPE;
  v_members jsonb;
  v_bills jsonb;
  v_pairwise jsonb;
  v_to_receive numeric := 0;
  v_to_pay numeric := 0;
  v_member_balances jsonb;
  v_raw_debts jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_group
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A former member must not read a group they have left. The pull bundle still delivers the
  -- rows (24: deletion events have to reach former members), so absence from the bundle is not
  -- the check — active membership is.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_uid AND gm.is_deleted IS FALSE
  ) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',            m.id,
      'userId',        m.user_id,
      'profileName',   COALESCE(NULLIF(BTRIM(p.display_name), ''), NULLIF(BTRIM(m.display_name), ''), 'Unknown'),
      'isCurrentUser', m.user_id = v_uid
    ) ORDER BY (m.user_id = v_uid) DESC, m.joined_at, m.id
  ), '[]'::jsonb)
  INTO v_members
  FROM public.group_members m
  LEFT JOIN public.kwenta_pull_rows_profiles('epoch'::timestamptz, v_uid) p ON p.id = m.user_id
  WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',          b.id,
      'title',       b.title,
      'note',        b.note,
      'currency',    b.currency,
      'totalAmount', b.total_amount,
      'createdAt',   b.created_at,
      'createdBy',   b.created_by,
      'paidBy',      b.paid_by,
      'groupId',     b.group_id,
      'category',    b.category,
      'originalCurrency', b.original_currency,
      'originalTotal',    b.original_total,
      'exchangeRate',     b.exchange_rate,
      'payorName',   public.kwenta_bill_participant_name(p_group_id, v_uid, b.paid_by)
    ) ORDER BY b.created_at DESC, b.id
  ), '[]'::jsonb)
  INTO v_bills
  FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
  WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'memberUserId', gp.member_user_id,
      'displayName',  gp.display_name,
      'net',          gp.net
    ) ORDER BY gp.display_name, gp.member_user_id), '[]'::jsonb),
    COALESCE(SUM(GREATEST(gp.net, 0)), 0),
    COALESCE(SUM(GREATEST(-gp.net, 0)), 0)
  INTO v_pairwise, v_to_receive, v_to_pay
  FROM public.kwenta_group_pairwise(p_group_id, v_uid) gp;

  -- Net against the group pool: credited for what you fronted, debited for your own shares.
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  sp AS (
    SELECT gb.paid_by, s.user_id, s.computed_amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL
  ),
  gs AS (
    SELECT s.* FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  ),
  deltas AS (
    SELECT sp.paid_by AS uid,  sp.computed_amount AS delta FROM sp
    UNION ALL
    SELECT sp.user_id AS uid, -sp.computed_amount        FROM sp
    UNION ALL
    -- Paying someone reduces what you owe the pool; receiving increases it.
    SELECT gs.from_user_id, gs.amount FROM gs
    UNION ALL
    SELECT gs.to_user_id, -gs.amount FROM gs
    UNION ALL
    -- Active members appear at zero: "settled" is a real answer the roster has to show.
    SELECT m.user_id, 0 FROM public.group_members m
    WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId',      t.uid,
    'displayName', public.kwenta_bill_participant_name(p_group_id, v_uid, t.uid),
    'amount',      t.amount
  ) ORDER BY t.amount DESC, t.uid), '[]'::jsonb)
  INTO v_member_balances
  FROM (
    SELECT d.uid, public.kwenta_round_money(SUM(d.delta)) AS amount
    FROM deltas d
    WHERE d.uid IS NOT NULL
    GROUP BY d.uid
  ) t;

  -- The directed debt graph the client decomposes into transfers, netted per unordered pair of
  -- literal ids in integer cents (083). A split is a debt from the splitter to the payer; a settled
  -- payment is a debt in the OPPOSITE direction and cancels against it. Zero nets are dropped; the
  -- edge runs debtor -> creditor.
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  bill_debts AS (
    SELECT s.user_id AS from_id, gb.paid_by AS to_id, ROUND(s.computed_amount * 100)::bigint AS cents
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL AND s.user_id <> gb.paid_by
  ),
  settlement_debts AS (
    SELECT s.to_user_id AS from_id, s.from_user_id AS to_id, ROUND(s.amount * 100)::bigint AS cents
    FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  ),
  signed AS (
    SELECT LEAST(d.from_id, d.to_id) AS a,
           GREATEST(d.from_id, d.to_id) AS b,
           CASE WHEN d.from_id < d.to_id THEN d.cents ELSE -d.cents END AS cents
    FROM (
      SELECT * FROM bill_debts
      UNION ALL
      SELECT * FROM settlement_debts
    ) d
    WHERE d.from_id <> d.to_id
  ),
  pair_net AS (
    SELECT sg.a, sg.b, SUM(sg.cents) AS net
    FROM signed sg
    GROUP BY sg.a, sg.b
    HAVING SUM(sg.cents) <> 0
  ),
  edges AS (
    SELECT CASE WHEN pn.net > 0 THEN pn.a ELSE pn.b END AS from_id,
           CASE WHEN pn.net > 0 THEN pn.b ELSE pn.a END AS to_id,
           ABS(pn.net) AS cents
    FROM pair_net pn
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'from', e.from_id, 'to', e.to_id, 'amount', ROUND(e.cents::numeric / 100, 2)
  ) ORDER BY e.from_id, e.to_id), '[]'::jsonb)
  INTO v_raw_debts
  FROM edges e;

  RETURN jsonb_build_object(
    'group', jsonb_build_object(
      'id',         v_group.id,
      'name',       v_group.name,
      'currency',   v_group.currency,
      'createdBy',  v_group.created_by,
      'inviteCode', v_group.invite_code,
      'updatedAt',  v_group.updated_at
    ),
    'members',        v_members,
    'bills',          v_bills,
    'pairwise',       v_pairwise,
    'totalToReceive', public.kwenta_round_money(v_to_receive),
    'totalToPay',     public.kwenta_round_money(v_to_pay),
    'memberBalances', v_member_balances,
    'rawDebts',       v_raw_debts
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** Elements p_from..p_to (1-based, inclusive) of a jsonb array, in order; '[]' when none. */
CREATE OR REPLACE FUNCTION test.g85_slice(p_arr jsonb, p_from int, p_to int)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_arr, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  WHERE t.ord BETWEEN p_from AND p_to;
$$;

/** The bill rows of a list paid by one user, in list order. */
CREATE OR REPLACE FUNCTION test.g85_paid_by(p_arr jsonb, p_payer uuid)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_arr, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  WHERE t.e ->> 'paidBy' = p_payer::text;
$$;

/** Ids of a list of rows, in order. */
CREATE OR REPLACE FUNCTION test.g85_ids(p_arr jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg((t.e ->> 'id')::uuid ORDER BY t.ord), '{}'::uuid[])
  FROM jsonb_array_elements(COALESCE(p_arr, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord);
$$;

/** The {id, createdAt} cursor of a row, as the client sends it. */
CREATE OR REPLACE FUNCTION test.g85_cursor(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('id', p_row -> 'id', 'createdAt', p_row -> 'createdAt');
$$;

/** Walk kwenta_group_bills_page from the start with page size p_limit; returns every row, in order.
    Raises when a page's `matching` disagrees with p_matching or the walk does not terminate. */
CREATE OR REPLACE FUNCTION test.g85_walk(p_group uuid, p_limit int, p_payer uuid, p_matching int)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  acc jsonb := '[]'::jsonb;
  p jsonb;
  cur jsonb := NULL;
  n int := 0;
BEGIN
  LOOP
    n := n + 1;
    IF n > 1000 THEN
      PERFORM test.fail('g85_walk terminates', '<= 1000 pages', 'more');
    END IF;
    p := public.kwenta_group_bills_page(p_group, p_limit, p_payer, cur);
    PERFORM test.assert_eq((p ->> 'matching')::int, p_matching,
      format('walk(limit %s): every page reports matching = %s (page %s)', p_limit, p_matching, n));
    EXIT WHEN jsonb_array_length(p -> 'rows') = 0;
    IF jsonb_array_length(p -> 'rows') > p_limit THEN
      PERFORM test.fail('a page holds at most p_limit rows', p_limit::text, jsonb_array_length(p -> 'rows')::text);
    END IF;
    acc := acc || (p -> 'rows');
    cur := test.g85_cursor(p -> 'rows' -> (jsonb_array_length(p -> 'rows') - 1));
  END LOOP;
  RETURN acc;
END;
$$;

/** True when kwenta_group_bills_page refuses the cursor. */
CREATE OR REPLACE FUNCTION test.g85_after_raises(p_group uuid, p_after jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.kwenta_group_bills_page(p_group, 5, NULL, p_after);
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$$;

/** One group bill as the client pushes it (066's test.bill_push shape plus group_id). */
CREATE OR REPLACE FUNCTION test.g85_group_bill_push(
  p_bill uuid, p_item uuid, p_actor uuid, p_group uuid, p_title text, p_amount numeric, p_split uuid[]
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'bills', jsonb_build_array(jsonb_build_object(
      'id', p_bill, 'title', p_title, 'group_id', p_group, 'currency', 'PHP',
      'created_by', p_actor, 'paid_by', p_actor, 'total_amount', p_amount,
      'note', '', 'category', NULL,
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')),
    'bill_items', jsonb_build_array(jsonb_build_object(
      'id', p_item, 'bill_id', p_bill, 'name', p_title, 'amount', p_amount,
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')),
    'item_splits', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', gen_random_uuid(), 'item_id', p_item, 'user_id', u,
        'split_type', 'equal', 'split_value', 1,
        'computed_amount', ROUND(p_amount / array_length(p_split, 1), 2),
        'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
        'is_deleted', false, 'device_id', 'test'))
      FROM unnest(p_split) u)
  );
$$;

/**
 * The shared fixture. Group "Siquijor" (PHP): Alice, Bob, Cara active; Dan paid two bills and was
 * then removed. 25 live bills B01..B25 at base + i minutes (B11 shares B10's created_at, so the id
 * tiebreak is inside the first page), payers: Dan on B04 and B07, else i%3 = 0 Alice, 1 Bob,
 * 2 Cara -> Alice 8, Cara 8, Bob 7, Dan 2. B05 is converted (USD). B26 is deleted and newest.
 * Bob paid Alice 10 in the group. A second group "Bohol" (Alice, Bob) has three bills Alice paid,
 * newer than every Siquijor bill. Zed is an account in neither group.
 */
CREATE OR REPLACE FUNCTION test.g85_fixture(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  alice uuid; bob uuid; cara uuid; dan uuid; zed uuid; g uuid; g2 uuid; b uuid; payer uuid;
  ids jsonb := '{}'::jsonb;
  base timestamptz := '2020-01-01T12:00:00+00'::timestamptz;
  i int;
BEGIN
  alice := test.new_account('g85-alice-' || p_tag || '@example.com', 'Alice');
  bob   := test.new_account('g85-bob-' || p_tag || '@example.com', 'Bob');
  cara  := test.new_account('g85-cara-' || p_tag || '@example.com', 'Cara');
  dan   := test.new_account('g85-dan-' || p_tag || '@example.com', 'Dan');
  zed   := test.new_account('g85-zed-' || p_tag || '@example.com', 'Zed');
  g := test.new_group(alice, 'Siquijor ' || p_tag, 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.add_member(g, dan, 'Dan');

  FOR i IN 1..25 LOOP
    payer := CASE WHEN i IN (4, 7) THEN dan
                  WHEN i % 3 = 0 THEN alice
                  WHEN i % 3 = 1 THEN bob
                  ELSE cara END;
    b := test.new_bill(payer, payer, g, 'B' || lpad(i::text, 2, '0'), 40 + i, ARRAY[alice, bob, cara, dan]);
    IF i = 5 THEN
      UPDATE public.bill_items SET original_amount = 0.80 WHERE bill_id = b;
      UPDATE public.item_splits SET original_amount = 0.20
       WHERE item_id IN (SELECT id FROM public.bill_items WHERE bill_id = b);
      UPDATE public.bills SET created_at = base + i * interval '1 minute',
             original_currency = 'USD', exchange_rate = 56.25, rate_source = 'online', original_total = 0.80
       WHERE id = b;
    ELSE
      UPDATE public.bills
         SET created_at = base + (CASE WHEN i = 11 THEN 10 ELSE i END) * interval '1 minute',
             category = CASE WHEN i % 4 = 0 THEN 'food' ELSE NULL END
       WHERE id = b;
    END IF;
    ids := ids || jsonb_build_object('b' || i, b);
  END LOOP;

  b := test.new_bill(alice, alice, g, 'B26 deleted', 99, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '30 minutes', is_deleted = true WHERE id = b;
  ids := ids || jsonb_build_object('b26_deleted', b);

  PERFORM test.new_settlement(bob, alice, 10, g);

  -- Dan leaves after his bills were filed: the roster drops him, his bills stay.
  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = dan;

  g2 := test.new_group(alice, 'Bohol ' || p_tag, 'PHP');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, bob, 'Bob');
  FOR i IN 1..3 LOOP
    b := test.new_bill(alice, alice, g2, 'Other ' || i, 10 * i, ARRAY[alice, bob]);
    UPDATE public.bills SET created_at = base + interval '1 day' + i * interval '1 minute' WHERE id = b;
    ids := ids || jsonb_build_object('o' || i, b);
  END LOOP;

  RETURN ids || jsonb_build_object('alice', alice, 'bob', bob, 'cara', cara, 'dan', dan, 'zed', zed,
                                   'g', g, 'g2', g2);
END;
$$;

-- ---------------------------------------------------------------------------
-- C1: kwenta_group_detail(uuid) is exactly 083's, for two perspectives, an empty group and an old
-- app's kwenta_read spec. No new key.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; g uuid; ge uuid; d jsonb; ref jsonb; who text;
BEGIN
  f := test.g85_fixture('c1');
  g := (f ->> 'g')::uuid;
  ge := test.new_group((f ->> 'alice')::uuid, 'Empty c1');
  PERFORM test.add_member(ge, (f ->> 'alice')::uuid, 'Alice');

  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_group_detail'), 1,
    'C1: kwenta_group_detail keeps exactly one signature');
  PERFORM test.assert_true(to_regprocedure('public.kwenta_group_detail(uuid)') IS NOT NULL,
    'C1: and it is still (uuid)');

  FOREACH who IN ARRAY ARRAY['alice', 'bob'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    d := public.kwenta_group_detail(g);
    ref := test.group_detail_083_reference(g);
    PERFORM test.as_owner();
    PERFORM test.assert_true(ref IS NOT NULL, 'C1: the 083 reference answers for ' || who);
    PERFORM test.assert_eq(jsonb_array_length(ref -> 'bills'), 25, 'C1: 083 lists all 25 live bills for ' || who);
    PERFORM test.assert_eq(d, ref, 'C1: kwenta_group_detail is jsonb-identical to 083 for ' || who);
    PERFORM test.assert_eq(d::text, ref::text, 'C1: and byte-identical as text for ' || who);
    PERFORM test.assert_false(d ? 'billCount', 'C1: no billCount key on the old endpoint (' || who || ')');
    PERFORM test.assert_false(d ? 'billPayers', 'C1: no billPayers key on the old endpoint (' || who || ')');
  END LOOP;

  PERFORM test.as_user((f ->> 'alice')::uuid);
  PERFORM test.assert_eq(public.kwenta_group_detail(ge), test.group_detail_083_reference(ge),
    'C1: an empty group is identical to 083 too');
  -- An installed app's mounted-group spec carries no limit: it must keep getting the whole list.
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail', g, NULL), test.group_detail_083_reference(g),
    'C1: kwenta_read(kwenta_group_detail) with no limit still returns 083''s full payload');
  PERFORM test.as_owner();

  -- Refused side, unchanged: a removed member and an outsider get NULL from both.
  FOREACH who IN ARRAY ARRAY['dan', 'zed'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb, 'C1: ' || who || ' still gets NULL');
    PERFORM test.assert_eq(test.group_detail_083_reference(g), NULL::jsonb, 'C1: as 083 did for ' || who);
    PERFORM test.as_owner();
  END LOOP;
  PERFORM test.note('C1: kwenta_group_detail unchanged (signature, payload, kwenta_read, refusals)');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2 + C23: kwenta_group_detail_paged = group detail with the n newest bills plus counts over
-- every live bill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; g uuid; alice uuid; bob uuid; cara uuid; dan uuid; d jsonb; p jsonb; ref jsonb;
  who text; expected_payers jsonb;
BEGIN
  f := test.g85_fixture('c2');
  g := (f ->> 'g')::uuid;
  alice := (f ->> 'alice')::uuid; bob := (f ->> 'bob')::uuid;
  cara := (f ->> 'cara')::uuid; dan := (f ->> 'dan')::uuid;

  -- Counts from the fixture: Alice 8, Cara 8, Bob 7, Dan 2 (removed, still counted); B26 is
  -- deleted and counted nowhere. Ties order by userId.
  SELECT jsonb_agg(jsonb_build_object('userId', u, 'count', c) ORDER BY c DESC, u)
  INTO expected_payers
  FROM (VALUES (alice, 8), (cara, 8), (bob, 7), (dan, 2)) v(u, c);

  FOREACH who IN ARRAY ARRAY['alice', 'bob'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    p := public.kwenta_group_detail_paged(g, 20);
    d := public.kwenta_group_detail(g);
    ref := test.group_detail_083_reference(g);
    PERFORM test.as_owner();

    PERFORM test.assert_true(p IS NOT NULL, 'C2: a member gets the paged detail (' || who || ')');
    PERFORM test.assert_eq(
      ARRAY(SELECT jsonb_object_keys(p) ORDER BY 1),
      ARRAY(SELECT k FROM (SELECT jsonb_object_keys(ref) AS k UNION ALL VALUES ('billCount'), ('billPayers')) s ORDER BY 1),
      'C2: the keys are group detail''s plus billCount and billPayers, nothing else (' || who || ')');
    PERFORM test.assert_eq(p - 'bills' - 'billCount' - 'billPayers', ref - 'bills',
      'C2: group, members, pairwise, totals, memberBalances, rawDebts equal group detail''s (' || who || ')');
    PERFORM test.assert_eq(p - 'bills' - 'billCount' - 'billPayers', d - 'bills',
      'C2: and the live kwenta_group_detail''s (' || who || ')');
    PERFORM test.assert_eq(p -> 'bills', test.g85_slice(ref -> 'bills', 1, 20),
      'C2: bills are the first 20 of group detail''s list, rows jsonb-identical (' || who || ')');
    PERFORM test.assert_eq(p -> 'bills' -> 0 ->> 'title', 'B25', 'C2: newest first (' || who || ')');
    PERFORM test.assert_eq(p -> 'bills' -> 19 ->> 'title', 'B06', 'C2: the 20th newest is B06 (' || who || ')');
    PERFORM test.assert_eq((p ->> 'billCount')::int, 25, 'C2: billCount counts every live bill (' || who || ')');
    PERFORM test.assert_eq(p -> 'billPayers', expected_payers,
      'C2/C23: billPayers covers every live bill, the removed member included, count DESC then userId (' || who || ')');
  END LOOP;

  -- The removed member is off the roster but on billPayers (the client restricts chips to the roster).
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'members') m WHERE m ->> 'userId' = dan::text),
    'C23: Dan is not in members');

  -- Limit: NULL = 20, clamped to at least 1.
  PERFORM test.as_user(alice);
  ref := test.group_detail_083_reference(g);
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_detail_paged(g, NULL) -> 'bills'), 20, 'C2: NULL limit = 20');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_detail_paged(g, 0) -> 'bills'), 1, 'C2: limit 0 clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_detail_paged(g, -3) -> 'bills'), 1, 'C2: a negative limit clamps to 1');
  PERFORM test.assert_eq(public.kwenta_group_detail_paged(g, 3) -> 'bills', test.g85_slice(ref -> 'bills', 1, 3),
    'C2: limit 3 = the 3 newest');
  PERFORM test.assert_eq(public.kwenta_group_detail_paged(g, 499) -> 'bills', ref -> 'bills',
    'C2: a limit above the bill count returns every bill, in group detail''s order');
  PERFORM test.assert_eq((public.kwenta_group_detail_paged(g, 1) ->> 'billCount')::int, 25,
    'C2: billCount does not depend on the limit');
  PERFORM test.as_owner();
  PERFORM test.note('C2/C23: paged detail = detail with n newest bills + counts over all live bills');
END;
$$;

-- An empty group: no bills, billCount 0, billPayers [].
DO $$
DECLARE
  alice uuid; g uuid; p jsonb;
BEGIN
  alice := test.new_account('g85-empty-alice@example.com', 'Alice');
  g := test.new_group(alice, 'Empty');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.as_user(alice);
  p := public.kwenta_group_detail_paged(g, 20);
  PERFORM test.assert_eq(p -> 'bills', '[]'::jsonb, 'C2: empty group, no bills');
  PERFORM test.assert_eq((p ->> 'billCount')::int, 0, 'C2: empty group, billCount 0');
  PERFORM test.assert_eq(p -> 'billPayers', '[]'::jsonb, 'C2: empty group, billPayers []');
  PERFORM test.assert_eq(p - 'bills' - 'billCount' - 'billPayers', public.kwenta_group_detail(g) - 'bills',
    'C2: empty group, every other key equals group detail''s');
  PERFORM test.assert_eq(public.kwenta_group_bills_page(g, 20), '{"rows": [], "matching": 0}'::jsonb,
    'C3: empty group, an empty page with matching 0');
  PERFORM test.as_owner();
  PERFORM test.note('C2/C3: empty group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: kwenta_group_bills_page walks every bill once, newest first, jsonb-identical rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; g uuid; alice uuid; cara uuid; dan uuid; zed uuid; ref jsonb; walked jsonb; p jsonb; sz int;
BEGIN
  f := test.g85_fixture('c3');
  g := (f ->> 'g')::uuid;
  alice := (f ->> 'alice')::uuid; cara := (f ->> 'cara')::uuid;
  dan := (f ->> 'dan')::uuid; zed := (f ->> 'zed')::uuid;

  PERFORM test.as_user(alice);
  ref := test.group_detail_083_reference(g);

  p := public.kwenta_group_bills_page(g, 20);
  PERFORM test.assert_eq(ARRAY(SELECT jsonb_object_keys(p) ORDER BY 1), ARRAY['matching', 'rows'],
    'C3: the page is {rows, matching}');
  PERFORM test.assert_eq(p -> 'rows', test.g85_slice(ref -> 'bills', 1, 20),
    'C3: the first page is group detail''s first 20 rows, jsonb-identical');
  PERFORM test.assert_eq((p ->> 'matching')::int, 25, 'C3: matching = every live bill');
  PERFORM test.assert_eq(public.kwenta_group_bills_page(g, 20, NULL, NULL), p, 'C3: explicit NULL payer / cursor = the first page');

  -- Walks at several page sizes, including 1 (every boundary, the created_at tie included).
  FOREACH sz IN ARRAY ARRAY[1, 7, 20, 500] LOOP
    walked := test.g85_walk(g, sz, NULL, 25);
    PERFORM test.assert_eq(walked, ref -> 'bills',
      format('C3: a walk of %s-row pages returns every bill once, in group detail''s order, rows identical', sz));
  END LOOP;

  -- Payer filter: Cara's 8 bills, then Dan's 2 (a removed member: paid_by is still his).
  walked := test.g85_walk(g, 3, cara, 8);
  PERFORM test.assert_eq(walked, test.g85_paid_by(ref -> 'bills', cara),
    'C3: a payer walk is exactly that payer''s bills, in order, rows identical');
  PERFORM test.assert_eq(jsonb_array_length(walked), 8, 'C3: Cara paid 8');
  walked := test.g85_walk(g, 20, dan, 2);
  PERFORM test.assert_eq(test.g85_ids(walked), test.g85_ids(test.g85_paid_by(ref -> 'bills', dan)),
    'C3: Dan''s two bills, filtered on paid_by');
  p := public.kwenta_group_bills_page(g, 20, zed);
  PERFORM test.assert_eq(p -> 'rows', '[]'::jsonb, 'C3: a payer with no bills here gets no rows');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C3: and matching 0');

  -- matching counts the filtered set whatever the cursor.
  p := public.kwenta_group_bills_page(g, 2, cara, test.g85_cursor(test.g85_paid_by(ref -> 'bills', cara) -> 4));
  PERFORM test.assert_eq((p ->> 'matching')::int, 8, 'C3: matching is the whole filtered count on a cursor page');
  PERFORM test.assert_eq(p -> 'rows', test.g85_slice(test.g85_paid_by(ref -> 'bills', cara), 6, 7),
    'C3: and the cursor page holds the 6th and 7th of Cara''s bills');

  -- Limit: NULL = 20; clamp to at least 1.
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_bills_page(g, NULL) -> 'rows'), 20, 'C3: NULL limit = 20');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_bills_page(g, 0) -> 'rows'), 1, 'C3: limit 0 clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_bills_page(g, -1) -> 'rows'), 1, 'C3: a negative limit clamps to 1');
  PERFORM test.as_owner();
  PERFORM test.note('C3: keyset walk, payer filter, matching, limits');
END;
$$;

-- C3: a cursor whose row was deleted (or edited) since still continues from its position.
DO $$
DECLARE
  f jsonb; g uuid; alice uuid; p1 jsonb; p2 jsonb; last_row jsonb; ref jsonb;
BEGIN
  f := test.g85_fixture('c3del');
  g := (f ->> 'g')::uuid;
  alice := (f ->> 'alice')::uuid;
  PERFORM test.as_user(alice);
  p1 := public.kwenta_group_bills_page(g, 5);
  PERFORM test.as_owner();
  last_row := p1 -> 'rows' -> 4;
  PERFORM test.assert_eq(last_row ->> 'title', 'B21', 'C3: page one ends at B21');

  UPDATE public.bills SET is_deleted = true WHERE id = (last_row ->> 'id')::uuid;

  PERFORM test.as_user(alice);
  p2 := public.kwenta_group_bills_page(g, 5, NULL, test.g85_cursor(last_row));
  ref := test.group_detail_083_reference(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(p2 -> 'rows' -> 0 ->> 'title', 'B20', 'C3: after the deleted cursor row the walk resumes at B20');
  PERFORM test.assert_eq(p2 -> 'rows', test.g85_slice(ref -> 'bills', 5, 9),
    'C3: the rows after a deleted cursor are the next five of the current list');
  PERFORM test.assert_eq((p2 ->> 'matching')::int, 24, 'C3: matching no longer counts the deleted bill');
  PERFORM test.note('C3: a deleted cursor row still continues');
END;
$$;

-- C3: a malformed cursor is refused, never read as "from the start".
DO $$
DECLARE
  f jsonb; g uuid; row0 jsonb;
BEGIN
  f := test.g85_fixture('c3bad');
  g := (f ->> 'g')::uuid;
  PERFORM test.as_user((f ->> 'alice')::uuid);
  row0 := public.kwenta_group_bills_page(g, 1) -> 'rows' -> 0;
  PERFORM test.assert_false(test.g85_after_raises(g, test.g85_cursor(row0)), 'C3: a well-formed cursor is accepted');
  PERFORM test.assert_true(test.g85_after_raises(g, '{}'::jsonb), 'C3: an empty object is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, '[]'::jsonb), 'C3: an array is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, '"abc"'::jsonb), 'C3: a string is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, 'null'::jsonb), 'C3: a JSON null is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, jsonb_build_object('createdAt', row0 -> 'createdAt')),
    'C3: a missing id is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, jsonb_build_object('id', row0 -> 'id')),
    'C3: a missing createdAt is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, jsonb_build_object('id', 'not-a-uuid', 'createdAt', row0 -> 'createdAt')),
    'C3: a non-uuid id is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, jsonb_build_object('id', row0 -> 'id', 'createdAt', 'yesterday-ish')),
    'C3: an unreadable createdAt is refused');
  PERFORM test.assert_true(test.g85_after_raises(g, jsonb_build_object('id', NULL, 'createdAt', row0 -> 'createdAt')),
    'C3: a null id is refused');
  PERFORM test.as_owner();
  PERFORM test.note('C3: malformed cursors are refused');
END;
$$;

-- C2/C3: the 500 clamp bounds one call, not the list.
DO $$
DECLARE
  alice uuid; g uuid; base timestamptz := '2020-01-01T00:00:00+00'::timestamptz; p jsonb;
BEGIN
  alice := test.new_account('g85-bulk-alice@example.com', 'Alice');
  g := test.new_group(alice, 'Bulk');
  PERFORM test.add_member(g, alice, 'Alice');
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), g, alice, alice, 'Bulk ' || n, 10, 'PHP',
         base + n * interval '1 second', now(), now(), false, 'test'
  FROM generate_series(1, 501) n;
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), b.id, b.title, 10, now(), now(), now(), false, 'test'
  FROM public.bills b WHERE b.group_id = g;
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), bi.id, alice, 'equal', 1, 10, now(), now(), now(), false, 'test'
  FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id WHERE b.group_id = g;

  PERFORM test.as_user(alice);
  p := public.kwenta_group_detail_paged(g, 100000);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'bills'), 500, 'C2: the paged detail clamps the limit to 500');
  PERFORM test.assert_eq((p ->> 'billCount')::int, 501, 'C2: billCount is still 501');
  p := public.kwenta_group_bills_page(g, 100000);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 500, 'C3: the page clamps the limit to 500');
  PERFORM test.assert_eq((p ->> 'matching')::int, 501, 'C3: matching is still 501');
  p := public.kwenta_group_bills_page(g, 500, NULL, test.g85_cursor(p -> 'rows' -> 499));
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 1, 'C3: the walk reaches the 501st bill');
  PERFORM test.assert_eq(p -> 'rows' -> 0 ->> 'title', 'Bulk 1', 'C3: and it is the oldest');
  PERFORM test.as_owner();
  PERFORM test.note('C2/C3: 500 clamp per call');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: refusals exactly like group detail; another group's bills never appear.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; g uuid; g2 uuid; gd uuid; alice uuid; who text; msg text; p jsonb; all_g uuid[]; all_g2 uuid[];
BEGIN
  f := test.g85_fixture('c4');
  g := (f ->> 'g')::uuid; g2 := (f ->> 'g2')::uuid;
  alice := (f ->> 'alice')::uuid;
  gd := test.new_group(alice, 'Deleted c4');
  PERFORM test.add_member(gd, alice, 'Alice');
  PERFORM test.new_bill(alice, alice, gd, 'Gone', 10, ARRAY[alice]);
  UPDATE public.groups SET is_deleted = true WHERE id = gd;

  -- An outsider and a removed member: NULL from both endpoints, as group detail answers them.
  FOREACH who IN ARRAY ARRAY['zed', 'dan'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb, 'C4: group detail refuses ' || who);
    PERFORM test.assert_eq(public.kwenta_group_detail_paged(g, 20), NULL::jsonb, 'C4: the paged detail refuses ' || who);
    PERFORM test.assert_eq(public.kwenta_group_bills_page(g, 20), NULL::jsonb, 'C4: the bills page refuses ' || who);
    PERFORM test.assert_eq(public.kwenta_group_bills_page(g, 20, (f ->> 'alice')::uuid), NULL::jsonb,
      'C4: a payer filter does not bypass the gate for ' || who);
    PERFORM test.as_owner();
  END LOOP;

  -- A deleted group, for its own member.
  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_group_detail(gd), NULL::jsonb, 'C4: group detail refuses a deleted group');
  PERFORM test.assert_eq(public.kwenta_group_detail_paged(gd, 20), NULL::jsonb, 'C4: the paged detail refuses a deleted group');
  PERFORM test.assert_eq(public.kwenta_group_bills_page(gd, 20), NULL::jsonb, 'C4: the bills page refuses a deleted group');
  -- An unknown group id.
  PERFORM test.assert_eq(public.kwenta_group_bills_page(gen_random_uuid(), 20), NULL::jsonb, 'C4: an unknown group is NULL');

  -- Another group's bills never appear, even for a payer who paid there.
  all_g := test.g85_ids(test.g85_walk(g, 500, NULL, 25));
  all_g2 := ARRAY[(f ->> 'o1')::uuid, (f ->> 'o2')::uuid, (f ->> 'o3')::uuid];
  PERFORM test.assert_false(all_g && all_g2, 'C4: none of Bohol''s bills appear in Siquijor''s walk');
  PERFORM test.assert_false(test.g85_ids(public.kwenta_group_bills_page(g, 500, alice) -> 'rows') && all_g2,
    'C4: nor in Siquijor filtered to Alice, who paid them');
  PERFORM test.assert_eq((public.kwenta_group_bills_page(g, 500, alice) ->> 'matching')::int, 8,
    'C4: Alice''s Siquijor count excludes her Bohol bills');
  PERFORM test.assert_false(test.g85_ids(public.kwenta_group_detail_paged(g, 500) -> 'bills') && all_g2,
    'C4: nor in the paged detail');
  -- The permitted side: Bohol answers with exactly its own three bills.
  p := public.kwenta_group_bills_page(g2, 20);
  PERFORM test.assert_ids(test.g85_ids(p -> 'rows'), all_g2, 'C4: Bohol lists exactly its own bills');
  PERFORM test.assert_eq((p ->> 'matching')::int, 3, 'C4: Bohol matching = 3');
  PERFORM test.assert_eq((public.kwenta_group_detail_paged(g2, 20) ->> 'billCount')::int, 3, 'C4: Bohol billCount = 3');
  PERFORM test.as_owner();

  -- No auth.uid(): both raise 'not authenticated'.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_group_bills_page(g, 20);
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C4: the bills page without auth.uid() raises ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_group_detail_paged(g, 20);
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C4: the paged detail without auth.uid() raises ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  PERFORM test.note('C4: non-member, removed member, deleted group, unauthenticated, cross-group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5: kwenta_read dispatches the paged detail with its limit; a write primes it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; g uuid; alice uuid; bob uuid; bill uuid := gen_random_uuid(); item uuid := gen_random_uuid();
  res jsonb; paged jsonb; full_read jsonb;
BEGIN
  f := test.g85_fixture('c5');
  g := (f ->> 'g')::uuid;
  alice := (f ->> 'alice')::uuid; bob := (f ->> 'bob')::uuid;

  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_detail_paged'),
    'C5: kwenta_read_is_allowed admits kwenta_group_detail_paged');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_detail'),
    'C5: and still admits kwenta_group_detail');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_group_bills_page'),
    'C27: kwenta_group_bills_page is not nameable from a write (it takes payer/cursor arguments)');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail_paged', g, 20), public.kwenta_group_detail_paged(g, 20),
    'C5: kwenta_read dispatches kwenta_group_detail_paged(id, limit)');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail_paged', g, 3), public.kwenta_group_detail_paged(g, 3),
    'C5: with the limit it was given');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_read('kwenta_group_detail_paged', g, NULL) -> 'bills'), 20,
    'C5: a spec without a limit gets the default 20');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_bills_page', g, 20), NULL::jsonb,
    'C27: kwenta_read does not dispatch kwenta_group_bills_page');

  res := public.kwenta_write(
    test.g85_group_bill_push(bill, item, alice, g, 'Fresh dinner', 300, ARRAY[alice, bob]),
    gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('key', 'group:' || g, 'fn', 'kwenta_group_detail_paged', 'id', g, 'limit', 20),
      jsonb_build_object('key', 'group-full:' || g, 'fn', 'kwenta_group_detail', 'id', g)));
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? bill::text, 'C5: the group bill is applied');
  paged := res -> 'reads' -> ('group:' || g);
  full_read := res -> 'reads' -> ('group-full:' || g);
  PERFORM test.assert_true(paged IS NOT NULL AND jsonb_typeof(paged) = 'object',
    'C5: the write returns the paged detail under its key');
  PERFORM test.assert_eq(jsonb_array_length(paged -> 'bills'), 20, 'C5: with 20 bills');
  PERFORM test.assert_eq(paged -> 'bills' -> 0 ->> 'id', bill::text, 'C5: the bill just written is already first');
  PERFORM test.assert_eq((paged ->> 'billCount')::int, 26, 'C5: billCount already includes it');
  PERFORM test.assert_eq(paged, public.kwenta_group_detail_paged(g, 20),
    'C5: the primed payload equals a direct call after the write');
  PERFORM test.assert_eq(jsonb_array_length(full_read -> 'bills'), 26,
    'C5: an old app''s spec (kwenta_group_detail, no limit) still gets every bill');
  PERFORM test.as_owner();
  PERFORM test.note('C5: kwenta_read dispatch + write priming');
END;
$$;

-- ---------------------------------------------------------------------------
-- C27: grants. Both endpoints authenticated only, one overload each; group detail keeps its grant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  sig text;
BEGIN
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_group_detail_paged'), 1,
    'C27: kwenta_group_detail_paged has one signature');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_group_bills_page'), 1,
    'C27: kwenta_group_bills_page has one signature');

  FOREACH sig IN ARRAY ARRAY[
    'public.kwenta_group_detail_paged(uuid, integer)',
    'public.kwenta_group_bills_page(uuid, integer, uuid, jsonb)',
    'public.kwenta_group_detail(uuid)'
  ] LOOP
    PERFORM test.assert_true(to_regprocedure(sig) IS NOT NULL, 'C27: ' || sig || ' exists');
    PERFORM test.assert_true(has_function_privilege('authenticated', sig, 'EXECUTE'), 'C27: authenticated executes ' || sig);
    PERFORM test.assert_false(has_function_privilege('anon', sig, 'EXECUTE'), 'C27: anon may not execute ' || sig);
    PERFORM test.assert_false(
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = to_regprocedure(sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
      'C27: PUBLIC holds no EXECUTE on ' || sig);
    PERFORM test.assert_eq(
      (SELECT format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.oid = to_regprocedure(sig)),
      'jsonb', 'C27: ' || sig || ' returns jsonb');
  END LOOP;
  PERFORM test.note('C27: grants');
END;
$$;
