-- 076_account_active_enforcement.test.sql
--
-- Migration 076 enforces `profiles.account_status` on the SERVER. Before it, the only check was a
-- client-side gate at app open, so an inactive (or unconfirmed) account holding a valid JWT could
-- read and write everything through PostgREST. Pinned here:
--   C18  an inactive caller reads 0 rows from every synced table (except its own profile) and
--        from kwenta_user_events / kwenta_notifications / kwenta_write_submissions; kwenta_write,
--        kwenta_sync and a direct profiles UPDATE are refused (42501,
--        `kwenta_account_inactive:<status>`) with the stored rows byte-identical; the read gate is
--        a RESTRICTIVE policy in the `(SELECT kwenta_caller_is_active())` form, and the write gate
--        a statement-level BEFORE INSERT/UPDATE/DELETE trigger on all ten tables.
--   C19  active callers are unaffected, and so is every writer with auth.uid() NULL
--        (handle_new_user on signup, the prune jobs, owner/service-side maintenance).
--   C33  kwenta_my_account_status still answers for an inactive caller; kwenta_pre_request refuses
--        every other request path with `kwenta_account_inactive:<status>`.
--
-- account_status values come from 025's CHECK: 'unconfirmed' | 'inactive' | 'active'.
-- Every read assertion runs under test.as_user — as the owner RLS does not apply (rule 11).

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers (this file's transaction is rolled back, so they vanish with it)
-- ---------------------------------------------------------------------------

/** Set a status the way an admin/server would: as the owner, auth.uid() NULL. */
CREATE OR REPLACE FUNCTION test.set_status(p_uid uuid, p_status text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.profiles SET account_status = p_status WHERE id = p_uid;
END;
$$;

/** Row count of a table as the CURRENT role (RLS applies after test.as_user). */
CREATE OR REPLACE FUNCTION test.visible_count(p_table text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I', p_table) INTO n;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION test.row_of(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION test.bill_push(p_bill uuid, p_item uuid, p_split uuid, p_creator uuid, p_title text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'bills', jsonb_build_array(jsonb_build_object('id', p_bill, 'title', p_title, 'group_id', NULL,
      'currency', 'PHP', 'created_by', p_creator, 'paid_by', p_creator, 'total_amount', 90,
      'note', '', 'category', NULL, 'created_at', now(), 'updated_at', now() + interval '1 minute',
      'synced_at', NULL, 'is_deleted', false, 'device_id', 'test')),
    'bill_items', jsonb_build_array(jsonb_build_object('id', p_item, 'bill_id', p_bill, 'name', 'thing',
      'amount', 90, 'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')),
    'item_splits', jsonb_build_array(jsonb_build_object('id', p_split, 'item_id', p_item,
      'user_id', p_creator, 'split_type', 'equal', 'split_value', 1, 'computed_amount', 90,
      'created_at', now(), 'updated_at', now() + interval '1 minute', 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')))
$$;

GRANT EXECUTE ON FUNCTION test.set_status(uuid, text), test.visible_count(text),
  test.row_of(text, uuid), test.bill_push(uuid, uuid, uuid, uuid, text) TO authenticated;

-- One account that owns a row in every table the gate covers.
CREATE TEMP TABLE fx (k text PRIMARY KEY, v uuid);
GRANT SELECT ON fx TO authenticated;

DO $$
DECLARE
  ina uuid; bob uuid; contact uuid; g uuid; b uuid; s uuid; link uuid := gen_random_uuid();
  sub uuid := gen_random_uuid();
BEGIN
  PERFORM test.as_owner();
  ina := test.new_account('a76-ina@example.com', 'Ina');
  bob := test.new_account('a76-bob@example.com', 'Bob');
  contact := test.new_contact(ina, 'Cha');
  g := test.new_group(ina, 'Trip');
  PERFORM test.add_member(g, ina, 'Ina');
  PERFORM test.add_member(g, bob, 'Bob');
  b := test.new_bill(ina, ina, NULL, 'Dinner', 100, ARRAY[ina, contact]);
  PERFORM test.new_bill(bob, bob, g, 'Hotel', 90, ARRAY[ina, bob]);
  s := test.new_settlement(contact, ina, 10);
  PERFORM test.log_settled(s, ina);
  INSERT INTO public.profile_peer_links (id, owner_user_id, anchor_profile_id, peer_profile_id,
    created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (link, ina, contact, bob, now(), now(), now(), false, 'test');
  INSERT INTO public.kwenta_notifications (recipient_id, actor_id, kind, title, body)
  VALUES (ina, bob, 'bill_participant', 't', 'b');
  INSERT INTO public.kwenta_write_submissions (submission_id, actor_user_id, applied_ids)
  VALUES (sub, ina, '{}'::jsonb);
  INSERT INTO fx VALUES ('ina', ina), ('bob', bob), ('contact', contact), ('group', g), ('bill', b);
END;
$$;

-- ---------------------------------------------------------------------------
-- C19 / C18 precondition: while ACTIVE the account sees a row in every gated table, so the
-- zeros below are the gate and not an empty fixture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
  t text;
BEGIN
  PERFORM test.as_user(ina);
  FOREACH t IN ARRAY ARRAY['groups', 'group_members', 'bills', 'bill_items', 'item_splits',
    'settlements', 'activity_log', 'profile_peer_links', 'kwenta_user_events',
    'kwenta_notifications', 'kwenta_write_submissions'] LOOP
    PERFORM test.assert_true(test.visible_count(t) > 0, 'C19: an active account reads its ' || t);
  END LOOP;
  PERFORM test.assert_true(test.visible_count('profiles') > 1,
    'C19: an active account reads its own profile and its contacts');
  PERFORM test.as_owner();
  PERFORM test.note('076 precondition: the fixture is visible to its owner through RLS');
END;
$$;

DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT account_status FROM public.profiles WHERE id = ina), 'active',
    'C19: test.new_account creates an ACTIVE account by default (076 harness change)');
  PERFORM test.as_user(ina);
  PERFORM test.assert_true(public.kwenta_caller_is_active(), 'C19: kwenta_caller_is_active() is true for an active caller');
  PERFORM test.as_owner();
  PERFORM test.assert_true(public.kwenta_caller_is_active(),
    'C19: kwenta_caller_is_active() is true when auth.uid() is NULL');
  PERFORM test.note('076 C19: caller-active is true for an active caller and for a NULL uid');
END;
$$;

-- ---------------------------------------------------------------------------
-- C18: an inactive account reads nothing but its own profile.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
  t text;
BEGIN
  PERFORM test.as_owner();
  PERFORM test.set_status(ina, 'inactive');
  PERFORM test.as_user(ina);
  PERFORM test.assert_false(public.kwenta_caller_is_active(), 'C18: kwenta_caller_is_active() is false for an inactive caller');
  FOREACH t IN ARRAY ARRAY['groups', 'group_members', 'bills', 'bill_items', 'item_splits',
    'settlements', 'activity_log', 'profile_peer_links', 'kwenta_user_events',
    'kwenta_notifications', 'kwenta_write_submissions'] LOOP
    PERFORM test.assert_eq(test.visible_count(t), 0::bigint, 'C18: an inactive account reads 0 rows from ' || t);
  END LOOP;
  PERFORM test.assert_eq(test.visible_count('profiles'), 1::bigint,
    'C18: an inactive account reads exactly one profile (its own)');
  PERFORM test.assert_eq((SELECT account_status FROM public.profiles WHERE id = ina), 'inactive',
    'C18: the one readable profile is its own, carrying its status');
  PERFORM test.as_owner();
  PERFORM test.set_status(ina, 'active');
  PERFORM test.note('076 C18: inactive account reads only its own profile');
END;
$$;

-- C18 (boundary): 'unconfirmed' is not active either.
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
BEGIN
  PERFORM test.as_owner();
  PERFORM test.set_status(ina, 'unconfirmed');
  PERFORM test.as_user(ina);
  PERFORM test.assert_eq(test.visible_count('bills'), 0::bigint, 'C18: an unconfirmed account reads 0 bills');
  PERFORM test.assert_eq(test.visible_count('profiles'), 1::bigint, 'C18: an unconfirmed account reads only its own profile');
  PERFORM test.as_owner();
  PERFORM test.set_status(ina, 'active');
END;
$$;

-- ---------------------------------------------------------------------------
-- C18: writes by an inactive account are refused with the status in the message, and stored
-- rows are byte-identical.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
  bob uuid := (SELECT v FROM fx WHERE k = 'bob');
  b uuid := (SELECT v FROM fx WHERE k = 'bill');
  nb uuid := gen_random_uuid();
  bill_before jsonb; prof_before jsonb; edit jsonb;
  st text; msg text;
BEGIN
  PERFORM test.as_owner();
  bill_before := test.row_of('bills', b);
  prof_before := test.row_of('profiles', ina);
  edit := jsonb_build_object('bills', jsonb_build_array(
    bill_before || jsonb_build_object('title', 'changed', 'updated_at', now() + interval '1 minute')));
  PERFORM test.set_status(ina, 'inactive');
  prof_before := test.row_of('profiles', ina);

  -- kwenta_write: an edit of its own bill.
  PERFORM test.as_user(ina);
  st := NULL; msg := NULL;
  BEGIN
    PERFORM public.kwenta_write(edit, gen_random_uuid(), '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18: kwenta_write by an inactive account raises 42501');
  PERFORM test.assert_true(msg LIKE '%kwenta_account_inactive:inactive%',
    'C18: the kwenta_write refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_eq(test.row_of('bills', b)::text, bill_before::text,
    'C18: the bill is byte-identical after a refused kwenta_write');

  -- kwenta_write: a brand-new bill is not stored.
  PERFORM test.as_user(ina);
  st := NULL;
  BEGIN
    PERFORM public.kwenta_write(test.bill_push(nb, gen_random_uuid(), gen_random_uuid(), ina, 'new'),
      gen_random_uuid(), '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18: a new bill through kwenta_write by an inactive account raises 42501');
  PERFORM test.assert_eq(test.row_of('bills', nb), NULL::jsonb, 'C18: the refused new bill is not stored');

  -- kwenta_sync (the replay / mirror path).
  PERFORM test.as_user(ina);
  st := NULL; msg := NULL;
  BEGIN
    PERFORM public.kwenta_sync('1970-01-01T00:00:00Z'::timestamptz, edit, gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18: kwenta_sync by an inactive account raises 42501');
  PERFORM test.assert_true(msg LIKE '%kwenta_account_inactive:inactive%',
    'C18: the kwenta_sync refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_eq(test.row_of('bills', b)::text, bill_before::text,
    'C18: the bill is byte-identical after a refused kwenta_sync');

  -- A direct profiles UPDATE (profiles keeps RLS-guarded client writes after 075).
  PERFORM test.as_user(ina);
  st := NULL; msg := NULL;
  BEGIN
    UPDATE public.profiles SET display_name = 'Renamed' WHERE id = ina;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18: a direct profiles UPDATE by an inactive account raises 42501');
  PERFORM test.assert_true(msg LIKE '%kwenta_account_inactive:inactive%',
    'C18: the profiles refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');
  PERFORM test.assert_eq(test.row_of('profiles', ina)::text, prof_before::text,
    'C18: the profile is byte-identical after a refused direct UPDATE');

  -- A direct kwenta_notifications INSERT (clients insert notifications as the actor, 009).
  PERFORM test.as_user(ina);
  st := NULL; msg := NULL;
  BEGIN
    INSERT INTO public.kwenta_notifications (recipient_id, actor_id, kind, title, body)
    VALUES (bob, ina, 'bill_participant', 'x', 'y');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C18: a notification INSERT by an inactive account raises 42501');
  PERFORM test.assert_true(msg LIKE '%kwenta_account_inactive:inactive%',
    'C18: the notification refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');

  -- The status in the message is the caller's own: 'unconfirmed' says so (H1.3 — the client keeps
  -- distinct copy for the two).
  PERFORM test.set_status(ina, 'unconfirmed');
  PERFORM test.as_user(ina);
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_write(edit, gen_random_uuid(), '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(msg LIKE '%kwenta_account_inactive:unconfirmed%',
    'C18: an unconfirmed caller''s refusal carries kwenta_account_inactive:unconfirmed (got: ' || COALESCE(msg, 'null') || ')');

  PERFORM test.set_status(ina, 'active');
  PERFORM test.note('076 C18: kwenta_write / kwenta_sync / profiles / notifications refused for inactive');
END;
$$;

-- ---------------------------------------------------------------------------
-- C18 (shape): the read gate is RESTRICTIVE, TO authenticated, in the (SELECT ...) initplan form
-- (evaluated once per query, not once per row), and the write gate is a statement-level BEFORE
-- INSERT/UPDATE/DELETE trigger on the nine synced tables plus kwenta_notifications.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'groups', 'group_members', 'bills', 'bill_items', 'item_splits',
    'settlements', 'activity_log', 'profile_peer_links', 'kwenta_user_events',
    'kwenta_notifications', 'kwenta_write_submissions'] LOOP
    PERFORM test.assert_true(EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = t
        AND p.permissive = 'RESTRICTIVE'
        AND 'authenticated' = ANY (p.roles)
        AND p.cmd IN ('SELECT', 'ALL')
        AND p.qual ILIKE '%SELECT%kwenta_caller_is_active()%'),
      'C18: ' || t || ' has a RESTRICTIVE authenticated read policy using (SELECT kwenta_caller_is_active())');
  END LOOP;

  FOREACH t IN ARRAY ARRAY['profiles', 'groups', 'group_members', 'bills', 'bill_items', 'item_splits',
    'settlements', 'activity_log', 'profile_peer_links', 'kwenta_notifications'] LOOP
    -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
    PERFORM test.assert_true(EXISTS (
      SELECT 1 FROM pg_trigger tr JOIN pg_proc fn ON fn.oid = tr.tgfoid
      WHERE tr.tgrelid = ('public.' || t)::regclass AND NOT tr.tgisinternal
        AND (tr.tgname = 'kwenta_enforce_caller_active' OR fn.proname = 'kwenta_enforce_caller_active')
        AND (tr.tgtype & 1) = 0 AND (tr.tgtype & 2) = 2 AND (tr.tgtype & 28) = 28),
      'C18: ' || t || ' has the statement-level BEFORE INSERT/UPDATE/DELETE kwenta_enforce_caller_active trigger');
  END LOOP;

  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_caller_is_active()', 'EXECUTE'),
    'C18: kwenta_caller_is_active is executable by authenticated (RLS policies call it)');
