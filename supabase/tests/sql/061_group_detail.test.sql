-- Migration 061: the Group detail screen.
--
-- The claim that needs pinning hardest is the one in the header: `pairwise` and `memberBalances`
-- are DIFFERENT quantities. A member can be square with the viewer and still be deep in the red
-- against the pool. If those ever collapse into one number, the member rows and the export card
-- start telling the user two different stories about the same group.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Shape and access
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; d jsonb;
BEGIN
  alice := test.new_account('gd-alice@example.com', 'Alice');
  bob   := test.new_account('gd-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  d := public.kwenta_group_detail(g);

  PERFORM test.assert_eq(d -> 'group' ->> 'name', 'Trip', 'group name');
  PERFORM test.assert_eq(d -> 'group' ->> 'currency', 'PHP', 'group currency');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'members'), 2, 'two members');
  PERFORM test.assert_true((d -> 'members' -> 0 ->> 'isCurrentUser')::boolean,
    'the viewer sorts first');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'bills'), 1, 'one bill');
  PERFORM test.assert_eq(d -> 'bills' -> 0 ->> 'payorName', 'Alice', 'payer name on the bill');
  PERFORM test.assert_money((d ->> 'totalToReceive')::numeric, 50, 'Alice is owed 50');
  PERFORM test.assert_money((d ->> 'totalToPay')::numeric, 0, 'and owes nothing');

  PERFORM test.as_owner();
  PERFORM test.note('group_detail: shape, roster order, bills, viewer totals');
END;
$$;

-- Only active members can read the group.
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid; g uuid;
BEGIN
  alice := test.new_account('gd2-alice@example.com', 'Alice');
  bob   := test.new_account('gd2-bob@example.com', 'Bob');
  zed   := test.new_account('gd2-zed@example.com', 'Zed');

  g := test.new_group(alice, 'Private');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb,
    'a non-member gets null, not a partial row that proves the group exists');
  PERFORM test.as_owner();

  -- Bob leaves. The pull bundle still carries the rows (24 — deletion events must reach former
  -- members), so absence from the bundle cannot be the check. Active membership is.
  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = bob;

  PERFORM test.as_user(bob);
  PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb,
    'a former member can no longer open the group');
  PERFORM test.as_owner();

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_detail(g) -> 'members'), 1,
    'and drops off the roster for everyone else');
  PERFORM test.as_owner();

  PERFORM test.note('group_detail: active membership gates the read');
END;
$$;

-- A deleted group is gone for its own creator too.
DO $$
DECLARE
  alice uuid; g uuid;
BEGIN
  alice := test.new_account('gd3-alice@example.com', 'Alice');
  g := test.new_group(alice, 'Gone');
  PERFORM test.add_member(g, alice, 'Alice');
  UPDATE public.groups SET is_deleted = true WHERE id = g;

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_group_detail(g), NULL::jsonb, 'a deleted group is null');
  PERFORM test.as_owner();
  PERFORM test.note('group_detail: deleted groups');
END;
$$;

-- ---------------------------------------------------------------------------
-- THE CASE THE HEADER EXISTS FOR: pairwise /= memberBalances
--
-- Bob fronts 90 for himself, Alice and Cara. Alice and Cara each owe Bob 30.
-- From ALICE's chair: she owes Bob 30 and is square with Cara — Cara is not on her radar.
-- Against the POOL: Bob is +60, Alice is -30, Cara is -30.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g uuid; d jsonb; bal jsonb;
BEGIN
  alice := test.new_account('gd4-alice@example.com', 'Alice');
  bob   := test.new_account('gd4-bob@example.com', 'Bob');
  cara  := test.new_account('gd4-cara@example.com', 'Cara');

  g := test.new_group(bob, 'Dinner club');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 90, ARRAY[alice, bob, cara]);

  PERFORM test.as_user(alice);
  d := public.kwenta_group_detail(g);

  -- Pairwise, from Alice's chair.
  PERFORM test.assert_money((d ->> 'totalToPay')::numeric, 30, 'Alice owes Bob 30 and nothing more');
  PERFORM test.assert_money((d ->> 'totalToReceive')::numeric, 0, 'Cara owes Alice nothing');

  -- Against the pool — a different question with a different answer.
  SELECT jsonb_object_agg(e ->> 'displayName', (e ->> 'amount')::numeric)
  INTO bal FROM jsonb_array_elements(d -> 'memberBalances') e;

  PERFORM test.assert_money((bal ->> 'Bob')::numeric, 60, 'Bob fronted 60 more than he consumed');
  PERFORM test.assert_money((bal ->> 'Alice')::numeric, -30, 'Alice is 30 down against the pool');
  PERFORM test.assert_money((bal ->> 'Cara')::numeric, -30,
    'Cara too — invisible to Alice pairwise, but real against the pool');

  PERFORM test.as_owner();
  PERFORM test.note('group_detail: pairwise and pool balances are different quantities');
END;
$$;

