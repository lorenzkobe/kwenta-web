-- Migration 083: smaller screen payloads.
--
-- Two endpoints were heavy enough to measure: a group detail whose `rawDebts` carried one edge per
-- split row and per payment (48.9 kB of an 80.8 kB response), and a Bills page that downloaded
-- every personal bill to show ten. Pinned here:
--
--   rawDebts (C1-C7): at most one edge per unordered pair of LITERAL user ids, from the debtor to
--   the creditor, amount = the pair's net in exact cents, zero nets dropped, ordered by from, to.
--   The edge set must equal what the client's buildDebtGraph would have netted from 079's raw
--   edges (so settle-up suggests the same transfers), and every other key of the response must be
--   identical to 079's.
--
--   kwenta_personal_bills_page (C8-C15): one bucket of kwenta_personal_bills(), filtered, sorted
--   and limited on the server, with the counts the page needs. Paging is keyset (p_after, the last
--   loaded row's {id, createdAt, title}): the next rows strictly after that position (H4.1). Each row is jsonb-identical to the
--   full endpoint's row for the same bill: there is one implementation of the row shape.
--
-- Hand-made rows: every bill, item, split and settlement comes from the 001 fixtures
-- (test.new_bill / new_settlement), except the bulk fixtures for C6/C15/C11-clamp, which insert
-- the SAME columns new_bill writes (equal splits, split_value = 1) via generate_series, and the
-- created_at / category / is_deleted / currency columns that are UPDATEd after a fixture insert.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- The 079 implementation, copied verbatim from 079_foreign_currency_bills.sql:697-881 with only
-- its name changed. It is the independent second opinion: 083 must equal it on every key but
-- rawDebts, and its raw rawDebts netted per pair must equal 083's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.group_detail_079_reference(p_group_id uuid)
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

  -- The directed debt graph the client decomposes into transfers. A split is a debt from the
  -- splitter to the payer; a settled payment is a debt in the OPPOSITE direction, which cancels
  -- against it rather than being subtracted (the client's buildDebtGraph nets the pair).
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  bill_debts AS (
    SELECT s.user_id AS from_id, gb.paid_by AS to_id, s.computed_amount AS amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL AND s.user_id <> gb.paid_by
  ),
  settlement_debts AS (
    SELECT s.to_user_id AS from_id, s.from_user_id AS to_id, s.amount
    FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'from', d.from_id, 'to', d.to_id, 'amount', d.amount
  )), '[]'::jsonb)
  INTO v_raw_debts
  FROM (
    SELECT * FROM bill_debts
    UNION ALL
    SELECT * FROM settlement_debts
  ) d;

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


/** The client's buildDebtGraph (src/lib/settlement-suggestions.ts:43), in SQL: net raw edges per
    unordered pair in integer cents, drop zero, orient debtor -> creditor, order by from, to.
    Output edges carry `cents` (integer) so the comparison cannot fail on numeric scale. */
CREATE OR REPLACE FUNCTION test.net_raw_debts(p_raw jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  WITH e AS (
    SELECT x ->> 'from' AS f, x ->> 'to' AS t, ROUND((x ->> 'amount')::numeric * 100)::bigint AS c
    FROM jsonb_array_elements(COALESCE(p_raw, '[]'::jsonb)) x
    WHERE x ->> 'from' <> x ->> 'to'
  ),
  signed AS (
    SELECT LEAST(f, t) AS a, GREATEST(f, t) AS b, CASE WHEN f < t THEN c ELSE -c END AS s FROM e
  ),
  pair AS (SELECT a, b, SUM(s) AS net FROM signed GROUP BY a, b)
  SELECT COALESCE(jsonb_agg(edge ORDER BY edge ->> 'from', edge ->> 'to'), '[]'::jsonb)
  FROM (
    SELECT CASE WHEN net > 0 THEN jsonb_build_object('from', a, 'to', b, 'cents', net)
                ELSE jsonb_build_object('from', b, 'to', a, 'cents', -net) END AS edge
    FROM pair WHERE net <> 0
  ) z;
$$;

/** 083's rawDebts in the same {from, to, cents} shape, KEEPING the emitted order. */
CREATE OR REPLACE FUNCTION test.as_cents(p_debts jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('from', x ->> 'from', 'to', x ->> 'to',
                       'cents', ROUND((x ->> 'amount')::numeric * 100)::bigint)
    ORDER BY o), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_debts, '[]'::jsonb)) WITH ORDINALITY AS t(x, o);
$$;

/** One edge's amount, or NULL when the pair has no edge in that direction. */
CREATE OR REPLACE FUNCTION test.edge(p_debts jsonb, p_from uuid, p_to uuid)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (x ->> 'amount')::numeric
  FROM jsonb_array_elements(COALESCE(p_debts, '[]'::jsonb)) x
  WHERE x ->> 'from' = p_from::text AND x ->> 'to' = p_to::text;
$$;

