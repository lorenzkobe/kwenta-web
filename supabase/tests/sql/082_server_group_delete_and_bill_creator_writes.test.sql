-- 082_server_group_delete_and_bill_creator_writes.test.sql
--
-- Migration 082, written from the requirements (the run's case table), blind to the migration:
--   C1  kwenta_delete_group by the group's creator soft-deletes the group, every membership, every
--       live bill of the group with its items and splits, and every live group settlement, in ONE
--       call, including bills other members created; nothing outside the group moves; the result
--       is kwenta_write's echo shape (per-table arrays of the touched rows);
--   C2  a non-creator member, a removed member, a stranger and an inactive creator are refused and
--       nothing changes;
--   C3  a second call on a deleted group returns without error and changes nothing, echoing only the
--       group and its roster; a former member who created the bill and is party to the payment
--       still receives the deleted rows in their pull bundle (024);
--   C4  stamps are GREATEST(now(), updated_at + 1us): a future-dated stored row is still deleted
--       (021b would otherwise keep it); an already-deleted settlement is not touched; exactly one
--       activity_log line, in the shape the client's deleteGroup writes;
--   C5  kwenta_delete_group(uuid) is executable by authenticated, not by anon;
--   C6  a group bill (row, items, splits) is written only by its creator while an active member;
--       another member's edit is refused; createBill by any member still passes;
--   C11 re-adding a removed member through kwenta_write with the EXISTING row id revives it;
--   C12 the group creator may soft-delete another member's group bill (row, items, splits), but
--       not edit it;
--   C13 an active member's id-only rewrite (split user_id / bill paid_by -> the canonical id of the
--       stored value) on another member's bill is accepted; the same rewrite plus anything else,
--       or a rewrite to a non-canonical id, is refused;
--   C14 linking a contact whose account already has a membership row in the group (live or
--       soft-deleted) never raises 23505: a live local row revives the account row and is
--       soft-deleted, a deleted local row is left alone;
--   C15 kwenta_delete_group also deletes live items/splits left under an already-deleted bill.
--   C19 the group creator's soft-delete of another member's bill, item or split is accepted only
--       once the stored group is deleted (the old client's cascade) and only changes is_deleted;
--   C20 the member id-only exception never lets the caller choose updated_at;
--   C21 no live bill, item, split or payment can be written into a deleted group, by anyone;
--   C22 kwenta_delete_group on a deleted group returns the group's current rows, changing nothing;
--   C23 kwenta_group_open is VOLATILE (it takes the group row FOR SHARE; the two-session race was
--       reproduced by the reviewer, the harness runs one session);
--   C26 an edit of a membership already live under a deleted group (a rename) applies; a revive does not;
--   C25 no live membership is written into a deleted group (push or link revive);
--   C24 deleting the group sweeps every live child, whichever way it is deleted: the old client's
--       kwenta_write cascade, a kwenta_sync replay of the group row alone, kwenta_delete_group, and
--       a second kwenta_delete_group cleans leftovers; the event fan-out still reaches members.
--
-- Rows: every push row for an EXISTING row is the stored row itself (to_jsonb of the table row,
-- the shape the pull bundle hands the client) with the edited columns overlaid. Hand-made rows are
-- only the NEW bill/item/splits in C6 (createBill), which copy 075's suite's column shape.
-- activity_log's action/entity_type values come from 001's CHECK; the line's shape (group_id =
-- entity_id = the group, action 'deleted', entity_type 'group') is what src/db/operations.ts
-- deleteGroup writes today.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.t82_row(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

/** Everything a group deletion could touch, as one comparable text value. */
CREATE OR REPLACE FUNCTION test.t82_state(p_group uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT jsonb_build_object(
    'groups', (SELECT to_jsonb(x) FROM public.groups x WHERE x.id = p_group),
    'group_members', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.group_members x WHERE x.group_id = p_group),
    'bills', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.bills x WHERE x.group_id = p_group),
    'bill_items', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.bill_items x
                   WHERE x.bill_id IN (SELECT id FROM public.bills WHERE group_id = p_group)),
    'item_splits', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.item_splits x
                    WHERE x.item_id IN (SELECT i.id FROM public.bill_items i JOIN public.bills b ON b.id = i.bill_id
                                        WHERE b.group_id = p_group)),
    'settlements', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.settlements x WHERE x.group_id = p_group),
    'activity_log', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.activity_log x
                     WHERE x.group_id = p_group OR x.entity_id = p_group)
  )::text
$$;

/** Live rows of each kind under a group, owner's view. */
CREATE OR REPLACE FUNCTION test.t82_live(p_group uuid, p_kind text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n bigint;
BEGIN
  IF p_kind = 'group_members' THEN
    SELECT count(*) INTO n FROM public.group_members WHERE group_id = p_group AND NOT is_deleted;
  ELSIF p_kind = 'bills' THEN
    SELECT count(*) INTO n FROM public.bills WHERE group_id = p_group AND NOT is_deleted;
  ELSIF p_kind = 'bill_items' THEN
    SELECT count(*) INTO n FROM public.bill_items i JOIN public.bills b ON b.id = i.bill_id
    WHERE b.group_id = p_group AND NOT i.is_deleted;
  ELSIF p_kind = 'item_splits' THEN
    SELECT count(*) INTO n FROM public.item_splits s JOIN public.bill_items i ON i.id = s.item_id
    JOIN public.bills b ON b.id = i.bill_id WHERE b.group_id = p_group AND NOT s.is_deleted;
  ELSIF p_kind = 'settlements' THEN
    SELECT count(*) INTO n FROM public.settlements WHERE group_id = p_group AND NOT is_deleted;
  ELSE
    RAISE EXCEPTION 'unknown kind %', p_kind;
  END IF;
  RETURN n;
END;
$$;

/** kwenta_delete_group as the CURRENT role: {state, msg, res}. Dynamic so this file loads before
    the function exists; the inner block is a savepoint, so a refusal leaves what a rollback does. */
CREATE OR REPLACE FUNCTION test.t82_del(p_group uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text; msg text;
BEGIN
  BEGIN
    EXECUTE 'SELECT to_jsonb(public.kwenta_delete_group($1))' INTO r USING p_group;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  RETURN jsonb_build_object('state', st, 'msg', msg, 'res', r);
END;
$$;

/** The ids in one echo array. */
CREATE OR REPLACE FUNCTION test.t82_ids(p_arr jsonb)
RETURNS uuid[] LANGUAGE sql AS $$
  SELECT COALESCE(ARRAY(SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_arr) = 'array' THEN p_arr ELSE '[]'::jsonb END) e), '{}')
$$;

/** Push through kwenta_write as the current user, moving updated_at forward so 021b never decides
    the outcome — the validator must. */
