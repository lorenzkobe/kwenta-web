-- Migration 051 must be a pure refactor.
--
-- It lifts each table's row set out of `kwenta_build_pull_bundle` into `kwenta_pull_rows_*`
-- functions so the new read endpoints can share one copy of the privacy predicates. If that
-- extraction changed ANY row set, it changed who can see what — so this file pins the current
-- bundle against a verbatim copy of the 049 body over a fixture built to exercise every branch.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- The pre-051 implementation, copied verbatim from 049:226-327. Do not "tidy" this: its whole
-- value is being an independent second opinion. If 049's predicates are ever intentionally
-- changed, this reference and the assertions below should be updated in the same commit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.bundle_049_reference(p_since timestamptz, uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profiles',
    (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
     FROM public.profiles p
     WHERE p.updated_at > p_since
       AND (
         p.id = uid
         OR (p.is_local IS TRUE AND p.owner_id = uid)
         OR (p.is_local IS TRUE AND p.linked_profile_id = uid AND p.is_deleted IS FALSE)
       )),
    'groups',
    (SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
     FROM public.groups g
     WHERE g.id IN (
         SELECT gm.group_id FROM public.group_members gm
         WHERE gm.user_id = uid
       )
       AND (
         g.updated_at > p_since
         OR EXISTS (
           SELECT 1 FROM public.group_members gm2
           WHERE gm2.group_id = g.id
             AND gm2.user_id = uid
             AND gm2.updated_at > p_since
         )
       )),
    'group_members',
    (SELECT COALESCE(jsonb_agg(to_jsonb(gm)), '[]'::jsonb)
     FROM public.group_members gm
     WHERE gm.updated_at > p_since
       AND (
         gm.user_id = uid
         OR gm.group_id IN (
           SELECT m.group_id FROM public.group_members m
           WHERE m.user_id = uid AND m.is_deleted IS FALSE
         )
       )),
    'bills',
    (SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
     FROM public.bills_for_sync(p_since) AS b),
    'bill_items',
    (SELECT COALESCE(jsonb_agg(to_jsonb(bi)), '[]'::jsonb)
     FROM public.bill_items bi
     WHERE bi.updated_at > p_since
       AND bi.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())),
    'item_splits',
    (SELECT COALESCE(jsonb_agg(to_jsonb(ish)), '[]'::jsonb)
     FROM public.item_splits ish
     WHERE ish.updated_at > p_since
       AND ish.item_id IN (
         SELECT bi2.id FROM public.bill_items bi2
         WHERE bi2.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())
       )),
    'settlements',
    (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
     FROM (
       SELECT s.*
       FROM public.settlements s
       WHERE s.updated_at > p_since
         AND s.group_id IS NOT NULL
         AND s.group_id IN (
           SELECT gm.group_id FROM public.group_members gm
           WHERE gm.user_id = uid
         )
       UNION ALL
       SELECT s2.*
       FROM public.settlements s2
       WHERE s2.updated_at > p_since
         AND s2.group_id IS NULL
         AND (
           s2.from_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
           OR s2.to_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
         )
     ) AS s),
    'activity_log',
    (SELECT COALESCE(jsonb_agg(to_jsonb(al)), '[]'::jsonb)
     FROM public.activity_log al
     WHERE al.updated_at > p_since
       AND (
         al.user_id = uid
         OR (
           al.group_id IS NOT NULL
           AND al.group_id IN (
             SELECT gm.group_id FROM public.group_members gm
             WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
           )
         )
       )),
    'profile_peer_links',
    (SELECT COALESCE(jsonb_agg(to_jsonb(ppl)), '[]'::jsonb)
     FROM public.profile_peer_links ppl
     WHERE ppl.updated_at > p_since
       AND ppl.owner_user_id = uid)
  );
$$;

