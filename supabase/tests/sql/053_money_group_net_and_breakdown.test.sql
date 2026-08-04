-- Migration 053: group pairwise net, breakdown, and the first client-facing money RPC.
--
-- Ported from tests/lib/settlement.test.ts and people.test.ts. The headline case is
-- "two members agree" — the invariant that makes a group ledger shared rather than per-device.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_group_pairwise — sign, mirror, settlements, zero rows, currency, names
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; net numeric; nm text; cnt int;
BEGIN
  alice := test.new_account('g1-alice@example.com', 'Alice');
  bob   := test.new_account('g1-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  -- Alice paid 100, split evenly -> Bob owes Alice 50.
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100.00, ARRAY[alice, bob]);

  SELECT gp.net, gp.display_name INTO net, nm
  FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net, 50.00, 'payer is owed the other side''s share');
  PERFORM test.assert_eq(nm, 'Bob', 'name comes from the group roster');

  -- Symmetry: Bob must see the exact mirror.
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, bob) gp WHERE gp.member_user_id = alice;
  PERFORM test.assert_money(net, -50.00, 'the other member sees the mirror image');

  -- A settled payment clears it, from both perspectives.
  PERFORM test.new_settlement(bob, alice, 50.00, g);
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net, 0.00, 'a settled payment zeroes the balance');
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, bob) gp WHERE gp.member_user_id = alice;
  PERFORM test.assert_money(net, 0.00, 'and zero from the other side too');

  -- A settled member still appears, at 0 — "settled" is an answer the UI must render.
  SELECT count(*) INTO cnt FROM public.kwenta_group_pairwise(g, alice) WHERE member_user_id = bob;
  PERFORM test.assert_eq(cnt, 1, 'an active member appears even at net zero');

  -- The viewer is never in their own list.
  SELECT count(*) INTO cnt FROM public.kwenta_group_pairwise(g, alice) WHERE member_user_id = alice;
  PERFORM test.assert_eq(cnt, 0, 'the viewer is excluded from their own balance list');

  PERFORM test.note('group_pairwise: sign, mirror, settlement, zero row, self-exclusion');
END;
$$;

DO $$
DECLARE
  alice uuid; bob uuid; g uuid; net numeric; cnt int; gone uuid;
BEGIN
  alice := test.new_account('g2-alice@example.com', 'Alice');
  bob   := test.new_account('g2-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'PHP group', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  -- A bill in another currency is DROPPED, never converted.
  PERFORM test.new_bill(alice, alice, g, 'USD bill', 100.00, ARRAY[alice, bob], 'USD');
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net, 0.00, 'a bill in a different currency is dropped, not converted');

  -- An empty currency counts as matching the group's.
  PERFORM test.new_bill(alice, alice, g, 'Untagged', 60.00, ARRAY[alice, bob], '');
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net, 30.00, 'an empty currency is treated as the group currency');

  -- An unsettled payment does not move anything.
  PERFORM test.new_bill(alice, alice, g, 'Meal', 40.00, ARRAY[alice, bob]);
  gone := test.new_settlement(bob, alice, 20.00, g);
  UPDATE public.settlements SET is_settled = false WHERE id = gone;
  SELECT gp.net INTO net FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net, 50.00, 'an unsettled group payment does not move the balance');

  -- A soft-deleted group yields no rows at all (the TS returns null).
  UPDATE public.groups SET is_deleted = true WHERE id = g;
  SELECT count(*) INTO cnt FROM public.kwenta_group_pairwise(g, alice);
  PERFORM test.assert_eq(cnt, 0, 'a soft-deleted group produces no balances');

  PERFORM test.note('group_pairwise: currency drop, empty currency, unsettled, deleted group');
END;
$$;

