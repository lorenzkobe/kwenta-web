-- 067_close_identity_cluster.test.sql
--
-- The duplicate-People bug, reproduced from the production shape that revealed it: a viewer's
-- own local contact, manually merged (profile_peer_links) to that person's ACCOUNT, where a
-- THIRD user also keeps a local contact linked to the same account.
--
-- Before 067 the cluster was reachable only by mixing two edge kinds, and the walk followed
-- profile links from the anchor but peer links from everywhere — so expand() disagreed with
-- itself depending on the starting id, and `kwenta_canonical_peer_ids` keyed one human twice.
--
-- The load-bearing assertion is SYMMETRY: y ∈ expand(x) must imply expand(y) = expand(x). A test
-- that only checked "the contact reaches the account" passed on the broken body.

-- ---------------------------------------------------------------------------
-- The cluster is closed: every member expands to the same set
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; other uuid; jello uuid;
  c_jello uuid;   -- Alice's own phonebook row for Jello, deliberately NOT linked
  o_jello uuid;   -- a THIRD user's phonebook row for Jello, linked to the account
  expected uuid[];
BEGIN
  alice := test.new_account('close-alice@example.com', 'Alice');
  other := test.new_account('close-other@example.com', 'Other');
  jello := test.new_account('close-jello@example.com', 'Jello');

  c_jello := test.new_contact(alice, 'Jello');
  o_jello := test.new_contact(other, 'Jello', jello);

  -- Alice merges her contact with the account by hand. This is the ONLY edge joining c_jello to
  -- the rest; o_jello hangs off the account by a profile link Alice did not create.
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, c_jello, jello, now(), now(), now(), false, 'test');

  expected := ARRAY[c_jello, jello, o_jello];

  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(c_jello, alice)), expected,
    'from the contact: a peer link then the account''s own linked contacts'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(jello, alice)), expected,
    'from the account: the same cluster'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(o_jello, alice)), expected,
    'from the third party''s contact: still the same cluster'
  );

  -- The property, stated directly rather than by three hand-written cases.
  PERFORM test.assert_true(
    NOT EXISTS (
      SELECT 1
      FROM public.kwenta_expand_identity(c_jello, alice) m
      WHERE ARRAY(SELECT e.id FROM public.kwenta_expand_identity(m.id, alice) e ORDER BY e.id)
         IS DISTINCT FROM
            ARRAY(SELECT e.id FROM public.kwenta_expand_identity(c_jello, alice) e ORDER BY e.id)
    ),
    'expansion is an equivalence relation: every member expands to the whole cluster'
  );

  -- Soft-deleting the ACCOUNT does not un-say "these are the same person". The old body returned
  -- early on a deleted anchor while the contacts still reached it — that gap IS the asymmetry.
  UPDATE public.profiles SET is_deleted = true WHERE id = jello;
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(jello, alice)), expected,
    'a soft-deleted account still clusters the live contacts that point at it'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(c_jello, alice)), expected,
    'and the view from the contact is unchanged by that'
  );

  PERFORM test.note('expand_identity: profile links and peer links close over ONE graph');
END;
$$;

-- ---------------------------------------------------------------------------
-- The user-visible symptom: one human, ONE row on the People page
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; other uuid; jello uuid;
  c_jello uuid; o_jello uuid; g uuid;
  contacts jsonb;