CREATE OR REPLACE FUNCTION test.t82_w(p_push jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text; arr jsonb; fixed jsonb := '{}'::jsonb;
BEGIN
  FOR k, arr IN SELECT key, value FROM jsonb_each(p_push) LOOP
    fixed := fixed || jsonb_build_object(k, (
      SELECT jsonb_agg(e || jsonb_build_object('updated_at', now() + interval '1 minute'))
      FROM jsonb_array_elements(arr) e));
  END LOOP;
  RETURN public.kwenta_write(fixed, gen_random_uuid(), '[]'::jsonb);
END;
$$;

/** Push and report {state, msg, res} instead of raising. */
CREATE OR REPLACE FUNCTION test.t82_try(p_push jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text; msg text;
BEGIN
  BEGIN
    r := test.t82_w(p_push);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  RETURN jsonb_build_object('state', st, 'msg', msg, 'res', r);
END;
$$;

/** One-row push: stored = applied without error and the id reported in `applied`. A refusal is
    078's P0001 'kwenta_write refused rows: <table>:<id>'; any other error propagates. */
CREATE OR REPLACE FUNCTION test.t82_w1(p_table text, p_row jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE res jsonb; msg text;
BEGIN
  BEGIN
    res := test.t82_w(jsonb_build_object(p_table, jsonb_build_array(p_row)));
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg LIKE 'kwenta_write refused rows:%' || p_table || ':' || (p_row ->> 'id') || '%' THEN
      RETURN false;
    END IF;
    RAISE;
  END;
  RETURN COALESCE(res -> 'applied' -> p_table ? (p_row ->> 'id'), false);
END;
$$;

CREATE OR REPLACE FUNCTION test.t82_refused(p_table text, p_row jsonb, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE who text := current_setting('request.jwt.claim.sub', true); before text; ok boolean;
BEGIN
  PERFORM test.as_owner();
  before := test.t82_row(p_table, (p_row ->> 'id')::uuid)::text;
  PERFORM test.as_user(who::uuid);
  ok := test.t82_w1(p_table, p_row);
  PERFORM test.as_owner();
  PERFORM test.assert_false(ok, p_what || ' (refused: not applied)');
  PERFORM test.assert_eq(test.t82_row(p_table, (p_row ->> 'id')::uuid)::text, before,
    p_what || ' (refused: stored row unchanged)');
  PERFORM test.as_user(who::uuid);
END;
$$;

CREATE OR REPLACE FUNCTION test.t82_applied(p_table text, p_row jsonb, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.assert_true(test.t82_w1(p_table, p_row), p_what);
END;
$$;

CREATE OR REPLACE FUNCTION test.t82_item(p_bill uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS
$$ SELECT id FROM public.bill_items WHERE bill_id = p_bill ORDER BY created_at, id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION test.t82_split(p_bill uuid, p_user uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER AS
$$ SELECT s.id FROM public.item_splits s JOIN public.bill_items i ON i.id = s.item_id
   WHERE i.bill_id = p_bill AND s.user_id = p_user LIMIT 1 $$;

CREATE OR REPLACE FUNCTION test.t82_new_bill(p_id uuid, p_creator uuid, p_group uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', p_group, 'currency', 'PHP',
    'created_by', p_creator, 'paid_by', p_creator, 'total_amount', 90, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t82_new_item(p_id uuid, p_bill uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'bill_id', p_bill, 'name', 'thing', 'amount', 90,
    'created_at', now(), 'updated_at', now(), 'synced_at', NULL, 'is_deleted', false,
    'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t82_new_split(p_id uuid, p_item uuid, p_user uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'item_id', p_item, 'user_id', p_user,
    'split_type', 'equal', 'split_value', 1, 'computed_amount', 45, 'created_at', now(),
    'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;

GRANT EXECUTE ON FUNCTION test.t82_row(text, uuid), test.t82_state(uuid), test.t82_live(uuid, text),
  test.t82_del(uuid), test.t82_ids(jsonb), test.t82_w(jsonb), test.t82_try(jsonb),
  test.t82_w1(text, jsonb), test.t82_refused(text, jsonb, text), test.t82_applied(text, jsonb, text),
  test.t82_item(uuid), test.t82_split(uuid, uuid), test.t82_new_bill(uuid, uuid, uuid, text),
  test.t82_new_item(uuid, uuid), test.t82_new_split(uuid, uuid, uuid)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- C5: the endpoint exists, authenticated may call it, anon may not.
-- (Runs first: every later block depends on the function existing.)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_true(to_regprocedure('public.kwenta_delete_group(uuid)') IS NOT NULL,
    'C5: public.kwenta_delete_group(uuid) exists');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_delete_group(uuid)', 'EXECUTE'),
    'C5: authenticated may execute kwenta_delete_group');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_delete_group(uuid)', 'EXECUTE'),
    'C5: anon may not execute kwenta_delete_group');
  PERFORM test.note('082 C5: kwenta_delete_group is an authenticated-only endpoint');
END;
$$;

-- ---------------------------------------------------------------------------
-- C1: the creator's delete takes the whole group down in one call, and nothing else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; h uuid;
  ma uuid; mb uuid; mc uuid; b1 uuid; b2 uuid; s1 uuid; bun uuid; leg_ids uuid[];
  hb uuid; hs uuid; pb uuid; ps uuid; out jsonb; res jsonb; e jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82a-alice@example.com', 'Alice');
  bob   := test.new_account('g82a-bob@example.com', 'Bob');
  carol := test.new_account('g82a-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  ma := test.add_member(g, alice, 'Alice');
  mb := test.add_member(g, bob, 'Bob');
  mc := test.add_member(g, carol, 'Carol');
  b1 := test.new_bill(alice, alice, g, 'Hotel', 90, ARRAY[alice, bob]);
  -- Created by ANOTHER member: a device that never opened it holds no row for it.
  b2 := test.new_bill(bob, bob, g, 'Taxi', 60, ARRAY[alice, bob, carol]);
  s1 := test.new_settlement(bob, alice, 10, g);
  bun := test.new_bundle(carol, ARRAY[alice, bob], ARRAY[5, 5]::numeric[], g);
  leg_ids := ARRAY(SELECT id FROM public.settlements WHERE bundle_id = bun);
  -- Outside the group: another group of Alice's, a personal bill and a personal payment between
  -- the same people. None of them may move.
  h := test.new_group(alice, 'Other');
  PERFORM test.add_member(h, alice, 'Alice');
  PERFORM test.add_member(h, bob, 'Bob');
  hb := test.new_bill(alice, alice, h, 'Other bill', 40, ARRAY[alice, bob]);
  hs := test.new_settlement(bob, alice, 3, h);
  pb := test.new_bill(alice, alice, NULL, 'Personal', 50, ARRAY[alice, bob]);
  ps := test.new_settlement(bob, alice, 7);

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C1: the creator''s delete succeeds (got: ' || out::text || ')');

  PERFORM test.assert_true((test.t82_row('groups', g) ->> 'is_deleted')::boolean, 'C1: the group is deleted');
  PERFORM test.assert_eq(test.t82_live(g, 'group_members'), 0::bigint, 'C1: every membership is deleted, the creator''s own included');
  PERFORM test.assert_eq(test.t82_live(g, 'bills'), 0::bigint, 'C1: both bills are deleted, the one another member created included');
  PERFORM test.assert_eq(test.t82_live(g, 'bill_items'), 0::bigint, 'C1: their items are deleted');
  PERFORM test.assert_eq(test.t82_live(g, 'item_splits'), 0::bigint, 'C1: their splits are deleted');
  PERFORM test.assert_eq(test.t82_live(g, 'settlements'), 0::bigint, 'C1: every group payment is deleted, bundle legs included');

  -- Nothing outside the group moved.
  PERFORM test.assert_false((test.t82_row('groups', h) ->> 'is_deleted')::boolean, 'C1: another group is untouched');
  PERFORM test.assert_eq(test.t82_live(h, 'group_members'), 2::bigint, 'C1: its roster is untouched');
  PERFORM test.assert_false((test.t82_row('bills', hb) ->> 'is_deleted')::boolean, 'C1: another group''s bill is untouched');
  PERFORM test.assert_eq(test.t82_live(h, 'item_splits'), 2::bigint, 'C1: and its splits');
  PERFORM test.assert_false((test.t82_row('settlements', hs) ->> 'is_deleted')::boolean, 'C1: another group''s payment is untouched');
  PERFORM test.assert_false((test.t82_row('bills', pb) ->> 'is_deleted')::boolean, 'C1: a personal bill between the same people is untouched');
  PERFORM test.assert_false((test.t82_row('settlements', ps) ->> 'is_deleted')::boolean, 'C1: a personal payment is untouched');

  -- The echo: kwenta_write's shape, per-table arrays of the touched rows, as stored.
  res := out -> 'res';
  PERFORM test.assert_eq(jsonb_typeof(res), 'object', 'C1: the result is a jsonb object (got: ' || COALESCE(res::text, 'null') || ')');
  PERFORM test.assert_ids(test.t82_ids(res -> 'groups'), ARRAY[g], 'C1: echo.groups is the group');
  PERFORM test.assert_ids(test.t82_ids(res -> 'group_members'), ARRAY[ma, mb, mc], 'C1: echo.group_members is the whole roster');
  PERFORM test.assert_ids(test.t82_ids(res -> 'bills'), ARRAY[b1, b2], 'C1: echo.bills is both bills');
  PERFORM test.assert_ids(test.t82_ids(res -> 'bill_items'), ARRAY[test.t82_item(b1), test.t82_item(b2)], 'C1: echo.bill_items');
  PERFORM test.assert_ids(test.t82_ids(res -> 'item_splits'),
    ARRAY(SELECT s.id FROM public.item_splits s JOIN public.bill_items i ON i.id = s.item_id WHERE i.bill_id IN (b1, b2)),
    'C1: echo.item_splits is all five splits');
  PERFORM test.assert_ids(test.t82_ids(res -> 'settlements'), ARRAY[s1] || leg_ids, 'C1: echo.settlements is every group payment');
  FOR e IN SELECT x FROM jsonb_array_elements(
      COALESCE(res -> 'groups', '[]') || COALESCE(res -> 'group_members', '[]') || COALESCE(res -> 'bills', '[]')
      || COALESCE(res -> 'bill_items', '[]') || COALESCE(res -> 'item_splits', '[]') || COALESCE(res -> 'settlements', '[]')) x
  LOOP
    PERFORM test.assert_true((e ->> 'is_deleted')::boolean, 'C1: every echoed row is the deleted row (id ' || (e ->> 'id') || ')');
  END LOOP;
  -- The echo is the STORED row, so the client mirrors the server's own stamp.
  SELECT x INTO e FROM jsonb_array_elements(res -> 'bills') x WHERE x ->> 'id' = b2::text;
  PERFORM test.assert_eq((e ->> 'updated_at')::timestamptz, (test.t82_row('bills', b2) ->> 'updated_at')::timestamptz,
    'C1: an echoed row carries the stored updated_at');
  PERFORM test.note('082 C1: the creator deletes the whole group in one call; nothing outside it moves');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2: non-creator member, removed member, stranger, inactive creator: refused, nothing changes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; mallory uuid; ina uuid; g uuid; g2 uuid; mcarol uuid;
  before text; out jsonb; who uuid; label text;
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_true(to_regprocedure('public.kwenta_delete_group(uuid)') IS NOT NULL,
    'C2: kwenta_delete_group exists (a refusal must not be the function being missing)');
  alice   := test.new_account('g82b-alice@example.com', 'Alice');
  bob     := test.new_account('g82b-bob@example.com', 'Bob');
  carol   := test.new_account('g82b-carol@example.com', 'Carol');
  mallory := test.new_account('g82b-mallory@example.com', 'Mallory');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  mcarol := test.add_member(g, carol, 'Carol');
  PERFORM test.new_bill(bob, bob, g, 'Taxi', 60, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 10, g);
  UPDATE public.group_members SET is_deleted = true WHERE id = mcarol;

  FOR who, label IN SELECT * FROM (VALUES (bob, 'a member who did not create the group'),
                                          (carol, 'a removed member'),
                                          (mallory, 'a stranger')) v(u, l) LOOP
    PERFORM test.as_owner();
    before := test.t82_state(g);
    PERFORM test.as_user(who);
    out := test.t82_del(g);
    PERFORM test.as_owner();
    PERFORM test.assert_true(out ->> 'state' IS NOT NULL, 'C2: ' || label || ' is refused (got: ' || out::text || ')');
    PERFORM test.assert_eq(test.t82_state(g), before, 'C2: ' || label || ': nothing changed');
  END LOOP;

  -- An inactive account that DID create the group: 076's gate, 42501 with the status.
  ina := test.new_account('g82b-ina@example.com', 'Ina', 'inactive');
  g2 := test.new_group(ina, 'Ina''s');
  PERFORM test.add_member(g2, ina, 'Ina');
  PERFORM test.add_member(g2, bob, 'Bob');
  PERFORM test.new_bill(ina, ina, g2, 'Lunch', 30, ARRAY[ina, bob]);
  before := test.t82_state(g2);
  PERFORM test.as_user(ina);
  out := test.t82_del(g2);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', '42501', 'C2: an inactive creator is refused with 42501 (got: ' || out::text || ')');
  PERFORM test.assert_true(COALESCE(out ->> 'msg' LIKE '%kwenta_account_inactive:inactive%', false),
    'C2: the refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(out ->> 'msg', 'null') || ')');
  PERFORM test.assert_eq(test.t82_state(g2), before, 'C2: an inactive creator: nothing changed');
  PERFORM test.note('082 C2: only the active creator may delete a group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: idempotent; the former member who created the bill and is party to the payment still receives
-- the deletion (a third member who is neither does not pull a bill she holds: not covered, not claimed).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; mb uuid; b uuid; s uuid; out jsonb; after1 text; bundle jsonb; e jsonb;
  first jsonb; k text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82c-alice@example.com', 'Alice');
  bob   := test.new_account('g82c-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  mb := test.add_member(g, bob, 'Bob');
  b := test.new_bill(bob, bob, g, 'Taxi', 60, ARRAY[alice, bob]);
  s := test.new_settlement(bob, alice, 10, g);

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C3: the first delete succeeds (got: ' || out::text || ')');
  after1 := test.t82_state(g);
  first := out -> 'res';

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C3: a second delete of the same group is not an error (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t82_state(g), after1, 'C3: a second delete changes nothing (no restamp, no second log line)');
  -- C22: and it answers with the group's current rows, so a stale device still mirrors the deletion.
  -- Only the group and its roster: a repeat call stays cheap however much history the group has.
  FOR k IN SELECT unnest(ARRAY['groups', 'group_members']) LOOP
    PERFORM test.assert_ids(test.t82_ids(out -> 'res' -> k), test.t82_ids(first -> k),
      'C22: the second call echoes the same ' || k || ' as the first');
    PERFORM test.assert_true(jsonb_array_length(out -> 'res' -> k) > 0, 'C22: ' || k || ' is not empty');
  END LOOP;
  FOR k IN SELECT unnest(ARRAY['bills', 'bill_items', 'item_splits', 'settlements']) LOOP
    PERFORM test.assert_eq(jsonb_array_length(out -> 'res' -> k), 0, 'C22: a repeat call does not echo ' || k);
  END LOOP;
  FOR e IN SELECT x FROM jsonb_array_elements((out -> 'res' -> 'groups') || (out -> 'res' -> 'group_members')) x
  LOOP
    PERFORM test.assert_true((e ->> 'is_deleted')::boolean, 'C22: every echoed row is deleted (id ' || (e ->> 'id') || ')');
  END LOOP;
  PERFORM test.assert_eq(jsonb_array_length(out -> 'res' -> 'activity_log'), 0, 'C22: no log line is echoed on a retry');

  -- 024: Bob's membership is deleted too, yet his pull bundle still carries the deletion.
  PERFORM test.as_user(bob);
  bundle := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz, '{}'::jsonb, NULL);
  PERFORM test.as_owner();
  SELECT x INTO e FROM jsonb_array_elements(bundle -> 'groups') x WHERE x ->> 'id' = g::text;
  PERFORM test.assert_true(COALESCE((e ->> 'is_deleted')::boolean, false), 'C3: the former member pulls the group as deleted');
  SELECT x INTO e FROM jsonb_array_elements(bundle -> 'group_members') x WHERE x ->> 'id' = mb::text;
  PERFORM test.assert_true(COALESCE((e ->> 'is_deleted')::boolean, false), 'C3: and their own membership as deleted');
  SELECT x INTO e FROM jsonb_array_elements(bundle -> 'bills') x WHERE x ->> 'id' = b::text;
  PERFORM test.assert_true(COALESCE((e ->> 'is_deleted')::boolean, false), 'C3: and the bill they created as deleted');
  SELECT x INTO e FROM jsonb_array_elements(bundle -> 'settlements') x WHERE x ->> 'id' = s::text;
  PERFORM test.assert_true(COALESCE((e ->> 'is_deleted')::boolean, false), 'C3: and the payment they are party to as deleted');
  PERFORM test.note('082 C3: idempotent, and the deletion reaches a former member who created the bill and is party to the payment');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: server stamps beat a future-dated stored row; a deleted payment is left alone; one log line.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; ma uuid; mb uuid; bf uuid; bn uuid; sf uuid; sd uuid; spf uuid;
  future timestamptz := now() + interval '1 year';
  old_sd timestamptz;
  old_bn timestamptz; old_ma timestamptz; out jsonb; n bigint; a record;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82d-alice@example.com', 'Alice');
  bob   := test.new_account('g82d-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  ma := test.add_member(g, alice, 'Alice');
  mb := test.add_member(g, bob, 'Bob');
  bf := test.new_bill(bob, bob, g, 'Future', 60, ARRAY[alice, bob]);
  bn := test.new_bill(alice, alice, g, 'Now', 30, ARRAY[alice, bob]);
  sf := test.new_settlement(bob, alice, 10, g);
  sd := test.new_settlement(bob, alice, 4, g);
  spf := test.t82_split(bf, bob);
  -- Rows a device with a clock a year ahead wrote (021b let them in as "newest").
  UPDATE public.groups SET updated_at = future WHERE id = g;
  UPDATE public.group_members SET updated_at = future WHERE id = mb;
  UPDATE public.bills SET updated_at = future WHERE id = bf;
  UPDATE public.bill_items SET updated_at = future WHERE id = test.t82_item(bf);
  UPDATE public.item_splits SET updated_at = future WHERE id = spf;
  UPDATE public.settlements SET updated_at = future WHERE id = sf;
  -- A payment deleted earlier: not live, so not part of this deletion.
  -- updated_at is left alone: 021b would keep the stored row against a backdated one.
  UPDATE public.settlements SET is_deleted = true WHERE id = sd;
  old_sd := (test.t82_row('settlements', sd) ->> 'updated_at')::timestamptz;
  old_bn := (test.t82_row('bills', bn) ->> 'updated_at')::timestamptz;
  old_ma := (test.t82_row('group_members', ma) ->> 'updated_at')::timestamptz;

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C4: the delete succeeds (got: ' || out::text || ')');

  PERFORM test.assert_true((test.t82_row('groups', g) ->> 'is_deleted')::boolean, 'C4: a future-dated group row is still deleted');
  PERFORM test.assert_eq((test.t82_row('groups', g) ->> 'updated_at')::timestamptz, future + interval '1 microsecond',
    'C4: and stamped updated_at + 1us');
  PERFORM test.assert_true((test.t82_row('group_members', mb) ->> 'is_deleted')::boolean, 'C4: a future-dated membership is deleted');
  PERFORM test.assert_eq((test.t82_row('group_members', mb) ->> 'updated_at')::timestamptz, future + interval '1 microsecond',
    'C4: membership stamped updated_at + 1us');
  PERFORM test.assert_true((test.t82_row('bills', bf) ->> 'is_deleted')::boolean, 'C4: a future-dated bill is deleted');
  PERFORM test.assert_eq((test.t82_row('bills', bf) ->> 'updated_at')::timestamptz, future + interval '1 microsecond',
    'C4: bill stamped updated_at + 1us');
  PERFORM test.assert_true((test.t82_row('bill_items', test.t82_item(bf)) ->> 'is_deleted')::boolean, 'C4: a future-dated item is deleted');
  PERFORM test.assert_true((test.t82_row('item_splits', spf) ->> 'is_deleted')::boolean, 'C4: a future-dated split is deleted');
  PERFORM test.assert_eq((test.t82_row('item_splits', spf) ->> 'updated_at')::timestamptz, future + interval '1 microsecond',
    'C4: split stamped updated_at + 1us');
  PERFORM test.assert_true((test.t82_row('settlements', sf) ->> 'is_deleted')::boolean, 'C4: a future-dated payment is deleted');
  PERFORM test.assert_eq((test.t82_row('settlements', sf) ->> 'updated_at')::timestamptz, future + interval '1 microsecond',
    'C4: payment stamped updated_at + 1us');
  -- Rows stored at "now": the stamp still moves strictly forward.
  PERFORM test.assert_true((test.t82_row('bills', bn) ->> 'updated_at')::timestamptz > old_bn,
    'C4: a present-dated bill''s updated_at moves forward');
  PERFORM test.assert_true((test.t82_row('group_members', ma) ->> 'updated_at')::timestamptz > old_ma,
    'C4: the creator''s membership updated_at moves forward');
  PERFORM test.assert_eq((test.t82_row('settlements', sd) ->> 'updated_at')::timestamptz, old_sd,
    'C4: an already-deleted payment is not restamped');

  SELECT count(*) INTO n FROM public.activity_log WHERE group_id = g OR entity_id = g;
  PERFORM test.assert_eq(n, 1::bigint, 'C4: exactly one activity_log line');
  SELECT * INTO a FROM public.activity_log WHERE group_id = g OR entity_id = g LIMIT 1;
  PERFORM test.assert_eq(a.user_id, alice, 'C4: the line is authored by the caller');
  PERFORM test.assert_eq(a.action, 'deleted', 'C4: action ''deleted''');
  PERFORM test.assert_eq(a.entity_type, 'group', 'C4: entity_type ''group''');
  PERFORM test.assert_eq(a.entity_id, g, 'C4: entity_id is the group');
  PERFORM test.note('082 C4: server stamps win over future-dated rows; one log line');
END;
$$;

-- ---------------------------------------------------------------------------
-- C15: live children left under an already-deleted bill of the group are swept too.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; g uuid; bd uuid; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82e-alice@example.com', 'Alice');
  bob   := test.new_account('g82e-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  bd := test.new_bill(bob, bob, g, 'Half-deleted', 60, ARRAY[alice, bob]);
  -- An older client deleted the bill row alone; its item and splits stayed live.
  UPDATE public.bills SET is_deleted = true WHERE id = bd;

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C15: the delete succeeds (got: ' || out::text || ')');
  PERFORM test.assert_true((test.t82_row('bill_items', test.t82_item(bd)) ->> 'is_deleted')::boolean,
    'C15: a live item under an already-deleted bill is deleted');
  PERFORM test.assert_eq(test.t82_live(g, 'item_splits'), 0::bigint,
    'C15: live splits under an already-deleted bill are deleted');
  PERFORM test.note('082 C15: leftovers under deleted bills are swept');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: a group bill is written only by its creator (while an active member).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; gb uuid; res jsonb;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82f-alice@example.com', 'Alice');
  bob   := test.new_account('g82f-bob@example.com', 'Bob');
  carol := test.new_account('g82f-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');
  gb := test.new_bill(bob, bob, g, 'Bob''s taxi', 90, ARRAY[alice, bob, carol]);

  -- Carol is an active member but did not create the bill.
  PERFORM test.as_user(carol);
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"title": "Carol edited"}',
    'C6: another member cannot retitle a group bill');
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || jsonb_build_object('paid_by', carol),
    'C6: nor change who paid');
  PERFORM test.t82_refused('bill_items', test.t82_row('bill_items', test.t82_item(gb)) || '{"amount": 120}',
    'C6: nor change its item');
  PERFORM test.t82_refused('bill_items', test.t82_new_item(gen_random_uuid(), gb),
    'C6: nor add an item');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb, carol)) || '{"computed_amount": 0}',
    'C6: nor zero their own share');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb, alice)) || '{"computed_amount": 1}',
    'C6: nor change someone else''s share');
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"is_deleted": true}',
    'C6: nor delete it');

  -- createBill in the group by a member who neither created the group nor any bill: still fine.
  res := test.t82_w(jsonb_build_object(
    'bills', jsonb_build_array(test.t82_new_bill(nb, carol, g, 'Carol''s lunch')),
    'bill_items', jsonb_build_array(test.t82_new_item(ni, nb)),
    'item_splits', jsonb_build_array(test.t82_new_split(gen_random_uuid(), ni, alice),
                                     test.t82_new_split(gen_random_uuid(), ni, carol))));
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text
    AND jsonb_array_length(res -> 'applied' -> 'item_splits') = 2, 'C6: createBill by any member still applies');
  -- And Carol, as ITS creator, edits it.
  PERFORM test.t82_applied('bills', test.t82_row('bills', nb) || '{"title": "Carol''s dinner"}',
    'C6: the creator retitles their own group bill');

  -- Bob, the bill's creator and an active member, edits his bill: row, item, split.
  PERFORM test.as_user(bob);
  PERFORM test.t82_applied('bills', test.t82_row('bills', gb) || '{"title": "Bob''s cab"}',
    'C6: the bill''s creator retitles it');
  PERFORM test.t82_applied('bill_items', test.t82_row('bill_items', test.t82_item(gb)) || '{"amount": 120}',
    'C6: and edits its item');
  PERFORM test.t82_applied('item_splits', test.t82_row('item_splits', test.t82_split(gb, carol)) || '{"computed_amount": 40}',
    'C6: and edits a split');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(test.t82_row('bills', gb) ->> 'title', 'Bob''s cab', 'C6: the creator''s edit landed');

  -- Removed from the group, the creator loses the right (the "while an active member" half).
  UPDATE public.group_members SET is_deleted = true WHERE group_id = g AND user_id = bob;
  PERFORM test.as_user(bob);
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"title": "after removal"}',
    'C6: a removed creator cannot edit their group bill');
  PERFORM test.note('082 C6: group bills are creator-only while a member; createBill by any member still passes');
