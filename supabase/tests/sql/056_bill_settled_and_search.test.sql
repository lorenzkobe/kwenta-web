-- Migration 056: the per-bill settled flag and global search.
-- Settled cases ported from tests/lib/personal-bill-status.test.ts.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_bill_settled
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; b uuid; ghost uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('bs-alice@example.com', 'Alice');
  bob   := test.new_account('bs-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bob', bob);

  PERFORM test.assert_true(public.kwenta_bill_settled(ghost, alice),
    'a bill that does not exist is settled — there is nothing left to owe');

  b := test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  PERFORM test.assert_false(public.kwenta_bill_settled(b, alice),
    'not settled while a participant still owes');

  -- A payment that clears the PERSON-level tab settles the bill, even though it is not tagged
  -- to this bill. That is the whole point of deriving status from the tab.
  PERFORM test.new_settlement(c_bob, alice, 50.00);
  PERFORM test.assert_true(public.kwenta_bill_settled(b, alice),
    'an untagged payment that clears the tab settles the bill');

  UPDATE public.bills SET is_deleted = true WHERE id = b;
  PERFORM test.assert_true(public.kwenta_bill_settled(b, alice), 'a deleted bill is settled');

  PERFORM test.note('bill_settled: missing, owing, cleared-by-tab, deleted');
END;
$$;

DO $$
DECLARE
  alice uuid; b uuid;
BEGIN
  alice := test.new_account('bs2-alice@example.com', 'Alice');
  -- A bill with only you on it has no counterparty to be square with.
  b := test.new_bill(alice, alice, NULL, 'Solo', 40.00, ARRAY[alice]);
  PERFORM test.assert_true(public.kwenta_bill_settled(b, alice),
    'a bill whose only participant is the viewer is settled');
  PERFORM test.note('bill_settled: solo bills');
END;
$$;

-- Sub-half-cent is noise; one cent is a real obligation.
DO $$
DECLARE
  alice uuid; c_bob uuid; b uuid;
BEGIN
  alice := test.new_account('bs3-alice@example.com', 'Alice');
  c_bob := test.new_contact(alice, 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Tiny', 100.00, ARRAY[alice, c_bob]);
  PERFORM test.new_settlement(c_bob, alice, 49.996);
  PERFORM test.assert_true(public.kwenta_bill_settled(b, alice),
    'a shortfall under half a cent is rounding noise, not a debt');

  PERFORM test.note('bill_settled: epsilon boundary');
END;
$$;

DO $$
DECLARE
  alice uuid; c_bob uuid; b uuid;
BEGIN
  alice := test.new_account('bs4-alice@example.com', 'Alice');
  c_bob := test.new_contact(alice, 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Cent', 100.00, ARRAY[alice, c_bob]);
  PERFORM test.new_settlement(c_bob, alice, 49.00);
  PERFORM test.assert_false(public.kwenta_bill_settled(b, alice),
    'one cent still outstanding is not settled');

  PERFORM test.note('bill_settled: one cent is a real obligation');
END;
$$;

-- Currency scoping: an open balance in another currency must not mark this bill unpaid.
DO $$
DECLARE
  alice uuid; c_bob uuid; b_php uuid;
BEGIN
  alice := test.new_account('bs5-alice@example.com', 'Alice');
  c_bob := test.new_contact(alice, 'Bob');

  b_php := test.new_bill(alice, alice, NULL, 'PHP meal', 100.00, ARRAY[alice, c_bob], 'PHP');
  PERFORM test.new_settlement(c_bob, alice, 50.00, NULL, NULL, 'PHP');
  -- A completely separate, unsettled USD debt.
  PERFORM test.new_bill(alice, alice, NULL, 'USD meal', 80.00, ARRAY[alice, c_bob], 'USD');

  PERFORM test.assert_true(public.kwenta_bill_settled(b_php, alice),
    'a bill settled in ITS currency stays settled despite an open balance in another');

  PERFORM test.note('bill_settled: scoped to the bill''s own currency');
END;
$$;

-- The client wrapper must not answer for a bill the caller cannot read.
DO $$
DECLARE
  alice uuid; carol uuid; g uuid; b uuid; res boolean;
BEGIN
  alice := test.new_account('bsr-alice@example.com', 'Alice');
  carol := test.new_account('bsr-carol@example.com', 'Carol');
  g     := test.new_group(carol, 'Carol only');
  PERFORM test.add_member(g, carol, 'Carol');
  b     := test.new_bill(carol, carol, g, 'Private', 50.00, ARRAY[carol]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  res := public.kwenta_bill_settled_for_me(b);
  PERFORM test.assert_eq(res, NULL,
    'a bill the caller cannot read returns null, never a status that proves it exists');

  PERFORM set_config('request.jwt.claim.sub', carol::text, true);
  PERFORM test.assert_true(public.kwenta_bill_settled_for_me(b) IS NOT NULL,
    'the owner does get an answer');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('bill_settled_for_me: unreadable bills return null');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_search
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; carol uuid; g uuid; gc uuid; res jsonb;
BEGIN
  alice := test.new_account('se-alice@example.com', 'Alice');
  carol := test.new_account('se-carol@example.com', 'Carol');
  PERFORM test.new_contact(alice, 'Zebra Contact');

  g := test.new_group(alice, 'Zebra Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.new_bill(alice, alice, g, 'Zebra Dinner', 100.00, ARRAY[alice]);

  -- Carol's private data must never appear in Alice's results.
  gc := test.new_group(carol, 'Zebra Secret');
  PERFORM test.add_member(gc, carol, 'Carol');
  PERFORM test.new_bill(carol, carol, gc, 'Zebra Secret Bill', 10.00, ARRAY[carol]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  res := public.kwenta_search('zebra');

  PERFORM test.assert_eq(jsonb_array_length(res -> 'bills'), 1, 'only the caller''s own bill matches');
  PERFORM test.assert_eq(res -> 'bills' -> 0 ->> 'title', 'Zebra Dinner', 'the right bill');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'groups'), 1, 'only the caller''s own group matches');
  PERFORM test.assert_eq(res -> 'groups' -> 0 ->> 'name', 'Zebra Trip', 'the right group');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'profiles'), 1, 'the caller''s own contact matches');

  -- Case-insensitive, and an empty query is not a wildcard.
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_search('ZEBRA') -> 'bills'), 1,
    'search is case-insensitive');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_search('   ') -> 'bills'), 0,
    'a blank query returns nothing rather than everything');

  -- A LIKE wildcard in the query must match literally, not select the whole table.
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_search('%') -> 'bills'), 0,
    'a bare % is escaped and matches nothing');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('search: scoped to the caller, case-insensitive, wildcard-safe');
END;
$$;

-- ---------------------------------------------------------------------------
-- Auth + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE raised boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN PERFORM public.kwenta_search('x');
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  PERFORM test.assert_true(raised, 'search refuses an unauthenticated caller');

  raised := false;
  BEGIN PERFORM public.kwenta_bill_settled_for_me(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  PERFORM test.assert_true(raised, 'settled flag refuses an unauthenticated caller');

  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_bill_settled(uuid, uuid)', 'EXECUTE'),
    'the viewer-argument settled function is not client-callable');
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_bill_settled_for_me(uuid)', 'EXECUTE'),
    'the auth.uid()-scoped wrapper is the client surface');
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_search(text)', 'EXECUTE'),
    'search is client-callable');

  PERFORM test.note('056 grants');
END;
$$;
