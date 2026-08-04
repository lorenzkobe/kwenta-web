-- Migration 064: settlement history, group spending, member breakdown, owed-in-group.
--
-- These four were the last money the client aggregated for itself, so this file's job is to pin
-- the behaviour that moved rather than to re-prove the arithmetic underneath it (053 and 061
-- already own `kwenta_group_pairwise`).
--
-- The load-bearing cases:
--   * A bundle is ONE payment with MANY legs. `recipients` collapses by recipient; `legs` keeps
--     every stored row. Collapse the two and "How this settled" loses the intermediary hop.
--   * A one-recipient bundle is NOT bundled. Getting this wrong renders "You paid 1 people".
--   * The person-scoped list does NOT bundle: a bundle spanning three people is not one payment
--     *to this person*, and showing its total on their page would credit them money that went
--     elsewhere.
--   * Group spending is CONSUMPTION, not a balance, and is currency-scoped — the client version
--     it replaces summed every currency into one number and labelled it with the group's.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- A single payment: shape.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; h jsonb; item jsonb;
BEGIN
  alice := test.new_account('sh-alice@example.com', 'Alice');
  bob   := test.new_account('sh-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_settlement(bob, alice, 40, g, NULL, 'PHP', 'Cash');

  PERFORM test.as_user(alice);
  h := public.kwenta_group_settlement_history(g);
  PERFORM test.assert_eq(jsonb_array_length(h), 1, 'one payment, one item');

  item := h -> 0;
  PERFORM test.assert_false((item ->> 'isBundled')::boolean, 'a lone payment is not bundled');
  PERFORM test.assert_eq(item ->> 'bundleId', NULL, 'and carries no bundle id');
  PERFORM test.assert_money((item ->> 'amount')::numeric, 40, 'amount');
  PERFORM test.assert_eq(item ->> 'fromName', 'Bob', 'payer name');
  PERFORM test.assert_eq(item ->> 'toName', 'Alice', 'recipient name');
  PERFORM test.assert_eq(item ->> 'label', 'Cash', 'label is carried through');
  PERFORM test.assert_eq(item ->> 'currency', 'PHP', 'currency');
  PERFORM test.assert_eq(item ->> 'groupId', g::text, 'the group-scoped list stamps the group');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'recipients'), 1, 'one recipient');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'legs'), 1, 'one leg');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'settlementIds'), 1, 'one settlement id');
  PERFORM test.assert_eq(item ->> 'recordedByUserId', NULL, 'no activity log, no attribution');

  PERFORM test.as_owner();
  PERFORM test.note('history: single payment shape');
END;
$$;

-- ---------------------------------------------------------------------------
-- A bundle is one item with many recipients — and its recipients sort by amount.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; h jsonb; item jsonb; bundle uuid;
BEGIN
  alice := test.new_account('sh2-alice@example.com', 'Alice');
  bob   := test.new_account('sh2-bob@example.com', 'Bob');
  cha   := test.new_account('sh2-cha@example.com', 'Cha');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cha, 'Cha');

  bundle := test.new_bundle(alice, ARRAY[bob, cha], ARRAY[30, 70]::numeric[], g, 'Settle up');

  PERFORM test.as_user(alice);
  h := public.kwenta_group_settlement_history(g);
  PERFORM test.assert_eq(jsonb_array_length(h), 1,
    'two stored rows sharing a bundle are ONE payment on screen');

  item := h -> 0;
  PERFORM test.assert_true((item ->> 'isBundled')::boolean, 'bundled');
  PERFORM test.assert_eq(item ->> 'id', bundle::text, 'the item is keyed by the bundle id');
  PERFORM test.assert_eq(item ->> 'bundleId', bundle::text, 'bundle id exposed');
  PERFORM test.assert_money((item ->> 'amount')::numeric, 100, 'amount is the whole bundle');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'recipients'), 2, 'two recipients');
  PERFORM test.assert_eq(item -> 'recipients' -> 0 ->> 'toName', 'Cha',
    'recipients sort by amount descending, so the 70 leads');
  PERFORM test.assert_money((item -> 'recipients' -> 0 ->> 'amount')::numeric, 70, 'top amount');
  PERFORM test.assert_eq(item -> 'recipients' -> 1 ->> 'toName', 'Bob', 'then the 30');
  PERFORM test.assert_eq(item ->> 'toUserId', cha::text, 'headline recipient is the largest');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'legs'), 2, 'one leg per stored row');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'settlementIds'), 2, 'both ids reported');

  PERFORM test.as_owner();
  PERFORM test.note('history: a bundle collapses to one item, recipients ranked by amount');