/** The three structural rules every netted rawDebts must satisfy. */
CREATE OR REPLACE FUNCTION test.assert_netted_shape(p_debts jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  n_pairs int; n_edges int; n_bad int; emitted text[]; sorted text[];
BEGIN
  n_edges := jsonb_array_length(p_debts);
  SELECT count(DISTINCT LEAST(x ->> 'from', x ->> 'to') || '|' || GREATEST(x ->> 'from', x ->> 'to'))
  INTO n_pairs FROM jsonb_array_elements(p_debts) x;
  PERFORM test.assert_eq(n_edges, n_pairs, p_what || ': at most one edge per unordered pair');

  SELECT count(*) INTO n_bad FROM jsonb_array_elements(p_debts) x
  WHERE (x ->> 'amount')::numeric <= 0 OR x ->> 'from' = x ->> 'to'
     OR (x ->> 'amount')::numeric * 100 <> ROUND((x ->> 'amount')::numeric * 100);
  PERFORM test.assert_eq(n_bad, 0, p_what || ': every amount is > 0, whole cents, never a self-edge');

  emitted := ARRAY(SELECT (x ->> 'from') || '|' || (x ->> 'to')
                   FROM jsonb_array_elements(p_debts) WITH ORDINALITY t(x, o) ORDER BY o);
  sorted := ARRAY(SELECT (x ->> 'from') || '|' || (x ->> 'to')
                  FROM jsonb_array_elements(p_debts) x ORDER BY x ->> 'from', x ->> 'to');
  PERFORM test.assert_eq(emitted, sorted, p_what || ': edges are ordered by from, to');
END;
$$;

-- ---------------------------------------------------------------------------
-- C1: opposing split debts between one pair collapse to one edge carrying the difference.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; debts jsonb;
BEGIN
  alice := test.new_account('n1-alice@example.com', 'Alice');
  bob   := test.new_account('n1-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Opposing');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  -- Bob owes Alice 50; Alice owes Bob 15. Net: Bob owes Alice 35.
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  PERFORM test.new_bill(bob, bob, g, 'Taxi', 30, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(jsonb_array_length(debts), 1, 'C1: two opposing debts become ONE edge');
  PERFORM test.assert_money(test.edge(debts, bob, alice), 35, 'C1: Bob owes Alice the 35 difference');
  PERFORM test.assert_eq(test.edge(debts, alice, bob), NULL::numeric, 'C1: no reverse edge survives');
  PERFORM test.assert_netted_shape(debts, 'C1');
  PERFORM test.as_owner();
  PERFORM test.note('C1: opposing split debts net to one edge, direction of the larger side');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2: a payment that fully clears the pair removes the pair; a partial one shrinks it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; debts jsonb;
BEGIN
  alice := test.new_account('n2-alice@example.com', 'Alice');
  bob   := test.new_account('n2-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Cleared');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Dinner', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 20, g, NULL, 'PHP');

  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(jsonb_array_length(debts), 1, 'C2: a partial payment leaves one edge');
  PERFORM test.assert_money(test.edge(debts, bob, alice), 30, 'C2: 50 owed - 20 paid = 30');
  PERFORM test.as_owner();

  PERFORM test.new_settlement(bob, alice, 30, g, NULL, 'PHP');
  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(debts, '[]'::jsonb, 'C2: a fully cleared pair has no edge at all (zero net dropped)');
  PERFORM test.as_owner();

  -- Overpaying flips the direction rather than going negative.
  PERFORM test.new_settlement(bob, alice, 5, g, NULL, 'PHP');
  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(jsonb_array_length(debts), 1, 'C2: an overpayment is one edge');
  PERFORM test.assert_money(test.edge(debts, alice, bob), 5, 'C2: the overpaid 5 is now owed back to Bob');
  PERFORM test.as_owner();
  PERFORM test.note('C2: settled payments cancel; zero nets are omitted; overpayment flips');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3 + C7: a four-member group with bills and partial payments. The netted set equals the client
-- netting of 079's raw edges (so buildSuggestedPayers suggests the same transfers — the Vitest
-- half in tests/lib/settlement-suggestions-netted.test.ts feeds these exact edges), and every
-- other key is identical to 079's.
--
-- Raw edges: Hotel (Alice pays 120 over 4): Bob, Cara, Dan -> Alice 30 each.
--            Wifi (Bob pays 80 over Alice, Bob): Alice -> Bob 40.
--            Food (Cara pays 60 over Bob, Cara, Dan): Bob -> Cara 20, Dan -> Cara 20.
--            Payments Dan -> Alice 10, Bob -> Alice 5 enter as Alice -> Dan 10, Alice -> Bob 5.
-- Netted:    Alice -> Bob 15, Cara -> Alice 30, Dan -> Alice 20, Bob -> Cara 20, Dan -> Cara 20.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; dan uuid; g uuid; d jsonb; ref jsonb;
BEGIN
  alice := test.new_account('n3-alice@example.com', 'Alice');
  bob   := test.new_account('n3-bob@example.com', 'Bob');
  cara  := test.new_account('n3-cara@example.com', 'Cara');
  dan   := test.new_account('n3-dan@example.com', 'Dan');
  g := test.new_group(alice, 'Four');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.add_member(g, dan, 'Dan');
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 120, ARRAY[alice, bob, cara, dan]);
  PERFORM test.new_bill(bob, bob, g, 'Wifi', 80, ARRAY[alice, bob]);
  PERFORM test.new_bill(cara, cara, g, 'Food', 60, ARRAY[bob, cara, dan]);
  PERFORM test.new_settlement(dan, alice, 10, g, NULL, 'PHP');
  PERFORM test.new_settlement(bob, alice, 5, g, NULL, 'PHP');

  PERFORM test.as_user(bob);
  d := public.kwenta_group_detail(g);
  ref := test.group_detail_079_reference(g);

  PERFORM test.assert_eq(jsonb_array_length(ref -> 'rawDebts'), 8, 'C3: 079 sends 8 raw edges for this group');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'rawDebts'), 5, 'C3: 083 sends one per non-zero pair');
  PERFORM test.assert_money(test.edge(d -> 'rawDebts', alice, bob), 15, 'C3: Alice -> Bob 15');
  PERFORM test.assert_money(test.edge(d -> 'rawDebts', cara, alice), 30, 'C3: Cara -> Alice 30');
  PERFORM test.assert_money(test.edge(d -> 'rawDebts', dan, alice), 20, 'C3: Dan -> Alice 20');
  PERFORM test.assert_money(test.edge(d -> 'rawDebts', bob, cara), 20, 'C3: Bob -> Cara 20');
  PERFORM test.assert_money(test.edge(d -> 'rawDebts', dan, cara), 20, 'C3: Dan -> Cara 20');
  PERFORM test.assert_eq(test.as_cents(d -> 'rawDebts'), test.net_raw_debts(ref -> 'rawDebts'),
    'C3: the netted edges are exactly what buildDebtGraph makes of 079''s raw edges, in from,to order');
  PERFORM test.assert_netted_shape(d -> 'rawDebts', 'C3');

  PERFORM test.assert_eq(d - 'rawDebts', ref - 'rawDebts',
    'C7: bills, members, pairwise, memberBalances, totals and group are identical to 079');
  PERFORM test.assert_eq(
    ARRAY(SELECT jsonb_object_keys(d) ORDER BY 1), ARRAY(SELECT jsonb_object_keys(ref) ORDER BY 1),
    'C7: no key added or dropped');
  PERFORM test.as_owner();
  PERFORM test.note('C3/C7: netted set equals client netting of 079 edges; other keys unchanged');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: foreign-currency bills and payments, deleted rows and unsettled payments stay out; the
