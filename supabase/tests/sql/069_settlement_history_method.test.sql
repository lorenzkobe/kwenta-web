-- 069_settlement_history_method.test.sql
--
-- `settlements.method` existed from 046 but was never emitted by any read endpoint, so the value
-- a user picked was unreachable the moment they saved. These assertions are what stops it going
-- write-only again: each of the three history endpoints must carry it, a bundle must resolve to
-- ONE method by the same first-non-blank rule `label` uses, and an unset method must arrive as
-- JSON null rather than the string "null" or an empty string (the client renders any non-empty
-- value as a tag).

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- All three endpoints carry the method for a lone payment.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid;
  h jsonb;
BEGIN
  alice := test.new_account('m69a-alice@example.com', 'Alice');
  bob   := test.new_account('m69a-bob@example.com',   'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');
  b := test.new_bill(alice, alice, g, 'Hotel', 200, ARRAY[alice, bob]);

  PERFORM test.new_settlement(bob, alice, 40, g, b, 'PHP', 'Rent share', NULL, 'GCash');

  PERFORM test.as_user(alice);

  h := public.kwenta_group_settlement_history(g);
  PERFORM test.assert_eq(h -> 0 ->> 'method', 'GCash', 'group history carries the method');
  PERFORM test.assert_eq(h -> 0 ->> 'label', 'Rent share',
    'and the label is still its own field — method did not replace it');

  h := public.kwenta_bill_settlement_history(b);
  PERFORM test.assert_eq(h -> 0 ->> 'method', 'GCash', 'bill history carries the method');

  h := public.kwenta_person_settlement_history(bob);
  PERFORM test.assert_eq(h -> 0 ->> 'method', 'GCash', 'person history carries the method');

  PERFORM test.as_owner();
  PERFORM test.note('069: method reaches all three history endpoints');
END;
$$;

-- ---------------------------------------------------------------------------
-- An unset method is JSON null, not "" and not the string "null". The client renders any
-- non-empty value as a tag, so an empty string would paint a blank chip on every old payment.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; h jsonb; item jsonb;
BEGIN
  alice := test.new_account('m69b-alice@example.com', 'Alice');
  bob   := test.new_account('m69b-bob@example.com',   'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');

  PERFORM test.new_settlement(bob, alice, 25, g, NULL, 'PHP', 'Cash back');

  PERFORM test.as_user(alice);
  h    := public.kwenta_group_settlement_history(g);
  item := h -> 0;
  PERFORM test.assert_true(item ? 'method', 'the key is always present');
  PERFORM test.assert_eq(jsonb_typeof(item -> 'method'), 'null',
    'and is JSON null when unset — never "" and never the string "null"');

  item := public.kwenta_person_settlement_history(bob) -> 0;
  PERFORM test.assert_eq(jsonb_typeof(item -> 'method'), 'null',
    'the person endpoint agrees');

  PERFORM test.as_owner();
  PERFORM test.note('069: an unset method is JSON null everywhere');
END;
$$;

-- ---------------------------------------------------------------------------
-- A blank-but-present method is treated as unset. Nothing writes ' ' today, but the label rule
-- next to it already guards this and the two must not disagree.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid;
BEGIN
  alice := test.new_account('m69c-alice@example.com', 'Alice');
  bob   := test.new_account('m69c-bob@example.com',   'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');

  PERFORM test.new_settlement(bob, alice, 25, g, NULL, 'PHP', '', NULL, '   ');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(
    jsonb_typeof(public.kwenta_group_settlement_history(g) -> 0 -> 'method'), 'null',
    'whitespace is not a method');
  PERFORM test.assert_eq(
    jsonb_typeof(public.kwenta_person_settlement_history(bob) -> 0 -> 'method'), 'null',
    'and the person endpoint agrees');
  PERFORM test.as_owner();
  PERFORM test.note('069: a whitespace method reads as unset');
END;
$$;

