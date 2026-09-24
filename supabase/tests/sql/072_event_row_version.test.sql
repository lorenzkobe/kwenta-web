-- 072_event_row_version.test.sql
--
-- Migration 072 adds the version of the row that fired a `kwenta_user_events` trigger to the event
-- payload: `row = {table, id, updated_at}`. A client skips the reconcile for an event whose row it
-- already mirrors at exactly that version (its own write's echo), so the three things pinned here
-- are what that skip relies on:
--   1. `row` names the row that CHANGED — for an item or split event that is the item or split,
--      not the bill the event is filed under — and its `updated_at` is the stored value, rendered
--      exactly as every read path renders it (to_jsonb), so a string compare is exact;
--   2. a hard DELETE carries NO row (the item/split triggers report op 'UPDATE' even then, so the
--      client cannot rely on `op` alone);
--   3. nothing else moved: the same recipients, the same existing payload keys.

SET client_min_messages = notice;

CREATE TEMP TABLE seen_events (id uuid PRIMARY KEY);

/** Events emitted since the last call, then marked seen. */
CREATE OR REPLACE FUNCTION test.take_events()
RETURNS SETOF public.kwenta_user_events
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    SELECT e.* FROM public.kwenta_user_events e
    WHERE e.id NOT IN (SELECT id FROM seen_events);
  INSERT INTO seen_events SELECT e.id FROM public.kwenta_user_events e
  ON CONFLICT DO NOTHING;
END;
$$;

/** True when payload.row points at a stored row whose updated_at renders identically. */
CREATE OR REPLACE FUNCTION test.row_version_matches(p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_table text := p_payload -> 'row' ->> 'table';
  v_stored jsonb;
BEGIN
  IF jsonb_typeof(p_payload -> 'row') IS DISTINCT FROM 'object'
     OR v_table NOT IN ('bills', 'bill_items', 'item_splits', 'settlements', 'groups', 'group_members') THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT to_jsonb(t.updated_at) FROM public.%I t WHERE t.id = $1', v_table)
    INTO v_stored USING (p_payload -> 'row' ->> 'id')::uuid;
  RETURN v_stored IS NOT NULL AND v_stored = p_payload -> 'row' -> 'updated_at';
END;
$$;

DO $$
DECLARE
  a uuid; b uuid; c uuid; d uuid;
  bill uuid; item uuid; split_b uuid; g uuid; gm_c uuid; gbill uuid; s uuid;
  n int;
BEGIN
  a := test.new_account('p72-a@example.com', 'Alice');
  b := test.new_account('p72-b@example.com', 'Bob');
  c := test.new_account('p72-c@example.com', 'Cha');
  d := test.new_account('p72-d@example.com', 'Dan');
  PERFORM test.take_events();

  -- Personal bill: bill, item and split rows each carry their OWN row.
  bill := test.new_bill(a, a, NULL, 'dinner', 30, ARRAY[a, b]);
  SELECT id INTO item FROM public.bill_items WHERE bill_id = bill;
  SELECT id INTO split_b FROM public.item_splits WHERE item_id = item AND user_id = b;
  CREATE TEMP TABLE ev1 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) > 0 FROM ev1), 'fixture: a personal bill emits events');
  PERFORM test.assert_true((SELECT bool_and(test.row_version_matches(payload)) FROM ev1),
    'every personal-bill event carries the stored version of the row that fired it');
  PERFORM test.assert_eq(
    (SELECT string_agg(DISTINCT payload -> 'row' ->> 'table', ',' ORDER BY payload -> 'row' ->> 'table') FROM ev1),
    'bill_items,bills,item_splits', 'item and split events name their own table, not the bill');
  PERFORM test.assert_true(
    (SELECT bool_and(entity_type = 'bills' AND entity_id = bill AND payload ->> 'bill_id' = bill::text
                     AND payload ? 'group_id' AND payload -> 'group_id' = 'null'::jsonb) FROM ev1),
    'existing keys are unchanged (entity is the bill, bill_id / group_id kept)');
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM ev1 WHERE payload -> 'row' ->> 'id' = split_b::text AND user_id = b),
    'the split holder is notified with the split row');
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev1), ARRAY[a, b],
    'personal bill recipients: creator and split holders');
  DROP TABLE ev1;

  -- An UPDATE carries the NEW version.
  UPDATE public.bills SET title = 'dinner!', updated_at = updated_at + interval '1 second' WHERE id = bill;
  CREATE TEMP TABLE ev2 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) = 2 AND bool_and(test.row_version_matches(payload)) FROM ev2),
    'a bill update reaches creator and split holder with the new version');

  -- Soft-deleting a split still reaches its (now former) holder (033), with the row.
  UPDATE public.item_splits SET is_deleted = true, updated_at = updated_at + interval '1 second' WHERE id = split_b;
  CREATE TEMP TABLE ev3 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM ev3 WHERE user_id = b AND test.row_version_matches(payload)
                                AND payload -> 'row' ->> 'id' = split_b::text),
    'a soft-deleted split still notifies its holder, carrying the split version');

  -- A HARD delete carries no row, although the split trigger reports op UPDATE.
  DELETE FROM public.item_splits WHERE id = split_b;
  CREATE TEMP TABLE ev4 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) > 0 FROM ev4), 'fixture: a hard split delete emits events');
  PERFORM test.assert_true(
    (SELECT bool_and(jsonb_typeof(payload -> 'row') IS DISTINCT FROM 'object') FROM ev4),
    'a hard-deleted split carries no row version');
  PERFORM test.assert_true((SELECT bool_and(op = 'UPDATE') FROM ev4),
    'precondition: the split trigger reports a hard delete as op UPDATE (why the client cannot key on op)');
  DELETE FROM public.item_splits WHERE item_id = item;
  DELETE FROM public.bill_items WHERE id = item;
  CREATE TEMP TABLE ev5 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT bool_and(jsonb_typeof(payload -> 'row') IS DISTINCT FROM 'object') FROM ev5),
    'a hard-deleted item carries no row version');
  DELETE FROM public.bills WHERE id = bill;
  CREATE TEMP TABLE ev6 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) > 0 AND bool_and(jsonb_typeof(payload -> 'row') IS DISTINCT FROM 'object'
                                                             AND op = 'DELETE') FROM ev6),
    'a hard-deleted bill carries no row version');

  -- Groups: a membership change emits a group_members event AND a groups event; both carry the
  -- MEMBER row (the groups event is a refresh hint caused by that row, not a group-row change).
  g := test.new_group(a, 'Trip');
  PERFORM test.add_member(g, a, 'Alice');
  PERFORM test.add_member(g, b, 'Bob');
  PERFORM test.take_events();
  gm_c := test.add_member(g, c, 'Cha');
  CREATE TEMP TABLE ev7 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true(
    (SELECT bool_and(payload -> 'row' ->> 'table' = 'group_members' AND payload -> 'row' ->> 'id' = gm_c::text
                     AND test.row_version_matches(payload) AND payload ->> 'group_id' = g::text) FROM ev7),
    'both events of a membership change carry the member row and keep group_id');
  PERFORM test.assert_eq((SELECT string_agg(DISTINCT entity_type, ',' ORDER BY entity_type) FROM ev7),
    'group_members,groups', 'a membership change still emits both entity types');
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev7), ARRAY[a, b, c],
    'membership events reach every active member');

  UPDATE public.groups SET name = 'Trip!', updated_at = updated_at + interval '1 second' WHERE id = g;
  CREATE TEMP TABLE ev8 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true(
    (SELECT count(*) = 3 AND bool_and(payload -> 'row' ->> 'table' = 'groups' AND test.row_version_matches(payload)) FROM ev8),
    'a group update carries the group row to every active member');

  -- Group bill and group settlement: active members only (a removed member hears nothing).
  UPDATE public.group_members SET is_deleted = true, updated_at = updated_at + interval '1 second' WHERE id = gm_c;
  PERFORM test.take_events();
  gbill := test.new_bill(b, b, g, 'hotel', 90, ARRAY[a, b]);
  CREATE TEMP TABLE ev9 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT bool_and(test.row_version_matches(payload) AND payload ->> 'group_id' = g::text) FROM ev9),
    'group bill events carry their rows and keep group_id');
  PERFORM test.assert_ids(ARRAY(SELECT DISTINCT user_id FROM ev9), ARRAY[a, b],
    'group bill events reach active members only');

  s := test.new_settlement(a, b, 10, g);
  CREATE TEMP TABLE ev10 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) = 2 AND bool_and(test.row_version_matches(payload)
                             AND payload -> 'row' ->> 'id' = s::text AND payload ->> 'group_id' = g::text) FROM ev10),
    'a group settlement carries its row to active members');

  s := test.new_settlement(c, d, 5);
  CREATE TEMP TABLE ev11 AS SELECT * FROM test.take_events();
  PERFORM test.assert_ids(ARRAY(SELECT user_id FROM ev11), ARRAY[c, d], 'a personal settlement reaches both parties');
  PERFORM test.assert_true((SELECT bool_and(test.row_version_matches(payload)
                             AND payload ->> 'from_user_id' = c::text AND payload ->> 'to_user_id' = d::text) FROM ev11),
    'a personal settlement carries its row and keeps from/to');
  DELETE FROM public.settlements WHERE id = s;
  CREATE TEMP TABLE ev12 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) = 2 AND bool_and(jsonb_typeof(payload -> 'row') IS DISTINCT FROM 'object') FROM ev12),
    'a hard-deleted settlement carries no row version');

  DELETE FROM public.group_members WHERE id = gm_c;
  CREATE TEMP TABLE ev13 AS SELECT * FROM test.take_events();
  PERFORM test.assert_true((SELECT count(*) > 0 AND bool_and(jsonb_typeof(payload -> 'row') IS DISTINCT FROM 'object') FROM ev13),
    'a hard-deleted membership carries no row version on either event');