END;
$$;

-- ---------------------------------------------------------------------------
-- C12: the group creator may soft-delete another member's bill, not edit it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; carol uuid; g uuid; gb uuid; gb2 uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82g-alice@example.com', 'Alice');
  bob   := test.new_account('g82g-bob@example.com', 'Bob');
  carol := test.new_account('g82g-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');
  gb  := test.new_bill(bob, bob, g, 'Bob''s taxi', 90, ARRAY[alice, bob]);
  gb2 := test.new_bill(bob, bob, g, 'Bob''s hotel', 60, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"title": "Alice edited"}',
    'C12: the group creator cannot edit another member''s bill');
  PERFORM test.t82_refused('bill_items', test.t82_row('bill_items', test.t82_item(gb)) || '{"amount": 1}',
    'C12: nor its item');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb, alice)) || '{"computed_amount": 0}',
    'C12: nor zero her own share on it');

  -- A member who created neither the group nor the bill cannot delete it.
  PERFORM test.as_user(carol);
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb2) || '{"is_deleted": true}',
    'C12: a plain member cannot delete another member''s bill');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb2, alice)) || '{"is_deleted": true}',
    'C12: nor one of its splits');
  PERFORM test.as_user(alice);
  -- While the group is LIVE the group creator cannot delete any part of another member's bill, nor
  -- the share she herself owes on it (that would cancel her debt without any bill being deleted).
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb, alice)) || '{"is_deleted": true}',
    'C19: the group creator cannot delete her own split on another member''s live bill');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', test.t82_split(gb, bob)) || '{"is_deleted": true}',
    'C19: nor another member''s split');
  PERFORM test.t82_refused('bill_items', test.t82_row('bill_items', test.t82_item(gb)) || '{"is_deleted": true}',
    'C19: nor its item');
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"is_deleted": true}',
    'C19: nor the whole bill');

  -- Old clients' deleteGroup cascade (and a queued group delete): the group row travels in the same
  -- submission and is pushed first, so by the time the bill is judged the group is deleted.
  -- A cascade that also rewrites the content of the row it deletes is refused whole.
  res := jsonb_build_object(
    'groups', jsonb_build_array(test.t82_row('groups', g) || '{"is_deleted": true}'),
    'bills', jsonb_build_array(test.t82_row('bills', gb) || '{"is_deleted": true, "title": "forged"}'));
  PERFORM test.as_user(alice);
  res := test.t82_try(res);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(res ->> 'state', 'P0001', 'C19: a cascade that changes the deleted row''s content is refused');
  PERFORM test.assert_false((test.t82_row('groups', g) ->> 'is_deleted')::boolean, 'C19: and rolled back, group included');

  PERFORM test.as_owner();
  res := jsonb_build_object(
    'groups', jsonb_build_array(test.t82_row('groups', g) || '{"is_deleted": true}'),
    'bills', jsonb_build_array(test.t82_row('bills', gb) || '{"is_deleted": true}'),
    'bill_items', jsonb_build_array(test.t82_row('bill_items', test.t82_item(gb)) || '{"is_deleted": true}'),
    'item_splits', (SELECT jsonb_agg(to_jsonb(s) || '{"is_deleted": true}') FROM public.item_splits s
                    WHERE s.item_id = test.t82_item(gb)));
  PERFORM test.as_user(alice);
  res := test.t82_try(res);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(res ->> 'state', NULL::text, 'C12: the group creator''s cascade deletes another member''s bill (got: ' || res::text || ')');
  PERFORM test.assert_true((test.t82_row('bills', gb) ->> 'is_deleted')::boolean, 'C12: the bill is deleted');
  PERFORM test.assert_true((test.t82_row('bill_items', test.t82_item(gb)) ->> 'is_deleted')::boolean, 'C12: its item is deleted');
  PERFORM test.assert_eq((SELECT count(*) FROM public.item_splits WHERE item_id = test.t82_item(gb) AND NOT is_deleted), 0::bigint,
    'C12: its splits are deleted');
  -- C24: the cascade named one bill; the group's sweep took the rest of the group with the group row.
  PERFORM test.assert_true((test.t82_row('bills', gb2) ->> 'is_deleted')::boolean, 'C24: the bill the cascade did not name is deleted too');
  PERFORM test.assert_eq(test.t82_live(g, 'item_splits'), 0::bigint, 'C24: no live split is left');
  PERFORM test.assert_eq(test.t82_live(g, 'group_members'), 0::bigint, 'C24: no live membership is left');

  PERFORM test.note('082 C12: the group creator deletes, but does not edit, others'' group bills');
