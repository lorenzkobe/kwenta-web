-- Migration 054: contact discovery, canonical peers, and the Home rollups.
--
-- The headline rule here is that a person appears ONCE. A contact and the account it links to
-- are the same human; listing both is the "Jello pays Jello" class of bug.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- kwenta_canonical_peer_ids — one id per real person
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; c_dave uuid; g uuid; ids uuid[];
BEGIN
  alice  := test.new_account('cp-alice@example.com', 'Alice');
  bob    := test.new_account('cp-bob@example.com', 'Bob');
  c_bob  := test.new_contact(alice, 'Bob', bob);
  c_dave := test.new_contact(alice, 'Dave');

  -- Alice's own phonebook is always related.
  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_ids(ids, ARRAY[c_bob, c_dave], 'owned local contacts are peers');

  -- Now share a group with Bob's ACCOUNT. Bob must NOT appear twice (account + contact).
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_ids(ids, ARRAY[c_bob, c_dave],
    'a co-member account collapses onto the local contact linked to it — one row per person');

  -- The viewer is never their own peer.
  PERFORM test.assert_false(alice = ANY(ids), 'the viewer is not in their own contact list');

  PERFORM test.note('canonical_peer_ids: account + linked contact collapse to one');
END;
$$;

-- A merged pair resolves to the anchor, so a manual "same person" merge also shows once.
DO $$
DECLARE
  alice uuid; a1 uuid; a2 uuid; ids uuid[];
BEGIN
  alice := test.new_account('cp2-alice@example.com', 'Alice');
  a1 := test.new_contact(alice, 'Jello');
  a2 := test.new_contact(alice, 'Jello Duplicate');

  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_ids(ids, ARRAY[a1, a2], 'before merging, two separate contacts');

  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, a1, a2, now(), now(), now(), false, 'test');

  -- Fixed by 055: grouping on the identity CLUSTER instead of resolving one hop at a time.
  -- The lower id wins the tie, and both are contacts Alice owns.
  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_eq(array_length(ids, 1), 1,
    'two merged contacts are ONE peer, not two');
  PERFORM test.assert_true(ids[1] = a1 OR ids[1] = a2,
    'the surviving peer is one of the merged pair');

  PERFORM test.note('canonical_peer_ids: a manual merge collapses to a single peer');
END;
$$;

-- A transitive chain must collapse too. Resolving one hop at a time cannot do this: a3 would
-- resolve to a2 and a2 to a1, leaving two peers for one person.
DO $$
DECLARE
  alice uuid; a1 uuid; a2 uuid; a3 uuid; cnt int;
BEGIN
  alice := test.new_account('chain-alice@example.com', 'Alice');
  a1 := test.new_contact(alice, 'Jello');
  a2 := test.new_contact(alice, 'Jello Dup');
  a3 := test.new_contact(alice, 'Jello Third');
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), alice, a1, a2, now(), now(), now(), false, 'test'),
    (gen_random_uuid(), alice, a2, a3, now(), now(), now(), false, 'test');

  SELECT count(*)::int INTO cnt FROM public.kwenta_canonical_peer_ids(alice);
  PERFORM test.assert_eq(cnt, 1, 'a transitive merge chain collapses to one peer');

  PERFORM test.note('canonical_peer_ids: transitive merges collapse');
END;
$$;

-- The bug this fixes: the rollup counted one debt twice.
DO $$
DECLARE
  alice uuid; a1 uuid; a2 uuid; ov jsonb;
BEGIN
  alice := test.new_account('dblcount-alice@example.com', 'Alice');
  a1 := test.new_contact(alice, 'Jello');
  a2 := test.new_contact(alice, 'Jello Duplicate');

  -- ONE 100 bill split evenly: Alice is owed 50.
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, a1]);
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, a1, a2, now(), now(), now(), false, 'test');

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  ov := public.kwenta_balances_overview();
  PERFORM test.assert_money((ov -> 'personalReceive' ->> 'PHP')::numeric, 50.00,
    'a merged contact is counted ONCE — this read 100.00 before migration 055');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('overview: merged contacts no longer double-count');