DO $$
DECLARE
  EPOCH constant timestamptz := '1970-01-01T00:00:00Z';

  alice   uuid;
  bob     uuid;
  carol   uuid;   -- an unrelated third account: nothing of hers may leak into Alice's bundle
  g_ab    uuid;   -- group Alice + Bob
  g_solo  uuid;   -- group Alice left (membership soft-deleted)
  m_solo  uuid;
  g_carol uuid;   -- group Alice was never in
  c_bob   uuid;   -- Alice's local contact, LINKED to Bob's account
  c_dave  uuid;   -- Alice's local contact, never linked
  c_alice uuid;   -- Bob's local contact linked to ALICE (delivered by 049's narrow exception)
  c_priv  uuid;   -- Carol's local contact: must never reach Alice
  peer    uuid;
  b_pers  uuid;
  b_group uuid;
  b_carol uuid;
BEGIN
  -- ---------------- fixture ----------------
  alice := test.new_account('alice@example.com', 'Alice');
  bob   := test.new_account('bob@example.com',   'Bob');
  carol := test.new_account('carol@example.com', 'Carol');

  c_bob   := test.new_contact(alice, 'Bob (contact)', bob);
  c_dave  := test.new_contact(alice, 'Dave');
  c_alice := test.new_contact(bob,   'Alice (contact)', alice);
  c_priv  := test.new_contact(carol, 'Carol''s private contact');

  g_ab := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g_ab, alice, 'Alice');
  PERFORM test.add_member(g_ab, bob,   'Bob');

  -- A group Alice was removed from. Both the group row and her membership stay visible so the
  -- deletion can still propagate to her (migrations 022/024).
  -- The membership id is captured first: a volatile function in a WHERE clause is evaluated
  -- once per scanned row, which inserts a member per row instead of once.
  g_solo := test.new_group(alice, 'Old flat');
  m_solo := test.add_member(g_solo, alice, 'Alice');
  UPDATE public.group_members SET is_deleted = true, updated_at = now() WHERE id = m_solo;

  g_carol := test.new_group(carol, 'Carol only');
  PERFORM test.add_member(g_carol, carol, 'Carol');

  b_pers  := test.new_bill(alice, alice, NULL, 'Dinner', 100.00, ARRAY[alice, c_bob]);
  b_group := test.new_bill(bob,   bob,   g_ab, 'Hotel',  300.00, ARRAY[alice, bob]);
  b_carol := test.new_bill(carol, carol, g_carol, 'Private', 50.00, ARRAY[carol]);

  PERFORM test.new_settlement(c_bob, alice, 40.00);                    -- personal, via contact id
  PERFORM test.new_settlement(bob,   alice, 25.00, g_ab);              -- group
  PERFORM test.new_settlement(carol, carol, 10.00, g_carol);           -- must not reach Alice

  peer := gen_random_uuid();
  INSERT INTO public.profile_peer_links (
    id, owner_user_id, anchor_profile_id, peer_profile_id,
    created_at, updated_at, synced_at, is_deleted, device_id
  ) VALUES (peer, alice, c_dave, c_bob, now(), now(), now(), false, 'test');

  INSERT INTO public.activity_log (
    id, group_id, user_id, entity_type, entity_id, action,
    created_at, updated_at, synced_at, is_deleted, device_id
  ) VALUES
    (gen_random_uuid(), NULL, alice, 'bill', b_pers,  'created', now(), now(), now(), false, 't'),
    (gen_random_uuid(), g_ab, bob,   'bill', b_group, 'created', now(), now(), now(), false, 't'),
    (gen_random_uuid(), g_carol, carol, 'bill', b_carol, 'created', now(), now(), now(), false, 't');

  -- ---------------- equivalence ----------------
  -- The bundle resolves the caller through auth.uid() in places (bills_for_sync,
  -- relevant_bill_ids_for_user), so each comparison must run AS the user being compared.
  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  PERFORM test.assert_bundle_eq(
    public.kwenta_build_pull_bundle(EPOCH, alice),
    test.bundle_049_reference(EPOCH, alice),
    '051 bundle matches the 049 reference for Alice'
  );
  PERFORM test.note('bundle equivalence: Alice');

  PERFORM set_config('request.jwt.claim.sub', bob::text, true);
  PERFORM test.assert_bundle_eq(
    public.kwenta_build_pull_bundle(EPOCH, bob),
    test.bundle_049_reference(EPOCH, bob),
    '051 bundle matches the 049 reference for Bob'
  );
  PERFORM test.note('bundle equivalence: Bob');

  PERFORM set_config('request.jwt.claim.sub', carol::text, true);
  PERFORM test.assert_bundle_eq(
    public.kwenta_build_pull_bundle(EPOCH, carol),
    test.bundle_049_reference(EPOCH, carol),
    '051 bundle matches the 049 reference for Carol'
  );
  PERFORM test.note('bundle equivalence: Carol');

  -- A non-epoch p_since exercises the `updated_at > p_since` branches, which the client no
  -- longer uses but the function still supports (050 replays pass it through).
  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  PERFORM test.assert_bundle_eq(
    public.kwenta_build_pull_bundle(now() + interval '1 hour', alice),
    test.bundle_049_reference(now() + interval '1 hour', alice),
    '051 bundle matches the reference for a future p_since (empty on both sides)'
  );
  PERFORM test.note('bundle equivalence: future p_since');