END;
$$;

-- ---------------------------------------------------------------------------
-- C13: an id-only canonical rewrite by an active member is accepted; anything more is refused.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; carol uuid; erin uuid; k uuid; g uuid; gb uuid; sp uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82h-alice@example.com', 'Alice');
  bob   := test.new_account('g82h-bob@example.com', 'Bob');
  carol := test.new_account('g82h-carol@example.com', 'Carol');
  erin  := test.new_account('g82h-erin@example.com', 'Erin');
  -- Alice's contact, already linked to Erin's account; the roster holds the account id
  -- (membershipUserIdForProfile), while Bob's bill still names the contact id (a pre-081 link).
  k := test.new_contact(alice, 'Erin (contact)', erin);
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');
  PERFORM test.add_member(g, erin, 'Erin');
  gb := test.new_bill(bob, k, g, 'Erin paid', 90, ARRAY[bob, k]);
  sp := test.t82_split(gb, k);
  PERFORM test.assert_eq(public.kwenta_canonical_user_id(k), erin, 'C13 fixture: the contact canonicalizes to the account');

  -- Carol: active member, created neither the group nor the bill.
  PERFORM test.as_user(carol);
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', sp) || jsonb_build_object('user_id', erin, 'computed_amount', 1),
    'C13: the canonical rewrite plus an amount change is refused');
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || jsonb_build_object('paid_by', erin, 'title', 'renamed'),
    'C13: the canonical payer rewrite plus a title change is refused');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', sp) || jsonb_build_object('user_id', carol),
    'C13: a rewrite to a NON-canonical id is refused');
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || jsonb_build_object('paid_by', carol),
    'C13: a payer rewrite to a non-canonical id is refused');

  PERFORM test.t82_applied('item_splits', test.t82_row('item_splits', sp) || jsonb_build_object('user_id', erin),
    'C13: an id-only split rewrite to the canonical id is accepted');
  PERFORM test.t82_applied('bills', test.t82_row('bills', gb) || jsonb_build_object('paid_by', erin),
    'C13: an id-only payer rewrite to the canonical id is accepted');
  PERFORM test.as_owner();
  PERFORM test.assert_eq((test.t82_row('item_splits', sp) ->> 'user_id')::uuid, erin, 'C13: the split now names the account');
  PERFORM test.assert_eq((test.t82_row('bills', gb) ->> 'paid_by')::uuid, erin, 'C13: the payer is now the account');
  PERFORM test.assert_eq(test.t82_row('bills', gb) ->> 'title', 'Erin paid', 'C13: nothing else on the bill moved');
  PERFORM test.assert_money((test.t82_row('item_splits', sp) ->> 'computed_amount')::numeric, 45, 'C13: nor the share');
  PERFORM test.note('082 C13: canonical id-only rewrites pass for members; anything more is refused');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: re-adding a removed member with the existing row id revives it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; bob uuid; g uuid; bm uuid; out jsonb; n bigint;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82i-alice@example.com', 'Alice');
  bob   := test.new_account('g82i-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  bm := test.add_member(g, bob, 'Bob');
  UPDATE public.group_members SET is_deleted = true WHERE id = bm;

  -- The removed member cannot restore themselves.
  PERFORM test.as_user(bob);
  PERFORM test.t82_refused('group_members', test.t82_row('group_members', bm) || '{"is_deleted": false}',
    'C11: a removed member cannot revive their own membership');

  PERFORM test.as_user(alice);
  out := test.t82_try(jsonb_build_object('group_members', jsonb_build_array(
    test.t82_row('group_members', bm) || jsonb_build_object('is_deleted', false, 'joined_at', now(), 'display_name', 'Bobby'))));
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C11: the re-add applies, no 23505 (got: ' || out::text || ')');
  PERFORM test.assert_true(COALESCE(out -> 'res' -> 'applied' -> 'group_members' ? bm::text, false), 'C11: reported applied');
  PERFORM test.assert_false((test.t82_row('group_members', bm) ->> 'is_deleted')::boolean, 'C11: the same row is live again');
  PERFORM test.assert_eq(test.t82_row('group_members', bm) ->> 'display_name', 'Bobby', 'C11: with the new roster name');
  SELECT count(*) INTO n FROM public.group_members WHERE group_id = g AND user_id = bob;
  PERFORM test.assert_eq(n, 1::bigint, 'C11: still exactly one row for (group, user)');
  PERFORM test.note('082 C11: re-add through the existing id revives the membership');
END;
$$;

-- ---------------------------------------------------------------------------
-- C14: linking onto an account that already has a membership row never raises 23505.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; erin uuid; k uuid; ga uuid; gb uuid; gc uuid;
  em_a uuid; km_a uuid; em_b uuid; km_b uuid; em_c uuid; km_c uuid; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82j-alice@example.com', 'Alice');
  erin  := test.new_account('g82j-erin@example.com', 'Erin');
  k := test.new_contact(alice, 'Erin (contact)');
  -- ga: Erin's account was removed earlier; the contact is a live member.
  ga := test.new_group(alice, 'A');
  PERFORM test.add_member(ga, alice, 'Alice');
  em_a := test.add_member(ga, erin, 'Erin');
  km_a := test.add_member(ga, k, 'Erin (contact)');
  UPDATE public.group_members SET is_deleted = true WHERE id = em_a;
  -- gb: both are live members.
  gb := test.new_group(alice, 'B');
  PERFORM test.add_member(gb, alice, 'Alice');
  em_b := test.add_member(gb, erin, 'Erin');
  km_b := test.add_member(gb, k, 'Erin (contact)');
  -- gc: both rows were removed.
  gc := test.new_group(alice, 'C');
  PERFORM test.add_member(gc, alice, 'Alice');
  em_c := test.add_member(gc, erin, 'Erin');
  km_c := test.add_member(gc, k, 'Erin (contact)');
  UPDATE public.group_members SET is_deleted = true WHERE id IN (em_c, km_c);

  PERFORM test.as_user(alice);
  out := test.t82_try(jsonb_build_object('profiles', jsonb_build_array(
    test.t82_row('profiles', k) || jsonb_build_object('linked_profile_id', erin))));
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C14: the link applies, no 23505 (got: ' || out::text || ')');
  PERFORM test.assert_eq((test.t82_row('profiles', k) ->> 'linked_profile_id')::uuid, erin, 'C14: the contact is linked');

  PERFORM test.assert_false((test.t82_row('group_members', em_a) ->> 'is_deleted')::boolean,
    'C14 (removed account, live contact): the account''s row is revived');
  PERFORM test.assert_true((test.t82_row('group_members', km_a) ->> 'is_deleted')::boolean,
    'C14 (removed account, live contact): the contact''s row is soft-deleted');
  PERFORM test.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id = ga AND user_id = erin), 1::bigint,
    'C14 (removed account, live contact): one row for the account');

  PERFORM test.assert_false((test.t82_row('group_members', em_b) ->> 'is_deleted')::boolean,
    'C14 (both live): the account''s row stays live');
  PERFORM test.assert_true((test.t82_row('group_members', km_b) ->> 'is_deleted')::boolean,
    'C14 (both live): the contact''s row is soft-deleted');

  PERFORM test.assert_true((test.t82_row('group_members', em_c) ->> 'is_deleted')::boolean,
    'C14 (both removed): the account''s row stays removed');
  PERFORM test.assert_true((test.t82_row('group_members', km_c) ->> 'is_deleted')::boolean,
    'C14 (both removed): the contact''s row stays removed');
  PERFORM test.assert_eq((test.t82_row('group_members', km_c) ->> 'user_id')::uuid, k,
    'C14 (both removed): the contact''s row is left as it was');
  PERFORM test.note('082 C14: a link onto an existing membership row revives or leaves, never 23505');