END;
$$;

-- Someone you have only ever exchanged a payment with is still a contact.
DO $$
DECLARE
  alice uuid; bob uuid; ids uuid[];
BEGIN
  alice := test.new_account('cp3-alice@example.com', 'Alice');
  bob   := test.new_account('cp3-bob@example.com', 'Bob');
  PERFORM test.new_settlement(bob, alice, 25.00);

  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_ids(ids, ARRAY[bob], 'a settlement counterparty is a contact');

  PERFORM test.note('canonical_peer_ids: settlement-only counterparties surface');
END;
$$;

-- Privacy: another user's phonebook is never related to me.
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; c_priv uuid; ids uuid[];
BEGIN
  alice  := test.new_account('cp4-alice@example.com', 'Alice');
  bob    := test.new_account('cp4-bob@example.com', 'Bob');
  carol  := test.new_account('cp4-carol@example.com', 'Carol');
  c_priv := test.new_contact(carol, 'Carol private contact');

  ids := ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice));
  PERFORM test.assert_false(c_priv = ANY(ids), 'another user''s local contact is never my peer');
  PERFORM test.assert_false(carol = ANY(ids), 'an unrelated account is not my peer');

  PERFORM test.note('canonical_peer_ids: no cross-account contact leakage');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_peer_display_name — the group-roster fallback (CLAUDE.md rule 6)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; nm text;
  orphan uuid := gen_random_uuid();
  roster_only uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('dn-alice@example.com', 'Alice');
  bob   := test.new_account('dn-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob Roster Name');

  nm := public.kwenta_peer_display_name(alice, bob);
  PERFORM test.assert_eq(nm, 'Bob', 'the profile name wins when the profile is visible');

  -- Two things constrain how this can be tested, and both are worth stating:
  --   * `group_members.user_id` has a FK to `profiles`, so SERVER-side a roster row can never
  --     outlive its profile. The fallback exists for the CLIENT, whose pull bundle deliberately
  --     withholds other users' local contacts (CLAUDE.md rule 6).
  --   * migration 017 syncs `group_members.display_name` from `profiles` on UPDATE, so blanking
  --     a profile name blanks the roster name too and would prove nothing.
  -- The reachable server-side case is therefore a profile that was CREATED without a usable
  -- name while the roster carries one.
  INSERT INTO public.profiles
    (id, email, display_name, created_at, updated_at, synced_at, is_deleted, device_id, is_local, linked_profile_id, owner_id)
  VALUES (roster_only, '', '   ', now(), now(), now(), false, 'test', true, NULL, alice);
  PERFORM test.add_member(g, roster_only, 'Roster Only Person');

  nm := public.kwenta_peer_display_name(alice, roster_only);
  PERFORM test.assert_eq(nm, 'Roster Only Person',
    'a whitespace-only profile name falls through to the roster, never to Unknown');

  PERFORM test.assert_eq(public.kwenta_peer_display_name(alice, orphan), 'Unknown',
    'an unresolvable id is Unknown, never null');

  PERFORM test.note('peer_display_name: roster fallback across the privacy boundary');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_contacts_with_balances / kwenta_balances_overview
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; c_dave uuid; g uuid;
  rows jsonb; ov jsonb;
