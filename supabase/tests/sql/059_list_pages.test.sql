-- Migration 059: the Bills list and the Groups list.
--
-- The two things worth pinning hard: a bill lands in exactly ONE bucket, and a person appears as
-- ONE participant pill no matter how many ids they hold. The second is the "Jello pays Jello"
-- family of bug in a different costume.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_groups_with_balances
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; rows jsonb; row0 jsonb;
BEGIN
  alice := test.new_account('gl-alice@example.com', 'Alice');
  bob   := test.new_account('gl-bob@example.com', 'Bob');
  carol := test.new_account('gl-carol@example.com', 'Carol');

  g := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 300, ARRAY[alice, bob, carol]);

  PERFORM test.as_user(alice);
  rows := public.kwenta_groups_with_balances();
  row0 := rows -> 0;

  PERFORM test.assert_eq(jsonb_array_length(rows), 1, 'one group');
  PERFORM test.assert_eq(row0 ->> 'name', 'Trip', 'name');
  PERFORM test.assert_eq((row0 ->> 'memberCount')::int, 3, 'active member count');
  PERFORM test.assert_money((row0 ->> 'totalToReceive')::numeric, 200, 'both debts sum into to-receive');
  PERFORM test.assert_money((row0 ->> 'totalToPay')::numeric, 0, 'nothing owed outward');

  PERFORM test.as_owner();
  PERFORM test.note('groups_with_balances: roster count + viewer standing');
END;
$$;

-- BOTH totals nonzero in one group. Ported from the Vitest coverage of
-- computeAllGroupPairwiseBalances, which this endpoint replaced. A single net scalar per group
-- cannot express this — it collapses the two directions and can only ever show one side.
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g uuid; row0 jsonb;
BEGIN
  alice := test.new_account('gb-alice@example.com', 'Alice');
  bob   := test.new_account('gb-bob@example.com', 'Bob');
  cara  := test.new_account('gb-cara@example.com', 'Cara');

  g := test.new_group(alice, 'Mixed');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');

  -- Bob paid 60, only Alice is on the split -> Alice owes Bob 60.
  PERFORM test.new_bill(bob, bob, g, 'Bob fronted', 60, ARRAY[alice]);
  -- Alice paid 30, only Cara is on the split -> Cara owes Alice 30.
  PERFORM test.new_bill(alice, alice, g, 'Alice fronted', 30, ARRAY[cara]);

  PERFORM test.as_user(alice);
  row0 := public.kwenta_groups_with_balances() -> 0;
  PERFORM test.assert_money((row0 ->> 'totalToReceive')::numeric, 30, 'Cara owes Alice 30');
  PERFORM test.assert_money((row0 ->> 'totalToPay')::numeric, 60, 'Alice owes Bob 60');
  PERFORM test.as_owner();

  PERFORM test.note('groups_with_balances: both directions coexist in one group');
END;
$$;

-- A member who left is out of the count; a group the viewer left is out of the list entirely.
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; rows jsonb;
BEGIN
  alice := test.new_account('gl2-alice@example.com', 'Alice');
  bob   := test.new_account('gl2-bob@example.com', 'Bob');
  carol := test.new_account('gl2-carol@example.com', 'Carol');

  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');

  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = carol;

  PERFORM test.as_user(alice);
  rows := public.kwenta_groups_with_balances();
  PERFORM test.assert_eq((rows -> 0 ->> 'memberCount')::int, 2, 'a removed member is not counted');
  PERFORM test.as_owner();

  PERFORM test.as_user(carol);
  PERFORM test.assert_eq(public.kwenta_groups_with_balances(), '[]'::jsonb,
    'a group the viewer left is not in their list');
  PERFORM test.as_owner();

  PERFORM test.note('groups_with_balances: membership scoping');
END;
$$;

-- A stranger's group never appears.
DO $$
DECLARE
  alice uuid; zed uuid; g uuid;