END;
$$;

-- ---------------------------------------------------------------------------
-- C20: the member id-only exception never lets the caller choose updated_at.
-- (Pushed straight through kwenta_write: t82_w would overwrite the very field under test.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; erin uuid; k uuid; g uuid; gb uuid; sp uuid;
  far text := '2999-01-01T00:00:00+00:00';
  before_bill timestamptz; before_split timestamptz; after_bill timestamptz; after_split timestamptz;
  res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82k-alice@example.com', 'Alice');
  bob   := test.new_account('g82k-bob@example.com', 'Bob');
  carol := test.new_account('g82k-carol@example.com', 'Carol');
  erin  := test.new_account('g82k-erin@example.com', 'Erin');
  k := test.new_contact(alice, 'Erin (contact)', erin);
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');
  PERFORM test.add_member(g, erin, 'Erin');
  gb := test.new_bill(bob, k, g, 'Erin paid', 90, ARRAY[bob, k]);
  sp := test.t82_split(gb, k);
  before_bill := (test.t82_row('bills', gb) ->> 'updated_at')::timestamptz;
  before_split := (test.t82_row('item_splits', sp) ->> 'updated_at')::timestamptz;

  -- The rewrite itself: accepted, but the server picks the version.
  PERFORM test.as_user(carol);
  res := public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.t82_row('bills', gb) || jsonb_build_object('paid_by', erin, 'updated_at', far)),
    'item_splits', jsonb_build_array(test.t82_row('item_splits', sp) || jsonb_build_object('user_id', erin, 'updated_at', far))),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? gb::text AND res -> 'applied' -> 'item_splits' ? sp::text,
    'C20: the canonical rewrite is accepted (got: ' || (res -> 'applied')::text || ')');
  after_bill := (test.t82_row('bills', gb) ->> 'updated_at')::timestamptz;
  after_split := (test.t82_row('item_splits', sp) ->> 'updated_at')::timestamptz;
  PERFORM test.assert_true(after_bill > before_bill AND after_bill < now() + interval '1 day',
    'C20: the bill''s version is server-stamped, not the caller''s 2999');
  PERFORM test.assert_true(after_split > before_split AND after_split < now() + interval '1 day',
    'C20: and the split''s');

  -- A no-op push (ids already canonical) with a future version leaves the row untouched.
  PERFORM test.as_user(carol);
  res := public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.t82_row('bills', gb) || jsonb_build_object('updated_at', far)),
    'item_splits', jsonb_build_array(test.t82_row('item_splits', sp) || jsonb_build_object('updated_at', far))),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? gb::text AND res -> 'applied' -> 'item_splits' ? sp::text,
    'C20: the no-op is accepted (the link''s own rewrite may already have been made by 045)');
  PERFORM test.assert_eq((test.t82_row('bills', gb) ->> 'updated_at')::timestamptz, after_bill,
    'C20: a no-op push with updated_at 2999 leaves the bill''s version alone');
  PERFORM test.assert_eq((test.t82_row('item_splits', sp) ->> 'updated_at')::timestamptz, after_split,
    'C20: and the split''s');

  -- The bill's creator, by contrast, still stamps his own edits.
  PERFORM test.as_user(bob);
  res := public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.t82_row('bills', gb) || jsonb_build_object('title', 'Bob retitled', 'updated_at', now() + interval '1 hour'))),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(test.t82_row('bills', gb) ->> 'title', 'Bob retitled', 'C20: the creator''s own edit is unaffected');
  PERFORM test.note('082 C20: the member exception cannot future-date a bill');