-- payer's own share is never an edge.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; debts jsonb; gone uuid; s uuid;
BEGIN
  alice := test.new_account('n4-alice@example.com', 'Alice');
  bob   := test.new_account('n4-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Filters', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'PHP dinner', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_bill(alice, alice, g, 'USD extra', 500, ARRAY[alice, bob], 'USD');
  PERFORM test.new_settlement(alice, bob, 70, g, NULL, 'USD');
  gone := test.new_bill(bob, bob, g, 'Deleted bill', 300, ARRAY[alice, bob], 'PHP');
  UPDATE public.bills SET is_deleted = true WHERE id = gone;
  s := test.new_settlement(bob, alice, 50, g, NULL, 'PHP');
  UPDATE public.settlements SET is_deleted = true WHERE id = s;
  s := test.new_settlement(bob, alice, 50, g, NULL, 'PHP');
  UPDATE public.settlements SET is_settled = false WHERE id = s;
  -- A split row deleted under a live bill.
  gone := test.new_bill(bob, bob, g, 'Half-deleted', 40, ARRAY[alice, bob], 'PHP');
  UPDATE public.item_splits SET is_deleted = true
  WHERE user_id = alice AND item_id IN (SELECT id FROM public.bill_items WHERE bill_id = gone);

  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(jsonb_array_length(debts), 1, 'C4: only the live PHP split is an edge');
  PERFORM test.assert_money(test.edge(debts, bob, alice), 50,
    'C4: USD rows, deleted bills/splits/payments and unsettled payments move nothing');
  PERFORM test.assert_netted_shape(debts, 'C4');
  PERFORM test.as_owner();
  PERFORM test.note('C4: currency, deletion and is_settled filters kept; no self-edges');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5: exact cents, and literal (not canonicalised) ids.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; c_bob uuid; g uuid; debts jsonb;
BEGIN
  alice := test.new_account('n5-alice@example.com', 'Alice');
  bob   := test.new_account('n5-bob@example.com', 'Bob');
  cara  := test.new_account('n5-cara@example.com', 'Cara');
  g := test.new_group(alice, 'Thirds');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  -- 100 over three: the first listed gets 33.34, the others 33.33 (001 new_bill remainder rule).
  PERFORM test.new_bill(alice, alice, g, 'One', 100, ARRAY[bob, alice, cara]);   -- Bob 33.34, Cara 33.33
  PERFORM test.new_bill(alice, alice, g, 'Two', 100, ARRAY[cara, bob, alice]);   -- Cara 33.34, Bob 33.33
  PERFORM test.new_bill(alice, alice, g, 'Three', 0.30, ARRAY[bob, cara, alice]); -- 0.10 each

  -- A legacy split filed under Alice's local contact for Bob (linked to Bob's account): the edge
  -- must carry that literal id. Canonicalising it would silently merge it into Bob's edge.
  c_bob := test.new_contact(alice, 'Bob (contact)', bob);
  PERFORM test.new_bill(alice, alice, g, 'Legacy', 10, ARRAY[alice, c_bob]);

  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';
  PERFORM test.assert_eq(test.edge(debts, bob, alice), 66.77::numeric,
    'C5: 33.34 + 33.33 + 0.10 = 66.77 exactly — no float drift');
  PERFORM test.assert_eq(test.edge(debts, cara, alice), 66.77::numeric, 'C5: and the same for Cara');
  PERFORM test.assert_eq(test.edge(debts, c_bob, alice), 5::numeric,
    'C5: the contact id stays its own literal edge');
  PERFORM test.assert_eq(jsonb_array_length(debts), 3, 'C5: three pairs, three edges');
  PERFORM test.assert_netted_shape(debts, 'C5');
  PERFORM test.as_owner();
  PERFORM test.note('C5: exact cents; literal ids');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6 + C7: the measured shape — 8 members, 59 bills each split across all 8. 079 sends 59 * 7 =
-- 413 edges; 083 at most 8 * 7 / 2 = 28.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  m uuid[] := '{}'; g uuid; i int; d jsonb; ref jsonb;
BEGIN
  FOR i IN 1..8 LOOP
    m := m || test.new_account('n6-m' || i || '@example.com', 'M' || i);
  END LOOP;
  g := test.new_group(m[1], 'Siquijor');
  FOR i IN 1..8 LOOP
    PERFORM test.add_member(g, m[i], 'M' || i);
  END LOOP;
  FOR i IN 1..59 LOOP
    PERFORM test.new_bill(m[1 + (i % 8)], m[1 + (i % 8)], g, 'Bill ' || i, 80 + (i * 7) % 113 + 0.37, m);
  END LOOP;
  PERFORM test.new_settlement(m[2], m[1], 12.34, g, NULL, 'PHP');

  PERFORM test.as_user(m[1]);
  d := public.kwenta_group_detail(g);
  ref := test.group_detail_079_reference(g);
  PERFORM test.assert_eq(jsonb_array_length(ref -> 'rawDebts'), 414, 'C6: 079 sends one edge per split plus the payment');
  PERFORM test.assert_true(jsonb_array_length(d -> 'rawDebts') <= 28,
    'C6: 083 sends at most n(n-1)/2 = 28 edges, never one per split');
  PERFORM test.assert_eq(test.as_cents(d -> 'rawDebts'), test.net_raw_debts(ref -> 'rawDebts'),
    'C6: and they are exactly the pair nets of the raw edges');
  PERFORM test.assert_netted_shape(d -> 'rawDebts', 'C6');
  PERFORM test.assert_eq(d - 'rawDebts', ref - 'rawDebts', 'C7: every other key identical to 079 at scale');
  PERFORM test.assert_true(octet_length((d -> 'rawDebts')::text) * 5 < octet_length((ref -> 'rawDebts')::text),
    'C6: the rawDebts payload shrinks by more than 5x');
  PERFORM test.as_owner();
  PERFORM test.note('C6: 59 bills x 8 members -> <= 28 edges');
END;
$$;

-- Access is unchanged: a non-member still gets null.
DO $$
DECLARE
  alice uuid; zed uuid; g uuid;
