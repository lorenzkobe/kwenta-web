-- 080_group_bill_participants_are_members.test.sql
--
-- Migration 080: through kwenta_write, a GROUP bill is refused (SQLSTATE P0001, the whole call
-- rolled back, no kwenta_write_submissions row) when a live split's user or the bill's paid_by
-- never had any group_members row in that group. The client's Dexie roster could lag the
-- server's, which is how a real member got "non-member participant(s)"; the server now decides.
-- Pinned here, from the requirements:
--   C10  a never-member split user, a never-member payer, and an edit that adds a never-member
--        are refused and nothing is stored;
--   C11  an active member, a former (soft-deleted) member, a linked contact on either side of the
--        roster row, a personal bill naming anyone, and a deleted split row naming a never-member
--        all pass;
--   C12  the server-only checker is not executable by authenticated or anon;
--   C16  kwenta_sync is unchanged: the same never-member push is not refused there;
--   C17  a membership row and a bill naming that member in the SAME kwenta_write pass;
--   C19  a bill that ALREADY names a never-member (legacy data) can be re-sent with the same people
--        and have a local contact link-rewritten to its account;
--   C20  an edit of that legacy bill that ADDS another never-member is still refused.
--
-- Hand-made rows: the jsonb push rows below copy the column shape 078's suite uses (and the
-- SyncFields + GroupMember / Bill types in src/types/index.ts). The roster row that holds a
-- LINKED local contact's id (C11) is inserted with test.add_member: that is the shape a contact
-- added to a group before it was linked leaves behind.

SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION test.t80_row(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION test.t80_bill(p_id uuid, p_group uuid, p_creator uuid, p_payer uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', p_group, 'currency', 'PHP',
    'created_by', p_creator, 'paid_by', p_payer, 'total_amount', 90, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t80_item(p_id uuid, p_bill uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'bill_id', p_bill, 'name', 'thing', 'amount', 90,
    'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL, 'is_deleted', false,
    'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t80_split(p_id uuid, p_item uuid, p_user uuid, p_deleted boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'item_id', p_item, 'user_id', p_user,
    'split_type', 'equal', 'split_value', 1, 'computed_amount', 45, 'created_at', now(),
    'updated_at', now() + interval '1 minute', 'synced_at', NULL, 'is_deleted', p_deleted, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t80_member(p_id uuid, p_group uuid, p_user uuid, p_name text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'group_id', p_group, 'user_id', p_user, 'display_name', p_name,
    'joined_at', now(), 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t80_group(p_id uuid, p_creator uuid, p_name text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'name', p_name, 'currency', 'PHP', 'created_by', p_creator,
    'invite_code', substr(md5(p_id::text), 1, 8), 'created_at', now(),
    'updated_at', now() + interval '1 minute', 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t80_submissions(p_id uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.kwenta_write_submissions WHERE submission_id = p_id
$$;
-- kwenta_write as the CURRENT role (call after test.as_user): {state, msg, res}. The inner
-- BEGIN/EXCEPTION is a savepoint, so a refused call leaves exactly what the real rollback leaves.
CREATE OR REPLACE FUNCTION test.t80_write(p_push jsonb, p_sub uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text; msg text;
BEGIN
  BEGIN
    r := public.kwenta_write(p_push, p_sub, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  RETURN jsonb_build_object('state', st, 'msg', msg, 'res', r);
END;
$$;
CREATE OR REPLACE FUNCTION test.t80_bill_push(p_bill jsonb, p_item jsonb, p_splits jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('bills', jsonb_build_array(p_bill), 'bill_items', jsonb_build_array(p_item),
    'item_splits', p_splits)
$$;

GRANT EXECUTE ON FUNCTION test.t80_row(text, uuid), test.t80_bill(uuid, uuid, uuid, uuid, text),
  test.t80_item(uuid, uuid), test.t80_split(uuid, uuid, uuid, boolean),
  test.t80_member(uuid, uuid, uuid, text), test.t80_group(uuid, uuid, text),
  test.t80_submissions(uuid), test.t80_write(jsonb, uuid), test.t80_bill_push(jsonb, jsonb, jsonb)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- C10: a never-member split user sinks the whole write; the same push with a member applies.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; h uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  sub uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80a-alice@example.com', 'Alice');
  bob   := test.new_account('m80a-bob@example.com', 'Bob');
  carol := test.new_account('m80a-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  -- Carol is a member of ANOTHER of Alice's groups: membership is per group, not "shares a group".
  h := test.new_group(alice, 'Office');
  PERFORM test.add_member(h, alice, 'Alice');
  PERFORM test.add_member(h, carol, 'Carol');

  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(nb, g, alice, alice, 'Dinner'), test.t80_item(ni, nb),
    jsonb_build_array(test.t80_split(s1, ni, alice), test.t80_split(s2, ni, carol))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C10: a split naming a never-member is refused with P0001 (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', nb), NULL::jsonb, 'C10: the bill is not stored');
  PERFORM test.assert_eq(test.t80_row('bill_items', ni), NULL::jsonb, 'C10: the item is not stored');
  PERFORM test.assert_eq(test.t80_row('item_splits', s1), NULL::jsonb, 'C10: the member''s split is not stored');
  PERFORM test.assert_eq(test.t80_row('item_splits', s2), NULL::jsonb, 'C10: the never-member''s split is not stored');
  PERFORM test.assert_eq(test.t80_submissions(sub), 0::bigint, 'C10: no submission marker is recorded');

  -- C11 (active member): the same bill naming Bob instead applies, under the SAME submission id.
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(nb, g, alice, alice, 'Dinner'), test.t80_item(ni, nb),
    jsonb_build_array(test.t80_split(s1, ni, alice), test.t80_split(s2, ni, bob))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C11: a bill naming active members is accepted (got: ' || out::text || ')');
  PERFORM test.assert_true(out -> 'res' -> 'applied' -> 'bills' ? nb::text, 'C11: the active-member bill is applied');
  PERFORM test.assert_eq(test.t80_row('item_splits', s2) ->> 'user_id', bob::text, 'C11: the active member''s split is stored');
  PERFORM test.assert_eq(test.t80_submissions(sub), 1::bigint, 'C11: the accepted write records its marker');
  PERFORM test.note('080 C10/C11: never-member split refused and rolled back; active member passes');
END;
$$;

-- ---------------------------------------------------------------------------
-- C10: a never-member PAYER sinks the write even when every split names a member.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  sub uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80b-alice@example.com', 'Alice');
  bob   := test.new_account('m80b-bob@example.com', 'Bob');
  carol := test.new_account('m80b-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(nb, g, alice, carol, 'Hotel'), test.t80_item(ni, nb),
    jsonb_build_array(test.t80_split(s1, ni, alice), test.t80_split(s2, ni, bob))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C10: a never-member paid_by is refused with P0001 (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', nb), NULL::jsonb, 'C10: the bill with a never-member payer is not stored');
  PERFORM test.assert_eq(test.t80_row('item_splits', s1), NULL::jsonb, 'C10: its splits are not stored');
  PERFORM test.assert_eq(test.t80_submissions(sub), 0::bigint, 'C10: no submission marker for the refused payer write');
  PERFORM test.note('080 C10: never-member payer refused');
END;
$$;

-- ---------------------------------------------------------------------------
-- C10: editing an existing group bill to add a never-member rolls back the WHOLE edit.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; b uuid; it uuid;
  s_new uuid := gen_random_uuid(); sub uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80c-alice@example.com', 'Alice');
  bob   := test.new_account('m80c-bob@example.com', 'Bob');
  carol := test.new_account('m80c-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(alice, alice, g, 'Groceries', 100, ARRAY[alice, bob]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;

  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b, g, alice, alice, 'Groceries (edited)'),
    test.t80_item(it, b), jsonb_build_array(test.t80_split(s_new, it, carol))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C10: an edit adding a never-member split is refused with P0001 (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'title', 'Groceries', 'C10: the bill keeps its stored title');
  PERFORM test.assert_money((test.t80_row('bill_items', it) ->> 'amount')::numeric, 100, 'C10: the item keeps its stored amount');
  PERFORM test.assert_eq(test.t80_row('item_splits', s_new), NULL::jsonb, 'C10: the never-member split is not stored');
  PERFORM test.assert_eq(test.t80_submissions(sub), 0::bigint, 'C10: no submission marker for the refused edit');
  PERFORM test.note('080 C10: an edit adding a never-member rolls back entirely');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: a former (soft-deleted) member passes — editing an old bill, and a new bill naming them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; dave uuid; g uuid; b uuid; it uuid; m_dave uuid; sp_a uuid; sp_d uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  n1 uuid := gen_random_uuid(); n2 uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80d-alice@example.com', 'Alice');
  dave  := test.new_account('m80d-dave@example.com', 'Dave');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m_dave := test.add_member(g, dave, 'Dave');
  b := test.new_bill(alice, dave, g, 'Old taxi', 100, ARRAY[alice, dave]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  SELECT id INTO sp_a FROM public.item_splits WHERE item_id = it AND user_id = alice;
  SELECT id INTO sp_d FROM public.item_splits WHERE item_id = it AND user_id = dave;
  -- Dave leaves: removeGroupMember soft-deletes the roster row.
  UPDATE public.group_members SET is_deleted = true, updated_at = now() WHERE id = m_dave;

  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b, g, alice, dave, 'Old taxi (renamed)'),
    test.t80_item(it, b), jsonb_build_array(test.t80_split(sp_a, it, alice), test.t80_split(sp_d, it, dave))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: editing an old bill that names a former member (payer and split) is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'title', 'Old taxi (renamed)', 'C11: the edit of the old bill is stored');

  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(nb, g, alice, dave, 'Late refund'), test.t80_item(ni, nb),
    jsonb_build_array(test.t80_split(n1, ni, alice), test.t80_split(n2, ni, dave))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: a new bill naming a former member is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('item_splits', n2) ->> 'user_id', dave::text, 'C11: the former member''s new split is stored');
  PERFORM test.note('080 C11: former members pass');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: a linked contact passes whichever side of the link the roster row holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; erin uuid; c_erin uuid; g1 uuid; g2 uuid;
  b1 uuid := gen_random_uuid(); i1 uuid := gen_random_uuid(); s1a uuid := gen_random_uuid(); s1e uuid := gen_random_uuid();
  b2 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); s2a uuid := gen_random_uuid(); s2e uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80e-alice@example.com', 'Alice');
  erin  := test.new_account('m80e-erin@example.com', 'Erin');
  c_erin := test.new_contact(alice, 'Erin (contact)', erin);

  -- Roster holds the LOCAL contact id; the bill names Erin's ACCOUNT.
  g1 := test.new_group(alice, 'Roster has contact');
  PERFORM test.add_member(g1, alice, 'Alice');
  PERFORM test.add_member(g1, c_erin, 'Erin');
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b1, g1, alice, erin, 'Ferry'), test.t80_item(i1, b1),
    jsonb_build_array(test.t80_split(s1a, i1, alice), test.t80_split(s1e, i1, erin))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: the account of a linked contact on the roster passes as split and payer (got: ' || out::text || ')');
  PERFORM test.assert_true(test.t80_row('bills', b1) IS NOT NULL, 'C11: the bill naming the linked account is stored');

  -- Roster holds the ACCOUNT id; the bill names Alice's local contact linked to it.
  g2 := test.new_group(alice, 'Roster has account');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, erin, 'Erin');
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b2, g2, alice, c_erin, 'Bus'), test.t80_item(i2, b2),
    jsonb_build_array(test.t80_split(s2a, i2, alice), test.t80_split(s2e, i2, c_erin))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: a linked contact whose account is on the roster passes as split and payer (got: ' || out::text || ')');
  -- 042 canonicalizes on store; pinned so the check above is known to be judging the stored id.
  PERFORM test.assert_eq(test.t80_row('item_splits', s2e) ->> 'user_id', erin::text,
    'C11: the contact-named split is stored under the account id');
  PERFORM test.note('080 C11: linked contacts pass in both directions');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: personal bills and deleted split rows are outside the rule.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid;
  pb uuid := gen_random_uuid(); pi uuid := gen_random_uuid(); ps1 uuid := gen_random_uuid(); ps2 uuid := gen_random_uuid();
  gb uuid := gen_random_uuid(); gi uuid := gen_random_uuid();
  gs1 uuid := gen_random_uuid(); gs2 uuid := gen_random_uuid(); gs_dead uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80f-alice@example.com', 'Alice');
  bob   := test.new_account('m80f-bob@example.com', 'Bob');
  carol := test.new_account('m80f-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  -- Personal bill (group_id null) naming an account Alice shares no group with.
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(pb, NULL, alice, alice, 'Coffee'), test.t80_item(pi, pb),
    jsonb_build_array(test.t80_split(ps1, pi, alice), test.t80_split(ps2, pi, carol))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: a personal bill naming anyone is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('item_splits', ps2) ->> 'user_id', carol::text, 'C11: the personal split is stored');

  -- Group bill whose only never-member row is a DELETED split.
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(gb, g, alice, alice, 'Snacks'), test.t80_item(gi, gb),
    jsonb_build_array(test.t80_split(gs1, gi, alice), test.t80_split(gs2, gi, bob),
                      test.t80_split(gs_dead, gi, carol, true))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C11: a deleted split naming a never-member does not refuse the bill (got: ' || out::text || ')');
  PERFORM test.assert_true(test.t80_row('bills', gb) IS NOT NULL, 'C11: the bill with a deleted never-member split is stored');
  PERFORM test.note('080 C11: personal bills and deleted splits unaffected');
END;
$$;

-- ---------------------------------------------------------------------------
-- C17: membership rows and a bill naming them in ONE kwenta_write pass (judged on stored rows).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; frank uuid; gina uuid; g uuid;
  m_frank uuid := gen_random_uuid();
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  g2 uuid := gen_random_uuid(); m2a uuid := gen_random_uuid(); m2g uuid := gen_random_uuid();
  b2 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid(); t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80g-alice@example.com', 'Alice');
  frank := test.new_account('m80g-frank@example.com', 'Frank');
  gina  := test.new_account('m80g-gina@example.com', 'Gina');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');

  -- The creator adds Frank and bills him in the same call.
  PERFORM test.as_user(alice);
  out := test.t80_write(
    test.t80_bill_push(test.t80_bill(nb, g, alice, frank, 'Gas'), test.t80_item(ni, nb),
      jsonb_build_array(test.t80_split(s1, ni, alice), test.t80_split(s2, ni, frank)))
    || jsonb_build_object('group_members', jsonb_build_array(test.t80_member(m_frank, g, frank, 'Frank'))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C17: a member added in the same write may be billed (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('group_members', m_frank) ->> 'user_id', frank::text, 'C17: the membership row is stored');
  PERFORM test.assert_eq(test.t80_row('bills', nb) ->> 'paid_by', frank::text, 'C17: the bill paid by the new member is stored');

  -- The whole group, its roster and its first bill in one call.
  PERFORM test.as_user(alice);
  out := test.t80_write(
    test.t80_bill_push(test.t80_bill(b2, g2, alice, alice, 'Welcome dinner'), test.t80_item(i2, b2),
      jsonb_build_array(test.t80_split(t1, i2, alice), test.t80_split(t2, i2, gina)))
    || jsonb_build_object('groups', jsonb_build_array(test.t80_group(g2, alice, 'New group')),
         'group_members', jsonb_build_array(test.t80_member(m2a, g2, alice, 'Alice'), test.t80_member(m2g, g2, gina, 'Gina'))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C17: a new group, its roster and a bill naming that roster in one write pass (got: ' || out::text || ')');
  PERFORM test.assert_true(test.t80_row('item_splits', t2) IS NOT NULL, 'C17: the new member''s split is stored');
  PERFORM test.note('080 C17: same-write membership counts');
END;
$$;

-- ---------------------------------------------------------------------------
-- C16: kwenta_sync is unchanged — the same never-member push is not refused there.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  res jsonb; st text; msg text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80h-alice@example.com', 'Alice');
  bob   := test.new_account('m80h-bob@example.com', 'Bob');
  carol := test.new_account('m80h-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.as_user(alice);
  BEGIN
    res := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz,
      test.t80_bill_push(test.t80_bill(nb, g, alice, carol, 'Replay'), test.t80_item(ni, nb),
        jsonb_build_array(test.t80_split(s1, ni, alice), test.t80_split(s2, ni, carol))),
      gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, NULL::text, 'C16: kwenta_sync does not raise on a never-member push (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C16: kwenta_sync applies the bill as before');
  PERFORM test.assert_true(res -> 'applied' -> 'item_splits' ? s2::text, 'C16: kwenta_sync applies the never-member split as before');
  PERFORM test.assert_eq(test.t80_row('bills', nb) ->> 'paid_by', carol::text, 'C16: kwenta_sync stores the bill unchanged');
  PERFORM test.note('080 C16: kwenta_sync unchanged');
END;
$$;

-- ---------------------------------------------------------------------------
-- C12: the checker is server-only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; st text;
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_false(has_function_privilege('authenticated', 'public.kwenta_group_bill_non_members(jsonb, jsonb)', 'EXECUTE'),
    'C12: authenticated cannot execute kwenta_group_bill_non_members');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_group_bill_non_members(jsonb, jsonb)', 'EXECUTE'),
    'C12: anon cannot execute kwenta_group_bill_non_members');

  alice := test.new_account('m80i-alice@example.com', 'Alice');
  PERFORM test.as_user(alice);
  BEGIN
    PERFORM public.kwenta_group_bill_non_members('{}'::jsonb, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C12: a signed-in user calling the checker gets permission denied');
  PERFORM test.note('080 C12: checker is server-only');
END;
$$;

-- ---------------------------------------------------------------------------
-- C19 / C20: legacy bills that already name a never-member. The judge covers only people a write ADDS.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; dora uuid; g uuid; b uuid; it uuid; sp_a uuid; sp_c uuid;
  n1 uuid := gen_random_uuid(); n2 uuid := gen_random_uuid(); n3 uuid := gen_random_uuid();
  sub uuid := gen_random_uuid();
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80j-alice@example.com', 'Alice');
  bob   := test.new_account('m80j-bob@example.com', 'Bob');
  carol := test.new_account('m80j-carol@example.com', 'Carol');
  dora  := test.new_account('m80j-dora@example.com', 'Dora');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  -- Legacy row: seeded as the owner, the way the pre-guard client stored it. Carol never had a roster row.
  b := test.new_bill(alice, carol, g, 'Legacy', 100, ARRAY[alice, carol]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  SELECT id INTO sp_a FROM public.item_splits WHERE item_id = it AND user_id = alice;
  SELECT id INTO sp_c FROM public.item_splits WHERE item_id = it AND user_id = carol;

  -- C19 (a): the same people re-sent as NEW split rows under a new title (what updateBill does).
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b, g, alice, carol, 'Legacy (renamed)'),
    test.t80_item(it, b), jsonb_build_array(test.t80_split(n1, it, alice), test.t80_split(n2, it, carol))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C19: re-sending the same people of a bill that names a never-member is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'title', 'Legacy (renamed)', 'C19: the edit is stored');
  PERFORM test.assert_eq(test.t80_row('item_splits', n2) ->> 'user_id', carol::text, 'C19: the never-member split is stored as before');

  -- C20: the same legacy bill, edited to ADD a second never-member (Dora), is refused whole.
  sub := gen_random_uuid();
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b, g, alice, carol, 'Legacy (again)'),
    test.t80_item(it, b), jsonb_build_array(test.t80_split(n1, it, alice), test.t80_split(n2, it, carol),
                                            test.t80_split(n3, it, dora))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C20: adding a second never-member to a legacy bill is refused with P0001 (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'title', 'Legacy (renamed)', 'C20: the bill keeps its stored title');
  PERFORM test.assert_eq(test.t80_row('item_splits', n3), NULL::jsonb, 'C20: the added never-member split is not stored');
  PERFORM test.assert_eq(test.t80_submissions(sub), 0::bigint, 'C20: no submission marker for the refused edit');

  -- C20: replacing the legacy person by a different never-member is an addition too.
  PERFORM test.as_user(alice);
  out := test.t80_write(test.t80_bill_push(test.t80_bill(b, g, alice, alice, 'Swap'),
    test.t80_item(it, b), jsonb_build_array(test.t80_split(n1, it, alice), test.t80_split(n3, it, dora))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C20: swapping the legacy never-member for another is refused (got: ' || out::text || ')');
  PERFORM test.note('080 C19/C20: legacy never-members pass only when already on the bill');
END;
$$;

-- C19 (b): linkProfileToRemote rewrites a local contact's splits and payer to its account in ONE
-- write that also carries the link. Neither the contact nor the account ever had a roster row.
DO $$
DECLARE
  alice uuid; erin uuid; c_erin uuid; g uuid; b uuid; it uuid; sp_e uuid;
  contact jsonb;
  out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('m80k-alice@example.com', 'Alice');
  erin  := test.new_account('m80k-erin@example.com', 'Erin');
  c_erin := test.new_contact(alice, 'Erin (contact)');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  b := test.new_bill(alice, c_erin, g, 'Legacy ferry', 100, ARRAY[alice, c_erin]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  SELECT id INTO sp_e FROM public.item_splits WHERE item_id = it AND user_id = c_erin;
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'paid_by', c_erin::text, 'C19: setup, the legacy payer is the unlinked contact');

  contact := test.t80_row('profiles', c_erin)
    || jsonb_build_object('linked_profile_id', erin, 'updated_at', now() + interval '1 minute', 'synced_at', NULL);
  PERFORM test.as_user(alice);
  out := test.t80_write(
    jsonb_build_object(
      'profiles', jsonb_build_array(contact),
      'bills', jsonb_build_array(test.t80_bill(b, g, alice, erin, 'Legacy ferry')),
      'item_splits', jsonb_build_array(test.t80_split(sp_e, it, erin))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text,
    'C19: a link rewrite of a legacy never-member contact to its account is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t80_row('profiles', c_erin) ->> 'linked_profile_id', erin::text, 'C19: the link is stored');
  PERFORM test.assert_eq(test.t80_row('bills', b) ->> 'paid_by', erin::text, 'C19: the payer now names the account');
  PERFORM test.assert_eq(test.t80_row('item_splits', sp_e) ->> 'user_id', erin::text, 'C19: the split now names the account');
  PERFORM test.note('080 C19: link rewrite of a legacy never-member passes');
END;
$$;