END;
$$;

-- ---------------------------------------------------------------------------
-- C21: nothing live is written into a deleted group, by anyone; soft-deletes still are.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; gb uuid; s1 uuid; it uuid; out jsonb; ps uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82l-alice@example.com', 'Alice');
  bob   := test.new_account('g82l-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  gb := test.new_bill(alice, alice, g, 'Hotel', 90, ARRAY[alice, bob]);
  s1 := test.new_settlement(bob, alice, 10, g);
  it := test.t82_item(gb);
  ps := test.t82_split(gb, bob);

  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C21 fixture: the group is deleted (got: ' || out::text || ')');

  PERFORM test.as_user(alice);
  -- New rows, live.
  PERFORM test.t82_refused('bills', test.t82_new_bill(gen_random_uuid(), alice, g, 'Late bill'),
    'C21: a new live bill in a deleted group is refused, even for the group creator');
  PERFORM test.t82_refused('bill_items', test.t82_new_item(gen_random_uuid(), gb),
    'C21: a new live item under its bill');
  PERFORM test.t82_refused('item_splits', test.t82_new_split(gen_random_uuid(), it, alice),
    'C21: a new live split');
  PERFORM test.t82_refused('settlements', test.t82_row('settlements', s1) || jsonb_build_object('id', gen_random_uuid(), 'is_deleted', false),
    'C21: a new live payment');
  -- Unbased revives of stored rows.
  PERFORM test.t82_refused('bills', test.t82_row('bills', gb) || '{"is_deleted": false}',
    'C21: reviving the bill');
  PERFORM test.t82_refused('bill_items', test.t82_row('bill_items', it) || '{"is_deleted": false}',
    'C21: reviving its item');
  PERFORM test.t82_refused('item_splits', test.t82_row('item_splits', ps) || '{"is_deleted": false}',
    'C21: reviving its split');
  PERFORM test.t82_refused('settlements', test.t82_row('settlements', s1) || '{"is_deleted": false}',
    'C21: reviving the payment');

  -- Soft-deletes (what the old cascade sends) stay allowed.
  PERFORM test.t82_applied('bills', test.t82_row('bills', gb), 'C21: a soft-delete of the bill still applies');
  PERFORM test.t82_applied('bill_items', test.t82_row('bill_items', it), 'C21: and of its item');
  PERFORM test.t82_applied('item_splits', test.t82_row('item_splits', ps), 'C21: and of its split');
  PERFORM test.t82_applied('settlements', test.t82_row('settlements', s1), 'C21: and of the payment');
  PERFORM test.assert_eq((SELECT provolatile FROM pg_proc WHERE oid = 'public.kwenta_group_open(uuid)'::regprocedure), 'v'::"char",
    'C23: kwenta_group_open is VOLATILE (it takes the group row FOR SHARE)');
  PERFORM test.note('082 C21: nothing live can be written into a deleted group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C24: one sweep, however the group is deleted.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; gb uuid; s1 uuid; mb uuid; res jsonb; out jsonb;
  ev_before bigint; ev_after bigint; bill_ev_before bigint; bill_ev_after bigint;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82m-alice@example.com', 'Alice');
  bob   := test.new_account('g82m-bob@example.com', 'Bob');

  -- A kwenta_sync replay of the group row ALONE (a legacy unsent row) leaves nothing live.
  g := test.new_group(alice, 'Synced');
  PERFORM test.add_member(g, alice, 'Alice');
  mb := test.add_member(g, bob, 'Bob');
  gb := test.new_bill(bob, bob, g, 'Taxi', 60, ARRAY[alice, bob]);
  s1 := test.new_settlement(bob, alice, 10, g);
  SELECT count(*) INTO ev_before FROM public.kwenta_user_events
   WHERE user_id = bob AND entity_id = g AND event_type = 'group_changed';
  SELECT count(*) INTO bill_ev_before FROM public.kwenta_user_events
   WHERE user_id = bob AND entity_id = gb AND event_type = 'bill_changed';
  PERFORM test.as_user(alice);
  res := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz,
    jsonb_build_object('groups', jsonb_build_array(
      test.t82_row('groups', g) || jsonb_build_object('is_deleted', true, 'updated_at', now() + interval '1 minute'))),
    NULL);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'groups' ? g::text, 'C24: the group row applies through kwenta_sync');
  PERFORM test.assert_eq(test.t82_live(g, 'bills'), 0::bigint, 'C24: kwenta_sync alone: no live bill is left');
  PERFORM test.assert_eq(test.t82_live(g, 'bill_items'), 0::bigint, 'C24: no live item');
  PERFORM test.assert_eq(test.t82_live(g, 'item_splits'), 0::bigint, 'C24: no live split');
  PERFORM test.assert_eq(test.t82_live(g, 'settlements'), 0::bigint, 'C24: no live payment');
  PERFORM test.assert_eq(test.t82_live(g, 'group_members'), 0::bigint, 'C24: no live membership');
  -- 024 / 012: the members were live when the events fired, so the deletion reached Bob.
  SELECT count(*) INTO ev_after FROM public.kwenta_user_events
   WHERE user_id = bob AND entity_id = g AND event_type = 'group_changed';
  SELECT count(*) INTO bill_ev_after FROM public.kwenta_user_events
   WHERE user_id = bob AND entity_id = gb AND event_type = 'bill_changed';
  PERFORM test.assert_true(ev_after > ev_before, 'C24: Bob receives a group_changed event for the deletion');
  PERFORM test.assert_true(bill_ev_after > bill_ev_before, 'C24: and a bill_changed event for the swept bill');

  -- Leftovers under an already-deleted group (what the old cascade stranded) are swept by a retry.
  g := test.new_group(alice, 'Stranded');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  gb := test.new_bill(bob, bob, g, 'Late bill', 60, ARRAY[alice, bob]);
  s1 := test.new_settlement(bob, alice, 10, g);
  ALTER TABLE public.groups DISABLE TRIGGER kwenta_groups_z_sweep_children;
  UPDATE public.groups SET is_deleted = true WHERE id = g;
  ALTER TABLE public.groups ENABLE TRIGGER kwenta_groups_z_sweep_children;
  PERFORM test.assert_eq(test.t82_live(g, 'bills'), 1::bigint, 'C24 fixture: a live bill is stranded under the deleted group');
  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C24: the retry succeeds (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t82_live(g, 'bills'), 0::bigint, 'C24: the retry sweeps the stranded bill');
  PERFORM test.assert_eq(test.t82_live(g, 'item_splits'), 0::bigint, 'C24: its splits');
  PERFORM test.assert_eq(test.t82_live(g, 'settlements'), 0::bigint, 'C24: the stranded payment');
  PERFORM test.assert_eq(test.t82_live(g, 'group_members'), 0::bigint, 'C24: and the memberships');
  PERFORM test.assert_eq(jsonb_array_length(out -> 'res' -> 'bills'), 0, 'C24: the repeat call echoes the group and roster only');
  PERFORM test.assert_eq((SELECT count(*) FROM public.activity_log WHERE entity_id = g), 0::bigint,
    'C24: the retry on a group the server never logged writes no line');
  PERFORM test.note('082 C24: one sweep, however the group is deleted');
