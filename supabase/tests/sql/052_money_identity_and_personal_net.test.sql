-- Migration 052: identity expansion + personal pairwise net.
--
-- These cases are ported from tests/lib/people.test.ts, which covers the same rules against the
-- TypeScript implementation. When that implementation is deleted, this file is the ONLY thing
-- keeping the rules honest — CLAUDE.md rule 10: a rule that moves into SQL takes its coverage
-- with it.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_round_money — the JS Math.round tie rule (migration header, rule 1)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_eq(public.kwenta_round_money(1.005), 1.01::numeric, 'positive half rounds up');
  PERFORM test.assert_eq(public.kwenta_round_money(1.004), 1.00::numeric, 'below half rounds down');
  -- The whole reason this function exists: SQL ROUND(-0.5) is -1, JS Math.round(-0.5) is -0.
  PERFORM test.assert_eq(public.kwenta_round_money(-0.005), 0.00::numeric,
    'NEGATIVE half breaks toward +infinity, as JS Math.round does (SQL ROUND would give -0.01)');
  PERFORM test.assert_eq(public.kwenta_round_money(-1.005), -1.00::numeric, 'negative half, larger magnitude');
  PERFORM test.assert_eq(public.kwenta_round_money(-1.006), -1.01::numeric, 'negative past half rounds away');
  PERFORM test.assert_eq(public.kwenta_round_money(0), 0.00::numeric, 'zero');
  PERFORM test.assert_eq(public.kwenta_round_money(NULL), 0.00::numeric, 'null is treated as zero');
  PERFORM test.note('round_money: JS tie semantics, including the negative half');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_expand_identity
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  c_bob uuid; c_bob2 uuid; c_dave uuid; c_del uuid;
  ghost uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('exp-alice@example.com', 'Alice');
  bob   := test.new_account('exp-bob@example.com', 'Bob');

  -- A bare contact expands to just itself.
  c_dave := test.new_contact(alice, 'Dave');
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(c_dave, alice)),
    ARRAY[c_dave],
    'an unlinked contact expands to itself only'
  );

  -- Forward link + siblings: two of Alice's contacts both point at Bob's account.
  c_bob  := test.new_contact(alice, 'Bob', bob);
  c_bob2 := test.new_contact(alice, 'Bobby', bob);
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(c_bob, alice)),
    ARRAY[c_bob, bob, c_bob2],
    'a linked contact expands to the account AND every sibling pointing at it'
  );

  -- Reverse direction: from the account, find the contacts pointing at it.
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(bob, alice)),
    ARRAY[bob, c_bob, c_bob2],
    'an account expands to the local contacts linked to it'
  );

  -- Soft-deleted rows drop out of the sibling/reverse arms.
  c_del := test.new_contact(alice, 'Deleted Bob', bob);
  UPDATE public.profiles SET is_deleted = true WHERE id = c_del;
  PERFORM test.assert_false(
    c_del = ANY(ARRAY(SELECT id FROM public.kwenta_expand_identity(bob, alice))),
    'a soft-deleted contact is excluded from expansion'
  );

  -- A profile that does not exist still expands to itself, never to nothing.
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(ghost, alice)),
    ARRAY[ghost],
    'a missing profile expands to itself'
  );

  PERFORM test.note('expand_identity: link, siblings, reverse, soft-delete, missing');
END;
$$;

DO $$
DECLARE
  alice uuid; bob uuid; carol uuid;
  a1 uuid; a2 uuid; a3 uuid; b1 uuid;
