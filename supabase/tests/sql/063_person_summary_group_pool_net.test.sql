-- Migration 063: the group-pool net on each person-summary group leg.
--
-- The case that matters is the one where the two numbers on the same leg disagree, because that
-- is exactly when substituting one for the other would be invisible in testing and wrong on
-- screen. A leg's `net` is pairwise; its `theirNet` is against the pool.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Two members: pairwise and pool are mirror images, so nothing distinguishes them
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; leg jsonb;
BEGIN
  alice := test.new_account('pn-alice@example.com', 'Alice');
  bob   := test.new_account('pn-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Pair');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  -- Bob fronts 100 for the two of them: Alice owes him 50.
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  leg := public.kwenta_person_summary(bob) -> 'groups' -> 0;

  PERFORM test.assert_money((leg ->> 'net')::numeric, -50, 'pairwise: Alice owes Bob 50');
  PERFORM test.assert_money((leg ->> 'theirNet')::numeric, 50, 'pool: Bob is up 50');

  PERFORM test.as_owner();
  PERFORM test.note('person_summary: two-member group, the two nets mirror');
END;
$$;

-- ---------------------------------------------------------------------------
-- THE CASE THE MIGRATION EXISTS FOR: a third member makes them disagree
--
-- Bob fronts 90 for himself, Alice and Cara.
--   pairwise (Alice's view of Bob): Alice owes Bob 30
--   pool (Bob):                     +60 — he is also carrying Cara's 30
-- The export card asks the POOL question, so a card fed the pairwise number would understate
-- what Bob is owed by half.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g uuid; leg jsonb;
BEGIN
  alice := test.new_account('pn2-alice@example.com', 'Alice');
  bob   := test.new_account('pn2-bob@example.com', 'Bob');
  cara  := test.new_account('pn2-cara@example.com', 'Cara');

  g := test.new_group(bob, 'Trio');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 90, ARRAY[alice, bob, cara]);

  PERFORM test.as_user(alice);
  leg := public.kwenta_person_summary(bob) -> 'groups' -> 0;

  PERFORM test.assert_money((leg ->> 'net')::numeric, -30,
    'pairwise: Alice owes Bob only her own share');
  PERFORM test.assert_money((leg ->> 'theirNet')::numeric, 60,
    'pool: Bob fronted 60 more than he consumed, including Cara''s share');

  PERFORM test.as_owner();
  PERFORM test.note('person_summary: pairwise and pool diverge once a third member exists');
END;
$$;

-- The pairwise legs and total are unchanged by this migration.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; s jsonb;
BEGIN
  alice := test.new_account('pn3-alice@example.com', 'Alice');
  bob   := test.new_account('pn3-bob@example.com', 'Bob');

  PERFORM test.new_bill(alice, alice, NULL, 'Personal', 100, ARRAY[alice, bob]);
  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g, 'Wifi', 60, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  s := public.kwenta_person_summary(bob);

  PERFORM test.assert_money((s -> 'personal' ->> 'PHP')::numeric, 50, 'personal leg unchanged');
  PERFORM test.assert_money((s -> 'total' ->> 'PHP')::numeric, 20, 'total unchanged: 50 - 30');
  PERFORM test.assert_eq(jsonb_array_length(s -> 'groups'), 1, 'one group leg');
  PERFORM test.assert_true(s -> 'groups' -> 0 ? 'groupName', 'the leg keeps its original keys');

  PERFORM test.as_owner();
  PERFORM test.note('person_summary: 053 behaviour is preserved, theirNet is additive');
END;
$$;

-- A payment moves the pool net too.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; leg jsonb;
BEGIN
  alice := test.new_account('pn4-alice@example.com', 'Alice');
  bob   := test.new_account('pn4-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Settled');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(alice, bob, 50, g, NULL, 'PHP');

  PERFORM test.as_user(alice);
  leg := public.kwenta_person_summary(bob) -> 'groups' -> 0;
  -- Settled: the leg drops out of the breakdown entirely (053 omits effectively-zero groups).
  PERFORM test.assert_eq(leg, NULL::jsonb, 'a settled group is not a leg at all');

  PERFORM test.as_owner();
  PERFORM test.note('person_summary: settled groups still drop out');
END;
$$;

-- The person is resolved to their id ON THAT ROSTER before the pool net is taken.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; g uuid; leg jsonb;
BEGIN
  alice := test.new_account('pn5-alice@example.com', 'Alice');
  bob   := test.new_account('pn5-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  g := test.new_group(alice, 'Roster');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 100, ARRAY[alice, bob]);

  -- Asked about the CONTACT, answered about the account that sits on the roster.
  PERFORM test.as_user(alice);
  leg := public.kwenta_person_summary(c_bob) -> 'groups' -> 0;
  PERFORM test.assert_money((leg ->> 'theirNet')::numeric, 50,
    'the contact resolves to its account''s roster id');

  PERFORM test.as_owner();
  PERFORM test.note('person_summary: pool net is roster-resolved');
END;
$$;

-- kwenta_group_pool_net is not client-callable: it takes the member as an argument.
DO $$
DECLARE
  alice uuid; ok boolean := false;
BEGIN
  alice := test.new_account('pn6-alice@example.com', 'Alice');
  PERFORM test.as_user(alice);
  BEGIN
    PERFORM public.kwenta_group_pool_net(gen_random_uuid(), gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(ok, 'a member-taking function must not be callable by a client');
  PERFORM test.note('group_pool_net stays server-internal');
END;
$$;