END;
$$;

-- ---------------------------------------------------------------------------
-- C25: no live membership enters a deleted group.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; erin uuid; k uuid; g uuid; mb uuid; me uuid; mk uuid; out jsonb;
  nm uuid := gen_random_uuid(); carol uuid; k2 uuid; dan uuid; mk2 uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82n-alice@example.com', 'Alice');
  bob   := test.new_account('g82n-bob@example.com', 'Bob');
  carol := test.new_account('g82n-carol@example.com', 'Carol');
  erin  := test.new_account('g82n-erin@example.com', 'Erin');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  mb := test.add_member(g, bob, 'Bob');
  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C25 fixture: the group is deleted (got: ' || out::text || ')');

  PERFORM test.as_user(alice);
  PERFORM test.t82_refused('group_members',
    jsonb_build_object('id', nm, 'group_id', g, 'user_id', carol, 'display_name', 'Carol', 'joined_at', now(),
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test'),
    'C25: a new live membership in a deleted group is refused, even for the group creator');
  PERFORM test.t82_refused('group_members', test.t82_row('group_members', mb) || '{"is_deleted": false}',
    'C25: reviving a removed member of a deleted group is refused');
  PERFORM test.t82_applied('group_members', test.t82_row('group_members', mb),
    'C25: a soft-delete of a membership still applies (the old cascade)');

  -- The link rewrite: a live contact row stranded in a deleted group is neither folded into a
  -- revived account row nor rewritten live onto the account.
  PERFORM test.as_owner();
  k := test.new_contact(alice, 'Erin (contact)');
  mk := test.add_member(g, k, 'Erin (contact)');
  me := test.add_member(g, erin, 'Erin');
  UPDATE public.group_members SET is_deleted = true WHERE id = me;
  PERFORM test.assert_false((test.t82_row('group_members', mk) ->> 'is_deleted')::boolean,
    'C25 fixture: a live contact membership is stranded in the deleted group');
  PERFORM test.as_user(alice);
  out := test.t82_try(jsonb_build_object('profiles', jsonb_build_array(
    test.t82_row('profiles', k) || jsonb_build_object('linked_profile_id', erin))));
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C25: the link applies (got: ' || out::text || ')');
  PERFORM test.assert_true((test.t82_row('group_members', me) ->> 'is_deleted')::boolean,
    'C25: the account''s removed row in a deleted group is not revived');
  -- The account has no row at all: the stranded live contact row is not rewritten live onto it.
  PERFORM test.as_owner();
  k2 := test.new_contact(alice, 'Dan (contact)');
  dan := test.new_account('g82n-dan@example.com', 'Dan');
  mk2 := test.add_member(g, k2, 'Dan (contact)');
  PERFORM test.as_user(alice);
  out := test.t82_try(jsonb_build_object('profiles', jsonb_build_array(
    test.t82_row('profiles', k2) || jsonb_build_object('linked_profile_id', dan))));
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C25: the second link applies (got: ' || out::text || ')');
  PERFORM test.assert_eq((test.t82_row('group_members', mk2) ->> 'user_id')::uuid, k2,
    'C25: a live contact row in a deleted group is not rewritten onto the account');
  PERFORM test.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id = g AND user_id = dan), 0::bigint,
    'C25: so the account gains no live membership there');
  PERFORM test.note('082 C25: no live membership enters a deleted group');
