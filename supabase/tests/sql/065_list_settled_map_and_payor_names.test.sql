-- Migration 065: four defects found reviewing the 051–064 read migration.
--
-- The load-bearing cases: a shared-bucket bill names its payer (the pull bundle can never carry
-- that profile row, which is why it read "Someone"); the settled flag survives being computed
-- set-wise instead of per bill; "not on this bill" is NULL and not a zero share; and a statement
-- bill event carries its category.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 1. payorName in the "shared with me" bucket
-- ---------------------------------------------------------------------------

-- Bob pays and splits Alice in. Alice's Shared tab must name Bob, even though `kwenta_pull_rows_
-- profiles` never returns Bob's account row to her.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; payload jsonb; shared jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p65-alice@example.com', 'Alice');
  bob   := test.new_account('p65-bob@example.com', 'Bob');
  b := test.new_bill(bob, bob, NULL, 'Bob''s dinner', 100, ARRAY[alice, bob]);

  -- Proves the premise of the bug: the bundle genuinely does not carry Bob to Alice.
  PERFORM test.assert_eq(
    (SELECT COUNT(*)::int FROM public.kwenta_pull_rows_profiles('epoch'::timestamptz, alice) pr
      WHERE pr.id = bob),
    0,
    'the pull bundle does not deliver another account''s profile row');

  PERFORM test.as_user(alice);
  payload := public.kwenta_personal_bills();
  shared := payload -> 'shared';

  PERFORM test.assert_eq(jsonb_array_length(shared), 1, 'the bill lands in the shared bucket');
  PERFORM test.assert_eq(shared -> 0 ->> 'payorName', 'Bob',
    'the shared bucket names the payer instead of falling back to "Someone"');

  PERFORM test.note('065 payorName: a shared-bucket bill names its payer');
END;
$$;

-- The viewer's own bills are UNCHANGED by this migration: the payer line names the viewer, the
-- participant pill is what says "You". 059's suite pins the same thing from the other side.
DO $$
DECLARE
  alice uuid; b uuid; payload jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p65b-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'My lunch', 60, ARRAY[alice]);

  PERFORM test.as_user(alice);
  payload := public.kwenta_personal_bills();

  PERFORM test.assert_eq(payload -> 'mine' -> 0 ->> 'payorName', 'Alice',
    'the viewer''s own bill still names the viewer, as before');
  PERFORM test.assert_eq(payload -> 'mine' -> 0 -> 'participants' -> 0 ->> 'label', 'You',
    'and the participant pill is the thing that says "You"');

  PERFORM test.note('065 payorName: own bills unchanged');
END;
$$;

-- A payer this viewer genuinely cannot resolve still degrades to 'Unknown' rather than erroring.
-- (kwenta_peer_display_name's own last resort; the row must still render.)
DO $$
DECLARE
  alice uuid; ghost uuid; b uuid; payload jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p65c-alice@example.com', 'Alice');
  ghost := test.new_account('p65c-ghost@example.com', 'Ghost');
  b := test.new_bill(ghost, ghost, NULL, 'Mystery', 40, ARRAY[alice, ghost]);
  -- Blank the payer's display name so neither profiles nor a roster can answer.
  UPDATE public.profiles SET display_name = '' WHERE id = ghost;

  PERFORM test.as_user(alice);
  payload := public.kwenta_personal_bills();

  PERFORM test.assert_eq(payload -> 'shared' -> 0 ->> 'payorName', 'Unknown',
    'an unresolvable payer degrades rather than breaking the row');

  PERFORM test.note('065 payorName: unresolvable payer degrades to Unknown');
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. kwenta_bills_settled_map — same answers as the per-bill function
-- ---------------------------------------------------------------------------

-- The map is a performance change, so what it must prove is that it did not change the ANSWER.
-- Every bill is checked against kwenta_bill_settled, which the 056 suite already pins.
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid;
  b_open uuid; b_settled uuid; b_solo uuid; b_deleted uuid;
  m jsonb; ids uuid[];
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('sm-alice@example.com', 'Alice');
  bob   := test.new_account('sm-bob@example.com', 'Bob');
  cha   := test.new_account('sm-cha@example.com', 'Cha');

  -- Open: Bob still owes Alice 50.
  b_open := test.new_bill(alice, alice, NULL, 'Open', 100, ARRAY[alice, bob]);
  -- Settled: Cha owed 50 and paid it back (untagged — the flag is a PERSON question).
  b_settled := test.new_bill(alice, alice, NULL, 'Settled', 100, ARRAY[alice, cha]);
  PERFORM test.new_settlement(cha, alice, 50, NULL, NULL, 'PHP');
  -- Solo: nobody else on it.
  b_solo := test.new_bill(alice, alice, NULL, 'Solo', 20, ARRAY[alice]);
  -- Deleted.
  b_deleted := test.new_bill(alice, alice, NULL, 'Gone', 80, ARRAY[alice, bob]);
  UPDATE public.bills SET is_deleted = true WHERE id = b_deleted;

  ids := ARRAY[b_open, b_settled, b_solo, b_deleted];
  m := public.kwenta_bills_settled_map(ids, alice);

  PERFORM test.assert_eq((m ->> b_open::text)::boolean, false, 'an open bill is unsettled');
  PERFORM test.assert_eq((m ->> b_settled::text)::boolean, true, 'a repaid bill is settled');
  PERFORM test.assert_eq((m ->> b_solo::text)::boolean, true, 'a solo bill is settled');
  PERFORM test.assert_eq((m ->> b_deleted::text)::boolean, true, 'a deleted bill is settled');

  -- The invariant that matters: identical to the single-bill function, bill for bill.
  PERFORM test.assert_eq((m ->> b_open::text)::boolean,
    public.kwenta_bill_settled(b_open, alice), 'map agrees with kwenta_bill_settled (open)');
  PERFORM test.assert_eq((m ->> b_settled::text)::boolean,
    public.kwenta_bill_settled(b_settled, alice), 'map agrees with kwenta_bill_settled (settled)');
  PERFORM test.assert_eq((m ->> b_solo::text)::boolean,
    public.kwenta_bill_settled(b_solo, alice), 'map agrees with kwenta_bill_settled (solo)');
  PERFORM test.assert_eq((m ->> b_deleted::text)::boolean,
    public.kwenta_bill_settled(b_deleted, alice), 'map agrees with kwenta_bill_settled (deleted)');

  PERFORM test.note('065 settled map: agrees with the per-bill function');
END;
$$;

-- Currency scoping survives the set-wise rewrite: a tab open in USD does not unsettle a PHP bill.
DO $$
DECLARE
  alice uuid; bob uuid; b_php uuid; b_usd uuid; m jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('sm2-alice@example.com', 'Alice');
  bob   := test.new_account('sm2-bob@example.com', 'Bob');

  b_php := test.new_bill(alice, alice, NULL, 'PHP bill', 100, ARRAY[alice, bob], 'PHP');
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');
  b_usd := test.new_bill(alice, alice, NULL, 'USD bill', 100, ARRAY[alice, bob], 'USD');

  m := public.kwenta_bills_settled_map(ARRAY[b_php, b_usd], alice);

  PERFORM test.assert_eq((m ->> b_php::text)::boolean, true,
    'the PHP tab is square, so the PHP bill is settled');
  PERFORM test.assert_eq((m ->> b_usd::text)::boolean, false,
    'the untouched USD tab leaves the USD bill unsettled');

  PERFORM test.note('065 settled map: stays currency-scoped');
END;
$$;

-- An unknown id is simply absent, and the caller's COALESCE treats absence as settled.
DO $$
DECLARE
  alice uuid; m jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('sm3-alice@example.com', 'Alice');
  m := public.kwenta_bills_settled_map(ARRAY[gen_random_uuid()], alice);
  PERFORM test.assert_eq(m, '{}'::jsonb, 'an unknown bill id yields no entry');

  m := public.kwenta_bills_settled_map(ARRAY[]::uuid[], alice);
  PERFORM test.assert_eq(m, '{}'::jsonb, 'an empty input yields an empty map');

  PERFORM test.note('065 settled map: unknown and empty inputs');
END;
$$;

-- The list endpoint carries the map's answer through unchanged.
DO $$
DECLARE
  alice uuid; bob uuid; b_open uuid; b_done uuid; payload jsonb; row_open jsonb; row_done jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('sm4-alice@example.com', 'Alice');
  bob   := test.new_account('sm4-bob@example.com', 'Bob');

  b_open := test.new_bill(alice, alice, NULL, 'Still open', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  payload := public.kwenta_personal_bills();
  SELECT e INTO row_open FROM jsonb_array_elements(payload -> 'mine') e
   WHERE e ->> 'id' = b_open::text;
  PERFORM test.assert_eq((row_open ->> 'settled')::boolean, false,
    'the list reports the open bill as unsettled');

  -- Square the tab; the same bill flips. Back to the owner to write the fixture — `as_user`
  -- dropped us to `authenticated`, where RLS applies and a bare INSERT is refused.
  PERFORM test.as_owner();
  PERFORM test.new_settlement(bob, alice, 50, NULL, NULL, 'PHP');
  PERFORM test.as_user(alice);
  payload := public.kwenta_personal_bills();
  SELECT e INTO row_done FROM jsonb_array_elements(payload -> 'mine') e
   WHERE e ->> 'id' = b_open::text;
  PERFORM test.assert_eq((row_done ->> 'settled')::boolean, true,
    'and flips once the person tab is square');

  PERFORM test.note('065 settled map: the list reflects it');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. mySplitTotal — NULL when the viewer is not on the bill
-- ---------------------------------------------------------------------------

-- THE regression: Alice records a gift and splits it entirely between Bob and Cha. She is the
-- payer but holds no split, so the screen must omit "Your share" rather than claim 0.00.
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; b uuid; detail jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('ms-alice@example.com', 'Alice');
  bob   := test.new_account('ms-bob@example.com', 'Bob');
  cha   := test.new_account('ms-cha@example.com', 'Cha');

  b := test.new_bill(alice, alice, NULL, 'Gift for Mum', 1000, ARRAY[bob, cha]);

  PERFORM test.as_user(alice);
  detail := public.kwenta_bill_detail(b);

  PERFORM test.assert_eq(detail -> 'mySplitTotal', 'null'::jsonb,
    'a payer with no split of their own gets null, not a zero share');

  PERFORM test.note('065 mySplitTotal: null when not a participant');
END;
$$;

-- A viewer who IS on the bill still gets their share, and a genuine zero share is still 0 —
-- that is a different fact from not being on the bill and must keep rendering.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; b_zero uuid; item uuid; detail jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('ms2-alice@example.com', 'Alice');
  bob   := test.new_account('ms2-bob@example.com', 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  PERFORM test.as_user(alice);
  detail := public.kwenta_bill_detail(b);
  PERFORM test.assert_money((detail ->> 'mySplitTotal')::numeric, 50,
    'a participant still gets their share');

  -- An explicit zero-amount split row: present, but worth nothing.
  PERFORM test.as_owner();
  b_zero := test.new_bill(alice, alice, NULL, 'Comped', 100, ARRAY[bob]);
  SELECT id INTO item FROM public.bill_items WHERE bill_id = b_zero LIMIT 1;
  INSERT INTO public.item_splits (
    id, item_id, user_id, split_type, split_value, computed_amount,
    created_at, updated_at, synced_at, is_deleted, device_id
  ) VALUES (gen_random_uuid(), item, alice, 'custom', 0, 0, now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  detail := public.kwenta_bill_detail(b_zero);
  PERFORM test.assert_eq(detail -> 'mySplitTotal', '0'::jsonb,
    'a real zero share is 0, not null');

  PERFORM test.note('065 mySplitTotal: participant share, and zero is not null');
END;
$$;

-- Group bills are unchanged: the screen does not show the line there.
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; detail jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('ms3-alice@example.com', 'Alice');
  bob   := test.new_account('ms3-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(alice, alice, g, 'Hotel', 200, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  detail := public.kwenta_bill_detail(b);
  PERFORM test.assert_eq(detail -> 'mySplitTotal', 'null'::jsonb,
    'a group bill still returns null');

  PERFORM test.note('065 mySplitTotal: group bills unchanged');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. category on statement bill events
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; events jsonb; bill_ev jsonb; pay_ev jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('cat-alice@example.com', 'Alice');
  bob   := test.new_account('cat-bob@example.com', 'Bob');

  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  UPDATE public.bills SET category = 'food' WHERE id = b;
  PERFORM test.new_settlement(bob, alice, 20, NULL, NULL, 'PHP');

  PERFORM test.as_user(alice);
  events := public.kwenta_person_statement(bob);

  SELECT e INTO bill_ev FROM jsonb_array_elements(events) e WHERE e ->> 'type' = 'personal_bill';
  SELECT e INTO pay_ev  FROM jsonb_array_elements(events) e WHERE e ->> 'type' = 'payment';

  PERFORM test.assert_eq(bill_ev ->> 'category', 'food', 'a bill event carries its category');
  PERFORM test.assert_eq(pay_ev -> 'category', 'null'::jsonb, 'a payment event has no category');

  PERFORM test.note('065 statement: category on bill events only');
END;
$$;

-- An uncategorised bill is null, not the empty string — the export renders both as blank, but
-- only one of them survives a round trip through the client's `typeof === string` guard.
DO $$
DECLARE
  alice uuid; bob uuid; b uuid; events jsonb; bill_ev jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('cat2-alice@example.com', 'Alice');
  bob   := test.new_account('cat2-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Uncategorised', 50, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  events := public.kwenta_person_statement(bob);
  SELECT e INTO bill_ev FROM jsonb_array_elements(events) e WHERE e ->> 'type' = 'personal_bill';

  PERFORM test.assert_eq(bill_ev -> 'category', 'null'::jsonb,
    'an uncategorised bill reports null');

  PERFORM test.note('065 statement: uncategorised bill is null');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the map takes a viewer argument, so a client must not be able to call it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_eq(
    has_function_privilege('authenticated', 'public.kwenta_bills_settled_map(uuid[], uuid)', 'EXECUTE'),
    false,
    'kwenta_bills_settled_map is not client-callable');

  PERFORM test.assert_eq(
    has_function_privilege('authenticated', 'public.kwenta_personal_bills()', 'EXECUTE'),
    true,
    'kwenta_personal_bills stays client-callable');
  PERFORM test.assert_eq(
    has_function_privilege('authenticated', 'public.kwenta_bill_detail(uuid)', 'EXECUTE'),
    true,
    'kwenta_bill_detail stays client-callable');
  PERFORM test.assert_eq(
    has_function_privilege('authenticated', 'public.kwenta_person_statement(uuid)', 'EXECUTE'),
    true,
    'kwenta_person_statement stays client-callable');

  PERFORM test.note('065 grants');
END;
$$;

-- ---------------------------------------------------------------------------
-- The privacy boundary, enforced rather than asserted in prose.
--
-- Migration 051 lifted every table's visible row set into `kwenta_pull_rows_<table>`, and CLAUDE.md
-- rule 5 says read endpoints must select from them. The money helpers in 052–054, 057 and 063 do
-- NOT: they read base tables and are scoped instead by explicit identity joins. That is safe for
-- exactly one reason — they take the viewer as an ARGUMENT and are not callable by a client, so
-- the only way to reach them is through an endpoint that derived the viewer from `auth.uid()`.
--
-- That reason is load-bearing and was previously enforced by nothing. A single GRANT would turn
-- any of them into "read any user's ledger by passing their id". This sweep is generic on
-- purpose: it catches a NEW viewer-taking function that someone grants, not just today's list.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leaked text;
BEGIN
  PERFORM test.as_owner();

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
  INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'kwenta%'
    -- A function that names its caller is one whose caller is NOT auth.uid().
    AND (COALESCE(p.proargnames, ARRAY[]::text[]) && ARRAY['p_viewer', 'p_uid', 'uid', 'p_owner'])
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  PERFORM test.assert_eq(
    leaked, NULL,
    'no function taking an explicit viewer argument is executable by authenticated');

  PERFORM test.note('065 boundary: viewer-argument helpers stay server-internal');
END;
$$;

-- The two exploits that sweep would have caught, pinned as behaviour rather than as a grant bit.
-- Both were reachable from any signed-in client before 065.

-- READ: naming another user in `kwenta_build_pull_bundle` handed back their profile (with email),
-- their private local contacts, their groups, their memberships and their settlements.
DO $$
DECLARE
  victim uuid; friend uuid; attacker uuid; g uuid; denied boolean := false;
BEGIN
  PERFORM test.as_owner();
  victim   := test.new_account('leak-victim@example.com', 'Victim');
  friend   := test.new_account('leak-friend@example.com', 'Friend');
  attacker := test.new_account('leak-attacker@example.com', 'Attacker');
  g := test.new_group(victim, 'Victim Private Trip', 'PHP');
  PERFORM test.add_member(g, victim, 'Victim');
  PERFORM test.add_member(g, friend, 'Friend');
  PERFORM test.new_settlement(victim, friend, 500, g, NULL, 'PHP', 'rent');
  PERFORM test.new_contact(victim, 'Victim secret contact');

  PERFORM test.as_user(attacker);
  BEGIN
    PERFORM public.kwenta_build_pull_bundle('epoch'::timestamptz, victim);
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;

  PERFORM test.assert_true(denied,
    'an authenticated client cannot call kwenta_build_pull_bundle for another user');

  PERFORM test.note('065 security: the pull bundle is not client-callable');
END;
$$;

-- WRITE: naming another user in a push validator inserted rows AUTHORED BY THEM.
DO $$
DECLARE
  victim uuid; attacker uuid; denied boolean := false; forged int;
BEGIN
  PERFORM test.as_owner();
  victim   := test.new_account('forge-victim@example.com', 'Victim');
  attacker := test.new_account('forge-attacker@example.com', 'Attacker');

  PERFORM test.as_user(attacker);
  BEGIN
    PERFORM public.kwenta_push_bills(
      jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid(), 'title', 'FORGED', 'group_id', NULL,
        'currency', 'PHP', 'created_by', victim, 'paid_by', victim,
        'total_amount', 4242, 'note', '', 'category', NULL,
        'created_at', now(), 'updated_at', now(), 'synced_at', now(),
        'is_deleted', false, 'device_id', 'x')),
      victim);
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;

  PERFORM test.assert_true(denied,
    'an authenticated client cannot call a push validator for another user');

  PERFORM test.as_owner();
  SELECT COUNT(*)::int INTO forged FROM public.bills WHERE created_by = victim;
  PERFORM test.assert_eq(forged, 0, 'and no row was written on the victim''s behalf');

  PERFORM test.note('065 security: push validators are not client-callable');
END;
$$;