END;
$$;

-- ---------------------------------------------------------------------------
-- A bundle with ONE recipient is not bundled. Otherwise the UI says "You paid 1 people".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; item jsonb; bundle uuid;
BEGIN
  alice := test.new_account('sh3-alice@example.com', 'Alice');
  bob   := test.new_account('sh3-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  bundle := test.new_bundle(alice, ARRAY[bob], ARRAY[50]::numeric[], g);

  PERFORM test.as_user(alice);
  item := public.kwenta_group_settlement_history(g) -> 0;
  PERFORM test.assert_false((item ->> 'isBundled')::boolean,
    'a bundle_id alone does not make it a bundle — it needs more than one recipient');
  PERFORM test.assert_eq(item ->> 'bundleId', NULL, 'and reports no bundle id');
  PERFORM test.assert_true(item ->> 'id' <> bundle::text,
    'so it is keyed by the settlement row, not the bundle');

  PERFORM test.as_owner();
  PERFORM test.note('history: one-recipient bundle is a plain payment');
END;
$$;

-- ---------------------------------------------------------------------------
-- Two rows to the SAME recipient in one bundle collapse into one recipient but keep both legs.
-- This is the difference that "How this settled" is built on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; item jsonb; v_at timestamptz;
BEGIN
  alice := test.new_account('sh4-alice@example.com', 'Alice');
  bob   := test.new_account('sh4-bob@example.com', 'Bob');
  cha   := test.new_account('sh4-cha@example.com', 'Cha');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cha, 'Cha');

  -- Alice pays Cha directly, and also covers Bob's debt to Cha: two legs, one recipient.
  v_at := now();
  INSERT INTO public.settlements (id, group_id, bundle_id, from_user_id, to_user_id, amount,
    currency, is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), g, '11111111-1111-1111-1111-111111111111', alice, cha, 20, 'PHP', true,
     '', v_at, v_at, v_at, false, 'test'),
    (gen_random_uuid(), g, '11111111-1111-1111-1111-111111111111', bob, cha, 30, 'PHP', true,
     '', v_at, v_at, v_at, false, 'test');

  PERFORM test.as_user(alice);
  item := public.kwenta_group_settlement_history(g) -> 0;

  PERFORM test.assert_eq(jsonb_array_length(item -> 'recipients'), 1,
    'both legs land on Cha, so there is ONE recipient');
  PERFORM test.assert_money((item -> 'recipients' -> 0 ->> 'amount')::numeric, 50,
    'and the recipient total is the sum of the legs');
  PERFORM test.assert_false((item ->> 'isBundled')::boolean,
    'one recipient means not bundled, bundle_id notwithstanding');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'legs'), 2,
    'but BOTH legs survive — losing one erases the intermediary hop');
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM jsonb_array_elements(item -> 'legs') l
             WHERE l ->> 'fromName' = 'Bob'),
    'the leg whose payer is not the headline payer is what makes a movement chain');

  PERFORM test.as_owner();
  PERFORM test.note('history: recipients collapse, legs do not');
END;
$$;

-- ---------------------------------------------------------------------------
-- bill attribution, label precedence, and "Added by".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; b uuid; b2 uuid; item jsonb;
  s1 uuid; bundle uuid; v_at timestamptz;
