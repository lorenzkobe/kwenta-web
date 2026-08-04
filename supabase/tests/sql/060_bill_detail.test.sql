-- Migration 060: the Bill detail screen.
--
-- Two rules carry the weight here. A person holding two ids on one item is charged ONCE (the
-- per-item first-match rule), and "settled" is answered by the PERSON tab rather than by the
-- bill, because payments are never tagged to a bill.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_bill_pairwise — direction, settlements, rounding
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; b uuid;
BEGIN
  alice := test.new_account('bp-alice@example.com', 'Alice');
  bob   := test.new_account('bp-bob@example.com', 'Bob');

  -- Alice fronts 100 for the two of them: Bob owes her 50.
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, alice, bob), 50,
    'the payer is owed the other side''s share');
  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, bob, alice), -50,
    'and the mirror is exactly negative');

  PERFORM test.note('bill_pairwise: sign and mirror');
END;
$$;

-- A payment tagged to the bill moves it; an untagged one does not.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid;
BEGIN
  alice := test.new_account('bp2-alice@example.com', 'Alice');
  bob   := test.new_account('bp2-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.new_settlement(bob, alice, 20, NULL, b, 'PHP');
  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, alice, bob), 30,
    'a bill-tagged payment reduces the bill net');

  -- An untagged payment belongs to the person tab, not to this bill.
  PERFORM test.new_settlement(bob, alice, 30, NULL, NULL, 'PHP');
  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, alice, bob), 30,
    'an untagged payment leaves the per-bill net alone');

  PERFORM test.note('bill_pairwise: only bill-tagged payments count');
END;
$$;

-- A deleted bill nets nothing; a third party's share is not the viewer's business.
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; b uuid;
BEGIN
  alice := test.new_account('bp3-alice@example.com', 'Alice');
  bob   := test.new_account('bp3-bob@example.com', 'Bob');
  cara  := test.new_account('bp3-cara@example.com', 'Cara');

  -- Alice fronts 90 three ways: Bob owes 30, Cara owes 30.
  b := test.new_bill(alice, alice, NULL, 'Split three ways', 90, ARRAY[alice, bob, cara]);
  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, alice, bob), 30,
    'only Bob''s own share, not Cara''s');

  UPDATE public.bills SET is_deleted = true WHERE id = b;
  PERFORM test.assert_eq(public.kwenta_bill_pairwise(b, alice, bob), NULL::numeric,
    'a deleted bill has no net');

  PERFORM test.note('bill_pairwise: per-person shares, deleted bills');
END;
$$;

-- THE FIRST-MATCH RULE: one person, two ids on the same item, charged once.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; b uuid; item uuid;
BEGIN
  alice := test.new_account('bp4-alice@example.com', 'Alice');
  bob   := test.new_account('bp4-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  -- One item, and Bob appears on it twice: once as the contact, once as the account.
  b := test.new_bill(alice, alice, NULL, 'Duplicated identity', 100, ARRAY[alice, c_bob]);
  SELECT id INTO item FROM public.bill_items WHERE bill_id = b LIMIT 1;
  INSERT INTO public.item_splits
    (id, item_id, user_id, split_type, split_value, computed_amount,
     created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), item, bob, 'equal', 1, 50, now(), now(), now(), false, 'test');

  PERFORM test.assert_money(public.kwenta_bill_pairwise(b, alice, c_bob), 50,
    'a duplicated identity on one item is charged once, not twice');

  PERFORM test.note('bill_pairwise: per-item first match per side');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_bill_detail
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd-alice@example.com', 'Alice');
  bob   := test.new_account('bd-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);

  PERFORM test.assert_eq(d -> 'bill' ->> 'title', 'Dinner', 'title');
  PERFORM test.assert_eq(d -> 'bill' ->> 'payorName', 'Alice', 'payer name');
  PERFORM test.assert_eq(d -> 'bill' ->> 'creatorName', 'Alice', 'creator name');
  PERFORM test.assert_eq(d -> 'groupName', 'null'::jsonb, 'a personal bill has no group name');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'items'), 1, 'one item');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'items' -> 0 -> 'splits'), 2, 'two splits');
  PERFORM test.assert_money((d ->> 'mySplitTotal')::numeric, 50,
    'the viewer''s own share of a personal bill');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pairs'), 1, 'one counterparty');
  PERFORM test.assert_eq(d -> 'pairs' -> 0 ->> 'displayName', 'Bob', 'counterparty name');
  PERFORM test.assert_money((d -> 'pairs' -> 0 ->> 'net')::numeric, 50, 'counterparty net');

  PERFORM test.as_owner();
  PERFORM test.note('bill_detail: bill, items, splits, own share, counterparty');
END;
$$;

-- The viewer is never their own counterparty, and a zero-net party is not a row.
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd2-alice@example.com', 'Alice');
  bob   := test.new_account('bd2-bob@example.com', 'Bob');
  cara  := test.new_account('bd2-cara@example.com', 'Cara');

  -- Alice paid; Bob and Cara each owe 30. Cara then settles her share against THIS bill.
  b := test.new_bill(alice, alice, NULL, 'Three ways', 90, ARRAY[alice, bob, cara]);
  PERFORM test.new_settlement(cara, alice, 30, NULL, b, 'PHP');

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pairs'), 1,
    'Cara is square on this bill, so she is not a row; Alice is never her own counterparty');
  PERFORM test.assert_eq(d -> 'pairs' -> 0 ->> 'displayName', 'Bob', 'only Bob remains');

  PERFORM test.as_owner();
  PERFORM test.note('bill_detail: self excluded, square parties omitted');