END;
$$;

-- The personal fanout takes its caller's row now; it stays server-internal.
DO $$
DECLARE
  fn regprocedure;
BEGIN
  SELECT p.oid::regprocedure INTO fn FROM pg_proc p
  WHERE p.proname = 'kwenta_fanout_personal_bill_participants' AND p.pronamespace = 'public'::regnamespace;
  PERFORM test.assert_eq((SELECT count(*) FROM pg_proc p WHERE p.proname = 'kwenta_fanout_personal_bill_participants'
                           AND p.pronamespace = 'public'::regnamespace), 1::bigint,
    'exactly one kwenta_fanout_personal_bill_participants (the old signature is dropped)');
  PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'),
    'the personal fanout is not executable by authenticated');
  PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'),
    'the personal fanout is not executable by anon');
  -- The event writers. The harness has no Supabase default privileges, so these pass even without
  -- 072's explicit revokes; whether production had granted them must be checked on a branch DB.
  PERFORM test.assert_false(has_function_privilege('authenticated',
    'public.kwenta_emit_user_event(uuid, text, text, uuid, text, jsonb)', 'EXECUTE'),
    'kwenta_emit_user_event is not executable by authenticated');
  PERFORM test.assert_false(has_function_privilege('authenticated',
    'public.kwenta_fanout_group_event(uuid, text, text, uuid, text, jsonb)', 'EXECUTE'),
    'kwenta_fanout_group_event is not executable by authenticated');
END;
$$;