BEGIN
  alice := test.new_account('sh5-alice@example.com', 'Alice');
  bob   := test.new_account('sh5-bob@example.com', 'Bob');
  cha   := test.new_account('sh5-cha@example.com', 'Cha');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cha, 'Cha');
  b  := test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  b2 := test.new_bill(alice, alice, g, 'Dinner', 60, ARRAY[alice, bob]);

  -- One payment tagged to a bill, recorded by Cha on Bob's behalf.
  s1 := test.new_settlement(bob, alice, 50, g, b, 'PHP', 'For the hotel');
  PERFORM test.log_settled(s1, cha, g);

  PERFORM test.as_user(alice);
  SELECT l INTO item FROM jsonb_array_elements(public.kwenta_group_settlement_history(g)) l
   WHERE l ->> 'billId' = b::text;

  PERFORM test.assert_eq(item ->> 'billId', b::text, 'bill attribution survives');
  PERFORM test.assert_eq(item ->> 'billTitle', 'Hotel', 'and resolves the bill title');
  PERFORM test.assert_eq(item ->> 'recordedByUserId', cha::text, 'recorder is read from the log');
  PERFORM test.assert_eq(item ->> 'recordedByName', 'Cha', 'and named');
  PERFORM test.assert_true(item ->> 'recordedByUserId' <> item ->> 'fromUserId',
    'recorder differs from payer — the case the attribution line exists for');

  -- A bundle whose rows point at DIFFERENT bills cannot claim either one.
  PERFORM test.as_owner();
  v_at := now();
  bundle := gen_random_uuid();
  INSERT INTO public.settlements (id, group_id, bill_id, bundle_id, from_user_id, to_user_id,
    amount, currency, is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), g, b,  bundle, bob, alice, 10, 'PHP', true, '',      v_at, v_at, v_at, false, 'test'),
    (gen_random_uuid(), g, b2, bundle, bob, cha,   10, 'PHP', true, 'Split', v_at, v_at, v_at, false, 'test');
  PERFORM test.as_user(alice);

  SELECT l INTO item FROM jsonb_array_elements(public.kwenta_group_settlement_history(g)) l
   WHERE l ->> 'id' = bundle::text;
  PERFORM test.assert_eq(item ->> 'billId', NULL,
    'rows pointing at different bills give no bill attribution at all');
  PERFORM test.assert_eq(item ->> 'billTitle', NULL, 'and therefore no title');
  PERFORM test.assert_eq(item ->> 'label', 'Split',
    'the first non-blank label wins over an empty one');

  PERFORM test.as_owner();
  PERFORM test.note('history: bill attribution, label precedence, recorded-by');
END;
$$;

-- ---------------------------------------------------------------------------
-- Excluded rows, and newest-first ordering.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; h jsonb; dead uuid; unsettled uuid;
BEGIN
  alice := test.new_account('sh6-alice@example.com', 'Alice');
  bob   := test.new_account('sh6-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.new_settlement(bob, alice, 10, g, NULL, 'PHP', 'old',   now() - interval '2 days');
  PERFORM test.new_settlement(bob, alice, 20, g, NULL, 'PHP', 'newer', now() - interval '1 day');

  dead := test.new_settlement(bob, alice, 99, g);
  UPDATE public.settlements SET is_deleted = true WHERE id = dead;
  unsettled := test.new_settlement(bob, alice, 77, g);
  UPDATE public.settlements SET is_settled = false WHERE id = unsettled;

  PERFORM test.as_user(alice);
  h := public.kwenta_group_settlement_history(g);
  PERFORM test.assert_eq(jsonb_array_length(h), 2,
    'deleted and unsettled rows are not payment history');
  PERFORM test.assert_eq(h -> 0 ->> 'label', 'newer', 'newest first');
  PERFORM test.assert_eq(h -> 1 ->> 'label', 'old', 'then older');

  PERFORM test.as_owner();
  PERFORM test.note('history: deleted/unsettled excluded, newest first');
END;
$$;

-- ---------------------------------------------------------------------------
-- Names come from the roster, because a co-member's local contact row is never on this device.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; ghost uuid; g uuid; item jsonb;
BEGIN
  alice := test.new_account('sh7-alice@example.com', 'Alice');
  bob   := test.new_account('sh7-bob@example.com', 'Bob');
  -- A local contact of Alice's: Bob can never read this profile row (pull-bundle privacy).
  ghost := test.new_contact(alice, 'Ghost');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, ghost, 'Ghost On Roster');

  PERFORM test.new_settlement(ghost, bob, 25, g);

  PERFORM test.as_user(bob);
  item := public.kwenta_group_settlement_history(g) -> 0;
  PERFORM test.assert_eq(item ->> 'fromName', 'Ghost On Roster',
    'the roster name renders even though the profile row is invisible to Bob');

  PERFORM test.as_owner();
  PERFORM test.note('history: roster-first name resolution across the privacy boundary');