END;
$$;

-- ---------------------------------------------------------------------------
-- C19: an active account's write is accepted; auth.uid()-NULL writers are unaffected even when
-- they touch an inactive account's rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
  bob uuid := (SELECT v FROM fx WHERE k = 'bob');
  b uuid := (SELECT v FROM fx WHERE k = 'bill');
  nb uuid := gen_random_uuid();
  res jsonb;
  newbie uuid;
  n bigint;
BEGIN
  PERFORM test.as_user(bob);
  res := public.kwenta_write(test.bill_push(nb, gen_random_uuid(), gen_random_uuid(), bob, 'active write'),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C19: an active account''s kwenta_write is applied');
  PERFORM test.assert_eq(test.row_of('bills', nb) ->> 'title', 'active write', 'C19: the active account''s bill is stored');

  -- Signup: handle_new_user writes profiles with auth.uid() NULL.
  newbie := test.new_account('a76-newbie@example.com', 'Newbie');
  PERFORM test.assert_true(test.row_of('profiles', newbie) IS NOT NULL,
    'C19: signup (handle_new_user, auth.uid() NULL) still creates the profile');
  newbie := test.new_account('a76-newbie2@example.com', 'Newbie2', 'inactive');
  PERFORM test.assert_eq(test.row_of('profiles', newbie) ->> 'account_status', 'inactive',
    'C19: test.new_account takes an optional trailing status');

  -- Server-side maintenance on an inactive account's rows (auth.uid() NULL).
  PERFORM test.set_status(ina, 'inactive');
  UPDATE public.bills SET title = 'server fix', updated_at = updated_at + interval '1 second' WHERE id = b;
  PERFORM test.assert_eq(test.row_of('bills', b) ->> 'title', 'server fix',
    'C19: an auth.uid()-NULL writer may update an inactive account''s bill');

  -- The prune jobs (073) run with auth.uid() NULL and delete from gated tables.
  PERFORM public.kwenta_prune_user_events(now() + interval '1 day');
  SELECT count(*) INTO n FROM public.kwenta_user_events;
  PERFORM test.assert_eq(n, 0::bigint, 'C19: kwenta_prune_user_events still deletes with auth.uid() NULL');
  PERFORM public.kwenta_prune_write_submissions(interval '-1 day');
  SELECT count(*) INTO n FROM public.kwenta_write_submissions;
  PERFORM test.assert_eq(n, 0::bigint, 'C19: kwenta_prune_write_submissions still deletes with auth.uid() NULL');
  PERFORM test.set_status(ina, 'active');
  PERFORM test.note('076 C19: active writes and NULL-uid writers unaffected');
END;
$$;

-- ---------------------------------------------------------------------------
-- C33: the status RPC answers an inactive caller; the pre-request hook refuses everything else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid := (SELECT v FROM fx WHERE k = 'ina');
  bob uuid := (SELECT v FROM fx WHERE k = 'bob');
  answer text;
  st text; msg text;
BEGIN
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_my_account_status()', 'EXECUTE'),
    'C33: kwenta_my_account_status is executable by authenticated');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_pre_request()', 'EXECUTE'),
    'C33: kwenta_pre_request is executable by authenticated (PostgREST runs it as the request role)');

  PERFORM test.as_owner();
  PERFORM test.set_status(ina, 'inactive');
  PERFORM test.as_user(ina);
  answer := (SELECT public.kwenta_my_account_status()::text);
  PERFORM test.as_owner();
  PERFORM test.assert_true(answer ~ '\minactive\M',
    'C33: kwenta_my_account_status answers ''inactive'' to an inactive caller (got: ' || COALESCE(answer, 'null') || ')');

  PERFORM test.as_user(bob);
  answer := (SELECT public.kwenta_my_account_status()::text);
  PERFORM test.as_owner();
  PERFORM test.assert_true(answer ~ '\mactive\M' AND answer !~ '\minactive\M',
    'C33: kwenta_my_account_status answers ''active'' to an active caller (got: ' || COALESCE(answer, 'null') || ')');

  -- Inactive caller: the exempt path passes.
  PERFORM test.as_user(ina);
  PERFORM set_config('request.path', '/rpc/kwenta_my_account_status', true);
  st := NULL; msg := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, NULL::text,
    'C33: kwenta_pre_request lets an inactive caller reach /rpc/kwenta_my_account_status (got: ' || COALESCE(msg, '') || ')');

  -- Inactive caller: an RPC endpoint and a table endpoint are refused.
  PERFORM test.as_user(ina);
  PERFORM set_config('request.path', '/rpc/kwenta_balances_overview', true);
  st := NULL; msg := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(COALESCE(st IN ('42501', 'PT403'), false),
    'C33: kwenta_pre_request refuses an inactive caller on /rpc/kwenta_balances_overview with a 403-mapped code (got: ' || COALESCE(st, 'no error') || ')');
  PERFORM test.assert_true(COALESCE(msg LIKE '%kwenta_account_inactive:inactive%', false),
    'C33: the pre-request refusal carries kwenta_account_inactive:inactive (got: ' || COALESCE(msg, 'null') || ')');

  PERFORM test.as_user(ina);
  PERFORM set_config('request.path', '/bills', true);
  st := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(st IS NOT NULL, 'C33: kwenta_pre_request refuses an inactive caller on a table path');

  -- A path that merely STARTS with the exempt name is not exempt.
  PERFORM test.as_user(ina);
  PERFORM set_config('request.path', '/rpc/kwenta_my_account_status_x', true);
  st := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(st IS NOT NULL, 'C33: only the exact status path is exempt');

  -- Unconfirmed caller: status carried through.
  PERFORM test.set_status(ina, 'unconfirmed');
  PERFORM test.as_user(ina);
  PERFORM set_config('request.path', '/rpc/kwenta_balances_overview', true);
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(COALESCE(msg LIKE '%kwenta_account_inactive:unconfirmed%', false),
    'C33: an unconfirmed caller''s pre-request refusal carries kwenta_account_inactive:unconfirmed (got: ' || COALESCE(msg, 'null') || ')');

  -- Active caller and no caller: every path passes.
  PERFORM test.as_user(bob);
  PERFORM set_config('request.path', '/rpc/kwenta_balances_overview', true);
  st := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, NULL::text, 'C33: kwenta_pre_request passes an active caller');

  PERFORM set_config('request.path', '/rpc/kwenta_balances_overview', true);
  st := NULL;
  BEGIN
    PERFORM public.kwenta_pre_request();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.assert_eq(st, NULL::text, 'C33: kwenta_pre_request passes a request with no auth.uid()');

  PERFORM test.set_status(ina, 'active');
  PERFORM test.note('076 C33: status RPC answers inactive callers; pre-request refuses the rest');
END;
$$;