BEGIN
  alice := test.new_account('peer-alice@example.com', 'Alice');
  bob   := test.new_account('peer-bob@example.com', 'Bob');
  carol := test.new_account('peer-carol@example.com', 'Carol');

  a1 := test.new_contact(alice, 'Jello');
  a2 := test.new_contact(alice, 'Jello Duplicate');
  a3 := test.new_contact(alice, 'Jello Third');
  b1 := test.new_contact(bob, 'Bob''s own contact');

  -- Alice merges a1<->a2 and a2<->a3. The cluster is transitive and undirected.
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), alice, a1, a2, now(), now(), now(), false, 'test'),
    (gen_random_uuid(), alice, a2, a3, now(), now(), now(), false, 'test'),
    -- Bob has his own unrelated link; it must never affect Alice.
    (gen_random_uuid(), bob, b1, carol, now(), now(), now(), false, 'test');

  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, alice)),
    ARRAY[a1, a2, a3],
    'peer links are transitive and undirected'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a3, alice)),
    ARRAY[a1, a2, a3],
    'the cluster is reachable from any member'
  );

  -- Viewer scoping: this is what makes PERSONAL balances viewer-relative (header rule 3).
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, bob)),
    ARRAY[a1],
    'another user does not see Alice''s merges'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, NULL)),
    ARRAY[a1],
    'no viewer means no peer expansion at all'
  );

  -- A soft-deleted link breaks the chain: a3 is only reachable through a2.
  UPDATE public.profile_peer_links SET is_deleted = true
  WHERE owner_user_id = alice AND anchor_profile_id = a2 AND peer_profile_id = a3;
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, alice)),
    ARRAY[a1, a2],
    'a soft-deleted peer link removes that edge'
  );

  PERFORM test.note('expand_identity: peer clusters are transitive, undirected and viewer-scoped');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_pairwise_personal — sign, payments, overpayment, currency
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid;
  net numeric;
BEGIN
  alice := test.new_account('pn-alice@example.com', 'Alice');
  bob   := test.new_account('pn-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bob', bob);

  -- Alice paid 100, split evenly with Bob -> Bob owes Alice 50.
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 50.00, 'viewer paid: positive, they owe the viewer');

  -- The mirror: from Bob's side the same bill is -50. Bob reaches Alice by her account id.
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(bob, alice) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, -50.00, 'the other side sees the mirror image');

  -- A payment moves the tab toward zero.
  PERFORM test.new_settlement(c_bob, alice, 20.00);
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 30.00, 'a payment from them reduces what they owe');

  -- Overpayment flips the sign — there is no "credit" (header rule 4).
  PERFORM test.new_settlement(c_bob, alice, 50.00);
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, -20.00, 'overpayment flips the tab past zero into the viewer''s debt');

  PERFORM test.note('pairwise_personal: sign, mirror, payment, overpayment flip');
END;
$$;

DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; c_bob uuid; s_eur uuid;
  cnt int; net numeric;
BEGIN
  alice := test.new_account('pn2-alice@example.com', 'Alice');
  bob   := test.new_account('pn2-bob@example.com', 'Bob');
  carol := test.new_account('pn2-carol@example.com', 'Carol');
  c_bob := test.new_contact(alice, 'Bob', bob);

  -- A bill Bob is not on must not appear in the Alice/Bob tab at all.
  PERFORM test.new_bill(alice, alice, NULL, 'Solo lunch', 40.00, ARRAY[alice, carol]);
  SELECT count(*) INTO cnt FROM public.kwenta_pairwise_personal(alice, c_bob);
  PERFORM test.assert_eq(cnt, 0, 'a bill the other person is not on contributes nothing');

  -- A payment between two unrelated people is likewise invisible.
  PERFORM test.new_settlement(carol, alice, 10.00);
  SELECT count(*) INTO cnt FROM public.kwenta_pairwise_personal(alice, c_bob);
  PERFORM test.assert_eq(cnt, 0, 'a payment with a third party does not enter this tab');

  -- Currencies never mix.
  PERFORM test.new_bill(alice, alice, NULL, 'PHP meal', 100.00, ARRAY[alice, c_bob], 'PHP');
  PERFORM test.new_bill(alice, alice, NULL, 'USD meal', 50.00,  ARRAY[alice, c_bob], 'USD');
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 50.00, 'PHP total is independent');
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'USD';
  PERFORM test.assert_money(net, 25.00, 'USD total is independent — no conversion');

  -- Soft-deleted bills drop out.
  UPDATE public.bills SET is_deleted = true WHERE title = 'USD meal';
  SELECT count(*) INTO cnt FROM public.kwenta_pairwise_personal(alice, c_bob) WHERE currency = 'USD';
  PERFORM test.assert_eq(cnt, 0, 'a soft-deleted bill contributes nothing');

  -- An unsettled payment is not money that moved.
  -- The id is captured FIRST: a volatile fixture function in a WHERE clause is re-evaluated per
  -- scanned row, which would insert one payment per existing settlement.
  PERFORM test.new_bill(alice, alice, NULL, 'EUR meal', 80.00, ARRAY[alice, c_bob], 'EUR');
  s_eur := test.new_settlement(c_bob, alice, 40.00, NULL, NULL, 'EUR');
  UPDATE public.settlements SET is_settled = false WHERE id = s_eur;
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'EUR';
  PERFORM test.assert_money(net, 40.00, 'an unsettled payment does not move the tab');

  PERFORM test.note('pairwise_personal: exclusion, per-currency isolation, soft-delete, unsettled');