END;
$$;

-- ---------------------------------------------------------------------------
-- Group history access: active membership, not mere delivery of the rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid; g uuid; m uuid;
BEGIN
  alice := test.new_account('sh8-alice@example.com', 'Alice');
  bob   := test.new_account('sh8-bob@example.com', 'Bob');
  zed   := test.new_account('sh8-zed@example.com', 'Zed');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m := test.add_member(g, bob, 'Bob');
  PERFORM test.new_settlement(bob, alice, 15, g);

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g), NULL::jsonb,
    'a stranger gets null, not an empty list that proves the group exists');
  PERFORM test.as_owner();

  UPDATE public.group_members SET is_deleted = true WHERE id = m;
  PERFORM test.as_user(bob);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g), NULL::jsonb,
    'a FORMER member is still sent the rows (024) but must not read the screen');

  PERFORM test.as_owner();
  PERFORM test.note('history: active-membership gating');
END;
$$;

-- ---------------------------------------------------------------------------
-- Bill-scoped history: only that bill's payments, and no group label.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; b2 uuid; h jsonb;
BEGIN
  alice := test.new_account('sh9-alice@example.com', 'Alice');
  bob   := test.new_account('sh9-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b  := test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  b2 := test.new_bill(alice, alice, g, 'Dinner', 60, ARRAY[alice, bob]);

  PERFORM test.new_settlement(bob, alice, 50, g, b);
  PERFORM test.new_settlement(bob, alice, 30, g, b2);
  PERFORM test.new_settlement(bob, alice, 10, g, NULL);

  PERFORM test.as_user(alice);
  h := public.kwenta_bill_settlement_history(b);
  PERFORM test.assert_eq(jsonb_array_length(h), 1, 'only this bill''s payment');
  PERFORM test.assert_money((h -> 0 ->> 'amount')::numeric, 50, 'the right one');
  PERFORM test.assert_eq(h -> 0 ->> 'groupId', NULL,
    'the bill-scoped list stamps no group — the row already names the bill');
  PERFORM test.assert_eq(h -> 0 ->> 'billTitle', 'Hotel', 'and names it');

  PERFORM test.as_owner();
  PERFORM test.note('history: bill scope');
END;
$$;

-- ---------------------------------------------------------------------------
-- A stranger's bill yields nothing: the settlement pull rows are the boundary.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid; g uuid; b uuid;
BEGIN
  alice := test.new_account('sh10-alice@example.com', 'Alice');
  bob   := test.new_account('sh10-bob@example.com', 'Bob');
  zed   := test.new_account('sh10-zed@example.com', 'Zed');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 50, g, b);

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_bill_settlement_history(b), '[]'::jsonb,
    'someone outside the group sees no payments on it');

  PERFORM test.as_owner();
  PERFORM test.note('history: bill scope is caller-scoped');
END;
$$;