BEGIN
  alice := test.new_account('gl3-alice@example.com', 'Alice');
  zed   := test.new_account('gl3-zed@example.com', 'Zed');
  g := test.new_group(zed, 'Private');
  PERFORM test.add_member(g, zed, 'Zed');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_groups_with_balances(), '[]'::jsonb,
    'groups the caller is not in are invisible');
  PERFORM test.as_owner();
  PERFORM test.note('groups_with_balances is caller-scoped');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_personal_bills — bucketing
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; res jsonb; mine jsonb; shared jsonb;
BEGIN
  alice := test.new_account('pb-alice@example.com', 'Alice');
  bob   := test.new_account('pb-bob@example.com', 'Bob');

  -- Alice's own personal bill.
  PERFORM test.new_bill(alice, alice, NULL, 'Alice dinner', 100, ARRAY[alice, bob]);
  -- Bob's personal bill that Alice is split into.
  PERFORM test.new_bill(bob, bob, NULL, 'Bob taxi', 50, ARRAY[alice, bob]);
  -- Bob's personal bill Alice has nothing to do with.
  PERFORM test.new_bill(bob, bob, NULL, 'Bob solo', 20, ARRAY[bob]);
  -- A GROUP bill must not appear in either bucket — this list is personal bills only.
  g := test.new_group(alice, 'Squad');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Group lunch', 80, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  res := public.kwenta_personal_bills();
  mine := res -> 'mine';
  shared := res -> 'shared';

  PERFORM test.assert_eq(jsonb_array_length(mine), 1, 'one bill Alice created');
  PERFORM test.assert_eq(mine -> 0 ->> 'title', 'Alice dinner', 'her own bill is in mine');
  PERFORM test.assert_eq(jsonb_array_length(shared), 1, 'one bill shared with her');
  PERFORM test.assert_eq(shared -> 0 ->> 'title', 'Bob taxi', 'Bob''s split bill is shared');

  PERFORM test.as_owner();
  PERFORM test.note('personal_bills: mine / shared / neither, group bills excluded');
END;
$$;

-- A bill can never be in both buckets, and a deleted bill is in neither.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; res jsonb;
BEGIN
  alice := test.new_account('pb2-alice@example.com', 'Alice');
  bob   := test.new_account('pb2-bob@example.com', 'Bob');

  -- Alice created it AND is split into it: the creator test wins, so it is 'mine' only.
  b := test.new_bill(alice, alice, NULL, 'Both ways', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  res := public.kwenta_personal_bills();
  PERFORM test.assert_eq(jsonb_array_length(res -> 'mine'), 1, 'creator bucket wins');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'shared'), 0, 'never counted twice');
  PERFORM test.as_owner();

  UPDATE public.bills SET is_deleted = true WHERE id = b;

  PERFORM test.as_user(alice);
  res := public.kwenta_personal_bills();
  PERFORM test.assert_eq(res -> 'mine', '[]'::jsonb, 'a deleted bill leaves the list');
  PERFORM test.as_owner();

  PERFORM test.note('personal_bills: buckets are disjoint, deletions honoured');
END;
$$;

-- The shared bucket follows the viewer's identity, not just their literal account id.
-- (Header note 2 — the same miss 049 fixed on the pull side.)
DO $$
DECLARE
  alice uuid; bob uuid; c_alice uuid; res jsonb;
BEGIN
  alice   := test.new_account('pb3-alice@example.com', 'Alice');
  bob     := test.new_account('pb3-bob@example.com', 'Bob');
  -- Bob's phonebook entry for Alice, linked to her real account.
  c_alice := test.new_contact(bob, 'Alice', alice);

  -- Bob files the bill against the CONTACT id, which is what happens before canonicalization.
  PERFORM test.new_bill(bob, bob, NULL, 'Filed under the contact', 100, ARRAY[c_alice, bob]);

  PERFORM test.as_user(alice);
  res := public.kwenta_personal_bills();
  PERFORM test.assert_eq(jsonb_array_length(res -> 'shared'), 1,
    'a split filed under a linked contact still reaches the account it points at');
  PERFORM test.as_owner();

  PERFORM test.note('personal_bills: shared bucket is identity-routed');
END;
$$;