-- A removed member keeps their roster name rather than rendering "Unknown".
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; m_bob uuid; nm text;
BEGIN
  alice := test.new_account('g3-alice@example.com', 'Alice');
  bob   := test.new_account('g3-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Old trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m_bob := test.add_member(g, bob, 'Bob The Removed');
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 80.00, ARRAY[alice, bob]);

  UPDATE public.group_members SET is_deleted = true WHERE id = m_bob;

  SELECT gp.display_name INTO nm
  FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_eq(nm, 'Bob The Removed',
    'a removed member keeps their roster name (soft-deleted rows still supply names)');

  PERFORM test.note('group_pairwise: removed members never render Unknown');
END;
$$;

-- ---------------------------------------------------------------------------
-- THE INVARIANT: a viewer-private merge must not change a SHARED group balance.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid;
  g uuid;
  net_a numeric; net_b numeric; cnt int;
BEGIN
  alice := test.new_account('inv-alice@example.com', 'Alice');
  bob   := test.new_account('inv-bob@example.com', 'Bob');
  carol := test.new_account('inv-carol@example.com', 'Carol');

  g := test.new_group(alice, 'Shared');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');

  PERFORM test.new_bill(alice, alice, g, 'Villa', 300.00, ARRAY[alice, bob, carol]);

  SELECT gp.net INTO net_a FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  SELECT gp.net INTO net_b FROM public.kwenta_group_pairwise(g, bob) gp WHERE gp.member_user_id = alice;
  PERFORM test.assert_money(net_a, 100.00, 'Alice is owed Bob''s share');
  PERFORM test.assert_money(net_b, -100.00, 'Bob sees the exact mirror');

  -- Now Alice privately declares that Bob and Carol are the same person. This is the dangerous
  -- case: the merge is real to Alice and invisible to everyone else, so if the group balance
  -- honoured it, Alice would see one 200 entry where Bob and Carol each see two 100s — the same
  -- group producing different ledgers, and different settle-up suggestions, per viewer.
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, bob, carol, now(), now(), now(), false, 'test');

  SELECT gp.net INTO net_a FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  SELECT gp.net INTO net_b FROM public.kwenta_group_pairwise(g, bob) gp WHERE gp.member_user_id = alice;
  PERFORM test.assert_money(net_a, 100.00,
    'a viewer-private merge of two ROSTER MEMBERS must NOT change the shared group balance');
  PERFORM test.assert_money(net_b, -100.00,
    'and the other member still computes the exact mirror — both sides agree');

  SELECT gp.net INTO net_a FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = carol;
  PERFORM test.assert_money(net_a, 100.00, 'Carol remains a separate 100, not folded into Bob');
  SELECT count(*)::int INTO cnt FROM public.kwenta_group_pairwise(g, alice);
  PERFORM test.assert_eq(cnt, 2, 'still exactly two counterparties, not one merged entry');

  -- The sharp case. Alice now privately merges HERSELF with Carol, then Carol and Bob transact
  -- without her. If the shared ledger honoured that merge, Alice would be credited for a bill
  -- she has nothing to do with — money appearing out of a private note only she can see.
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, alice, carol, now(), now(), now(), false, 'test');

  PERFORM test.new_bill(carol, carol, g, 'Carol buys Bob lunch', 80.00, ARRAY[bob, carol]);

  SELECT gp.net INTO net_a FROM public.kwenta_group_pairwise(g, alice) gp WHERE gp.member_user_id = bob;
  PERFORM test.assert_money(net_a, 100.00,
    'a bill between two OTHER members must not touch the viewer''s balance, even when the '
    'viewer has privately merged themselves with one of them');

  SELECT gp.net INTO net_b FROM public.kwenta_group_pairwise(g, bob) gp WHERE gp.member_user_id = carol;
  PERFORM test.assert_money(net_b, -40.00, 'Bob owes Carol his share of that bill, as always');

  PERFORM test.note('group_pairwise: viewer-private identity merges never move a shared ledger');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_pairwise_breakdown — personal + groups, and total = the signed sum of parts
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; c_bob uuid;
  b jsonb;