-- ---------------------------------------------------------------------------
-- Person history: one item per stored row, even inside a bundle.
--
-- The bundle below pays Bob 30 and Cha 70. On Bob's page the answer is 30 — showing the 100 would
-- credit Bob with money that went to Cha.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; h jsonb;
BEGIN
  alice := test.new_account('ph1-alice@example.com', 'Alice');
  bob   := test.new_account('ph1-bob@example.com', 'Bob');
  cha   := test.new_account('ph1-cha@example.com', 'Cha');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cha, 'Cha');

  PERFORM test.new_bundle(alice, ARRAY[bob, cha], ARRAY[30, 70]::numeric[], g);

  PERFORM test.as_user(alice);
  h := public.kwenta_person_settlement_history(bob);
  PERFORM test.assert_eq(jsonb_array_length(h), 1, 'one row concerns Bob');
  PERFORM test.assert_money((h -> 0 ->> 'amount')::numeric, 30,
    'and it is Bob''s leg, not the bundle total');
  PERFORM test.assert_false((h -> 0 ->> 'isBundled')::boolean,
    'the person list never bundles');
  PERFORM test.assert_eq(h -> 0 ->> 'groupName', 'Trip', 'labelled with its own group');

  PERFORM test.as_owner();
  PERFORM test.note('person history: per-leg, never the bundle total');
END;
$$;

-- ---------------------------------------------------------------------------
-- Person history: personal payments, third parties excluded, identity expansion.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; contact uuid; h jsonb;
BEGIN
  alice   := test.new_account('ph2-alice@example.com', 'Alice');
  bob     := test.new_account('ph2-bob@example.com', 'Bob');
  cha     := test.new_account('ph2-cha@example.com', 'Cha');
  -- Alice's phonebook entry for Bob, linked to his real account.
  contact := test.new_contact(alice, 'Bobby', bob);

  PERFORM test.new_settlement(alice, bob, 25, NULL);       -- direct, account id
  PERFORM test.new_settlement(alice, contact, 15, NULL);   -- filed under the local contact id
  PERFORM test.new_settlement(alice, cha, 99, NULL);       -- a third party

  PERFORM test.as_user(alice);
  h := public.kwenta_person_settlement_history(bob);

  PERFORM test.assert_eq(jsonb_array_length(h), 2,
    'a payment filed under the linked contact id still belongs to Bob');
  PERFORM test.assert_money(
    (SELECT SUM((l ->> 'amount')::numeric) FROM jsonb_array_elements(h) l), 40,
    'both legs, and only those');
  PERFORM test.assert_eq(h -> 0 ->> 'groupName', 'Personal',
    'a non-group payment is labelled Personal');
  PERFORM test.assert_eq(h -> 0 ->> 'groupId', NULL, 'with no group id');

  h := public.kwenta_person_settlement_history(cha);
  PERFORM test.assert_eq(jsonb_array_length(h), 1, 'Cha''s page shows only Cha''s payment');

  PERFORM test.as_owner();
  PERFORM test.note('person history: identity expansion, personal label, third parties out');
END;
$$;

-- ---------------------------------------------------------------------------
-- Person history is caller-scoped: a payment between two other people is not visible.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid;
BEGIN
  alice := test.new_account('ph3-alice@example.com', 'Alice');
  bob   := test.new_account('ph3-bob@example.com', 'Bob');
  zed   := test.new_account('ph3-zed@example.com', 'Zed');
  PERFORM test.new_settlement(bob, zed, 40, NULL);

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_person_settlement_history(bob), '[]'::jsonb,
    'Alice cannot see what Bob paid Zed');

  PERFORM test.as_owner();
  PERFORM test.note('person history: caller scoping');
END;
$$;