-- ---------------------------------------------------------------------------
-- A bundle resolves to ONE method: first non-blank, ordered created_at DESC then id — the same
-- rule `label` uses. recordPersonPayment stamps every leg identically, so a disagreement can only
-- arise from a hand-edited row; the rule still has to be deterministic.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; g uuid; bundle uuid; item jsonb;
BEGIN
  alice := test.new_account('m69d-alice@example.com', 'Alice');
  bob   := test.new_account('m69d-bob@example.com',   'Bob');
  cha   := test.new_account('m69d-cha@example.com',   'Cha');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');
  PERFORM test.add_member(g, cha,   'Cha');

  bundle := test.new_bundle(alice, ARRAY[bob, cha], ARRAY[30, 70]::numeric[], g,
                            'Settle up', 'PHP', 'GoTyme');

  PERFORM test.as_user(alice);
  item := public.kwenta_group_settlement_history(g) -> 0;
  PERFORM test.assert_true((item ->> 'isBundled')::boolean, 'two recipients is a bundle');
  PERFORM test.assert_eq(item ->> 'method', 'GoTyme', 'and it carries one method for the bundle');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'legs'), 2, 'both legs are still there');
  PERFORM test.as_owner();

  -- Blank one leg's method: the remaining non-blank one must still win, not NULL.
  UPDATE public.settlements SET method = NULL
   WHERE bundle_id = bundle AND to_user_id = cha;

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g) -> 0 ->> 'method', 'GoTyme',
    'FIRST NON-BLANK wins — one leg losing its method does not blank the payment');
  PERFORM test.as_owner();
  PERFORM test.note('069: a bundle resolves to one method, first non-blank');
END;
$$;

-- ---------------------------------------------------------------------------
-- 064's existing guarantees still hold — this migration adds a key and changes nothing else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; item jsonb;
BEGIN
  alice := test.new_account('m69e-alice@example.com', 'Alice');
  bob   := test.new_account('m69e-bob@example.com',   'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');
  b := test.new_bill(alice, alice, g, 'Hotel', 200, ARRAY[alice, bob]);

  PERFORM test.new_settlement(bob, alice, 40, g, b, 'PHP', 'Cash', NULL, 'BDO');

  PERFORM test.as_user(alice);
  item := public.kwenta_group_settlement_history(g) -> 0;
  PERFORM test.assert_false((item ->> 'isBundled')::boolean, 'a lone payment is not bundled');
  PERFORM test.assert_eq(item ->> 'bundleId', NULL, 'and carries no bundle id');
  PERFORM test.assert_money((item ->> 'amount')::numeric, 40, 'amount unchanged');
  PERFORM test.assert_eq(item ->> 'billTitle', 'Hotel', 'bill attribution unchanged');
  PERFORM test.assert_eq(item ->> 'label', 'Cash', 'label unchanged');
  PERFORM test.assert_eq(item ->> 'method', 'BDO', 'and method sits alongside it');
  PERFORM test.assert_eq(jsonb_array_length(item -> 'recipients'), 1, 'one recipient');

  -- A former member is still SENT the rows by 024 and must still be refused the screen.
  PERFORM test.as_owner();
  UPDATE public.group_members SET is_deleted = TRUE WHERE group_id = g AND user_id = bob;
  PERFORM test.as_user(bob);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g), NULL,
    'active-membership gating survives the rewrite');

  PERFORM test.as_owner();
  PERFORM test.note('069: 064 behaviour intact; only a key was added');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the builder names its caller and must stay off-limits (rule 5).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_false(
    has_function_privilege('authenticated',
      'public.kwenta_settlement_history_build(uuid[], uuid, uuid, text)', 'EXECUTE'),
    'the builder takes the acting user as an ARGUMENT, so it is service_role only');
  PERFORM test.assert_true(
    has_function_privilege('authenticated',
      'public.kwenta_person_settlement_history(uuid)', 'EXECUTE'),
    'the person endpoint derives the viewer from auth.uid() and stays client-callable');
  PERFORM test.note('069: grants unchanged by the rewrite');
END;
$$;