END;
$$;

-- ---------------------------------------------------------------------------
-- The subtlest rule: ONE split per side per item (header rule 2).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; c_bob_dup uuid;
  v_bill uuid; v_item uuid; net numeric;
BEGIN
  alice     := test.new_account('dup-alice@example.com', 'Alice');
  bob       := test.new_account('dup-bob@example.com', 'Bob');
  c_bob     := test.new_contact(alice, 'Bob', bob);
  c_bob_dup := test.new_contact(alice, 'Bob (duplicate)', bob);

  -- Alice paid 90. Bob is on the SAME item twice, under two ids that both expand to him —
  -- exactly what a duplicate contact linked to one account produces.
  v_bill := test.new_bill(alice, alice, NULL, 'Shared', 90.00, ARRAY[alice]);
  SELECT bi.id INTO v_item FROM public.bill_items bi WHERE bi.bill_id = v_bill;

  INSERT INTO public.item_splits
    (id, item_id, user_id, split_type, split_value, computed_amount,
     created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), v_item, c_bob,     'equal', 1, 30.00, now(), now(), now(), false, 'test'),
    (gen_random_uuid(), v_item, c_bob_dup, 'equal', 1, 30.00, now(), now(), now(), false, 'test');

  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  -- 30, not 60. Summing here would double-count one person because identity expansion
  -- deliberately matches both of their ids.
  PERFORM test.assert_money(net, 30.00,
    'a person on one item under two linked ids counts ONCE, not twice');

  PERFORM test.note('pairwise_personal: no double-count across expanded ids on one item');
END;
$$;

-- Two DIFFERENT people on one item must still both count — the rule above must not collapse
-- genuinely distinct participants.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; c_dave uuid;
  v_bill uuid; v_item uuid; net numeric;
BEGIN
  alice  := test.new_account('two-alice@example.com', 'Alice');
  bob    := test.new_account('two-bob@example.com', 'Bob');
  c_bob  := test.new_contact(alice, 'Bob', bob);
  c_dave := test.new_contact(alice, 'Dave');

  v_bill := test.new_bill(alice, alice, NULL, 'Three way', 90.00, ARRAY[alice]);
  SELECT bi.id INTO v_item FROM public.bill_items bi WHERE bi.bill_id = v_bill;

  INSERT INTO public.item_splits
    (id, item_id, user_id, split_type, split_value, computed_amount,
     created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), v_item, c_bob,  'equal', 1, 30.00, now(), now(), now(), false, 'test'),
    (gen_random_uuid(), v_item, c_dave, 'equal', 1, 30.00, now(), now(), now(), false, 'test');

  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 30.00, 'Bob owes only his own share');
  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_dave) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 30.00, 'Dave owes only his own share');

  PERFORM test.note('pairwise_personal: distinct people on one item are not collapsed');
END;
$$;

-- A payment filed against the local contact id must reach the account it is linked to, and
-- vice versa — this is the identity routing migration 049 delivers rows for.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; net numeric;
BEGIN
  alice := test.new_account('route-alice@example.com', 'Alice');
  bob   := test.new_account('route-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bob', bob);

  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  -- Payment recorded under Bob's ACCOUNT id, while the split used the CONTACT id.
  PERFORM test.new_settlement(bob, alice, 50.00);

  SELECT n.net INTO net FROM public.kwenta_pairwise_personal(alice, c_bob) n WHERE n.currency = 'PHP';
  PERFORM test.assert_money(net, 0.00,
    'a payment under the account id settles a debt recorded under the contact id');

  PERFORM test.note('pairwise_personal: contact id and account id are the same tab');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the viewer is an argument, so these must not be client-callable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_expand_identity(uuid, uuid)', 'EXECUTE'),
    'kwenta_expand_identity must not be executable by authenticated'
  );
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_pairwise_personal(uuid, uuid)', 'EXECUTE'),
    'kwenta_pairwise_personal must not be executable by authenticated'
  );
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_round_money(numeric)', 'EXECUTE'),
    'kwenta_round_money is pure arithmetic and may be granted'
  );
  PERFORM test.note('grants: viewer-argument money functions are not client-callable');
END;
$$;