-- The pool balances always sum to zero — money is moved, never created.
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g uuid; total numeric;
BEGIN
  alice := test.new_account('gd5-alice@example.com', 'Alice');
  bob   := test.new_account('gd5-bob@example.com', 'Bob');
  cara  := test.new_account('gd5-cara@example.com', 'Cara');

  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.new_bill(alice, alice, g, 'Rent', 300, ARRAY[alice, bob, cara]);
  PERFORM test.new_bill(bob, bob, g, 'Wifi', 60, ARRAY[alice, bob]);
  PERFORM test.new_settlement(cara, alice, 40, g, NULL, 'PHP');

  PERFORM test.as_user(alice);
  SELECT SUM((e ->> 'amount')::numeric) INTO total
  FROM jsonb_array_elements(public.kwenta_group_detail(g) -> 'memberBalances') e;
  PERFORM test.assert_money(total, 0, 'pool balances net to zero');
  PERFORM test.as_owner();

  PERFORM test.note('group_detail: the pool conserves money');
END;
$$;

-- A settled member still appears, at zero. "Settled" is an answer the roster must show.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; bal jsonb;
BEGIN
  alice := test.new_account('gd6-alice@example.com', 'Alice');
  bob   := test.new_account('gd6-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Square');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Lunch', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 50, g, NULL, 'PHP');

  PERFORM test.as_user(alice);
  SELECT jsonb_object_agg(e ->> 'displayName', (e ->> 'amount')::numeric)
  INTO bal FROM jsonb_array_elements(public.kwenta_group_detail(g) -> 'memberBalances') e;

  PERFORM test.assert_money((bal ->> 'Bob')::numeric, 0, 'Bob paid up and shows as zero');
  PERFORM test.assert_money((bal ->> 'Alice')::numeric, 0, 'so does Alice');
  PERFORM test.as_owner();

  PERFORM test.note('group_detail: settled members stay on the roster at zero');
END;
$$;

-- ---------------------------------------------------------------------------
-- rawDebts — the graph the client decomposes
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; d jsonb; debts jsonb;
BEGIN
  alice := test.new_account('gd7-alice@example.com', 'Alice');
  bob   := test.new_account('gd7-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Graph');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  debts := public.kwenta_group_detail(g) -> 'rawDebts';

  PERFORM test.assert_eq(jsonb_array_length(debts), 1,
    'the payer''s own share is not a debt to themselves');
  PERFORM test.assert_eq(debts -> 0 ->> 'from', bob::text, 'the splitter owes');
  PERFORM test.assert_eq(debts -> 0 ->> 'to', alice::text, 'the payer is owed');
  PERFORM test.assert_money((debts -> 0 ->> 'amount')::numeric, 50, 'their share');
  PERFORM test.as_owner();

  -- A settled payment enters as a debt in the OPPOSITE direction, which the client's
  -- buildDebtGraph nets against the original rather than subtracting from it.
  PERFORM test.new_settlement(bob, alice, 50, g, NULL, 'PHP');

  PERFORM test.as_user(alice);
  d := public.kwenta_group_detail(g);
  debts := d -> 'rawDebts';
  PERFORM test.assert_eq(jsonb_array_length(debts), 2, 'the payment is a second, reversed edge');
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM jsonb_array_elements(debts) e
            WHERE e ->> 'from' = alice::text AND e ->> 'to' = bob::text
              AND (e ->> 'amount')::numeric = 50),
    'the reversed edge runs payer-ward');
  PERFORM test.as_owner();

  PERFORM test.note('rawDebts: split edges plus reversed settlement edges');
END;
$$;

-- Currency: a foreign-currency bill is dropped from every aggregate, never converted.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; d jsonb;
BEGIN
  alice := test.new_account('gd8-alice@example.com', 'Alice');
  bob   := test.new_account('gd8-bob@example.com', 'Bob');

  g := test.new_group(alice, 'PHP group', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'PHP dinner', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_bill(alice, alice, g, 'USD extra', 500, ARRAY[alice, bob], 'USD');

  PERFORM test.as_user(alice);
  d := public.kwenta_group_detail(g);

  PERFORM test.assert_eq(jsonb_array_length(d -> 'bills'), 2,
    'both bills are still LISTED — the user recorded them');
  PERFORM test.assert_money((d ->> 'totalToReceive')::numeric, 50,
    'but only the PHP one moves the balance');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'rawDebts'), 1,
    'and only the PHP one enters the debt graph');

  PERFORM test.as_owner();
  PERFORM test.note('group_detail: foreign-currency rows are dropped, not converted');
END;
$$;

-- A removed member keeps their roster name wherever they still appear.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; bal jsonb;
BEGIN
  alice := test.new_account('gd9-alice@example.com', 'Alice');
  bob   := test.new_account('gd9-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Roster');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bobby on the roster');
  PERFORM test.new_bill(alice, alice, g, 'Dinner', 100, ARRAY[alice, bob]);

  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = bob;

  PERFORM test.as_user(alice);
  SELECT jsonb_object_agg(e ->> 'displayName', (e ->> 'amount')::numeric)
  INTO bal FROM jsonb_array_elements(public.kwenta_group_detail(g) -> 'memberBalances') e;

  PERFORM test.assert_true(bal ? 'Bobby on the roster',
    'a removed member still owes what they owed, under their roster name — never "Unknown"');
  PERFORM test.as_owner();

  PERFORM test.note('group_detail: removed members keep their name');
END;
$$;

-- An unauthenticated caller is refused.
DO $$
DECLARE
  ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.kwenta_group_detail(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.assert_true(ok, 'no auth.uid() raises');
  PERFORM test.note('group_detail refuses an unauthenticated caller');
END;
$$;