END;
$$;

-- squareOverall comes from the PERSON tab, not from this bill, and is currency-scoped.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd3-alice@example.com', 'Alice');
  bob   := test.new_account('bd3-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_false((d -> 'pairs' -> 0 ->> 'squareOverall')::boolean,
    'Bob owes 50 overall, so the line is not square');
  PERFORM test.as_owner();

  -- An UNTAGGED payment clears the tab. The bill's own net is untouched (payments are never
  -- tagged in practice), but the line must now read square — that is the whole point.
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_money((d -> 'pairs' -> 0 ->> 'net')::numeric, 50,
    'the per-bill net still shows what this bill contributed');
  PERFORM test.assert_true((d -> 'pairs' -> 0 ->> 'squareOverall')::boolean,
    'settling the PERSON squares the line, because that is where payments land');
  PERFORM test.as_owner();

  PERFORM test.note('bill_detail: squareOverall follows the person tab');
END;
$$;

-- A balance in a different currency must not flip the flag.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd4-alice@example.com', 'Alice');
  bob   := test.new_account('bd4-bob@example.com', 'Bob');

  b := test.new_bill(alice, alice, NULL, 'PHP dinner', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');
  -- An unrelated USD debt in the other direction.
  PERFORM test.new_bill(bob, bob, NULL, 'USD taxi', 80, ARRAY[alice, bob], 'USD');

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_true((d -> 'pairs' -> 0 ->> 'squareOverall')::boolean,
    'square in PHP stays square — a USD balance is a different ledger');

  PERFORM test.as_owner();
  PERFORM test.note('bill_detail: squareOverall is currency-scoped');
END;
$$;

-- Group bills: the roster supplies names, and mySplitTotal is not reported.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd5-alice@example.com', 'Alice');
  bob   := test.new_account('bd5-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Squad');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bobby on the roster');
  b := test.new_bill(alice, alice, g, 'Group dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);

  PERFORM test.assert_eq(d ->> 'groupName', 'Squad', 'group name');
  PERFORM test.assert_eq(d -> 'mySplitTotal', 'null'::jsonb,
    'a group bill does not report the viewer''s own share');
  PERFORM test.assert_eq(d -> 'pairs' -> 0 ->> 'displayName', 'Bobby on the roster',
    'the roster name wins — a co-member''s contact row is never on this device');

  PERFORM test.as_owner();
  -- A removed member still has a name on the bills they were part of.
  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = bob;

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_eq(d -> 'pairs' -> 0 ->> 'displayName', 'Bobby on the roster',
    'a removed member is never "Unknown" on their own bills');

  PERFORM test.as_owner();
  PERFORM test.note('bill_detail: roster names, group bills');
END;
$$;

-- An unreadable bill is NULL — "deleted" and "not yours" must be indistinguishable.
DO $$
DECLARE
  alice uuid; zed uuid; b uuid;
BEGIN
  alice := test.new_account('bd6-alice@example.com', 'Alice');
  zed   := test.new_account('bd6-zed@example.com', 'Zed');
  b := test.new_bill(zed, zed, NULL, 'Not yours', 50, ARRAY[zed]);

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_bill_detail(b), NULL::jsonb,
    'a stranger''s bill returns null, not a partial row that proves it exists');
  PERFORM test.assert_eq(public.kwenta_bill_detail(gen_random_uuid()), NULL::jsonb,
    'and so does a bill that does not exist');
  PERFORM test.as_owner();

  PERFORM test.note('bill_detail: unreadable is indistinguishable from absent');
END;
$$;

-- Deleted items and splits drop out.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; d jsonb;
BEGIN
  alice := test.new_account('bd7-alice@example.com', 'Alice');
  bob   := test.new_account('bd7-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  UPDATE public.item_splits sp SET is_deleted = true
  FROM public.bill_items bi
  WHERE bi.id = sp.item_id AND bi.bill_id = b AND sp.user_id = bob;

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'items' -> 0 -> 'splits'), 1,
    'a deleted split is not rendered');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pairs'), 0,
    'and it stops producing a counterparty row');

  PERFORM test.as_owner();
  PERFORM test.note('bill_detail: deleted splits drop out');
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
    PERFORM public.kwenta_bill_detail(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.assert_true(ok, 'no auth.uid() raises');
  PERFORM test.note('bill_detail refuses an unauthenticated caller');
END;
$$;

-- The counterparty must render under the viewer's own phonebook name, exactly as the Bills LIST
-- does (059). Two surfaces naming the same person differently is the bug this guards.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; b uuid; item uuid; d jsonb;
BEGIN
  alice := test.new_account('bd8-alice@example.com', 'Bob Account Name');
  bob   := test.new_account('bd8-bob@example.com', 'Bob Account Name');
  c_bob := test.new_contact(alice, 'Bobby from my phone', bob);

  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, c_bob]);
  SELECT id INTO item FROM public.bill_items WHERE bill_id = b LIMIT 1;
  INSERT INTO public.item_splits
    (id, item_id, user_id, split_type, split_value, computed_amount,
     created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), item, bob, 'equal', 1, 50, now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(b);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pairs'), 1, 'one person, one row');
  PERFORM test.assert_eq(d -> 'pairs' -> 0 ->> 'displayName', 'Bobby from my phone',
    'the phonebook name wins over the account name, matching the Bills list');
  PERFORM test.as_owner();

  PERFORM test.note('bill_detail: counterparty uses the viewer''s phonebook name');
END;
$$;