END;
$$;

-- ---------------------------------------------------------------------------
-- Content assertions. Equivalence alone would also pass if BOTH sides were wrong, so pin the
-- privacy boundary directly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  EPOCH constant timestamptz := '1970-01-01T00:00:00Z';
  alice uuid;
  bob uuid;
  carol uuid;
  c_priv uuid;
  c_alice uuid;
  g_carol uuid;
  bundle jsonb;
  ids uuid[];
BEGIN
  alice := test.new_account('a2@example.com', 'Alice2');
  bob   := test.new_account('b2@example.com', 'Bob2');
  carol := test.new_account('c2@example.com', 'Carol2');

  c_priv  := test.new_contact(carol, 'Carol2 private');
  c_alice := test.new_contact(bob, 'Alice2 as contact', alice);

  g_carol := test.new_group(carol, 'Carol2 group');
  PERFORM test.add_member(g_carol, carol, 'Carol2');
  PERFORM test.new_bill(carol, carol, g_carol, 'Carol2 bill', 80.00, ARRAY[carol]);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  bundle := public.kwenta_build_pull_bundle(EPOCH, alice);

  -- Carol's local contact must not appear in Alice's bundle. This is THE cross-account boundary.
  ids := ARRAY(SELECT (e->>'id')::uuid FROM jsonb_array_elements(bundle->'profiles') e);
  PERFORM test.assert_false(c_priv = ANY(ids), 'another user''s local contact must not be delivered');
  PERFORM test.assert_true(alice = ANY(ids), 'own profile is delivered');

  -- 049's narrow exception: a contact explicitly LINKED to Alice is delivered to Alice even
  -- though Bob owns it, because without it Bob's identity-routed settlements are unresolvable.
  PERFORM test.assert_true(
    c_alice = ANY(ids),
    'a local contact linked to the caller IS delivered (049 exception)'
  );

  -- Nothing from a group Alice is not in.
  PERFORM test.assert_eq(
    jsonb_array_length(bundle->'groups'), 0, 'no groups for a user with no memberships'
  );
  PERFORM test.assert_eq(
    jsonb_array_length(bundle->'bills'), 0, 'no bills from a group the caller is not in'
  );

  PERFORM test.note('privacy boundary: foreign local contacts, groups and bills excluded');
END;
$$;

-- ---------------------------------------------------------------------------
-- The row functions must not be callable by clients: they take `uid` as an argument, so a grant
-- to `authenticated` would let any signed-in user read any other user's rows by passing their id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  bad text[] := '{}';
BEGIN
  FOR fn IN
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'kwenta_pull_rows_%'
  LOOP
    IF has_function_privilege('authenticated', 'public.' || fn || '(timestamptz, uuid)', 'EXECUTE') THEN
      bad := bad || fn;
    END IF;
  END LOOP;

  PERFORM test.assert_eq(
    array_length(bad, 1), NULL,
    'no kwenta_pull_rows_* function is executable by authenticated (leaked: ' || bad::text || ')'
  );

  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'kwenta_pull_rows_%'),
    9,
    'all nine pull-row functions exist'
  );

  PERFORM test.note('grants: pull-row functions are not client-callable');
END;
$$;
