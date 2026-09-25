-- Migration 075: the push validators authorize the STORED row, not only the incoming one.
--
-- Every `kwenta_push_*` used to check only the row the caller sent, then `ON CONFLICT (id) DO
-- UPDATE` with no condition on the row already stored. The incoming checks key on columns the
-- caller supplies (`created_by`, `user_id`, `owner_id`), so a row that passes them can still
-- land on an id the caller has no right to. These blocks pin, table by table:
--   * a write to a row the caller may not write is dropped from `applied` and leaves the stored
--     row byte-identical;
--   * key columns (group, parent, owner, creator) cannot move on update;
--   * every write shape the app actually produces is still accepted (operations.ts audit).
-- All writes go through `kwenta_write`, the app's own write RPC, as `test.as_user`.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** One stored row as the client would echo it back. SECURITY DEFINER so a fixture can read a
    row the acting user cannot see — that is the row an attacker would name by id. */
CREATE OR REPLACE FUNCTION test.row_of(p_table text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

/** Push rows through kwenta_write as the current user. `updated_at` is moved forward so the
    021b server-wins guard never decides the outcome — the validator must. */
CREATE OR REPLACE FUNCTION test.w(p_push jsonb, p_submission uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  k text;
  arr jsonb;
  fixed jsonb := '{}'::jsonb;
BEGIN
  FOR k, arr IN SELECT key, value FROM jsonb_each(p_push) LOOP
    fixed := fixed || jsonb_build_object(k, (
      SELECT jsonb_agg(e || jsonb_build_object('updated_at', now() + interval '1 minute'))
      FROM jsonb_array_elements(arr) e));
  END LOOP;
  RETURN public.kwenta_write(fixed, p_submission, '[]'::jsonb);
END;
$$;

/** Push ONE row and report whether the server stored it.

    Since 078 `kwenta_write` raises (P0001, naming the row) instead of returning a partial
    `applied` when a non-activity_log row is refused. That raise, naming THIS row, is reported as
    "not stored"; any other error still propagates and fails the suite. */
CREATE OR REPLACE FUNCTION test.w1(p_table text, p_row jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE res jsonb; st text; msg text;
BEGIN
  BEGIN
    res := test.w(jsonb_build_object(p_table, jsonb_build_array(p_row)));
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    IF msg LIKE 'kwenta_write refused rows:%' || p_table || ':' || (p_row ->> 'id') || '%' THEN
      RETURN false;
    END IF;
    RAISE;
  END;
  RETURN coalesce(res -> 'applied' -> p_table ? (p_row ->> 'id'), false);
END;
$$;

/** A refused write: not in `applied`, and the stored row (or its absence) is unchanged. */
CREATE OR REPLACE FUNCTION test.assert_refused(p_table text, p_row jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  who text := current_setting('request.jwt.claim.sub', true);
  before jsonb;
  ok boolean;
BEGIN
  PERFORM test.as_owner();
  before := test.row_of(p_table, (p_row ->> 'id')::uuid);
  PERFORM test.as_user(who::uuid);
  ok := test.w1(p_table, p_row);
  PERFORM test.as_owner();
  PERFORM test.assert_false(ok, p_what || ' — not reported as applied');
  PERFORM test.assert_eq(test.row_of(p_table, (p_row ->> 'id')::uuid)::text,
                         before::text, p_what || ' — stored row unchanged');
  PERFORM test.as_user(who::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_applied(p_table text, p_row jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM test.assert_true(test.w1(p_table, p_row), p_what);
END;
$$;

GRANT EXECUTE ON FUNCTION test.row_of(text, uuid), test.w(jsonb, uuid), test.w1(text, jsonb),
  test.assert_refused(text, jsonb, text), test.assert_applied(text, jsonb, text) TO authenticated;

/** The first item / split of a bill (fixtures make exactly one item). */
CREATE OR REPLACE FUNCTION test.item_of(p_bill uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS
$$ SELECT id FROM public.bill_items WHERE bill_id = p_bill ORDER BY created_at, id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION test.split_of(p_bill uuid, p_user uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS
$$ SELECT s.id FROM public.item_splits s JOIN public.bill_items i ON i.id = s.item_id
   WHERE i.bill_id = p_bill AND s.user_id = p_user LIMIT 1 $$;

/** A fresh row in the shape the client pushes. */
CREATE OR REPLACE FUNCTION test.bill_row(p_id uuid, p_creator uuid, p_group uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', p_group, 'currency', 'PHP',
    'created_by', p_creator, 'paid_by', p_creator, 'total_amount', 90, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.item_row(p_id uuid, p_bill uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'bill_id', p_bill, 'name', 'thing', 'amount', 90,
    'created_at', now(), 'updated_at', now(), 'synced_at', NULL, 'is_deleted', false,
    'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.split_row(p_id uuid, p_item uuid, p_user uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'item_id', p_item, 'user_id', p_user,
    'split_type', 'equal', 'split_value', 1, 'computed_amount', 45, 'created_at', now(),
    'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.member_row(p_id uuid, p_group uuid, p_user uuid, p_name text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'group_id', p_group, 'user_id', p_user,
    'display_name', p_name, 'joined_at', now(), 'created_at', now(), 'updated_at', now(),
    'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.payment_row(
  p_id uuid, p_group uuid, p_from uuid, p_to uuid, p_amount numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'group_id', p_group, 'bill_id', NULL, 'bundle_id', NULL,
    'from_user_id', p_from, 'to_user_id', p_to, 'amount', p_amount, 'currency', 'PHP',
    'is_settled', true, 'label', '', 'method', NULL, 'created_at', now(), 'updated_at', now(),
    'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.activity_row(p_id uuid, p_group uuid, p_user uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'group_id', p_group, 'user_id', p_user,
    'action', 'created', 'entity_type', 'bill', 'entity_id', gen_random_uuid(),
    'description', 'x', 'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;

GRANT EXECUTE ON FUNCTION test.item_of(uuid), test.split_of(uuid, uuid),
  test.bill_row(uuid, uuid, uuid, text), test.item_row(uuid, uuid),
  test.split_row(uuid, uuid, uuid), test.member_row(uuid, uuid, uuid, text),
  test.payment_row(uuid, uuid, uuid, uuid, numeric), test.activity_row(uuid, uuid, uuid)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- C1. The four reported writes by an unrelated account are refused.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; mallory uuid; g uuid; b uuid; nb uuid := gen_random_uuid();
  nm uuid := gen_random_uuid(); row jsonb; prof jsonb;
BEGIN
  PERFORM test.as_owner();
  alice   := test.new_account('w75a-alice@example.com', 'Alice');
  bob     := test.new_account('w75a-bob@example.com', 'Bob');
  mallory := test.new_account('w75a-mallory@example.com', 'Mallory');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);
  row  := test.row_of('bills', b);
  prof := test.row_of('profiles', alice);

  PERFORM test.as_user(mallory);
  PERFORM test.assert_refused('bills',
    row || jsonb_build_object('title', 'changed', 'created_by', mallory, 'is_deleted', true),
    'another account''s personal bill cannot be rewritten or deleted');
  PERFORM test.assert_refused('group_members', test.member_row(nm, g, mallory, 'M'),
    'a stranger cannot add themselves to a group');
  PERFORM test.assert_refused('bills', test.bill_row(nb, mallory, g, 'planted'),
    'a stranger cannot add a bill to a group they are not in');
  PERFORM test.assert_refused('profiles',
    prof || jsonb_build_object('display_name', 'changed', 'is_local', true, 'owner_id', mallory),
    'another account''s profile cannot be rewritten');

  PERFORM test.note('075 C1: the four reported cross-account writes are refused');
END;
$$;

-- ---------------------------------------------------------------------------
-- C1b. A PERSONAL bill belongs to its creator: a participant (the debtor) cannot delete it,
--      change its items or zero their own share. They can still record a payment against it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; b uuid; pay uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75k-alice@example.com', 'Alice');
  bob   := test.new_account('w75k-bob@example.com', 'Bob');
  b := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  PERFORM test.as_user(bob);
  PERFORM test.assert_refused('bills', test.row_of('bills', b) || '{"is_deleted": true, "title": "gone"}',
    'a participant cannot delete or retitle the creator''s personal bill');
  PERFORM test.assert_refused('bill_items', test.row_of('bill_items', test.item_of(b)) || '{"amount": 1}',
    'nor change its item');
  PERFORM test.assert_refused('item_splits', test.row_of('item_splits', test.split_of(b, bob)) || '{"computed_amount": 0}',
    'nor zero their own share');
  PERFORM test.assert_refused('item_splits', test.split_row(gen_random_uuid(), test.item_of(b), bob),
    'nor add a split');
  PERFORM test.assert_applied('settlements',
    test.payment_row(pay, NULL, bob, alice, 50) || jsonb_build_object('bill_id', b),
    'a participant still records a payment tagged to the bill');

  PERFORM test.note('075 C1b: personal bills are creator-only');
END;
$$;

-- ---------------------------------------------------------------------------
-- C1c. An ACCOUNT profile cannot be linked to another account or turned into someone's contact,
--      through kwenta_write or a direct table update. Renaming yourself still works.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; mallory uuid; n int;
BEGIN
  PERFORM test.as_owner();
  alice   := test.new_account('w75l-alice@example.com', 'Alice');
  mallory := test.new_account('w75l-mallory@example.com', 'Mallory');

  PERFORM test.as_user(mallory);
  PERFORM test.assert_refused('profiles',
    test.row_of('profiles', mallory) || jsonb_build_object('linked_profile_id', alice),
    'an account cannot link itself to another account via kwenta_write');
  PERFORM test.assert_refused('profiles',
    test.row_of('profiles', mallory) || jsonb_build_object('is_local', true, 'owner_id', mallory),
    'an account row cannot be turned local (is_local is frozen)');

  BEGIN
    UPDATE public.profiles SET linked_profile_id = alice WHERE id = mallory;
    PERFORM test.fail('direct link of an account profile', 'insufficient_privilege', 'succeeded');
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.profiles SET is_local = true, owner_id = alice WHERE id = mallory;
    PERFORM test.fail('direct re-owning of an account profile', 'insufficient_privilege', 'succeeded');
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.profiles SET display_name = 'Mal', updated_at = now() + interval '1 minute' WHERE id = mallory;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 1, 'a direct rename of your own profile still applies (AuthProvider)');
  PERFORM test.assert_true((SELECT linked_profile_id IS NULL AND is_local IS FALSE AND owner_id IS NULL
                            FROM public.profiles WHERE id = mallory), 'and nothing else moved');

  PERFORM test.note('075 C1c: account profiles cannot be linked or re-owned');
END;
$$;

-- ---------------------------------------------------------------------------
-- C12. deletePerson: the contact AND a peer link anchored on it go in one submission.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; k uuid; link uuid := gen_random_uuid(); res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75m-alice@example.com', 'Alice');
  bob   := test.new_account('w75m-bob@example.com', 'Bob');
  k := test.new_contact(alice, 'Bobby');
  INSERT INTO public.profile_peer_links (id, owner_user_id, anchor_profile_id, peer_profile_id,
    created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (link, alice, k, bob, now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  res := test.w(jsonb_build_object(
    'profiles', jsonb_build_array(test.row_of('profiles', k) || '{"is_deleted": true}'),
    'profile_peer_links', jsonb_build_array(test.row_of('profile_peer_links', link) || '{"is_deleted": true}')));
  PERFORM test.as_owner();
  PERFORM test.assert_true((SELECT is_deleted FROM public.profiles WHERE id = k), 'contact deleted');
  PERFORM test.assert_true((SELECT is_deleted FROM public.profile_peer_links WHERE id = link),
    'and the link anchored on it, although its anchor was deleted first in the same submission');

  -- A NEW link still needs a live anchor.
  PERFORM test.as_user(alice);
  PERFORM test.assert_refused('profile_peer_links', jsonb_build_object('id', gen_random_uuid(),
    'owner_user_id', alice, 'anchor_profile_id', k, 'peer_profile_id', bob, 'created_at', now(),
    'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test'),
    'a new link on a deleted contact is refused');

  PERFORM test.note('075 C12: deletePerson cascade with a peer link applies whole');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2. Key columns cannot move a stored row where the caller could not create it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; mallory uuid; g uuid; h uuid; gb uuid; ab uuid; mb uuid;
  gp uuid; contact uuid; link uuid; act uuid; bob_m uuid;
BEGIN
  PERFORM test.as_owner();
  alice   := test.new_account('w75b-alice@example.com', 'Alice');
  bob     := test.new_account('w75b-bob@example.com', 'Bob');
  mallory := test.new_account('w75b-mallory@example.com', 'Mallory');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  bob_m := test.add_member(g, bob, 'Bob');
  h := test.new_group(bob, 'H');
  PERFORM test.add_member(h, bob, 'Bob');
  gb := test.new_bill(alice, alice, g, 'Group dinner', 90, ARRAY[alice, bob]);
  ab := test.new_bill(alice, alice, NULL, 'Alice lunch', 90, ARRAY[alice]);
  mb := test.new_bill(mallory, mallory, NULL, 'Mallory lunch', 90, ARRAY[mallory]);
  gp := test.new_settlement(bob, alice, 30, g);
  contact := test.new_contact(alice, 'Cha');
  link := gen_random_uuid();
  INSERT INTO public.profile_peer_links (id, owner_user_id, anchor_profile_id, peer_profile_id,
    created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (link, alice, contact, bob, now(), now(), now(), false, 'test');
  act := gen_random_uuid();
  INSERT INTO public.activity_log (id, group_id, user_id, action, entity_type, entity_id,
    description, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (act, g, alice, 'created', 'bill', gb, 'x', now(), now(), now(), false, 'test');

  -- Bob is an active member of G and H, so the incoming row passes; the move must not.
  PERFORM test.as_user(bob);
  PERFORM test.assert_refused('bills', test.row_of('bills', gb) || jsonb_build_object('group_id', h),
    'a group bill cannot be moved to another group');
  PERFORM test.assert_refused('settlements',
    test.row_of('settlements', gp) || jsonb_build_object('group_id', h),
    'a group payment cannot be moved to another group');
  PERFORM test.assert_refused('settlements',
    test.row_of('settlements', gp) || jsonb_build_object('bill_id', gb),
    'a payment cannot be re-attributed to a bill');
  PERFORM test.assert_refused('group_members',
    test.row_of('group_members', bob_m) || jsonb_build_object('user_id', mallory),
    'a non-creator cannot hand their membership to someone else');
  PERFORM test.assert_refused('group_members',
    test.row_of('group_members', bob_m) || jsonb_build_object('group_id', h),
    'a membership cannot move to another group');
  PERFORM test.assert_refused('activity_log', test.activity_row(gen_random_uuid(), g, alice),
    'a member cannot write a log line authored by someone else');

  PERFORM test.as_user(alice);
  PERFORM test.assert_refused('bills', test.row_of('bills', ab) || jsonb_build_object('created_by', bob),
    'a bill''s creator cannot be changed');
  PERFORM test.assert_refused('profiles',
    test.row_of('profiles', contact) || jsonb_build_object('owner_id', bob),
    'a contact cannot be handed to another owner');

  -- Mallory owns bill mb, so a row naming mb as its parent passes the incoming check.
  PERFORM test.as_user(mallory);
  PERFORM test.assert_refused('bill_items',
    test.row_of('bill_items', test.item_of(ab)) || jsonb_build_object('bill_id', mb),
    'an item cannot be moved onto a bill the caller owns');
  PERFORM test.assert_refused('item_splits',
    test.row_of('item_splits', test.split_of(ab, alice)) || jsonb_build_object('item_id', test.item_of(mb)),
    'a split cannot be moved onto an item the caller owns');
  PERFORM test.assert_refused('groups',
    test.row_of('groups', g) || jsonb_build_object('created_by', mallory),
    'a group cannot be taken over');
  PERFORM test.assert_refused('profiles',
    test.row_of('profiles', contact) || jsonb_build_object('owner_id', mallory),
    'another user''s contact cannot be claimed');
  PERFORM test.assert_refused('activity_log',
    test.row_of('activity_log', act) || jsonb_build_object('user_id', mallory, 'group_id', NULL),
    'another user''s log line cannot be rewritten');

  -- The peer-link validator forces owner_user_id = caller, so the takeover needs an anchor the
  -- caller owns; the stored link is still Alice's.
  PERFORM test.as_owner();
  contact := test.new_contact(mallory, 'Mine');
  PERFORM test.as_user(mallory);
  PERFORM test.assert_refused('profile_peer_links',
    test.row_of('profile_peer_links', link) || jsonb_build_object('anchor_profile_id', contact),
    'another user''s peer link cannot be taken over');

  PERFORM test.note('075 C2: key columns are frozen on update');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3. The write shapes the app produces are still accepted.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; dave uuid; g uuid; gb uuid; res jsonb;
  b uuid := gen_random_uuid(); i uuid := gen_random_uuid();
  ng uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  cm uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75c-alice@example.com', 'Alice');
  bob   := test.new_account('w75c-bob@example.com', 'Bob');
  carol := test.new_account('w75c-carol@example.com', 'Carol');
  dave  := test.new_account('w75c-dave@example.com', 'Dave');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  gb := test.new_bill(alice, alice, g, 'Alice paid', 90, ARRAY[alice, bob]);

  -- createBill, personal.
  PERFORM test.as_user(alice);
  res := test.w(jsonb_build_object(
    'bills', jsonb_build_array(test.bill_row(b, alice, NULL, 'Lunch')),
    'bill_items', jsonb_build_array(test.item_row(i, b)),
    'item_splits', jsonb_build_array(test.split_row(gen_random_uuid(), i, alice),
                                     test.split_row(gen_random_uuid(), i, bob))));
  PERFORM test.assert_eq(jsonb_array_length(res -> 'applied' -> 'item_splits'), 2,
    'createBill (personal): bill, item and both splits stored');

  -- createBill, group, by a member who did not create the group.
  b := gen_random_uuid(); i := gen_random_uuid();
  PERFORM test.as_user(bob);
  res := test.w(jsonb_build_object(
    'bills', jsonb_build_array(test.bill_row(b, bob, g, 'Taxi')),
    'bill_items', jsonb_build_array(test.item_row(i, b)),
    'item_splits', jsonb_build_array(test.split_row(gen_random_uuid(), i, alice),
                                     test.split_row(gen_random_uuid(), i, bob))));
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? b::text
    AND jsonb_array_length(res -> 'applied' -> 'item_splits') = 2,
    'createBill (group, member): all rows stored');

  -- A member edits another member's group bill, its item and a split.
  PERFORM test.as_owner();
  res := jsonb_build_object(
    'bills', jsonb_build_array(test.row_of('bills', gb) || jsonb_build_object('paid_by', bob, 'title', 'Bob paid')),
    'bill_items', jsonb_build_array(test.row_of('bill_items', test.item_of(gb)) || '{"amount": 120}'),
    'item_splits', jsonb_build_array(test.row_of('item_splits', test.split_of(gb, bob)) || '{"computed_amount": 60}'));
  PERFORM test.as_user(bob);
  res := test.w(res);
  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT paid_by FROM public.bills WHERE id = gb), bob,
    'a member can edit a group bill someone else created');
  PERFORM test.assert_money((SELECT amount FROM public.bill_items WHERE id = test.item_of(gb)), 120,
    'and its item');
  PERFORM test.assert_money((SELECT computed_amount FROM public.item_splits WHERE id = test.split_of(gb, bob)), 60,
    'and its split');

  -- The creator adds a member, then removes them.
  PERFORM test.as_user(alice);
  PERFORM test.assert_applied('group_members', test.member_row(cm, g, carol, 'Carol'),
    'the group creator adds a member');
  PERFORM test.assert_applied('group_members',
    test.member_row(cm, g, carol, 'Carol') || '{"is_deleted": true}',
    'the group creator removes a member');

  -- createGroup with its roster, in one submission.
  PERFORM test.as_user(dave);
  res := test.w(jsonb_build_object(
    'groups', jsonb_build_array(jsonb_build_object('id', ng, 'name', 'New', 'currency', 'PHP',
      'created_by', dave, 'invite_code', 'abcdefgh', 'created_at', now(), 'updated_at', now(),
      'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')),
    'group_members', jsonb_build_array(test.member_row(m1, ng, dave, 'Dave'),
                                       test.member_row(m2, ng, carol, 'Carol'))));
  PERFORM test.assert_true(res -> 'applied' -> 'groups' ? ng::text
    AND jsonb_array_length(res -> 'applied' -> 'group_members') = 2,
    'createGroup: group, creator and member stored together');

  PERFORM test.note('075 C3: createBill, member edits, roster changes and createGroup still apply');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4. deleteGroup: the whole cascade in ONE submission, own membership included.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b1 uuid; b2 uuid; s uuid; ts uuid; push jsonb; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75d-alice@example.com', 'Alice');
  bob   := test.new_account('w75d-bob@example.com', 'Bob');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b1 := test.new_bill(alice, alice, g, 'A', 90, ARRAY[alice, bob]);
  b2 := test.new_bill(bob, bob, g, 'B', 60, ARRAY[alice, bob]);
  s  := test.new_settlement(bob, alice, 10, g);
  -- A payment tagged to a bill: its bill is deleted EARLIER in the same submission.
  ts := test.new_settlement(bob, alice, 5, g, b1);

  -- Same order as src/db/operations.ts deleteGroup: memberships (incl. Alice's own) go before
  -- the bills, so the bills are authorized after Alice is no longer an ACTIVE member.
  push := jsonb_build_object(
    'groups', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.groups x WHERE id = g),
    'group_members', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.group_members x WHERE group_id = g),
    'bills', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.bills x WHERE group_id = g),
    'bill_items', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.bill_items x WHERE bill_id IN (b1, b2)),
    'item_splits', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.item_splits x
                    WHERE item_id IN (SELECT id FROM public.bill_items WHERE bill_id IN (b1, b2))),
    'settlements', (SELECT jsonb_agg(to_jsonb(x) || '{"is_deleted": true}') FROM public.settlements x WHERE group_id = g),
    'activity_log', jsonb_build_array(test.activity_row(gen_random_uuid(), g, alice)));

  PERFORM test.as_user(alice);
  res := test.w(push);
  PERFORM test.as_owner();
  PERFORM test.assert_true((SELECT is_deleted FROM public.groups WHERE id = g), 'group deleted');
  PERFORM test.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id = g AND NOT is_deleted), 0::bigint,
    'every membership deleted, the creator''s own included');
  PERFORM test.assert_eq((SELECT count(*) FROM public.bills WHERE group_id = g AND NOT is_deleted), 0::bigint,
    'both bills deleted, including the one another member created');
  PERFORM test.assert_eq((SELECT count(*) FROM public.bill_items WHERE bill_id IN (b1, b2) AND NOT is_deleted), 0::bigint,
    'their items deleted');
  PERFORM test.assert_eq((SELECT count(*) FROM public.item_splits sp JOIN public.bill_items i ON i.id = sp.item_id
                          WHERE i.bill_id IN (b1, b2) AND NOT sp.is_deleted), 0::bigint,
    'their splits deleted');
  PERFORM test.assert_true((SELECT is_deleted FROM public.settlements WHERE id = s), 'the payment deleted');
  PERFORM test.assert_true((SELECT is_deleted FROM public.settlements WHERE id = ts),
    'and the payment tagged to a bill deleted in the same submission');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'applied' -> 'bills'), 2,
    'and all of it reported applied');

  PERFORM test.note('075 C4: deleteGroup cascade applies after the creator''s own membership goes');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5. linkProfileToRemote: the link and every id rewrite it implies.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; erin uuid; k uuid; g uuid; km uuid; gb uuid; ps uuid; res jsonb; push jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75e-alice@example.com', 'Alice');
  bob   := test.new_account('w75e-bob@example.com', 'Bob');
  erin  := test.new_account('w75e-erin@example.com', 'Erin');
  k := test.new_contact(alice, 'Erin (contact)');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  km := test.add_member(g, k, 'Erin');
  -- Bob's bill, paid by Alice's contact, with a split on the contact.
  gb := test.new_bill(bob, k, g, 'Bob logged', 90, ARRAY[bob, k]);
  ps := test.new_settlement(k, alice, 25);

  push := jsonb_build_object(
    'profiles', jsonb_build_array(test.row_of('profiles', k) || jsonb_build_object('linked_profile_id', erin)),
    'group_members', jsonb_build_array(test.row_of('group_members', km) || jsonb_build_object('user_id', erin)),
    'bills', jsonb_build_array(test.row_of('bills', gb) || jsonb_build_object('paid_by', erin)),
    'item_splits', jsonb_build_array(test.row_of('item_splits', test.split_of(gb, k)) || jsonb_build_object('user_id', erin)),
    'settlements', jsonb_build_array(test.row_of('settlements', ps) || jsonb_build_object('from_user_id', erin)));

  PERFORM test.as_user(alice);
  res := test.w(push);
  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT linked_profile_id FROM public.profiles WHERE id = k), erin, 'contact linked');
  PERFORM test.assert_eq((SELECT user_id FROM public.group_members WHERE id = km), erin,
    'the creator rewrites the contact''s membership to the account');
  PERFORM test.assert_eq((SELECT paid_by FROM public.bills WHERE id = gb), erin,
    'paid_by rewritten on a group bill another member created');
  PERFORM test.assert_true(EXISTS (SELECT 1 FROM public.item_splits WHERE item_id = test.item_of(gb) AND user_id = erin),
    'the split on that bill rewritten');
  PERFORM test.assert_eq((SELECT from_user_id FROM public.settlements WHERE id = ps), erin,
    'the personal payment''s party rewritten');

  PERFORM test.note('075 C5: linkProfileToRemote rewrites all land');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6. Payments: any active member manages a group payment; a party manages a personal one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; mallory uuid; g uuid;
  gp uuid := gen_random_uuid(); pp uuid := gen_random_uuid(); row jsonb;
