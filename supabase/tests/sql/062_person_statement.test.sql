-- Migration 062: the Person page statement.
--
-- The invariant that matters more than any individual row: per currency, the event deltas SUM to
-- the same number `kwenta_person_summary` reports as the total. That total is the hero on the
-- same screen. If these ever drift, the page contradicts itself in front of the user — the header
-- says one thing and the running balance beneath it ends on another.
--
-- Several blocks below therefore assert the sum, not just the individual rows.

SET client_min_messages = notice;

-- Sum the deltas of a statement for one currency.
CREATE OR REPLACE FUNCTION test.statement_sum(p_events jsonb, p_currency text)
RETURNS numeric
LANGUAGE sql
AS $$
  SELECT COALESCE(SUM((e ->> 'delta')::numeric), 0)
  FROM jsonb_array_elements(p_events) e
  WHERE e ->> 'currency' = p_currency;
$$;

-- ---------------------------------------------------------------------------
-- Personal bills and payments
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps-alice@example.com', 'Alice');
  bob   := test.new_account('ps-bob@example.com', 'Bob');

  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);

  PERFORM test.assert_eq(jsonb_array_length(ev), 1, 'one event');
  PERFORM test.assert_eq(ev -> 0 ->> 'type', 'personal_bill', 'a personal bill');
  PERFORM test.assert_eq(ev -> 0 ->> 'contextLabel', 'Personal', 'context label');
  PERFORM test.assert_eq(ev -> 0 ->> 'title', 'Dinner', 'title');
  PERFORM test.assert_money((ev -> 0 ->> 'delta')::numeric, 50, 'Bob owes Alice 50');
  PERFORM test.assert_money((ev -> 0 ->> 'rawAmount')::numeric, 50, 'rawAmount is the magnitude');

  PERFORM test.as_owner();
  PERFORM test.note('statement: personal bill event');
END;
$$;

-- A payment appears with the counterparty's name, and flips the sign.
DO $$
DECLARE
  alice uuid; bob uuid; ev jsonb; pay jsonb;
BEGIN
  alice := test.new_account('ps2-alice@example.com', 'Alice');
  bob   := test.new_account('ps2-bob@example.com', 'Bob');

  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);

  SELECT e INTO pay FROM jsonb_array_elements(ev) e WHERE e ->> 'type' = 'payment';
  PERFORM test.assert_eq(pay ->> 'title', 'Bob paid you', 'the payment is described from the viewer''s side');
  PERFORM test.assert_money((pay ->> 'delta')::numeric, -50, 'their payment reduces what they owe');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), 0, 'and the tab lands at zero');

  PERFORM test.as_owner();
  PERFORM test.note('statement: payments carry the counterparty name and flip the sign');
END;
$$;

-- The viewer paying THEM reads the other way round.
DO $$
DECLARE
  alice uuid; bob uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps3-alice@example.com', 'Alice');
  bob   := test.new_account('ps3-bob@example.com', 'Bob');

  PERFORM test.new_bill(bob, bob, NULL, 'Taxi', 80, ARRAY[alice, bob]);
  PERFORM test.new_settlement(alice, bob, 40, NULL, NULL, 'PHP');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM jsonb_array_elements(ev) e
            WHERE e ->> 'type' = 'payment' AND e ->> 'title' = 'You paid Bob'),
    'the viewer''s own payment is phrased from their side');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), 0, 'settled');

  PERFORM test.as_owner();
  PERFORM test.note('statement: outgoing payments');
END;
$$;