-- ---------------------------------------------------------------------------
-- Participant pills: one person, one pill
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; res jsonb; pills jsonb;
BEGIN
  alice := test.new_account('pp-alice@example.com', 'Alice');
  bob   := test.new_account('pp-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  -- The bill touches BOTH of Bob's ids. He is still one person.
  PERFORM test.new_bill(alice, alice, NULL, 'Two ids one Bob', 90, ARRAY[alice, c_bob, bob]);

  PERFORM test.as_user(alice);
  res := public.kwenta_personal_bills();
  pills := res -> 'mine' -> 0 -> 'participants';

  PERFORM test.assert_eq(jsonb_array_length(pills), 2,
    'Alice and Bob — the contact and the account collapse to one pill');
  PERFORM test.assert_eq(pills -> 0 ->> 'label', 'You', 'the viewer sorts first and reads "You"');
  PERFORM test.assert_eq(pills -> 1 ->> 'label', 'Bobby',
    'the viewer''s own phonebook name wins over the account name');
  PERFORM test.assert_eq(pills -> 1 ->> 'id', c_bob::text,
    'the representative id is the viewer''s local contact');

  PERFORM test.as_owner();
  PERFORM test.note('participant pills: one pill per person, phonebook name preferred');
END;
$$;

-- A manual peer-link merge collapses two contacts into one pill too (the 055 family).
DO $$
DECLARE
  alice uuid; j1 uuid; j2 uuid; pills jsonb;
BEGIN
  alice := test.new_account('pp2-alice@example.com', 'Alice');
  j1 := test.new_contact(alice, 'Jello');
  j2 := test.new_contact(alice, 'Jello Dup');

  PERFORM test.new_bill(alice, alice, NULL, 'Merged', 90, ARRAY[alice, j1, j2]);

  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, j1, j2, now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  pills := public.kwenta_personal_bills() -> 'mine' -> 0 -> 'participants';
  PERFORM test.assert_eq(jsonb_array_length(pills), 2,
    'a merged pair is one pill, not two');
  PERFORM test.as_owner();

  PERFORM test.note('participant pills: manual merges collapse');
END;
$$;

-- ---------------------------------------------------------------------------
-- Row payload: item count, payer name, settled flag, category
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; row0 jsonb;
BEGIN
  alice := test.new_account('pr-alice@example.com', 'Alice');
  bob   := test.new_account('pr-bob@example.com', 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  UPDATE public.bills SET category = 'food' WHERE id = b;

  PERFORM test.as_user(alice);
  row0 := public.kwenta_personal_bills() -> 'mine' -> 0;

  PERFORM test.assert_eq((row0 ->> 'itemCount')::int, 1, 'one active item');
  PERFORM test.assert_eq(row0 ->> 'payorName', 'Alice', 'the payer name is resolved');
  PERFORM test.assert_eq(row0 ->> 'category', 'food', 'category round-trips');
  PERFORM test.assert_money((row0 ->> 'totalAmount')::numeric, 100, 'amount round-trips');
  PERFORM test.assert_false((row0 ->> 'settled')::boolean, 'Bob has not paid, so it is unsettled');

  PERFORM test.as_owner();
  -- Bob pays his half. The flag is person-level (056), so the bill now reads settled.
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');

  PERFORM test.as_user(alice);
  row0 := public.kwenta_personal_bills() -> 'mine' -> 0;
  PERFORM test.assert_true((row0 ->> 'settled')::boolean, 'settling the tab settles the bill');

  PERFORM test.as_owner();
  PERFORM test.note('personal_bills: row payload and the 056 settled flag');
END;
$$;

-- A soft-deleted item stops counting.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid;
BEGIN
  alice := test.new_account('pr2-alice@example.com', 'Alice');
  bob   := test.new_account('pr2-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  UPDATE public.bill_items SET is_deleted = true WHERE bill_id = b;

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(
    (public.kwenta_personal_bills() -> 'mine' -> 0 ->> 'itemCount')::int, 0,
    'a deleted item is not counted');
  PERFORM test.as_owner();
  PERFORM test.note('personal_bills: deleted items drop out of the count');
END;
$$;

-- An unauthenticated caller is refused rather than handed an empty list.
DO $$
DECLARE
  ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.kwenta_personal_bills();
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.assert_true(ok, 'no auth.uid() raises instead of returning an empty list');
  PERFORM test.note('personal_bills refuses an unauthenticated caller');
END;
$$;
