-- 081_base_version_conflicts.test.sql
--
-- Migration 081: a row pushed through kwenta_write may carry `_base_updated_at` — the server
-- version the client built the edit from. Written from the requirements, blind to the migration:
--   C1  a base that differs from the stored updated_at refuses the WHOLE call (P0001, 'changed on
--       another device'), nothing is stored and no kwenta_write_submissions row is recorded;
--   C2  a matching base applies and the stored updated_at is SERVER-stamped (> the previous stored
--       version), whatever the client's updated_at says — years ahead or years behind;
--   C3  rows without a base behave exactly as before: the client's updated_at is stored, and 021b
--       keeps a newer stored row over an older incoming one; new rows are unaffected;
--   C4  a base on a row that does not exist yet is ignored (the insert proceeds);
--   C5  a soft-deleted server row cannot be un-deleted by a stale edit carrying the old base;
--   C6  the key never reaches a table, and kwenta_sync ignores bases (unchanged);
--   C7  a replay under the same submission id still returns the original outcome;
--   C17 a contact link pushed ALONE through kwenta_write still rewrites splits, payers, payments
--       and memberships server-side (045's trigger).
--
-- Rows: every push row for an EXISTING row is the stored row itself (to_jsonb of the table row,
-- i.e. the shape the pull bundle hands the client) with the edited columns overlaid. Hand-made
-- rows are only the NEW bills/items in C1/C3/C4, which copy 078's suite's column shape.

SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION test.t81_row(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;
CREATE OR REPLACE FUNCTION test.t81_new_bill(p_id uuid, p_creator uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', NULL, 'currency', 'PHP',
    'created_by', p_creator, 'paid_by', p_creator, 'total_amount', 90, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.t81_submissions(p_id uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.kwenta_write_submissions WHERE submission_id = p_id
$$;
-- kwenta_write as the CURRENT role (call after test.as_user): {state, msg, detail, res}. The inner
-- BEGIN/EXCEPTION is a savepoint, so a refused call leaves exactly what the real rollback leaves.
CREATE OR REPLACE FUNCTION test.t81_write(p_push jsonb, p_sub uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text; msg text; det text;
BEGIN
  BEGIN
    r := public.kwenta_write(p_push, p_sub, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT, det = PG_EXCEPTION_DETAIL;
  END;
  RETURN jsonb_build_object('state', st, 'msg', msg, 'detail', det, 'res', r);
END;
$$;
-- The edit a device sends: the stored row it loaded, edited columns overlaid, plus its base.
CREATE OR REPLACE FUNCTION test.t81_edit(p_loaded jsonb, p_changes jsonb, p_base text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT (p_loaded || p_changes)
    || CASE WHEN p_base IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_base_updated_at', p_base) END
$$;

GRANT EXECUTE ON FUNCTION test.t81_row(text, uuid), test.t81_new_bill(uuid, uuid, text),
  test.t81_submissions(uuid), test.t81_write(jsonb, uuid), test.t81_edit(jsonb, jsonb, text)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- C1: a stale base refuses the whole call — the edited row, a matching row and a new row alike.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; b2 uuid; nb uuid := gen_random_uuid(); sub uuid := gen_random_uuid();
  loaded jsonb; loaded2 jsonb; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81a-alice@example.com', 'Alice');
  b  := test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice]);
  b2 := test.new_bill(alice, alice, NULL, 'Taxi', 40, ARRAY[alice]);
  loaded  := test.t81_row('bills', b);
  loaded2 := test.t81_row('bills', b2);
  -- Another device edits the bill after this device loaded it.
  UPDATE public.bills SET title = 'Dinner (other device)', updated_at = (loaded ->> 'updated_at')::timestamptz + interval '5 seconds'
  WHERE id = b;

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
      test.t81_edit(loaded, jsonb_build_object('title', 'Dinner (mine)', 'updated_at', now() + interval '1 minute'),
        loaded ->> 'updated_at'),
      test.t81_edit(loaded2, jsonb_build_object('title', 'Taxi (mine)', 'updated_at', now() + interval '1 minute'),
        loaded2 ->> 'updated_at'),
      test.t81_new_bill(nb, alice, 'Brand new'))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001',
    'C1: a base that differs from the stored version is refused with P0001 (got: ' || out::text || ')');
  PERFORM test.assert_true(COALESCE(out ->> 'msg' LIKE '%changed on another device%', false),
    'C1: the refusal says the row was changed on another device (got: ' || COALESCE(out ->> 'msg', 'null') || ')');
  PERFORM test.assert_true(COALESCE(out ->> 'detail' LIKE '%' || b::text || '%', false),
    'C1: the DETAIL names the conflicting row (got: ' || COALESCE(out ->> 'detail', 'null') || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Dinner (other device)',
    'C1: the other device''s edit survives');
  PERFORM test.assert_eq(test.t81_row('bills', b2) ->> 'title', 'Taxi',
    'C1: the matching-base row in the same call is rolled back too');
  PERFORM test.assert_eq(test.t81_row('bills', nb), NULL::jsonb, 'C1: the new row in the same call is not stored');
  PERFORM test.assert_eq(test.t81_submissions(sub), 0::bigint, 'C1: no submission marker is recorded');

  -- A base one microsecond off is still a different version.
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
      test.t81_edit(test.t81_row('bills', b), jsonb_build_object('title', 'Off by 1us'),
        ((test.t81_row('bills', b) ->> 'updated_at')::timestamptz - interval '1 microsecond')::text))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001', 'C1: a base 1us older than the stored version is refused (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Dinner (other device)', 'C1: the 1us-stale edit is not stored');
  PERFORM test.note('081 C1: a stale base refuses the whole call, marker included');
END;
$$;

-- C1 on a child table: a stale item edit sinks the bill edit sent with it.
DO $$
DECLARE
  alice uuid; b uuid; it uuid; sub uuid := gen_random_uuid();
  lb jsonb; li jsonb; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81b-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Groceries', 100, ARRAY[alice]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  lb := test.t81_row('bills', b);
  li := test.t81_row('bill_items', it);
  UPDATE public.bill_items SET amount = 120, updated_at = (li ->> 'updated_at')::timestamptz + interval '3 seconds' WHERE id = it;

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object(
    'bills', jsonb_build_array(test.t81_edit(lb, jsonb_build_object('title', 'Groceries (mine)'), lb ->> 'updated_at')),
    'bill_items', jsonb_build_array(test.t81_edit(li, jsonb_build_object('amount', 90), li ->> 'updated_at'))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001', 'C1: a stale bill_items base is refused (got: ' || out::text || ')');
  PERFORM test.assert_money((test.t81_row('bill_items', it) ->> 'amount')::numeric, 120.00, 'C1: the newer item amount survives');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Groceries', 'C1: the bill edit in the same call is rolled back');
  PERFORM test.assert_eq(test.t81_submissions(sub), 0::bigint, 'C1: no marker for the refused child-table write');
  PERFORM test.note('081 C1: child-table conflicts refuse the call too');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2: a matching base applies; the stored version is the server's, not the client's clock.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; c uuid; loaded jsonb; out jsonb; prev timestamptz; stored timestamptz;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81c-alice@example.com', 'Alice');

  -- Client clock years AHEAD.
  b := test.new_bill(alice, alice, NULL, 'Hotel', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', b);
  prev := (loaded ->> 'updated_at')::timestamptz;
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Hotel (edited)', 'updated_at', '2099-01-01T00:00:00Z'),
      loaded ->> 'updated_at'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C2: a matching base is accepted (got: ' || out::text || ')');
  PERFORM test.assert_true(out -> 'res' -> 'applied' -> 'bills' ? b::text, 'C2: the bill is in applied');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Hotel (edited)', 'C2: the edit is stored');
  stored := (test.t81_row('bills', b) ->> 'updated_at')::timestamptz;
  PERFORM test.assert_true(stored > prev, 'C2: the stored version moves past the previous one (prev ' || prev || ', now ' || stored || ')');
  PERFORM test.assert_true(stored <= clock_timestamp(),
    'C2: a client clock years ahead does not decide the stored version (stored ' || stored || ')');

  -- Client clock years BEHIND: 021b alone would keep the stored row and drop this edit.
  c := test.new_bill(alice, alice, NULL, 'Flight', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', c);
  prev := (loaded ->> 'updated_at')::timestamptz;
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Flight (edited)', 'updated_at', '2001-01-01T00:00:00Z'),
      loaded ->> 'updated_at'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C2: a matching base with a past client clock is accepted (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', c) ->> 'title', 'Flight (edited)',
    'C2: a client clock years behind still applies the edit');
  stored := (test.t81_row('bills', c) ->> 'updated_at')::timestamptz;
  PERFORM test.assert_true(stored > prev, 'C2: the stored version is server-stamped past the previous one (prev ' || prev || ', now ' || stored || ')');
  PERFORM test.assert_true(stored <= clock_timestamp(), 'C2: and not after the server''s clock');

  -- The echo carries the stored (server) version, so the device mirrors the version it will base on next.
  PERFORM test.assert_true(
    COALESCE((SELECT bool_or((e ->> 'updated_at')::timestamptz = stored)
              FROM jsonb_array_elements(COALESCE(out -> 'res' -> 'bills', '[]'::jsonb)) e
              WHERE e ->> 'id' = c::text), false),
    'C2: the write echo returns the server-stamped version (got: ' || COALESCE((out -> 'res' -> 'bills')::text, 'null') || ')');

  -- A second edit based on the stamped version is accepted (the next save from the same device).
  loaded := test.t81_row('bills', c);
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Flight (twice)'), loaded ->> 'updated_at'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C2: an edit based on the stamped version applies (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', c) ->> 'title', 'Flight (twice)', 'C2: the second edit is stored');
  PERFORM test.note('081 C2: matching base applies with a server-stamped version');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: no base = today's behaviour.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; nb uuid := gen_random_uuid(); loaded jsonb; out jsonb;
  prev timestamptz; client_at timestamptz;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81d-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Rent', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', b);
  prev := (loaded ->> 'updated_at')::timestamptz;

  -- Older incoming row, no base: 021b keeps the stored row; the call itself succeeds.
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Rent (stale)', 'updated_at', prev - interval '1 hour'), NULL))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C3: an older row without a base is not refused (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Rent', 'C3: 021b keeps the newer stored row');
  PERFORM test.assert_eq((test.t81_row('bills', b) ->> 'updated_at')::timestamptz, prev, 'C3: the stored version is unchanged');

  -- Newer incoming row, no base: stored with the CLIENT's updated_at, exactly.
  client_at := prev + interval '10 minutes';
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Rent (newer)', 'updated_at', client_at), NULL))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C3: a newer row without a base applies (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Rent (newer)', 'C3: the newer edit is stored');
  PERFORM test.assert_eq((test.t81_row('bills', b) ->> 'updated_at')::timestamptz, client_at,
    'C3: without a base the client''s updated_at is stored as sent');

  -- A new row: stored with its own updated_at.
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(test.t81_new_bill(nb, alice, 'New'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C3: a new row applies (got: ' || out::text || ')');
  PERFORM test.assert_eq((test.t81_row('bills', nb) ->> 'updated_at')::timestamptz, now() + interval '1 minute',
    'C3: a new row keeps the updated_at it was sent with');
  PERFORM test.note('081 C3: rows without a base keep 021b semantics');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: a base on a row that does not exist yet is ignored.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; nb uuid := gen_random_uuid(); sub uuid := gen_random_uuid(); out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81e-alice@example.com', 'Alice');
  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_new_bill(nb, alice, 'Fresh') || jsonb_build_object('_base_updated_at', '2020-01-01T00:00:00Z'))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C4: a base on a missing row does not refuse the call (got: ' || out::text || ')');
  PERFORM test.assert_true(out -> 'res' -> 'applied' -> 'bills' ? nb::text, 'C4: the new row is applied');
  PERFORM test.assert_eq(test.t81_row('bills', nb) ->> 'title', 'Fresh', 'C4: the new row is stored');
  PERFORM test.assert_eq(test.t81_submissions(sub), 1::bigint, 'C4: the submission is recorded');
  PERFORM test.note('081 C4: a base on a not-yet-existing row is ignored');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5: a stale edit cannot un-delete a row another device deleted — even with a clock years ahead.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; loaded jsonb; out jsonb; sub uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81f-alice@example.com', 'Alice');
  bob   := test.new_account('b81f-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(alice, alice, g, 'Boat', 100, ARRAY[alice, bob]);
  loaded := test.t81_row('bills', b);
  -- Bob deletes it on his device.
  UPDATE public.bills SET is_deleted = true, updated_at = (loaded ->> 'updated_at')::timestamptz + interval '2 seconds'
  WHERE id = b;

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Boat (edited)', 'is_deleted', false, 'updated_at', '2099-01-01T00:00:00Z'),
      loaded ->> 'updated_at'))), sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', 'P0001', 'C5: a stale edit of a deleted row is refused (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'is_deleted', 'true', 'C5: the row stays deleted');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Boat', 'C5: the stale edit is not stored');
  PERFORM test.assert_eq(test.t81_submissions(sub), 0::bigint, 'C5: no marker for the refused un-delete');
  PERFORM test.note('081 C5: a stale edit cannot resurrect a deleted row');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: the key is never stored, and kwenta_sync ignores bases.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; c uuid; nb uuid := gen_random_uuid(); loaded jsonb; out jsonb; res jsonb;
  prev timestamptz; client_at timestamptz;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81g-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Gym', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', b);

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Gym (edited)'), loaded ->> 'updated_at'),
    test.t81_new_bill(nb, alice, 'Pool') || jsonb_build_object('_base_updated_at', now()::text))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C6: rows carrying the key are accepted (got: ' || out::text || ')');
  PERFORM test.assert_false(test.t81_row('bills', b) ? '_base_updated_at', 'C6: the edited row has no _base_updated_at column');
  PERFORM test.assert_false(test.t81_row('bills', nb) ? '_base_updated_at', 'C6: the new row has no _base_updated_at column');
  PERFORM test.assert_false(
    COALESCE((SELECT bool_or(e ? '_base_updated_at') FROM jsonb_array_elements(COALESCE(out -> 'res' -> 'bills', '[]'::jsonb)) e), false),
    'C6: the write echo carries no _base_updated_at');

  -- kwenta_sync: a STALE base with a newer client clock applies exactly as 021b decides today.
  c := test.new_bill(alice, alice, NULL, 'Spa', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', c);
  prev := (loaded ->> 'updated_at')::timestamptz;
  UPDATE public.bills SET title = 'Spa (other device)', updated_at = prev + interval '1 second' WHERE id = c;
  client_at := prev + interval '1 hour';
  PERFORM test.as_user(alice);
  res := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz, jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Spa (sync)', 'updated_at', client_at), loaded ->> 'updated_at'))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? c::text, 'C6: kwenta_sync does not refuse a stale base');
  PERFORM test.assert_eq(test.t81_row('bills', c) ->> 'title', 'Spa (sync)', 'C6: kwenta_sync applies the newer-clock row');
  PERFORM test.assert_eq((test.t81_row('bills', c) ->> 'updated_at')::timestamptz, client_at,
    'C6: kwenta_sync stores the client''s updated_at (no server stamp)');
  PERFORM test.assert_false(test.t81_row('bills', c) ? '_base_updated_at', 'C6: kwenta_sync stores no key either');

  -- kwenta_sync: a MATCHING base with an older client clock is still dropped by 021b.
  loaded := test.t81_row('bills', c);
  PERFORM test.as_user(alice);
  res := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz, jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Spa (old clock)', 'updated_at', '2001-01-01T00:00:00Z'), loaded ->> 'updated_at'))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(test.t81_row('bills', c) ->> 'title', 'Spa (sync)', 'C6: kwenta_sync keeps 021b for a matching base');
  PERFORM test.assert_eq((test.t81_row('bills', c) ->> 'updated_at')::timestamptz, client_at, 'C6: kwenta_sync does not stamp');
  PERFORM test.note('081 C6: key never stored; kwenta_sync unchanged');
END;
$$;

-- ---------------------------------------------------------------------------
-- C7: a replay under the same submission id returns the original outcome, though its base is
-- now stale (the first call moved the version).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; loaded jsonb; push jsonb; out jsonb; out2 jsonb; sub uuid := gen_random_uuid();
  after_first jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81h-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Concert', 100, ARRAY[alice]);
  loaded := test.t81_row('bills', b);
  push := jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Concert (edited)'), loaded ->> 'updated_at')));

  PERFORM test.as_user(alice);
  out := test.t81_write(push, sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C7 precondition: the first submission applies (got: ' || out::text || ')');
  after_first := test.t81_row('bills', b);

  PERFORM test.as_user(alice);
  out2 := test.t81_write(push, sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out2 ->> 'state', NULL::text, 'C7: the replay is not refused as a conflict (got: ' || out2::text || ')');
  PERFORM test.assert_true(COALESCE((out2 -> 'res' ->> 'replayed')::boolean, false), 'C7: the replay is reported as a replay');
  PERFORM test.assert_eq(out2 -> 'res' -> 'applied', out -> 'res' -> 'applied', 'C7: the replay returns the original applied ids');
  PERFORM test.assert_eq(test.t81_row('bills', b), after_first, 'C7: the replay changes nothing');
  PERFORM test.assert_eq(test.t81_submissions(sub), 1::bigint, 'C7: one marker');
  PERFORM test.note('081 C7: replay returns the original outcome');
END;
$$;

-- ---------------------------------------------------------------------------
-- C17: a contact link pushed alone still canonicalizes every row server-side (045).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c uuid; g uuid; m uuid; b uuid; it uuid; sp uuid; s_from uuid; s_to uuid;
  loaded jsonb; out jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81i-alice@example.com', 'Alice');
  bob   := test.new_account('b81i-bob@example.com', 'Bob');
  c := test.new_contact(alice, 'Bobby');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m := test.add_member(g, c, 'Bobby');
  b := test.new_bill(alice, c, NULL, 'Lunch', 100, ARRAY[alice, c]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  SELECT id INTO sp FROM public.item_splits WHERE item_id = it AND user_id = c;
  s_from := test.new_settlement(c, alice, 10);
  s_to   := test.new_settlement(alice, c, 5);
  loaded := test.t81_row('profiles', c);

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('profiles', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('linked_profile_id', bob, 'updated_at', now() + interval '1 minute'),
      loaded ->> 'updated_at'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C17: the link applies (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('profiles', c) ->> 'linked_profile_id', bob::text, 'C17: the contact is linked');
  PERFORM test.assert_eq(test.t81_row('item_splits', sp) ->> 'user_id', bob::text, 'C17: the split is rewritten to the account');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'paid_by', bob::text, 'C17: the payer is rewritten to the account');
  PERFORM test.assert_eq(test.t81_row('settlements', s_from) ->> 'from_user_id', bob::text, 'C17: settlement from_user_id is rewritten');
  PERFORM test.assert_eq(test.t81_row('settlements', s_to) ->> 'to_user_id', bob::text, 'C17: settlement to_user_id is rewritten');
  PERFORM test.assert_eq(test.t81_row('group_members', m) ->> 'user_id', bob::text, 'C17: the membership is rewritten');
  PERFORM test.note('081 C17: a link alone canonicalizes splits, payers, payments, memberships');
END;
$$;

-- ---------------------------------------------------------------------------
-- C19: a link rewrites rows whose stored updated_at is in the FUTURE (a fast client clock wrote
-- them). 045 stamps now(), which 021b would otherwise discard for exactly these rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; c uuid; g uuid; m uuid; b uuid; it uuid; sp uuid; s_from uuid;
  loaded jsonb; out jsonb; future timestamptz := now() + interval '1 year';
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81j-alice@example.com', 'Alice');
  bob   := test.new_account('b81j-bob@example.com', 'Bob');
  c := test.new_contact(alice, 'Bobby');
  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  m := test.add_member(g, c, 'Bobby');
  b := test.new_bill(alice, c, NULL, 'Lunch', 100, ARRAY[alice, c]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  SELECT id INTO sp FROM public.item_splits WHERE item_id = it AND user_id = c;
  s_from := test.new_settlement(c, alice, 10);
  -- Rows a device with a clock a year ahead wrote (021b let them in as "newest").
  UPDATE public.item_splits SET updated_at = future WHERE id = sp;
  UPDATE public.bills SET updated_at = future WHERE id = b;
  UPDATE public.settlements SET updated_at = future WHERE id = s_from;
  UPDATE public.group_members SET updated_at = future WHERE id = m;
  loaded := test.t81_row('profiles', c);

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('profiles', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('linked_profile_id', bob), loaded ->> 'updated_at'))), gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C19: the link applies (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('item_splits', sp) ->> 'user_id', bob::text,
    'C19: a split with a future updated_at is still rewritten to the account');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'paid_by', bob::text,
    'C19: a payer on a future-stamped bill is still rewritten');
  PERFORM test.assert_eq(test.t81_row('settlements', s_from) ->> 'from_user_id', bob::text,
    'C19: a future-stamped settlement is still rewritten');
  PERFORM test.assert_eq(test.t81_row('group_members', m) ->> 'user_id', bob::text,
    'C19: a future-stamped membership is still rewritten');
  PERFORM test.note('081 C19: link rewrites survive future-stamped rows');
END;
$$;

-- ---------------------------------------------------------------------------
-- C20: a replay with the SAME bases (now stale: the first apply moved the versions) returns the
-- original outcome for a multi-table write. The base check runs only on a first apply.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; it uuid; lb jsonb; li jsonb; push jsonb; out jsonb; out2 jsonb;
  sub uuid := gen_random_uuid(); bill_after jsonb; item_after jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81k-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Museum', 100, ARRAY[alice]);
  SELECT id INTO it FROM public.bill_items WHERE bill_id = b;
  lb := test.t81_row('bills', b);
  li := test.t81_row('bill_items', it);
  push := jsonb_build_object(
    'bills', jsonb_build_array(test.t81_edit(lb, jsonb_build_object('title', 'Museum (edited)', 'total_amount', 80), lb ->> 'updated_at')),
    'bill_items', jsonb_build_array(test.t81_edit(li, jsonb_build_object('amount', 80), li ->> 'updated_at')));

  PERFORM test.as_user(alice);
  out := test.t81_write(push, sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C20 precondition: the first apply succeeds (got: ' || out::text || ')');
  bill_after := test.t81_row('bills', b);
  item_after := test.t81_row('bill_items', it);

  PERFORM test.as_user(alice);
  out2 := test.t81_write(push, sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out2 ->> 'state', NULL::text, 'C20: a replay with the same bases is not refused (got: ' || out2::text || ')');
  PERFORM test.assert_true(COALESCE((out2 -> 'res' ->> 'replayed')::boolean, false), 'C20: it is reported as a replay');
  PERFORM test.assert_eq(out2 -> 'res' -> 'applied', out -> 'res' -> 'applied', 'C20: the original applied ids are returned');
  PERFORM test.assert_eq(test.t81_row('bills', b), bill_after, 'C20: the replay does not touch the bill');
  PERFORM test.assert_eq(test.t81_row('bill_items', it), item_after, 'C20: the replay does not touch the item');
  PERFORM test.note('081 C20: replays skip the base check');
END;
$$;

-- ---------------------------------------------------------------------------
-- C23: `_overwrite: true` (the user's explicit "apply mine" retry) skips the base check and is
-- server-stamped, so it changes the stored row even when its client updated_at is OLDER.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; b uuid; loaded jsonb; out jsonb; v1 timestamptz; stored timestamptz; sub uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('b81l-alice@example.com', 'Alice');
  b := test.new_bill(alice, alice, NULL, 'Bike', 100, ARRAY[alice]);
  -- Fixtures are stamped now() and the whole file is one transaction, so age the row first: a
  -- stored version in the future could never be "<= the server clock" after a server stamp.
  -- 021b refuses to move a version backwards, so lift it for this one fixture edit.
  ALTER TABLE public.bills DISABLE TRIGGER kwenta_server_wins_bills;
  UPDATE public.bills SET updated_at = now() - interval '1 hour' WHERE id = b;
  ALTER TABLE public.bills ENABLE TRIGGER kwenta_server_wins_bills;
  loaded := test.t81_row('bills', b);
  v1 := (loaded ->> 'updated_at')::timestamptz + interval '30 seconds';
  UPDATE public.bills SET title = 'Bike (other device)', updated_at = v1 WHERE id = b;

  PERFORM test.as_user(alice);
  out := test.t81_write(jsonb_build_object('bills', jsonb_build_array(
    test.t81_edit(loaded, jsonb_build_object('title', 'Bike (mine)', '_overwrite', true), NULL))),
    sub);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(out ->> 'state', NULL::text, 'C23: an overwrite row is not refused (got: ' || out::text || ')');
  PERFORM test.assert_eq(test.t81_row('bills', b) ->> 'title', 'Bike (mine)',
    'C23: the overwrite replaces the newer stored row although its client updated_at is older');
  stored := (test.t81_row('bills', b) ->> 'updated_at')::timestamptz;
  PERFORM test.assert_true(stored > v1, 'C23: the overwrite is server-stamped past the stored version (stored ' || stored || ', was ' || v1 || ')');
  PERFORM test.assert_true(stored <= clock_timestamp(), 'C23: and not after the server clock');
  PERFORM test.assert_false(test.t81_row('bills', b) ? '_overwrite', 'C23: the _overwrite key is never stored');
  PERFORM test.assert_eq(test.t81_submissions(sub), 1::bigint, 'C23: the overwrite records its marker');
  PERFORM test.note('081 C23: _overwrite skips the base check and is server-stamped');
END;
$$;

-- C24 (rows carrying a base or _overwrite are locked FOR UPDATE) needs two concurrent sessions.
-- This harness runs one session per file, so C24 is NOT covered here.