-- ---------------------------------------------------------------------------
-- Group spending is CONSUMPTION: shares assigned, regardless of who fronted the money.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; s jsonb; rows_ jsonb;
BEGIN
  alice := test.new_account('gs1-alice@example.com', 'Alice');
  bob   := test.new_account('gs1-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  PERFORM test.new_bill(bob, bob, g, 'Dinner', 40, ARRAY[bob]);
  -- A payment must not touch consumption: Bob repaying Alice does not un-eat the hotel.
  PERFORM test.new_settlement(bob, alice, 50, g);

  PERFORM test.as_user(alice);
  s := public.kwenta_group_spending(g);
  PERFORM test.assert_eq(s ->> 'currency', 'PHP', 'the group currency is reported');
  rows_ := s -> 'rows';
  PERFORM test.assert_eq(jsonb_array_length(rows_), 2, 'two spenders');
  PERFORM test.assert_eq(rows_ -> 0 ->> 'displayName', 'Bob', 'ranked by amount, Bob leads');
  PERFORM test.assert_money((rows_ -> 0 ->> 'amount')::numeric, 90, 'Bob consumed 50 + 40');
  PERFORM test.assert_money((rows_ -> 1 ->> 'amount')::numeric, 50, 'Alice consumed 50');

  PERFORM test.as_owner();
  PERFORM test.note('spending: consumption per member, payments ignored');
END;
$$;

-- ---------------------------------------------------------------------------
-- Group spending is currency-scoped.
--
-- This is a BEHAVIOUR CHANGE from the client version, which summed every currency in the group
-- into one number and rendered it with the group's currency symbol.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; s jsonb; deleted_bill uuid;
BEGIN
  alice := test.new_account('gs2-alice@example.com', 'Alice');
  bob   := test.new_account('gs2-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_bill(alice, alice, g, 'Duty free', 500, ARRAY[alice, bob], 'USD');
  deleted_bill := test.new_bill(alice, alice, g, 'Cancelled', 80, ARRAY[alice, bob], 'PHP');
  UPDATE public.bills SET is_deleted = true WHERE id = deleted_bill;

  PERFORM test.as_user(alice);
  s := public.kwenta_group_spending(g);
  PERFORM test.assert_money((s -> 'rows' -> 0 ->> 'amount')::numeric, 50,
    'the USD bill is dropped, never converted, and the deleted bill is gone');
  PERFORM test.assert_eq(jsonb_array_length(s -> 'rows'), 2, 'still two members');

  PERFORM test.as_owner();
  PERFORM test.note('spending: currency-scoped and deletion-aware');
END;
$$;

-- ---------------------------------------------------------------------------
-- Group spending access + an empty group.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; zed uuid; g uuid; s jsonb;
BEGIN
  alice := test.new_account('gs3-alice@example.com', 'Alice');
  zed   := test.new_account('gs3-zed@example.com', 'Zed');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_group_spending(g), NULL::jsonb, 'non-member gets null');
  PERFORM test.as_user(alice);
  s := public.kwenta_group_spending(g);
  PERFORM test.assert_eq(s -> 'rows', '[]'::jsonb,
    'a group with no bills reports no spenders, not a null payload');

  PERFORM test.as_owner();
  PERFORM test.note('spending: access + empty group');
END;
$$;

-- ---------------------------------------------------------------------------
-- Member breakdown: signs, and who may ask.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; d jsonb;
BEGIN
  alice := test.new_account('mb1-alice@example.com', 'Alice');
  bob   := test.new_account('mb1-bob@example.com', 'Bob');
  cha   := test.new_account('mb1-cha@example.com', 'Cha');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cha, 'Cha');

  -- Alice fronts 90 for three: Bob and Cha each owe her 30.
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 90, ARRAY[alice, bob, cha]);
  -- Bob fronts 20 for himself and Cha: Cha owes Bob 10.
  PERFORM test.new_bill(bob, bob, g, 'Taxi', 20, ARRAY[bob, cha]);

  PERFORM test.as_user(alice);

  d := public.kwenta_group_member_breakdown(g, bob);
  PERFORM test.assert_eq(d ->> 'displayName', 'Bob', 'the subject is named');
  PERFORM test.assert_eq(d ->> 'currency', 'PHP', 'group currency');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pays'), 1, 'Bob pays one person');
  PERFORM test.assert_eq(d -> 'pays' -> 0 ->> 'displayName', 'Alice', 'namely Alice');
  PERFORM test.assert_money((d -> 'pays' -> 0 ->> 'amount')::numeric, 30,
    'amounts are positive magnitudes, not signed nets');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'receives'), 1, 'and receives from one');
  PERFORM test.assert_eq(d -> 'receives' -> 0 ->> 'displayName', 'Cha', 'namely Cha');
  PERFORM test.assert_money((d -> 'receives' -> 0 ->> 'amount')::numeric, 10, 'the taxi share');

  -- The mirror: Cha's view of the same ledger.
  d := public.kwenta_group_member_breakdown(g, cha);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pays'), 2, 'Cha owes both');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'receives'), 0, 'and is owed by nobody');

  PERFORM test.as_owner();
  PERFORM test.note('breakdown: signs, magnitudes, and the mirror');