BEGIN
  alice  := test.new_account('ov-alice@example.com', 'Alice');
  bob    := test.new_account('ov-bob@example.com', 'Bob');
  c_bob  := test.new_contact(alice, 'Bob', bob);
  c_dave := test.new_contact(alice, 'Dave');

  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  -- Bob: +50 personal, +30 group = +80 combined.
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  PERFORM test.new_bill(alice, alice, g, 'Taxi', 60.00, ARRAY[alice, bob]);
  -- Dave: Alice owes him 40 personal.
  PERFORM test.new_bill(alice, c_dave, NULL, 'Drinks', 80.00, ARRAY[alice, c_dave]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);

  rows := public.kwenta_contacts_with_balances();
  PERFORM test.assert_eq(jsonb_array_length(rows), 2, 'two people, not three (Bob appears once)');

  ov := public.kwenta_balances_overview();
  -- personal only: +50 from Bob, -40 from Dave
  PERFORM test.assert_money((ov -> 'personalReceive' ->> 'PHP')::numeric, 50.00, 'personal to receive');
  PERFORM test.assert_money((ov -> 'personalPay' ->> 'PHP')::numeric, 40.00, 'personal to pay');
  -- combined: Bob is +80 once the group leg is included; Dave unchanged
  PERFORM test.assert_money((ov -> 'combinedReceive' ->> 'PHP')::numeric, 80.00,
    'combined to receive includes the group leg');
  PERFORM test.assert_money((ov -> 'combinedPay' ->> 'PHP')::numeric, 40.00, 'combined to pay');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('overview: personal vs combined buckets, per currency');
END;
$$;

-- Netting happens PER PERSON before bucketing: someone who owes on one bill and is owed on
-- another must not appear in both columns.
DO $$
DECLARE
  alice uuid; c_bob uuid; ov jsonb;
BEGIN
  alice := test.new_account('net-alice@example.com', 'Alice');
  c_bob := test.new_contact(alice, 'Bob');

  PERFORM test.new_bill(alice, alice,  NULL, 'Alice paid', 100.00, ARRAY[alice, c_bob]); -- +50
  PERFORM test.new_bill(alice, c_bob,  NULL, 'Bob paid',    60.00, ARRAY[alice, c_bob]); -- -30

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  ov := public.kwenta_balances_overview();

  PERFORM test.assert_money((ov -> 'personalReceive' ->> 'PHP')::numeric, 20.00,
    'the person is netted to a single +20 before bucketing');
  PERFORM test.assert_eq(ov -> 'personalPay' ->> 'PHP', NULL,
    'and therefore does NOT also appear in the to-pay column');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('overview: per-person netting before bucketing');
END;
$$;

-- A balance inside rounding noise is neither owed nor owing.
DO $$
DECLARE
  alice uuid; c_bob uuid; ov jsonb;
BEGIN
  alice := test.new_account('eps-alice@example.com', 'Alice');
  c_bob := test.new_contact(alice, 'Bob');

  PERFORM test.new_bill(alice, alice, NULL, 'Tiny', 0.00, ARRAY[alice, c_bob]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  ov := public.kwenta_balances_overview();
  PERFORM test.assert_eq(ov -> 'personalReceive' ->> 'PHP', NULL, 'a zero balance is not receivable');
  PERFORM test.assert_eq(ov -> 'personalPay' ->> 'PHP', NULL, 'and not payable either');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('overview: effectively-zero balances are bucketed nowhere');
END;
$$;

-- ---------------------------------------------------------------------------
-- Auth + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE raised boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN PERFORM public.kwenta_contacts_with_balances();
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  PERFORM test.assert_true(raised, 'contacts RPC refuses an unauthenticated caller');

  raised := false;
  BEGIN PERFORM public.kwenta_balances_overview();
  EXCEPTION WHEN OTHERS THEN raised := true; END;
  PERFORM test.assert_true(raised, 'overview RPC refuses an unauthenticated caller');

  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_canonical_peer_ids(uuid)', 'EXECUTE'),
    'the viewer-argument peer function must not be client-callable');
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_related_profile_ids(uuid)', 'EXECUTE'),
    'the viewer-argument related-ids function must not be client-callable');
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_contacts_with_balances()', 'EXECUTE'),
    'the auth.uid()-scoped contacts RPC is the client surface');
  PERFORM test.assert_true(
    has_function_privilege('authenticated', 'public.kwenta_balances_overview()', 'EXECUTE'),
    'the auth.uid()-scoped overview RPC is the client surface');

  PERFORM test.note('054 grants: only auth.uid()-scoped wrappers are client-callable');
END;
$$;