BEGIN
  alice := test.new_account('n7-alice@example.com', 'Alice');
  zed   := test.new_account('n7-zed@example.com', 'Zed');
  g := test.new_group(alice, 'Private');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb, 'C7: a non-member still gets null');
  PERFORM test.as_owner();
END;
$$;

-- ===========================================================================
-- kwenta_personal_bills_page
-- ===========================================================================

/** Shared fixture: Alice's seven bills, three shared with her by Bob, one of Carl's she is not on.
    created_at is set per bill (now() is constant inside a transaction). m5 and m7 share a
    timestamp on purpose: the id tiebreak is part of the contract. Returns the ids in a jsonb map. */
CREATE OR REPLACE FUNCTION test.bills_page_fixture(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  alice uuid; bob uuid; carl uuid; ids jsonb := '{}'::jsonb; b uuid;
  base timestamptz := '2026-09-01T12:00:00+00'::timestamptz;
BEGIN
  alice := test.new_account('bp-alice-' || p_tag || '@example.com', 'Alice');
  bob   := test.new_account('bp-bob-' || p_tag || '@example.com', 'Bob');
  carl  := test.new_account('bp-carl-' || p_tag || '@example.com', 'Carl');
  ids := ids || jsonb_build_object('alice', alice, 'bob', bob, 'carl', carl);

  -- key, title, day, category, split-with-bob
  b := test.new_bill(alice, alice, NULL, 'apple', 10, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '1 day', category = 'food' WHERE id = b;
  ids := ids || jsonb_build_object('m1', b);
  b := test.new_bill(alice, alice, NULL, 'Banana', 20, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '2 days' WHERE id = b;
  ids := ids || jsonb_build_object('m2', b);
  b := test.new_bill(alice, alice, NULL, 'cherry', 30, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '3 days', category = 'transport' WHERE id = b;
  ids := ids || jsonb_build_object('m3', b);
  b := test.new_bill(alice, alice, NULL, 'Apple', 40, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '4 days', category = 'food' WHERE id = b;
  ids := ids || jsonb_build_object('m4', b);
  b := test.new_bill(alice, alice, NULL, 'date', 50, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '5 days' WHERE id = b;
  ids := ids || jsonb_build_object('m5', b);
  b := test.new_bill(alice, alice, NULL, 'APPLE', 60, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '6 days' WHERE id = b;
  ids := ids || jsonb_build_object('m6', b);
  b := test.new_bill(alice, alice, NULL, 'Elder', 70, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '5 days' WHERE id = b;
  ids := ids || jsonb_build_object('m7', b);
  -- A deleted bill of Alice's never counts.
  b := test.new_bill(alice, alice, NULL, 'Deleted', 99, ARRAY[alice]);
  UPDATE public.bills SET is_deleted = true WHERE id = b;
  -- A group bill is not a personal bill.
  PERFORM test.new_bill(alice, alice, test.new_group(alice, 'G ' || p_tag), 'Group thing', 80, ARRAY[alice]);

  b := test.new_bill(bob, bob, NULL, 'Bob lunch', 100, ARRAY[bob, alice]);
  UPDATE public.bills SET created_at = base + interval '1 day', category = 'health' WHERE id = b;
  ids := ids || jsonb_build_object('s1', b);
  b := test.new_bill(bob, bob, NULL, 'bob coffee', 8, ARRAY[bob, alice]);
  UPDATE public.bills SET created_at = base + interval '7 days' WHERE id = b;
  ids := ids || jsonb_build_object('s2', b);
  b := test.new_bill(bob, bob, NULL, 'Bob taxi', 12, ARRAY[bob, alice]);
  UPDATE public.bills SET created_at = base + interval '3 days' WHERE id = b;
  ids := ids || jsonb_build_object('s3', b);

  b := test.new_bill(carl, carl, NULL, 'Carl secret', 500, ARRAY[carl, bob]);
  ids := ids || jsonb_build_object('carl_bill', b);
  RETURN ids;
END;
$$;

/** The ids of a page response, in order. */
CREATE OR REPLACE FUNCTION test.page_ids(p_page jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg((x ->> 'id')::uuid ORDER BY o), '{}')
  FROM jsonb_array_elements(COALESCE(p_page -> 'rows', '[]'::jsonb)) WITH ORDINALITY t(x, o);
$$;

/** Ids from a fixture map, in the order given. */
CREATE OR REPLACE FUNCTION test.ids_of(p_map jsonb, VARIADIC p_keys text[])
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_agg((p_map ->> k)::uuid ORDER BY o) FROM unnest(p_keys) WITH ORDINALITY t(k, o);
$$;

-- ---------------------------------------------------------------------------
-- C8 + C14: first p_limit rows in the chosen sort, the counts, and the categories of `mine`.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; p jsonb; lo text; hi text;
BEGIN
  f := test.bills_page_fixture('c8');
  -- m5 and m7 share created_at: the id breaks the tie, ascending, in BOTH date sorts.
  IF (f ->> 'm5') < (f ->> 'm7') THEN lo := 'm5'; hi := 'm7'; ELSE lo := 'm7'; hi := 'm5'; END IF;

  PERFORM test.as_user((f ->> 'alice')::uuid);

  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm6', lo, hi, 'm4', 'm3', 'm2', 'm1'),
    'C8/C14: date_desc = created_at DESC, id ASC');
  PERFORM test.assert_eq((p ->> 'matching')::int, 7, 'C8: matching counts the bucket (deleted and group bills excluded)');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'C8: mine = 7');
  PERFORM test.assert_eq((p ->> 'shared')::int, 3, 'C8: shared = 3');
  PERFORM test.assert_eq(p -> 'categories', '["food", "transport"]'::jsonb,
    'C8: categories are the distinct non-null categories of MINE, sorted (Bob''s "health" is not one)');

  p := public.kwenta_personal_bills_page('mine', 3, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm6', lo, hi), 'C8: the limit takes the first 3');
  PERFORM test.assert_eq((p ->> 'matching')::int, 7, 'C8: matching is the total before the limit');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'C8: mine is unaffected by the limit');

  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_asc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm1', 'm2', 'm3', 'm4', lo, hi, 'm6'),
    'C14: date_asc = created_at ASC, id ASC (the tie keeps id ASC, it is not a plain reverse)');

  -- 'apple', 'Apple', 'APPLE' tie on lower(title): newest first (m6 day 6, m4 day 4, m1 day 1).
  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'title_asc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm6', 'm4', 'm1', 'm2', 'm3', 'm5', 'm7'),
    'C14: title_asc is case-insensitive; ties newest first');
  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'title_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm7', 'm5', 'm3', 'm2', 'm6', 'm4', 'm1'),
    'C14: title_desc reverses the titles, ties STILL newest first');
  p := public.kwenta_personal_bills_page('mine', 2, 'all', NULL, 'title_asc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm6', 'm4'), 'C14: the sort applies before the limit');

  p := public.kwenta_personal_bills_page('shared', 20, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 's2', 's3', 's1'), 'C8: the shared bucket, newest first');
  PERFORM test.assert_eq((p ->> 'matching')::int, 3, 'C8: shared matching');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'C8: both totals come back on either bucket');
  PERFORM test.assert_eq(p -> 'categories', '["food", "transport"]'::jsonb,
    'C8: categories are from mine even when the shared bucket is asked for');

  -- Defaults: settled 'all', category NULL, sort 'date_desc'.
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('mine', 20),
    public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc'), 'C8: the defaults');
  PERFORM test.assert_eq(
    ARRAY(SELECT jsonb_object_keys(p) ORDER BY 1),
    ARRAY['categories', 'matching', 'mine', 'rows', 'shared'], 'C8: exactly the five keys');

  PERFORM test.as_owner();
  PERFORM test.note('C8/C14: sorting, limits, counts, categories');