-- ---------------------------------------------------------------------------
-- THE RECONCILIATION INVARIANT, across every context at once
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g1 uuid; g2 uuid; ev jsonb; total numeric;
BEGIN
  alice := test.new_account('ps4-alice@example.com', 'Alice');
  bob   := test.new_account('ps4-bob@example.com', 'Bob');
  cara  := test.new_account('ps4-cara@example.com', 'Cara');

  -- Personal: Bob owes Alice 50.
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  -- Group 1: Bob fronts 60 for the two of them -> Alice owes 30.
  g1 := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g1, alice, 'Alice');
  PERFORM test.add_member(g1, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g1, 'Wifi', 60, ARRAY[alice, bob]);
  -- Group 2: three people, Alice fronts 90 -> Bob owes her 30 (Cara's share is not theirs).
  g2 := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, bob, 'Bob');
  PERFORM test.add_member(g2, cara, 'Cara');
  PERFORM test.new_bill(alice, alice, g2, 'Hotel', 90, ARRAY[alice, bob, cara]);
  -- A payment in group 1.
  PERFORM test.new_settlement(alice, bob, 10, g1, NULL, 'PHP');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  -- Via the CLIENT-facing function, the same one the hero on that screen calls.
  total := (public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric;

  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), total,
    'the statement''s deltas sum to the hero number above it');
  -- 50 personal - 30 group1 + 10 payment + 30 group2 = 60
  PERFORM test.assert_money(total, 60, 'and that number is what the contexts actually add up to');

  PERFORM test.as_owner();
  PERFORM test.note('statement reconciles to kwenta_person_summary across every context');
END;
$$;

-- The invariant must survive the peer-link case that broke the naive version: one person on one
-- item under TWO ids. Personal bills take one split per side; summing both would double them.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; b uuid; item uuid; ev jsonb; total numeric;
BEGIN
  alice := test.new_account('ps5-alice@example.com', 'Alice');
  bob   := test.new_account('ps5-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  b := test.new_bill(alice, alice, NULL, 'Duplicated', 100, ARRAY[alice, c_bob]);
  SELECT id INTO item FROM public.bill_items WHERE bill_id = b LIMIT 1;
  INSERT INTO public.item_splits
    (id, item_id, user_id, split_type, split_value, computed_amount,
     created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), item, bob, 'equal', 1, 50, now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(c_bob);
  total := (public.kwenta_person_summary(c_bob) -> 'total' ->> 'PHP')::numeric;

  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), 50, 'charged once, not twice');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), total, 'and still reconciles');

  PERFORM test.as_owner();
  PERFORM test.note('statement: a duplicated identity on one item stays reconciled');
END;
$$;

-- ---------------------------------------------------------------------------
-- Exclusions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps6-alice@example.com', 'Alice');
  bob   := test.new_account('ps6-bob@example.com', 'Bob');
  cara  := test.new_account('ps6-cara@example.com', 'Cara');

  -- Cara paid for Alice and Bob. Nothing moved BETWEEN Alice and Bob.
  PERFORM test.new_bill(cara, cara, NULL, 'Cara treated us', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  PERFORM test.assert_eq(ev, '[]'::jsonb,
    'a third party paying for both of you is not an event between you');
  PERFORM test.as_owner();

  PERFORM test.note('statement: third-party-paid bills are excluded');
END;
$$;

-- A group the two of them do not share is invisible, even if both are in it separately.
DO $$
DECLARE
  alice uuid; bob uuid; cara uuid; g uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps7-alice@example.com', 'Alice');
  bob   := test.new_account('ps7-bob@example.com', 'Bob');
  cara  := test.new_account('ps7-cara@example.com', 'Cara');

  -- Alice and Cara share a group; Bob is not in it.
  g := test.new_group(alice, 'Not with Bob');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, cara, 'Cara');
  PERFORM test.new_bill(alice, alice, g, 'Lunch', 100, ARRAY[alice, cara]);

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  PERFORM test.assert_eq(ev, '[]'::jsonb, 'a group Bob is not in never appears on his statement');
  PERFORM test.as_owner();

  PERFORM test.note('statement: only shared groups');
END;
$$;