END;
$$;

-- ---------------------------------------------------------------------------
-- C26: only a TRANSITION to live is refused; a rename of a stranded live membership applies.
-- ---------------------------------------------------------------------------
DO $$
DECLARE alice uuid; carol uuid; g uuid; mc uuid; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('g82o-alice@example.com', 'Alice');
  carol := test.new_account('g82o-carol@example.com', 'Carol');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.as_user(alice);
  out := test.t82_del(g);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C26 fixture: the group is deleted (got: ' || out::text || ')');
  -- A membership the old cascade left live under the deleted group.
  mc := test.add_member(g, carol, 'Carol');

  PERFORM test.as_user(carol);
  PERFORM test.t82_applied('group_members', test.t82_row('group_members', mc) || '{"display_name": "Carol R"}',
    'C26: a member renames her own stranded live membership (renameSelf is not sunk by it)');
  PERFORM test.as_user(alice);
  PERFORM test.t82_applied('group_members', test.t82_row('group_members', mc) || '{"display_name": "Carol Q"}',
    'C26: and the group creator can too');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(test.t82_row('group_members', mc) ->> 'display_name', 'Carol Q', 'C26: the rename landed');
  PERFORM test.assert_false((test.t82_row('group_members', mc) ->> 'is_deleted')::boolean, 'C26: and the row is still live');

  -- Once it is deleted, neither can bring it back.
  UPDATE public.group_members SET is_deleted = true WHERE id = mc;
  PERFORM test.as_user(alice);
  PERFORM test.t82_refused('group_members', test.t82_row('group_members', mc) || '{"is_deleted": false}',
    'C26: a revive of the deleted row is still refused');
  PERFORM test.as_user(carol);
  PERFORM test.t82_refused('group_members', test.t82_row('group_members', mc) || '{"is_deleted": false}',
    'C26: for the member herself as well');
  PERFORM test.note('082 C26: a rename of a stranded live membership applies; a revive does not');
END;
$$;