BEGIN
  PERFORM test.as_owner();
  alice   := test.new_account('w75f-alice@example.com', 'Alice');
  bob     := test.new_account('w75f-bob@example.com', 'Bob');
  carol   := test.new_account('w75f-carol@example.com', 'Carol');
  mallory := test.new_account('w75f-mallory@example.com', 'Mallory');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');

  PERFORM test.as_user(carol);
  row := test.payment_row(gp, g, bob, alice, 40);
  PERFORM test.assert_applied('settlements', row, 'a member records a payment between two others');
  PERFORM test.assert_applied('settlements', row || '{"amount": 45, "method": "Cash"}', 'and edits it');
  PERFORM test.assert_applied('settlements', row || '{"is_deleted": true}', 'and deletes it');

  PERFORM test.as_user(alice);
  row := test.payment_row(pp, NULL, alice, bob, 20);
  PERFORM test.assert_applied('settlements', row, 'a personal payment by its payer');
  PERFORM test.as_user(bob);
  PERFORM test.assert_applied('settlements', row || '{"amount": 25}', 'edited by the other party');
  PERFORM test.as_user(mallory);
  PERFORM test.assert_refused('settlements', row || '{"is_deleted": true}',
    'a non-party cannot delete a personal payment');
  PERFORM test.assert_refused('settlements', row || jsonb_build_object('to_user_id', mallory, 'amount', 1),
    'nor claim it by naming themselves as a party');

  PERFORM test.note('075 C6: payments by members and parties still apply; others are refused');