END;
$$;

-- ---------------------------------------------------------------------------
-- C9: settled / category filters run before the limit; matching counts the filtered set.
-- Which bills are settled is kwenta_personal_bills()'s answer (the settled map), not re-derived.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; p jsonb; full_mine jsonb; settled_ids uuid[]; open_ids uuid[];
BEGIN
  f := test.bills_page_fixture('c9');
  PERFORM test.as_user((f ->> 'alice')::uuid);
  full_mine := public.kwenta_personal_bills() -> 'mine';
  settled_ids := ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(full_mine) WITH ORDINALITY t(x, o)
                       WHERE (x ->> 'settled')::boolean ORDER BY o);
  open_ids := ARRAY(SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(full_mine) WITH ORDINALITY t(x, o)
                    WHERE NOT (x ->> 'settled')::boolean ORDER BY o);
  -- Solo bills (m1, m5, m6, m7) owe nobody; m2, m3, m4 leave Bob owing Alice.
  PERFORM test.assert_ids(settled_ids, test.ids_of(f, 'm1', 'm5', 'm6', 'm7'), 'C9 fixture: solo bills are settled');
  PERFORM test.assert_ids(open_ids, test.ids_of(f, 'm2', 'm3', 'm4'), 'C9 fixture: bills Bob owes on are open');

  p := public.kwenta_personal_bills_page('mine', 20, 'settled', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), settled_ids, 'C9: settled filter, same order as the full list');
  PERFORM test.assert_eq((p ->> 'matching')::int, 4, 'C9: matching = 4 settled');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'C9: mine stays the unfiltered total');

  p := public.kwenta_personal_bills_page('mine', 1, 'unsettled', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm4'), 'C9: filter THEN limit (newest open bill)');
  PERFORM test.assert_eq((p ->> 'matching')::int, 3, 'C9: matching counts all 3 open bills, not the 1 returned');

  p := public.kwenta_personal_bills_page('mine', 20, 'all', 'food', 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm4', 'm1'), 'C9: category filter');
  PERFORM test.assert_eq((p ->> 'matching')::int, 2, 'C9: matching = 2 food');
  PERFORM test.assert_eq(p -> 'categories', '["food", "transport"]'::jsonb, 'C9: categories ignore the filter');

  p := public.kwenta_personal_bills_page('mine', 20, 'unsettled', 'food', 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'm4'), 'C9: both filters combine');
  PERFORM test.assert_eq((p ->> 'matching')::int, 1, 'C9: matching = 1');

  p := public.kwenta_personal_bills_page('mine', 20, 'settled', 'transport', 'date_desc');
  PERFORM test.assert_eq(p -> 'rows', '[]'::jsonb, 'C9: nothing matches -> empty rows, not null');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C9: matching = 0');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'C9: and the bucket total is still there for the page');

  p := public.kwenta_personal_bills_page('mine', 20, 'all', 'health', 'date_desc');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C9: a category present only in shared matches nothing in mine');

  PERFORM test.as_owner();
  PERFORM test.note('C9: filters before the limit');
END;
$$;

-- ---------------------------------------------------------------------------
-- C10: every row is jsonb-identical to kwenta_personal_bills()'s row for that bill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; full_rows jsonb; bucket text; sort text; settled text; p jsonb; n_bad int; n_rows int := 0;
BEGIN
  f := test.bills_page_fixture('c10');
  PERFORM test.as_user((f ->> 'alice')::uuid);
  full_rows := public.kwenta_personal_bills();

  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
      FOREACH settled IN ARRAY ARRAY['all', 'settled', 'unsettled'] LOOP
        p := public.kwenta_personal_bills_page(bucket, 500, settled, NULL, sort);
        n_rows := n_rows + jsonb_array_length(p -> 'rows');
        SELECT count(*) INTO n_bad
        FROM jsonb_array_elements(p -> 'rows') r
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(full_rows -> bucket) x WHERE x = r);
        PERFORM test.assert_eq(n_bad, 0, format('C10: %s/%s/%s rows are the full endpoint''s rows', bucket, sort, settled));
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM test.assert_true(n_rows > 0, 'C10: the loop compared real rows');

  -- Unfiltered date_desc is the full bucket, row for row and in order.
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc') -> 'rows',
    full_rows -> 'mine', 'C10: mine/all/date_desc IS kwenta_personal_bills().mine');
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc') -> 'rows',
    full_rows -> 'shared', 'C10: shared/all/date_desc IS kwenta_personal_bills().shared');
  PERFORM test.as_owner();
  PERFORM test.note('C10: one row-shape implementation');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: unknown values are refused; the limit is clamped; NULL category means all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.page_raises(p_bucket text, p_limit int, p_settled text, p_sort text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.kwenta_personal_bills_page(p_bucket, p_limit, p_settled, NULL, p_sort);
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$$;

DO $$
DECLARE
  f jsonb; p jsonb;
BEGIN
  f := test.bills_page_fixture('c11');
  PERFORM test.as_user((f ->> 'alice')::uuid);

  PERFORM test.assert_true(test.page_raises('all', 20, 'all', 'date_desc'), 'C11: bucket ''all'' is refused');
  PERFORM test.assert_true(test.page_raises('MINE', 20, 'all', 'date_desc'), 'C11: bucket is case-exact');
  PERFORM test.assert_true(test.page_raises('', 20, 'all', 'date_desc'), 'C11: empty bucket is refused');
  PERFORM test.assert_true(test.page_raises('mine', 20, 'open', 'date_desc'), 'C11: settled ''open'' is refused');
  PERFORM test.assert_true(test.page_raises('mine', 20, 'all', 'newest'), 'C11: sort ''newest'' is refused');
  PERFORM test.assert_true(test.page_raises('mine', 20, 'all', 'created_at desc'), 'C11: sort is not passed through as SQL');
  PERFORM test.assert_false(test.page_raises('shared', 20, 'unsettled', 'title_desc'), 'C11: valid values are accepted');

  p := public.kwenta_personal_bills_page('mine', 0, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 1, 'C11: limit 0 is clamped up to 1');
  p := public.kwenta_personal_bills_page('mine', -5, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 1, 'C11: a negative limit is clamped up to 1');
  p := public.kwenta_personal_bills_page('mine', NULL, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 7, 'C11: NULL limit means 20 (7 bills, all fit)');
  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq((p ->> 'matching')::int, 7, 'C11: NULL category means every category');
  PERFORM test.as_owner();
  PERFORM test.note('C11: argument validation and clamps');
END;
$$;

-- C11 (upper clamp) and the NULL-limit default of 20, which need more rows than the limits.
DO $$
DECLARE
  alice uuid; p jsonb;
BEGIN
  alice := test.new_account('bp-many@example.com', 'Many');
  -- 501 bills in new_bill's exact shape: one item, one equal split on the creator.
  CREATE TEMP TABLE many_bills ON COMMIT DROP AS
    SELECT gen_random_uuid() AS bill_id, gen_random_uuid() AS item_id, i FROM generate_series(1, 501) i;
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT bill_id, NULL, alice, alice, 'Bill ' || i, 10, 'PHP',
         '2026-01-01'::timestamptz + make_interval(mins => i), now(), now(), false, 'test'
  FROM many_bills;
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT item_id, bill_id, 'Bill ' || i, 10, now(), now(), now(), false, 'test' FROM many_bills;
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), item_id, alice, 'equal', 1, 10, now(), now(), now(), false, 'test' FROM many_bills;

  PERFORM test.as_user(alice);
  p := public.kwenta_personal_bills_page('mine', 1000, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 500, 'C11: a limit above 500 is clamped to 500');
  PERFORM test.assert_eq((p ->> 'matching')::int, 501, 'C11: matching still counts all 501');
  p := public.kwenta_personal_bills_page('mine', NULL, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 20, 'C11: NULL limit -> 20');
  PERFORM test.assert_eq(p -> 'rows' -> 0 ->> 'title', 'Bill 501', 'C11: newest first');
  PERFORM test.as_owner();
  PERFORM test.note('C11: limit clamped to 500, NULL -> 20');