BEGIN
  alice := test.new_account('bd-alice@example.com', 'Alice');
  bob   := test.new_account('bd-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bob', bob);

  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  -- personal: Alice paid 100 split with Bob -> +50
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  -- group: Alice paid 60 split with Bob -> +30
  PERFORM test.new_bill(alice, alice, g, 'Taxi', 60.00, ARRAY[alice, bob]);

  b := public.kwenta_pairwise_breakdown(alice, c_bob);

  PERFORM test.assert_money((b -> 'personal' ->> 'PHP')::numeric, 50.00, 'personal leg');
  PERFORM test.assert_eq(jsonb_array_length(b -> 'groups'), 1, 'one shared group is listed');
  PERFORM test.assert_money((b -> 'groups' -> 0 ->> 'net')::numeric, 30.00, 'group leg');
  PERFORM test.assert_eq(b -> 'groups' -> 0 ->> 'groupName', 'Trip', 'group name is carried');
  -- The reconciliation invariant the Person page depends on.
  PERFORM test.assert_money((b -> 'total' ->> 'PHP')::numeric, 80.00,
    'total is the plain signed sum of personal + every group');

  -- The group leg is found via identity expansion: the split used Bob's ACCOUNT id while the
  -- caller asked about Alice's local CONTACT for him.
  PERFORM test.note('breakdown: personal + group legs reconcile, contact id resolves to roster id');
END;
$$;

-- An effectively-zero group is not a line item, and a settled group drops out entirely.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b jsonb;
BEGIN
  alice := test.new_account('bd2-alice@example.com', 'Alice');
  bob   := test.new_account('bd2-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Even');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.new_bill(alice, alice, g, 'Meal', 40.00, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 20.00, g);

  b := public.kwenta_pairwise_breakdown(alice, bob);
  PERFORM test.assert_eq(jsonb_array_length(b -> 'groups'), 0,
    'a settled group is omitted from the breakdown');

  PERFORM test.note('breakdown: effectively-zero groups are omitted');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_person_summary — the client surface. Viewer is auth.uid(), never an argument.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; b jsonb;
BEGIN
  alice := test.new_account('rpc-alice@example.com', 'Alice');
  bob   := test.new_account('rpc-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bob', bob);
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  b := public.kwenta_person_summary(c_bob);
  PERFORM test.assert_money((b -> 'total' ->> 'PHP')::numeric, 50.00, 'Alice sees +50');

  -- Bob asking about Alice gets HIS OWN standing, mirrored — never Alice's view.
  PERFORM set_config('request.jwt.claim.sub', bob::text, true);
  b := public.kwenta_person_summary(alice);
  PERFORM test.assert_money((b -> 'total' ->> 'PHP')::numeric, -50.00,
    'the RPC always answers for the CALLER, so Bob sees the mirror');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('person_summary: scoped to auth.uid(), not to an argument');
END;
$$;

-- An unauthenticated caller must be refused rather than silently answered.
DO $$
DECLARE
  raised boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.kwenta_person_summary(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    raised := true;
  END;
  PERFORM test.assert_true(raised, 'kwenta_person_summary refuses an unauthenticated caller');
  PERFORM test.note('person_summary: unauthenticated is an error, not an empty answer');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_group_pairwise(uuid, uuid)', 'EXECUTE'),
    'kwenta_group_pairwise takes a viewer argument and must not be client-callable'
  );
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_pairwise_breakdown(uuid, uuid)', 'EXECUTE'),
    'kwenta_pairwise_breakdown takes a viewer argument and must not be client-callable'
  );
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_person_summary(uuid)', 'EXECUTE'),
    'kwenta_person_summary derives the viewer from auth.uid() and IS the client surface'
  );
  PERFORM test.note('grants: only the auth.uid()-scoped wrapper is client-callable');
END;
$$;