END;
$$;

-- ---------------------------------------------------------------------------
-- C7. A removed member no longer writes to the group.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; bob_m uuid; bb uuid; gp uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75g-alice@example.com', 'Alice');
  bob   := test.new_account('w75g-bob@example.com', 'Bob');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  bob_m := test.add_member(g, bob, 'Bob');
  bb := test.new_bill(bob, bob, g, 'Bob''s bill', 90, ARRAY[alice, bob]);
  gp := test.new_settlement(bob, alice, 30, g);
  UPDATE public.group_members SET is_deleted = true WHERE id = bob_m;

  PERFORM test.as_user(bob);
  PERFORM test.assert_refused('bills', test.bill_row(gen_random_uuid(), bob, g, 'after'),
    'no new group bill after removal');
  PERFORM test.assert_refused('bills', test.row_of('bills', bb) || '{"total_amount": 1}',
    'no edit of a group bill, even one they created');
  PERFORM test.assert_refused('bill_items', test.item_row(gen_random_uuid(), bb), 'no new item');
  PERFORM test.assert_refused('item_splits',
    test.row_of('item_splits', test.split_of(bb, alice)) || '{"computed_amount": 0}', 'no split edit');
  PERFORM test.assert_refused('settlements', test.payment_row(gen_random_uuid(), g, bob, alice, 5),
    'no new group payment');
  PERFORM test.assert_refused('settlements', test.row_of('settlements', gp) || '{"is_deleted": true}',
    'no delete of a group payment');
  PERFORM test.assert_refused('group_members', test.row_of('group_members', bob_m) || '{"is_deleted": false}',
    'cannot restore their own membership');

  PERFORM test.note('075 C7: a removed member is refused everywhere in the group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C8. A member renames their own roster entry in someone else's group; a member may leave.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; g uuid; bob_m uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75h-alice@example.com', 'Alice');
  bob   := test.new_account('w75h-bob@example.com', 'Bob');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  bob_m := test.add_member(g, bob, 'Bob');

  PERFORM test.as_user(bob);
  PERFORM test.assert_applied('group_members',
    test.row_of('group_members', bob_m) || '{"display_name": "Robert"}',
    'own display_name in another''s group');
  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT display_name FROM public.group_members WHERE id = bob_m), 'Robert',
    'and it landed');

  PERFORM test.note('075 C8: own roster name still editable');