END;
$$;

-- ---------------------------------------------------------------------------
-- C12: a viewer sees only their own buckets; unauthenticated is refused.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; p jsonb; alice_ids uuid[]; bob_ids uuid[]; msg text;
BEGIN
  f := test.bills_page_fixture('c12');

  PERFORM test.as_user((f ->> 'alice')::uuid);
  alice_ids := test.page_ids(public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc'))
            || test.page_ids(public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc'));
  PERFORM test.assert_false((f ->> 'carl_bill')::uuid = ANY(alice_ids),
    'C12: Carl''s bill with Bob never reaches Alice');
  PERFORM test.as_owner();

  PERFORM test.as_user((f ->> 'carl')::uuid);
  p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(test.page_ids(p), test.ids_of(f, 'carl_bill'), 'C12: Carl sees only his own bill');
  PERFORM test.assert_eq((p ->> 'mine')::int, 1, 'C12: Carl mine = 1');
  PERFORM test.assert_eq((p ->> 'shared')::int, 0, 'C12: Carl shared = 0 — none of Alice''s bills');
  PERFORM test.assert_eq(p -> 'categories', '[]'::jsonb, 'C12: no categories leak from other accounts');
  PERFORM test.as_owner();

  -- Bob is on m2, m3, m4 of Alice's and on Carl's bill: exactly his shared bucket.
  PERFORM test.as_user((f ->> 'bob')::uuid);
  bob_ids := test.page_ids(public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc'));
  PERFORM test.assert_ids(bob_ids, test.ids_of(f, 'm2', 'm3', 'm4', 'carl_bill'),
    'C12: Bob''s shared bucket is exactly the bills he is split on');
  PERFORM test.as_owner();

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc');
    msg := NULL;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C12: no auth.uid() raises ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  PERFORM test.note('C12: scoped to auth.uid(); unauthenticated refused');
END;
$$;

-- ---------------------------------------------------------------------------
-- C13: granted to authenticated, not anon. (The 073 allowlist names it too.)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_true(has_function_privilege('authenticated',
    'public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb)', 'EXECUTE'),
    'C13: authenticated may call the page endpoint');
  PERFORM test.assert_false(has_function_privilege('anon',
    'public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb)', 'EXECUTE'),
    'C13: anon may not');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_personal_bills()', 'EXECUTE'),
    'C13: the full endpoint stays callable for Export and installed older builds');
  PERFORM test.note('C13: grants');
END;
$$;

-- ---------------------------------------------------------------------------
-- C15: the measured account — ~109 own bills and ~60 shared — gets 20 rows per tab.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; p jsonb; full_rows jsonb; q jsonb;
BEGIN
  alice := test.new_account('bp-big-alice@example.com', 'Alice');
  bob   := test.new_account('bp-big-bob@example.com', 'Bob');
  CREATE TEMP TABLE big_bills ON COMMIT DROP AS
    SELECT gen_random_uuid() AS bill_id, gen_random_uuid() AS item_id, i,
           CASE WHEN i <= 109 THEN alice ELSE bob END AS creator
    FROM generate_series(1, 169) i;
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT bill_id, NULL, creator, creator, 'Bill ' || i, 100, 'PHP',
         '2026-01-01'::timestamptz + make_interval(hours => i), now(), now(), false, 'test'
  FROM big_bills;
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT item_id, bill_id, 'Bill ' || i, 100, now(), now(), now(), false, 'test' FROM big_bills;
  -- Both people on every bill, 50 each (equal split, split_value 1, as the form writes it).
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), item_id, u, 'equal', 1, 50, now(), now(), now(), false, 'test'
  FROM big_bills, LATERAL (VALUES (alice), (bob)) v(u);

  PERFORM test.as_user(alice);
  full_rows := public.kwenta_personal_bills();
  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc');
  q := public.kwenta_personal_bills_page('shared', 20, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(jsonb_array_length(full_rows -> 'mine') + jsonb_array_length(full_rows -> 'shared'), 169,
    'C15 fixture: the full endpoint sends all 169');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 20, 'C15: My bills gets 20 rows');
  PERFORM test.assert_eq(jsonb_array_length(q -> 'rows'), 20, 'C15: Shared gets 20 rows');
  PERFORM test.assert_eq((p ->> 'mine')::int, 109, 'C15: with the true mine total');
  PERFORM test.assert_eq((p ->> 'shared')::int, 60, 'C15: and the true shared total');
  PERFORM test.assert_true(octet_length(p::text) * 4 < octet_length(full_rows::text),
    'C15: a page is well under a quarter of the full list''s bytes');
  PERFORM test.as_owner();
  PERFORM test.note('C15: 20 rows per tab, not the whole list');
END;
$$;

-- ===========================================================================
-- Keyset paging: p_after (H4.1)
-- ===========================================================================

/** The cursor a client sends: the last loaded row's id, createdAt and title. */
CREATE OR REPLACE FUNCTION test.cursor_of(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('id', p_row -> 'id', 'createdAt', p_row -> 'createdAt', 'title', p_row -> 'title');
$$;

CREATE OR REPLACE FUNCTION test.page_after_raises(p_sort text, p_after jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.kwenta_personal_bills_page('mine', 20, 'all', NULL, p_sort, p_after);
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- (a) For every sort, in both buckets and under a filter, a cursor on ANY row returns exactly the
-- rows after it, in order. The fixture's apple / Apple / APPLE share a lower(title) and m5 / m7
-- share a created_at, so the title ties and the id tiebreak are both crossed by a cursor.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; sort text; bucket text; settled text; full_p jsonb; rows_arr jsonb; ids uuid[]; i int; p jsonb; n_checked int := 0;
BEGIN
  f := test.bills_page_fixture('kc');
  PERFORM test.as_user((f ->> 'alice')::uuid);

  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    FOREACH settled IN ARRAY ARRAY['all', 'unsettled'] LOOP
      FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
        full_p := public.kwenta_personal_bills_page(bucket, 500, settled, NULL, sort);
        rows_arr := full_p -> 'rows';
        ids := test.page_ids(full_p);
        FOR i IN 0 .. jsonb_array_length(rows_arr) - 1 LOOP
          p := public.kwenta_personal_bills_page(bucket, 500, settled, NULL, sort, test.cursor_of(rows_arr -> i));
          PERFORM test.assert_eq(test.page_ids(p), ids[i + 2:], format('KC-a: %s/%s/%s after row %s', bucket, settled, sort, i));
          PERFORM test.assert_eq((p ->> 'matching')::int, (full_p ->> 'matching')::int,
            format('KC-a: %s/%s/%s matching is still the whole filtered count', bucket, settled, sort));
          n_checked := n_checked + 1;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM test.assert_true(n_checked > 40, 'KC-a: the loop compared real cursors');

  -- The limit applies after the cursor, and mine / shared / categories are untouched by it.
  full_p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'title_asc');
  p := public.kwenta_personal_bills_page('mine', 2, 'all', NULL, 'title_asc', test.cursor_of(full_p -> 'rows' -> 1));
  PERFORM test.assert_eq(test.page_ids(p), (test.page_ids(full_p))[3:4], 'KC-a: limit 2 after the second row');
  PERFORM test.assert_eq((p ->> 'matching')::int, 7, 'KC-a: matching is the full filtered count');
  PERFORM test.assert_eq((p ->> 'mine')::int, 7, 'KC-a: mine unchanged');
  PERFORM test.assert_eq((p ->> 'shared')::int, 3, 'KC-a: shared unchanged');
  PERFORM test.assert_eq(p -> 'categories', '["food", "transport"]'::jsonb, 'KC-a: categories unchanged');

  -- A cursor on the last row is an empty page, not an error; a NULL cursor is the first page.
  p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc',
         test.cursor_of(public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc') -> 'rows' -> 6));
  PERFORM test.assert_eq(p -> 'rows', '[]'::jsonb, 'KC-a: after the last row there is nothing');
  PERFORM test.assert_eq((p ->> 'matching')::int, 7, 'KC-a: and matching still says 7');
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc', NULL),
    public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc'), 'KC-a: a NULL cursor is the first page');
  PERFORM test.as_owner();
  PERFORM test.note('KC-a: a cursor returns exactly the rows after it, for every sort, bucket and filter');
END;
$$;

-- ---------------------------------------------------------------------------
-- (b) 530 bills (past the 500 clamp), with duplicate timestamps and duplicate titles: walking pages
-- of 20 through p_after visits every filtered row exactly once and reaches the last one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; sort text; settled text; p jsonb; cursor jsonb; seen uuid[]; page uuid[]; n_pages int; expected int; all_ids uuid[];
BEGIN
  alice := test.new_account('kc-walk@example.com', 'Walker');
  CREATE TEMP TABLE walk_bills ON COMMIT DROP AS
    SELECT gen_random_uuid() AS bill_id, gen_random_uuid() AS item_id, i FROM generate_series(1, 530) i;
  -- Three bills per timestamp and ten per title: every tie rule is crossed many times.
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT bill_id, NULL, alice, alice,
         CASE WHEN i % 2 = 0 THEN 'Title ' ELSE 'TITLE ' END || (i % 53),
         10, 'PHP', '2026-01-01'::timestamptz + make_interval(mins => i / 3), now(), now(), false, 'test'
  FROM walk_bills;
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT item_id, bill_id, 'Item', 10, now(), now(), now(), false, 'test' FROM walk_bills;
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), item_id, alice, 'equal', 1, 10, now(), now(), now(), false, 'test' FROM walk_bills;

  -- The temp table belongs to the owner: read what the walks compare against before as_user.
  all_ids := ARRAY(SELECT bill_id FROM walk_bills);
  UPDATE public.bills SET category = 'food' WHERE id IN (SELECT bill_id FROM walk_bills WHERE i % 7 = 0);
  expected := (SELECT count(*) FROM walk_bills WHERE i % 7 = 0);

  PERFORM test.as_user(alice);
  FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
    seen := '{}'; cursor := NULL; n_pages := 0;
    LOOP
      p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, sort, cursor);
      PERFORM test.assert_eq((p ->> 'matching')::int, 530, format('KC-b: %s matching stays 530 on every page', sort));
      page := test.page_ids(p);
      EXIT WHEN cardinality(page) = 0;
      PERFORM test.assert_true(cardinality(page) <= 20, 'KC-b: a page never exceeds 20');
      PERFORM test.assert_false(seen && page, format('KC-b: %s page %s repeats a row already visited', sort, n_pages));
      seen := seen || page;
      n_pages := n_pages + 1;
      cursor := test.cursor_of(p -> 'rows' -> (jsonb_array_length(p -> 'rows') - 1));
      EXIT WHEN n_pages > 40;
    END LOOP;
    PERFORM test.assert_eq(cardinality(seen), 530, format('KC-b: %s walk visits all 530 bills', sort));
    PERFORM test.assert_eq(n_pages, 27, format('KC-b: %s walk is 27 pages of 20 (26 full + 10)', sort));
    PERFORM test.assert_ids(seen, all_ids, format('KC-b: %s every fixture bill visited, and nothing else', sort));
  END LOOP;

  -- Under a filter: only the unsettled / category rows, none of the others, still exactly once.
  seen := '{}'; cursor := NULL;
  LOOP
    p := public.kwenta_personal_bills_page('mine', 20, 'all', 'food', 'title_desc', cursor);
    page := test.page_ids(p);
    EXIT WHEN cardinality(page) = 0;
    PERFORM test.assert_false(seen && page, 'KC-b: filtered walk repeats nothing');
    seen := seen || page;
    cursor := test.cursor_of(p -> 'rows' -> (jsonb_array_length(p -> 'rows') - 1));
  END LOOP;
  PERFORM test.assert_eq(cardinality(seen), expected, 'KC-b: the category walk visits every food bill once');
  PERFORM test.as_owner();
  PERFORM test.note('KC-b: keyset walks past the 500 clamp, no gap or duplicate, for every sort');
END;
$$;

-- ---------------------------------------------------------------------------
-- (c) A cursor whose row has since been deleted still continues from where it was.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; sort text; p jsonb; before_ids uuid[]; cur jsonb; cur_id uuid; after_ids uuid[];
BEGIN
  f := test.bills_page_fixture('kd');
  FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
    PERFORM test.as_user((f ->> 'alice')::uuid);
    p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, sort);
    before_ids := test.page_ids(p);
    cur := test.cursor_of(p -> 'rows' -> 2);
    cur_id := (cur ->> 'id')::uuid;
    PERFORM test.as_owner();

    UPDATE public.bills SET is_deleted = true WHERE id = cur_id;
    PERFORM test.as_user((f ->> 'alice')::uuid);
    p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, sort, cur);
    after_ids := test.page_ids(p);
    PERFORM test.assert_eq(after_ids, before_ids[4:], format('KC-c: %s continues after a deleted cursor row', sort));
    PERFORM test.assert_eq((p ->> 'matching')::int, 6, format('KC-c: %s matching no longer counts the deleted bill', sort));
    PERFORM test.as_owner();

    UPDATE public.bills SET is_deleted = false WHERE id = cur_id;
  END LOOP;
  PERFORM test.note('KC-c: a deleted cursor row still works (compared on key values, not looked up)');
