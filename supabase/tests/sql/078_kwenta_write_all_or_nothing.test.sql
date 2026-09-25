-- 078_kwenta_write_all_or_nothing.test.sql
--
-- Migration 078 makes `kwenta_write` all-or-nothing: when any pushed row other than an
-- `activity_log` line is refused (absent from `applied`), the whole call raises and rolls back —
-- the rows that WERE accepted and the submission marker included. Before it, a save whose split
-- was refused stored the bill without that split (a half-written money record the client then
-- mirrored), and the marker made a corrected retry under the same submission id a no-op replay.
-- Pinned here (C22):
--   * one refused split → no bill, no item, no split stored; no kwenta_write_submissions row;
--     the error names the refused row; a retry under the SAME submission id then applies;
--   * an activity_log refusal alone does not fail the write (rule 9: the audit line is exempt);
--   * accepted writes are unchanged (applied, stored, marker recorded);
--   * kwenta_sync is NOT changed: it is the bulk replay path, so the same push stays partial.

SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION test.row_of(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION test.bill_row(p_id uuid, p_creator uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', NULL, 'currency', 'PHP',
    'created_by', p_creator, 'paid_by', p_creator, 'total_amount', 90, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.item_row(p_id uuid, p_bill uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'bill_id', p_bill, 'name', 'thing', 'amount', 90,
    'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL, 'is_deleted', false,
    'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.split_row(p_id uuid, p_item uuid, p_user uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'item_id', p_item, 'user_id', p_user,
    'split_type', 'equal', 'split_value', 1, 'computed_amount', 45, 'created_at', now(),
    'updated_at', now() + interval '1 minute', 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.activity_row(p_id uuid, p_user uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'group_id', NULL, 'user_id', p_user,
    'action', 'created', 'entity_type', 'bill', 'entity_id', gen_random_uuid(),
    'description', 'x', 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;
CREATE OR REPLACE FUNCTION test.submission_count(p_id uuid)
RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.kwenta_write_submissions WHERE submission_id = p_id
$$;

GRANT EXECUTE ON FUNCTION test.row_of(text, uuid), test.bill_row(uuid, uuid, text),
  test.item_row(uuid, uuid), test.split_row(uuid, uuid, uuid), test.activity_row(uuid, uuid),
  test.submission_count(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- C22: one refused split sinks the whole kwenta_write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bob_bill uuid; bob_item uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s_ok1 uuid := gen_random_uuid(); s_ok2 uuid := gen_random_uuid(); s_bad uuid := gen_random_uuid();
  sub uuid := gen_random_uuid();
  push jsonb; good jsonb; res jsonb;
  st text; msg text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w78a-alice@example.com', 'Alice');
  bob   := test.new_account('w78a-bob@example.com', 'Bob');
  bob_bill := test.new_bill(bob, bob, NULL, 'Bob''s dinner', 100, ARRAY[bob]);
  SELECT id INTO bob_item FROM public.bill_items WHERE bill_id = bob_bill;

  good := jsonb_build_object(
    'bills', jsonb_build_array(test.bill_row(nb, alice, 'Lunch')),
    'bill_items', jsonb_build_array(test.item_row(ni, nb)),
    'item_splits', jsonb_build_array(test.split_row(s_ok1, ni, alice), test.split_row(s_ok2, ni, bob)));
  -- The refused row: a split on an item of Bob's personal bill, which Alice may not write (075).
  push := jsonb_set(good, '{item_splits}',
    (good -> 'item_splits') || jsonb_build_array(test.split_row(s_bad, bob_item, alice)));

  PERFORM test.as_user(alice);
  st := NULL; msg := NULL;
  BEGIN
    res := public.kwenta_write(push, sub, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(st IS NOT NULL,
    'C22: kwenta_write raises when one non-activity_log row is refused (got applied: ' || COALESCE((res -> 'applied' -> 'item_splits')::text, 'null') || ')');
  PERFORM test.assert_true(COALESCE(msg LIKE '%' || s_bad::text || '%', false),
    'C22: the error names the refused row (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_eq(test.row_of('bills', nb), NULL::jsonb, 'C22: the bill is not stored');
  PERFORM test.assert_eq(test.row_of('bill_items', ni), NULL::jsonb, 'C22: the item is not stored');
  PERFORM test.assert_eq(test.row_of('item_splits', s_ok1), NULL::jsonb, 'C22: the accepted split is not stored');
  PERFORM test.assert_eq(test.row_of('item_splits', s_bad), NULL::jsonb, 'C22: the refused split is not stored');
  PERFORM test.assert_eq(test.submission_count(sub), 0::bigint, 'C22: no submission marker is recorded');

  -- The marker was not recorded, so a corrected retry under the SAME submission id applies (a
  -- recorded marker would have turned it into a replay of an empty outcome).
  PERFORM test.as_user(alice);
  res := public.kwenta_write(good, sub, '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C22: the corrected retry applies the bill');
  PERFORM test.assert_false(COALESCE((res ->> 'replayed')::boolean, false), 'C22: the corrected retry is not a replay');
  PERFORM test.assert_eq(test.row_of('bills', nb) ->> 'title', 'Lunch', 'C22: the bill is stored after the retry');
  PERFORM test.assert_true(test.row_of('item_splits', s_ok2) IS NOT NULL, 'C22: its splits are stored after the retry');
  PERFORM test.assert_eq(test.submission_count(sub), 1::bigint, 'C22: an accepted write records its marker');

  -- A replay touches no gated table, so 076's write trigger never fires for it: kwenta_write
  -- checks the caller first. An inactive account replaying that submission id gets no echo.
  UPDATE public.profiles SET account_status = 'inactive' WHERE id = alice;
  PERFORM test.as_user(alice);
  res := NULL; st := NULL; msg := NULL;
  BEGIN
    res := public.kwenta_write(good, sub, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18/C22: an inactive caller replaying an existing submission is refused');
  PERFORM test.assert_true(COALESCE(msg LIKE '%kwenta_account_inactive:inactive%', false),
    'C18/C22: the replay refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_eq(res, NULL::jsonb, 'C18/C22: the refused replay returns no echo');
  UPDATE public.profiles SET account_status = 'active' WHERE id = alice;

  PERFORM test.note('078 C22: a refused split rolls back the whole kwenta_write and its marker');
END;
$$;

-- ---------------------------------------------------------------------------
-- C22: an activity_log refusal alone does not fail the write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid(); s1 uuid := gen_random_uuid();
  act uuid := gen_random_uuid(); sub uuid := gen_random_uuid();
  res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w78b-alice@example.com', 'Alice');
  bob   := test.new_account('w78b-bob@example.com', 'Bob');

  PERFORM test.as_user(alice);
  -- A log line authored as Bob is refused by 075's validator; the money rows are fine.
  res := public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.bill_row(nb, alice, 'Taxi')),
    'bill_items', jsonb_build_array(test.item_row(ni, nb)),
    'item_splits', jsonb_build_array(test.split_row(s1, ni, alice)),
    'activity_log', jsonb_build_array(test.activity_row(act, bob))), sub, '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C22: the bill is applied despite the refused log line');
  PERFORM test.assert_false(COALESCE(res -> 'applied' -> 'activity_log' ? act::text, false),
    'C22 precondition: the foreign-authored log line is refused');
  PERFORM test.assert_true(test.row_of('bills', nb) IS NOT NULL, 'C22: the bill is stored');
  PERFORM test.assert_eq(test.row_of('activity_log', act), NULL::jsonb, 'C22: the refused log line is not stored');
  PERFORM test.assert_eq(test.submission_count(sub), 1::bigint, 'C22: the submission is recorded');
  PERFORM test.note('078 C22: activity_log refusals stay exempt');
END;
$$;

-- ---------------------------------------------------------------------------
-- C22: kwenta_sync stays partial — the bulk replay must not be blocked by one bad row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bob_bill uuid; bob_item uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s_ok uuid := gen_random_uuid(); s_bad uuid := gen_random_uuid();
  res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('w78c-alice@example.com', 'Alice');
  bob   := test.new_account('w78c-bob@example.com', 'Bob');
  bob_bill := test.new_bill(bob, bob, NULL, 'Bob''s dinner', 100, ARRAY[bob]);
  SELECT id INTO bob_item FROM public.bill_items WHERE bill_id = bob_bill;

  PERFORM test.as_user(alice);
  res := public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz, jsonb_build_object(
    'bills', jsonb_build_array(test.bill_row(nb, alice, 'Brunch')),
    'bill_items', jsonb_build_array(test.item_row(ni, nb)),
    'item_splits', jsonb_build_array(test.split_row(s_ok, ni, alice), test.split_row(s_bad, bob_item, alice))),
    gen_random_uuid());
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C22: kwenta_sync still applies the accepted bill');
  PERFORM test.assert_true(res -> 'applied' -> 'item_splits' ? s_ok::text, 'C22: kwenta_sync still applies the accepted split');
  PERFORM test.assert_false(res -> 'applied' -> 'item_splits' ? s_bad::text, 'C22: kwenta_sync leaves the refused split out of applied');
  PERFORM test.assert_true(test.row_of('bills', nb) IS NOT NULL, 'C22: kwenta_sync stores the bill (partial by design)');
  PERFORM test.assert_eq(test.row_of('item_splits', s_bad), NULL::jsonb, 'C22: kwenta_sync does not store the refused split');
  PERFORM test.note('078 C22: kwenta_sync stays partial');
END;
$$;