END;
$$;

-- ---------------------------------------------------------------------------
-- C9. Client roles have no direct write privilege on the synced tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text; r text; p text;
  mallory uuid;
BEGIN
  PERFORM test.as_owner();
  FOREACH t IN ARRAY ARRAY['bills', 'bill_items', 'item_splits', 'settlements', 'activity_log',
                           'groups', 'group_members', 'profile_peer_links'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        PERFORM test.assert_false(has_table_privilege(r, 'public.' || t, p),
          format('%s has no %s on %s', r, p, t));
      END LOOP;
      PERFORM test.assert_true(has_table_privilege(r, 'public.' || t, 'SELECT'),
        format('%s keeps SELECT on %s (RLS still decides which rows)', r, t));
    END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['profiles', 'kwenta_notifications'] LOOP
    PERFORM test.assert_true(has_table_privilege('authenticated', 'public.' || t, 'INSERT')
      AND has_table_privilege('authenticated', 'public.' || t, 'UPDATE'),
      format('authenticated still writes %s directly (under RLS)', t));
    PERFORM test.assert_false(has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE'),
      format('but cannot TRUNCATE %s, which RLS does not govern', t));
  END LOOP;

  -- And an actual attempt, not just the catalog.
  mallory := test.new_account('w75i-mallory@example.com', 'Mallory');
  PERFORM test.as_user(mallory);
  BEGIN
    INSERT INTO public.bills (id, title, created_by, paid_by, total_amount, currency,
      created_at, updated_at, is_deleted, device_id)
    VALUES (gen_random_uuid(), 'direct', mallory, mallory, 1, 'PHP', now(), now(), false, 'x');
    PERFORM test.fail('direct INSERT into bills', 'insufficient_privilege', 'succeeded');
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM test.as_owner();

  PERFORM test.note('075 C9: direct writes on synced tables revoked from client roles');
END;
$$;

-- ---------------------------------------------------------------------------
-- C10. Replaying the same submission applies once and returns the same outcome.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; carol uuid; g uuid; sub uuid := gen_random_uuid();
  cm uuid := gen_random_uuid(); b uuid := gen_random_uuid(); push jsonb; r1 jsonb; r2 jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w75j-alice@example.com', 'Alice');
  carol := test.new_account('w75j-carol@example.com', 'Carol');
  g := test.new_group(alice, 'G');
  PERFORM test.add_member(g, alice, 'Alice');
  push := jsonb_build_object(
    'group_members', jsonb_build_array(test.member_row(cm, g, carol, 'Carol')),
    'bills', jsonb_build_array(test.bill_row(b, alice, g, 'once')));

  PERFORM test.as_user(alice);
  r1 := test.w(push, sub);
  r2 := test.w(push, sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(r2 -> 'applied', r1 -> 'applied', 'a replay reports the original outcome');
  PERFORM test.assert_true(r1 -> 'applied' -> 'group_members' ? cm::text AND r1 -> 'applied' -> 'bills' ? b::text,
    'and that outcome is the write applied');
  PERFORM test.assert_eq((SELECT count(*) FROM public.bills WHERE id = b), 1::bigint, 'one bill');
  PERFORM test.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id = g AND user_id = carol), 1::bigint,
    'one membership');

  -- The same rows again under a NEW submission are an ordinary update of rows Alice may write.
  PERFORM test.as_user(alice);
  r2 := test.w(push, gen_random_uuid());
  PERFORM test.assert_eq(r2 -> 'applied', r1 -> 'applied', 're-sending the rows is still accepted');

  PERFORM test.note('075 C10: replay stays idempotent');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the new helper takes the acting user, so it is server-only (rule 5).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_false(has_function_privilege('authenticated', 'public.kwenta_can_write_group(uuid, uuid)', 'EXECUTE'),
    'kwenta_can_write_group is not client-callable');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_can_write_group(uuid, uuid)', 'EXECUTE'),
    'nor by anon');
  PERFORM test.assert_false(has_function_privilege('authenticated', 'public.kwenta_can_write_bill(uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.kwenta_can_write_bill(uuid, uuid)', 'EXECUTE'),
    'kwenta_can_write_bill is not client-callable');
  PERFORM test.note('075 grants: helpers are service_role only');
END;
$$;