END;
$$;

-- ---------------------------------------------------------------------------
-- Breakdown: a settled relationship is not a line item; the subject need not be active.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid; g uuid; d jsonb; m uuid;
BEGIN
  alice := test.new_account('mb2-alice@example.com', 'Alice');
  bob   := test.new_account('mb2-bob@example.com', 'Bob');
  zed   := test.new_account('mb2-zed@example.com', 'Zed');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m := test.add_member(g, bob, 'Bob');

  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 50, g);

  PERFORM test.as_user(alice);
  d := public.kwenta_group_member_breakdown(g, bob);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pays'), 0,
    'squared off, so it is no longer something Bob pays');
  PERFORM test.assert_eq(jsonb_array_length(d -> 'receives'), 0, 'nor something he receives');
  PERFORM test.as_owner();

  -- A removed member can still carry a balance — which is exactly what the removal guard asks.
  UPDATE public.group_members SET is_deleted = true WHERE id = m;
  PERFORM test.new_bill(alice, alice, g, 'Late charge', 40, ARRAY[alice, bob]);
  PERFORM test.as_user(alice);
  d := public.kwenta_group_member_breakdown(g, bob);
  PERFORM test.assert_eq(jsonb_array_length(d -> 'pays'), 1,
    'the SUBJECT need not be an active member');
  PERFORM test.assert_money((d -> 'pays' -> 0 ->> 'amount')::numeric, 20, 'his share of the charge');
  PERFORM test.as_owner();

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_group_member_breakdown(g, bob), NULL::jsonb,
    'but the CALLER must be one');

  PERFORM test.as_owner();
  PERFORM test.note('breakdown: epsilon drop, subject vs caller membership');
END;
$$;

-- ---------------------------------------------------------------------------
-- owedInGroup: the payment cap.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; zed uuid; g uuid;
BEGIN
  alice := test.new_account('og1-alice@example.com', 'Alice');
  bob   := test.new_account('og1-bob@example.com', 'Bob');
  zed   := test.new_account('og1-zed@example.com', 'Zed');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  PERFORM test.assert_money(public.kwenta_owed_in_group(g, bob, alice), 50,
    'Bob owes Alice half the hotel');
  PERFORM test.assert_money(public.kwenta_owed_in_group(g, alice, bob), 0,
    'and Alice owes Bob nothing — you cannot pay down a debt you do not have');
  PERFORM test.assert_money(public.kwenta_owed_in_group(g, bob, zed), 0,
    'a stranger to the ledger is owed nothing');

  -- Paying it down lowers the cap; overpaying is not this function''s business to prevent.
  PERFORM test.as_owner();
  PERFORM test.new_settlement(bob, alice, 30, g);
  PERFORM test.as_user(alice);
  PERFORM test.assert_money(public.kwenta_owed_in_group(g, bob, alice), 20, 'cap follows the debt');

  PERFORM test.as_user(zed);
  PERFORM test.assert_eq(public.kwenta_owed_in_group(g, bob, alice), NULL::numeric,
    'a non-member may not probe the group ledger');

  PERFORM test.as_owner();
  PERFORM test.note('owed_in_group: cap, direction, access');
END;
$$;

-- ---------------------------------------------------------------------------
-- The internal helpers stay internal.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'kwenta_settlement_history_build',
    'kwenta_settlement_party_name',
    'kwenta_is_active_group_member'
  ] LOOP
    PERFORM test.assert_false(
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = fn
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      ),
      fn || ' takes a viewer/subject as an argument and must not be client-callable'
    );
  END LOOP;

  PERFORM test.note('064: internal helpers are not granted to authenticated');
END;
$$;