-- Deleted bills and unsettled payments drop out.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; s uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps8-alice@example.com', 'Alice');
  bob   := test.new_account('ps8-bob@example.com', 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Deleted', 100, ARRAY[alice, bob]);
  s := test.new_settlement(bob, alice, 20, NULL, NULL, 'PHP');
  UPDATE public.bills SET is_deleted = true WHERE id = b;
  UPDATE public.settlements SET is_settled = false WHERE id = s;

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  PERFORM test.assert_eq(ev, '[]'::jsonb, 'deleted bills and unsettled payments are not events');
  PERFORM test.as_owner();

  PERFORM test.note('statement: deletions and unsettled payments');
END;
$$;

-- Currencies stay in their own ledgers, and both reconcile.
DO $$
DECLARE
  alice uuid; bob uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps9-alice@example.com', 'Alice');
  bob   := test.new_account('ps9-bob@example.com', 'Bob');

  PERFORM test.new_bill(alice, alice, NULL, 'PHP dinner', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_bill(bob, bob, NULL, 'USD taxi', 80, ARRAY[alice, bob], 'USD');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);

  PERFORM test.assert_eq(jsonb_array_length(ev), 2, 'both events');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'), 50, 'PHP ledger');
  PERFORM test.assert_money(test.statement_sum(ev, 'USD'), -40, 'USD ledger, opposite direction');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'),
    (public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric, 'PHP reconciles');
  PERFORM test.assert_money(test.statement_sum(ev, 'USD'),
    (public.kwenta_person_summary(bob) -> 'total' ->> 'USD')::numeric, 'USD reconciles');

  PERFORM test.as_owner();
  PERFORM test.note('statement: per-currency ledgers each reconcile');
END;
$$;

-- A GROUP bill in a currency other than the group's is dropped, exactly as the balance function
-- drops it. Without this the statement would show a row the hero number never counted, and the
-- running balance would end somewhere the header disagrees with.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps11-alice@example.com', 'Alice');
  bob   := test.new_account('ps11-bob@example.com', 'Bob');

  g := test.new_group(alice, 'PHP group', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'PHP dinner', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_bill(alice, alice, g, 'USD extra', 500, ARRAY[alice, bob], 'USD');

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);

  PERFORM test.assert_eq(jsonb_array_length(ev), 1,
    'the off-currency group bill is not an event');
  PERFORM test.assert_eq(ev -> 0 ->> 'title', 'PHP dinner', 'only the matching-currency bill');
  PERFORM test.assert_money(test.statement_sum(ev, 'PHP'),
    (public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric,
    'and the statement still reconciles to the hero');

  PERFORM test.as_owner();
  PERFORM test.note('statement: off-currency group bills are dropped, matching the balance fn');
END;
$$;

-- Ordering is chronological and deterministic — the running-balance pass depends on it.
DO $$
DECLARE
  alice uuid; bob uuid; b1 uuid; b2 uuid; ev jsonb;
BEGIN
  alice := test.new_account('ps10-alice@example.com', 'Alice');
  bob   := test.new_account('ps10-bob@example.com', 'Bob');

  b1 := test.new_bill(alice, alice, NULL, 'First', 100, ARRAY[alice, bob]);
  b2 := test.new_bill(alice, alice, NULL, 'Second', 60, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = now() - interval '2 days' WHERE id = b1;
  UPDATE public.bills SET created_at = now() - interval '1 day'  WHERE id = b2;

  PERFORM test.as_user(alice);
  ev := public.kwenta_person_statement(bob);
  PERFORM test.assert_eq(ev -> 0 ->> 'title', 'First', 'oldest first');
  PERFORM test.assert_eq(ev -> 1 ->> 'title', 'Second', 'then the next');
  PERFORM test.as_owner();

  PERFORM test.note('statement: chronological ascending');
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
    PERFORM public.kwenta_person_statement(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.assert_true(ok, 'no auth.uid() raises');
  PERFORM test.note('statement refuses an unauthenticated caller');
END;
$$;