END;
$$;

-- ---------------------------------------------------------------------------
-- (d) A malformed cursor is refused, never silently read as "from the start".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; row0 jsonb;
BEGIN
  f := test.bills_page_fixture('km');
  PERFORM test.as_user((f ->> 'alice')::uuid);
  row0 := public.kwenta_personal_bills_page('mine', 1, 'all', NULL, 'date_desc') -> 'rows' -> 0;

  PERFORM test.assert_false(test.page_after_raises('date_desc', test.cursor_of(row0)), 'KC-d: a well-formed cursor is accepted');
  PERFORM test.assert_true(test.page_after_raises('date_desc', '{}'::jsonb), 'KC-d: an empty object is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc', '[]'::jsonb), 'KC-d: an array is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc', '"abc"'::jsonb), 'KC-d: a string is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc', 'null'::jsonb), 'KC-d: a JSON null is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc', jsonb_build_object('createdAt', row0 -> 'createdAt')),
    'KC-d: a missing id is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc', jsonb_build_object('id', row0 -> 'id')),
    'KC-d: a missing createdAt is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc',
    jsonb_build_object('id', 'not-a-uuid', 'createdAt', row0 -> 'createdAt')), 'KC-d: a non-uuid id is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc',
    jsonb_build_object('id', row0 -> 'id', 'createdAt', 'yesterday-ish')), 'KC-d: an unreadable createdAt is refused');
  PERFORM test.assert_true(test.page_after_raises('date_desc',
    jsonb_build_object('id', NULL, 'createdAt', row0 -> 'createdAt')), 'KC-d: a null id is refused');
  PERFORM test.assert_true(test.page_after_raises('title_asc',
    jsonb_build_object('id', row0 -> 'id', 'createdAt', row0 -> 'createdAt')),
    'KC-d: a title sort needs the title key');
  PERFORM test.assert_false(test.page_after_raises('date_desc',
    jsonb_build_object('id', row0 -> 'id', 'createdAt', row0 -> 'createdAt')),
    'KC-d: a date sort does not need a title');
  PERFORM test.as_owner();
  PERFORM test.note('KC-d: malformed cursors are refused');
END;
$$;