BEGIN
  alice := test.new_account('people-alice@example.com', 'Alice');
  other := test.new_account('people-other@example.com', 'Other');
  jello := test.new_account('people-jello@example.com', 'Jello');

  c_jello := test.new_contact(alice, 'Jello');
  o_jello := test.new_contact(other, 'Jello', jello);

  -- The canonical key is MIN(cluster), so the two walks only produce DIFFERENT keys when the id
  -- the short walk misses is the smallest one — which is how it presented in production. With
  -- fixture uuids being random, this test would otherwise pass against the broken body roughly
  -- two times in three. Force the third party's contact low, and assert that it really is lowest
  -- so a freak uuid fails loudly instead of quietly weakening the test.
  UPDATE public.profiles SET id = '00000000-0000-4000-8000-000000000001' WHERE id = o_jello;
  o_jello := '00000000-0000-4000-8000-000000000001';
  PERFORM test.assert_true(
    o_jello < c_jello AND o_jello < jello,
    'precondition: the id the broken walk misses must sort lowest'
  );

  -- Both ids must be DISCOVERABLE or there is nothing to duplicate: the contact through
  -- owned_locals, the account through a shared group. This is the production shape.
  g := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, jello, 'Jello');

  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, c_jello, jello, now(), now(), now(), false, 'test');

  PERFORM test.assert_eq(
    (SELECT count(*) FROM public.kwenta_canonical_peer_ids(alice)), 1::bigint,
    'the merged contact and the account are ONE canonical peer'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_canonical_peer_ids(alice)), ARRAY[c_jello],
    'and the representative is Alice''s own contact, so her chosen name shows'
  );

  -- End to end, through the endpoint the People page actually calls, as Alice.
  PERFORM test.as_user(alice);
  contacts := public.kwenta_contacts_with_balances();
  PERFORM test.assert_eq(
    jsonb_array_length(contacts), 1,
    'the People page lists this human exactly once'
  );
  PERFORM test.as_owner();

  PERFORM test.note('canonical peers: a merged contact + account is one People row');
END;
$$;

-- ---------------------------------------------------------------------------
-- What the closure must NOT change
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; jello uuid;
  c_live uuid; c_del uuid; a1 uuid; a2 uuid;
  ghost uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('keep-alice@example.com', 'Alice');
  bob   := test.new_account('keep-bob@example.com', 'Bob');
  jello := test.new_account('keep-jello@example.com', 'Jello');

  c_live := test.new_contact(alice, 'Jello', jello);
  c_del  := test.new_contact(alice, 'Old Jello', jello);
  UPDATE public.profiles SET is_deleted = true WHERE id = c_del;

  -- A soft-deleted contact must drop out from BOTH ends. The edge is gated on the row holding
  -- `linked_profile_id`, so closing the graph must not resurrect it via the reverse arm.
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(jello, alice)), ARRAY[jello, c_live],
    'a soft-deleted contact stays out of the account''s cluster'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(c_del, alice)), ARRAY[c_del],
    'and a soft-deleted contact does not reach the account either'
  );

  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(ghost, alice)), ARRAY[ghost],
    'a missing profile still expands to itself, never to nothing'
  );

  -- Peer links stay PRIVATE to the viewer who made them: 053's invariant (a private merge never
  -- moves a shared group ledger) rests on this, and closing the graph must not widen it.
  a1 := test.new_contact(alice, 'Dup A');
  a2 := test.new_contact(alice, 'Dup B');
  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), alice, a1, a2, now(), now(), now(), false, 'test');

  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, alice)), ARRAY[a1, a2],
    'the viewer sees their own merge'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, bob)), ARRAY[a1],
    'another user never sees Alice''s merge'
  );
  PERFORM test.assert_ids(
    ARRAY(SELECT id FROM public.kwenta_expand_identity(a1, NULL)), ARRAY[a1],
    'no viewer means no peer expansion at all'
  );

  PERFORM test.note('closure preserves soft-delete, missing rows and viewer scoping');
END;
$$;

-- ---------------------------------------------------------------------------
-- Rule 5: it names its viewer, so the viewer must not be able to call it
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_expand_identity(uuid, uuid)', 'EXECUTE'),
    'kwenta_expand_identity must not be executable by authenticated'
  );
  PERFORM test.assert_false(
    has_function_privilege('authenticated', 'public.kwenta_canonical_peer_ids(uuid)', 'EXECUTE'),
    'kwenta_canonical_peer_ids must not be executable by authenticated'
  );
  PERFORM test.note('067: grants unchanged by the replace');
END;
$$;
