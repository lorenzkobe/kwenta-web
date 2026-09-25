-- 077_profile_and_peer_link_events.test.sql
--
-- Migration 077 makes profile / contact and peer-link changes emit `kwenta_user_events`, so the
-- client can relax its periodic full refresh to 60 minutes (a rename or a merge made on another
-- device used to reach this one only through that refresh). Pinned here:
--   C20  a local contact's change reaches its OWNER; an account's rename reaches the account
--        itself and the owners of LIVE contacts linked to it; a peer-link change reaches its
--        owner_user_id. Each payload carries `row = {table, id, updated_at}` matching the stored
--        row (072's contract, rendered by to_jsonb) and deliberately NO `linked_profile_id` key —
--        an older client treats that key as "full sync" (034's link event), which would undo the
--        point of the change.
--   C21  nobody else hears it: not a stranger, not a co-member of a shared group, not the owner of
--        a soft-deleted linked contact; and a no-op UPDATE emits nothing at all.
-- Entity types are the ones `kwenta_reconcile_user_event` (028) already serves: 'profiles' and
-- 'profile_peer_links'. Events of other entity types (017 renames roster rows, which emits group
-- events to co-members) are out of scope and filtered out below.

SET client_min_messages = notice;

CREATE TEMP TABLE seen_events (id uuid PRIMARY KEY);

CREATE OR REPLACE FUNCTION test.take_events()
RETURNS SETOF public.kwenta_user_events
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    SELECT e.* FROM public.kwenta_user_events e
    WHERE e.id NOT IN (SELECT id FROM seen_events)
      AND e.entity_type IN ('profiles', 'profile_peer_links');
  INSERT INTO seen_events SELECT e.id FROM public.kwenta_user_events e
  ON CONFLICT DO NOTHING;
END;
$$;

/** payload.row names a stored row of p_table whose updated_at renders identically. */
CREATE OR REPLACE FUNCTION test.row_matches(p_payload jsonb, p_table text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE v_stored jsonb;
BEGIN
  IF jsonb_typeof(p_payload -> 'row') IS DISTINCT FROM 'object'
     OR p_payload -> 'row' ->> 'table' IS DISTINCT FROM p_table
     OR p_payload -> 'row' ->> 'id' IS DISTINCT FROM p_id::text THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT to_jsonb(t.updated_at) FROM public.%I t WHERE t.id = $1', p_table)
    INTO v_stored USING p_id;
  RETURN v_stored IS NOT NULL AND v_stored = p_payload -> 'row' -> 'updated_at';
END;
$$;

-- ---------------------------------------------------------------------------
-- C20 + C21: contacts, accounts, peer links.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; dan uuid; eve uuid;
  c_alice uuid; c_cha_dead uuid; c_plain uuid; g uuid; link uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('e77-alice@example.com', 'Alice');
  bob   := test.new_account('e77-bob@example.com', 'Bob');
  cha   := test.new_account('e77-cha@example.com', 'Cha');
  dan   := test.new_account('e77-dan@example.com', 'Dan');
  eve   := test.new_account('e77-eve@example.com', 'Eve');
  c_alice := test.new_contact(alice, 'Bobby', bob);         -- Alice's live contact linked to Bob
  c_cha_dead := test.new_contact(cha, 'B', bob);            -- Cha's contact linked to Bob, deleted below
  UPDATE public.profiles SET is_deleted = true, updated_at = updated_at + interval '1 second' WHERE id = c_cha_dead;
  c_plain := test.new_contact(alice, 'Mika');               -- Alice's unlinked contact
  g := test.new_group(dan, 'Trip');                          -- Dan shares a group with Bob
  PERFORM test.add_member(g, dan, 'Dan');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.take_events();

  -- A contact rename reaches its owner only, carrying the contact row.
  UPDATE public.profiles SET display_name = 'Mika M', updated_at = updated_at + interval '2 seconds' WHERE id = c_plain;
  CREATE TEMP TABLE ev1 AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev1), ARRAY[alice],
    'C20: a contact rename reaches exactly its owner');
  PERFORM test.assert_true((SELECT count(*) = 1 FROM ev1), 'C20: one event for one contact change');
  PERFORM test.assert_true((SELECT bool_and(entity_type = 'profiles' AND entity_id = c_plain
                                             AND test.row_matches(payload, 'profiles', c_plain)) FROM ev1),
    'C20: the contact event is a profiles event carrying the stored contact version');
  PERFORM test.assert_false((SELECT bool_or(payload ? 'linked_profile_id') FROM ev1),
    'C20: the contact event carries no linked_profile_id key');

  -- A new contact reaches its owner.
  PERFORM test.new_contact(alice, 'Nina');
  CREATE TEMP TABLE ev1b AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev1b), ARRAY[alice],
    'C20: a new contact reaches exactly its owner');

  -- An account rename reaches the account and the owners of LIVE contacts linked to it.
  UPDATE public.profiles SET display_name = 'Robert', updated_at = updated_at + interval '3 seconds' WHERE id = bob;
  CREATE TEMP TABLE ev2 AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev2), ARRAY[bob, alice],
    'C20/C21: an account rename reaches itself and Alice (live linked contact) — not Cha (deleted contact), Dan (co-member) or Eve (stranger)');
  PERFORM test.assert_true((SELECT bool_and(entity_type = 'profiles' AND entity_id = bob
                                             AND test.row_matches(payload, 'profiles', bob)) FROM ev2),
    'C20: the account rename carries the stored account version');
  PERFORM test.assert_false((SELECT bool_or(payload ? 'linked_profile_id') FROM ev2),
    'C20: no rename event carries a linked_profile_id key');

  -- An account change to a column nobody displays does not fan out to contact owners.
  UPDATE public.profiles SET device_id = 'other-device', updated_at = updated_at + interval '4 seconds' WHERE id = bob;
  CREATE TEMP TABLE ev3 AS SELECT * FROM test.take_events();
  PERFORM test.assert_false(EXISTS (SELECT 1 FROM ev3 WHERE user_id = alice),
    'C21: an account change outside name/email/avatar/is_deleted does not reach linked-contact owners');

  -- A no-op UPDATE emits nothing to anyone.
  UPDATE public.profiles SET display_name = display_name WHERE id IN (bob, c_plain);
  CREATE TEMP TABLE ev4 AS SELECT * FROM test.take_events();
  PERFORM test.assert_eq((SELECT count(*) FROM ev4), 0::bigint, 'C21: a no-op profiles UPDATE emits no event');

  -- A peer link reaches its owner only, on insert and on update.
  INSERT INTO public.profile_peer_links (id, owner_user_id, anchor_profile_id, peer_profile_id,
    created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (link, alice, c_plain, bob, now(), now(), now(), false, 'test');
  CREATE TEMP TABLE ev5 AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev5), ARRAY[alice],
    'C20/C21: a new peer link reaches exactly its owner (not Bob, the peer)');
  PERFORM test.assert_true((SELECT count(*) = 1 AND bool_and(entity_type = 'profile_peer_links' AND entity_id = link
                                             AND test.row_matches(payload, 'profile_peer_links', link)) FROM ev5),
    'C20: the peer-link event carries the stored link version');

  UPDATE public.profile_peer_links SET is_deleted = true, updated_at = updated_at + interval '5 seconds' WHERE id = link;
  CREATE TEMP TABLE ev6 AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev6), ARRAY[alice],
    'C20: an unmerge (peer-link soft delete) reaches its owner');
  PERFORM test.assert_true((SELECT bool_and(test.row_matches(payload, 'profile_peer_links', link)) FROM ev6),
    'C20: the unmerge event carries the new link version');

  UPDATE public.profile_peer_links SET is_deleted = is_deleted WHERE id = link;
  CREATE TEMP TABLE ev7 AS SELECT * FROM test.take_events();
  PERFORM test.assert_eq((SELECT count(*) FROM ev7), 0::bigint, 'C21: a no-op peer-link UPDATE emits no event');

  -- Linking a contact: 034 still tells the linked account (with its linked_profile_id payload);
  -- 077's event goes to the contact's owner and carries no linked_profile_id key.
  UPDATE public.profiles SET linked_profile_id = eve, updated_at = updated_at + interval '6 seconds' WHERE id = c_plain;
  CREATE TEMP TABLE ev8 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true(EXISTS (SELECT 1 FROM ev8 WHERE user_id = eve AND payload ? 'linked_profile_id'),
    'C20: 034''s link event to the linked account is unchanged');
  PERFORM test.assert_true(EXISTS (SELECT 1 FROM ev8 WHERE user_id = alice AND test.row_matches(payload, 'profiles', c_plain)),
    'C20: the contact owner hears about the link with the contact row');
  PERFORM test.assert_false(EXISTS (SELECT 1 FROM ev8 WHERE user_id = alice AND payload ? 'linked_profile_id'),
    'C20: the owner''s event carries no linked_profile_id key');
  PERFORM test.assert_false(EXISTS (SELECT 1 FROM ev8 WHERE user_id IN (bob, cha, dan)),
    'C21: linking Alice''s contact to Eve tells nobody else');

  PERFORM test.note('077 C20/C21: profile and peer-link events reach exactly their audience');
END;
$$;

-- ---------------------------------------------------------------------------
-- C20: the trigger functions are server-only (rule 5).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
  WHERE tr.tgrelid IN ('public.profiles'::regclass, 'public.profile_peer_links'::regclass)
    AND NOT tr.tgisinternal
    -- Trigger functions that predate 077 (and 076's enforcement trigger) are out of scope here.
    AND p.proname NOT IN ('kwenta_on_profile_linked', 'kwenta_sync_group_member_display_name',
      'kwenta_server_wins_updated_at_guard', 'kwenta_canonicalize_on_link',
      'kwenta_profiles_guard_identity', 'kwenta_enforce_caller_active')
    AND p.proname LIKE 'kwenta_%'
    AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  PERFORM test.assert_eq(n, 0::bigint, 'C20: no kwenta_* trigger function on profiles / peer links is client-executable');
END;
$$;
