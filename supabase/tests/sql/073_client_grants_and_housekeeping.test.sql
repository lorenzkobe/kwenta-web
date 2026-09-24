-- 073_client_grants_and_housekeeping.test.sql
--
-- The harness now emulates Supabase's default privileges (000_supabase_shim.sql), so a function a
-- migration creates starts out executable by anon AND authenticated, exactly as in production.
-- Pinned here:
--   1. the server-only functions that only ever revoked PUBLIC are closed to both client roles;
--   2. what `authenticated` may execute is an explicit ALLOWLIST, so the next function someone
--      forgets to revoke fails this suite instead of shipping open;
--   3. anon keeps only the four helpers RLS policies call, and those policies still evaluate;
--   4. a function created after 073 is closed until granted (default ACL revoked);
--   5. the housekeeping scheduler: a no-op without pg_cron, an upsert of two jobs with it;
--   6. Bills-list pills name a person by their account rather than another user's nickname.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 1 + 2 + 3: the grant state of every client-reachable function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION test.executable_by(p_role text)
RETURNS text[]
LANGUAGE sql
AS $$
  SELECT COALESCE(array_agg(DISTINCT p.proname::text ORDER BY p.proname::text), '{}')
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege(p_role, p.oid, 'EXECUTE');
$$;

DO $$
DECLARE
  fn text;
  server_only text[] := ARRAY[
    'public.kwenta_identity_repair_report()',
    'public.kwenta_identity_repair_apply(boolean)',
    'public.kwenta_repair_resolve_in_group(uuid, uuid, boolean)',
    'public.kwenta_collapse_legacy_credit_plan()',
    'public.kwenta_collapse_legacy_credit_settlements(boolean)',
    'public.kwenta_prune_user_events(timestamptz)',
    'public.kwenta_prune_write_submissions(interval)',
    'public.kwenta_canonical_user_id(uuid)',
    'public.kwenta_settlement_party_id(uuid, uuid)',
    'public.kwenta_empty_reconcile_bundle()',
    'public.kwenta_repair_orphan_settlements()',
    'public.kwenta_schedule_housekeeping()'
  ];
BEGIN
  FOREACH fn IN ARRAY server_only LOOP
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'), fn || ' is not executable by anon');
    PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'),
      fn || ' is not executable by authenticated');
    PERFORM test.assert_true(has_function_privilege('service_role', fn, 'EXECUTE'),
      fn || ' stays executable by service_role');
  END LOOP;
END;
$$;

DO $$
BEGIN
  -- Every name here is called by the client (src/**: `rpc(`, src/api/balances.ts, or kwenta_read's
  -- whitelist), is an RLS policy helper, is SECURITY INVOKER and adds no authority
  -- (kwenta_read_is_allowed, kwenta_round_money), or answers only for auth.uid() and has no client
  -- caller yet (kwenta_bill_settled_for_me).
  -- Adding a client endpoint means adding it here, on purpose.
  PERFORM test.assert_eq(test.executable_by('authenticated'), ARRAY[
    'admin_delete_user', 'admin_list_profiles', 'admin_set_account_status', 'admin_set_user_type',
    'bills_for_sync', 'is_admin', 'is_group_member',
    'kwenta_balances_overview', 'kwenta_bill_detail', 'kwenta_bill_settled_for_me',
    'kwenta_bill_settlement_history', 'kwenta_contacts_with_balances',
    'kwenta_fetch_bill_bundle', 'kwenta_fetch_group_bundle', 'kwenta_fetch_profile_for_linking',
    'kwenta_fetch_settlement', 'kwenta_group_detail', 'kwenta_group_member_breakdown',
    'kwenta_group_settlement_history', 'kwenta_group_spending', 'kwenta_groups_with_balances',
    'kwenta_lookup_profile_id_by_email', 'kwenta_owed_in_group', 'kwenta_person_settlement_history',
    'kwenta_person_statement', 'kwenta_person_summary', 'kwenta_personal_bills', 'kwenta_read',
    'kwenta_read_is_allowed', 'kwenta_recent_bills', 'kwenta_reconcile_user_event',
    'kwenta_repair_settlements', 'kwenta_round_money',
    'kwenta_search', 'kwenta_sync', 'kwenta_write', 'relevant_bill_ids_for_user',
    'user_can_read_personal_bill', 'user_is_participant_on_personal_bill'
  ]::text[], 'authenticated executes exactly the client allowlist');

  PERFORM test.assert_eq(test.executable_by('anon'), ARRAY[
    'is_admin', 'is_group_member', 'user_can_read_personal_bill', 'user_is_participant_on_personal_bill'
  ]::text[], 'anon executes only the helpers RLS policies call');
END;
$$;

-- 3 (boundary): the policies that call those helpers still evaluate for anon and for a user.
DO $$
DECLARE
  alice uuid := test.new_account('alice073rls@example.com', 'Alice');
  g uuid := test.new_group(alice, 'Trip');
  n bigint;
  m bigint;
BEGIN
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.new_bill(alice, alice, g, 'Dinner', 100, ARRAY[alice]);
  PERFORM test.new_bill(alice, alice, NULL, 'Taxi', 50, ARRAY[alice]);

  -- anon cannot see the `test` schema, so read as anon and assert after switching back.
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO n FROM public.bills;
  SELECT count(*) INTO m FROM public.groups;
  EXECUTE 'RESET ROLE';
  PERFORM test.assert_eq(n, 0::bigint, 'anon reads no bills, and the policy helpers run without a permission error');
  PERFORM test.assert_eq(m, 0::bigint, 'anon reads no groups');

  PERFORM test.as_user(alice);
  SELECT count(*) INTO n FROM public.bills;
  PERFORM test.assert_eq(n, 2::bigint, 'a signed-in user still reads their group and personal bills through RLS');
  PERFORM test.as_owner();
END;
$$;

-- ---------------------------------------------------------------------------
-- 4: a function created after 073 is closed until a migration grants it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.kwenta_probe_073() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;

DO $$
BEGIN
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_probe_073()', 'EXECUTE'),
    'a new function is not executable by anon by default');
  PERFORM test.assert_false(has_function_privilege('authenticated', 'public.kwenta_probe_073()', 'EXECUTE'),
    'a new function is not executable by authenticated by default');
  PERFORM test.assert_true(has_function_privilege('service_role', 'public.kwenta_probe_073()', 'EXECUTE'),
    'service_role keeps its default grant');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5: housekeeping. No pg_cron in the harness, so first the no-op, then a stub with pg_cron's
-- signature (cron.schedule(job_name, schedule, command) upserts by name).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_eq(public.kwenta_schedule_housekeeping(), false,
    'without pg_cron the scheduler reports false and does not raise');
END;
$$;

CREATE SCHEMA cron;
CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text NOT NULL, command text NOT NULL);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING 1::bigint;
$$;

DO $$
DECLARE
  cmd_events text;
  cmd_subs text;
BEGIN
  PERFORM test.assert_eq(public.kwenta_schedule_housekeeping(), true, 'with pg_cron the scheduler reports true');
  PERFORM test.assert_eq(public.kwenta_schedule_housekeeping(), true, 'a second call succeeds too');
  PERFORM test.assert_eq((SELECT array_agg(jobname ORDER BY jobname) FROM cron.job),
    ARRAY['kwenta-prune-user-events', 'kwenta-prune-write-submissions'],
    'exactly the two named jobs, not duplicated by the second call');

  SELECT command INTO cmd_events FROM cron.job WHERE jobname = 'kwenta-prune-user-events';
  SELECT command INTO cmd_subs FROM cron.job WHERE jobname = 'kwenta-prune-write-submissions';
  PERFORM test.assert_true(cmd_events LIKE '%kwenta_prune_user_events(now() - interval ''30 days'')%',
    'the events job prunes events older than 30 days: ' || cmd_events);
  PERFORM test.assert_true(cmd_subs LIKE '%kwenta_prune_write_submissions(interval ''30 days'')%',
    'the submissions job prunes markers older than 30 days: ' || cmd_subs);

  -- The job commands must actually run as written.
  EXECUTE cmd_events;
  EXECUTE cmd_subs;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6: Bills-list pills. Alice's private contact for Carol ("Nick C") is linked to Carol's account
-- and its id is forced LOW, so the pre-073 MIN(id) rule picks it and prints Alice's nickname.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bob   uuid := test.new_account('bob073@example.com', 'Bob');
  alice uuid := test.new_account('alice073@example.com', 'Alice');
  carol uuid := test.new_account('carol073@example.com', 'Carol');
  nick  uuid := '00000000-0000-0000-0000-0000000073c1';
  gone  uuid := '00000000-0000-0000-0000-0000000073c2';
  goneb uuid := '00000000-0000-0000-0000-0000000073c3';
  dave  uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid;
  res jsonb;
  pills jsonb;
BEGIN
  PERFORM test.assert_true(nick::text < carol::text, 'precondition: the nickname contact sorts below Carol''s account');

  INSERT INTO public.profiles (id, email, display_name, created_at, updated_at, synced_at,
                               is_deleted, device_id, is_local, linked_profile_id, owner_id)
  VALUES (nick, '', 'Nick C', now(), now(), now(), false, 'test', true, carol, alice),
         (gone, '', 'Old C',  now(), now(), now(), true,  'test', true, carol, alice),
         (goneb, '', 'Old B', now(), now(), now(), true,  'test', true, bob,   alice);
  dave := test.new_contact(alice, 'Dave nick');

  b1 := test.new_bill(alice, alice, NULL, 'Only the contact', 90, ARRAY[bob, nick]);
  b2 := test.new_bill(alice, alice, NULL, 'Contact and account', 90, ARRAY[bob, nick, carol]);
  b3 := test.new_bill(alice, alice, NULL, 'Unlinked contact', 90, ARRAY[bob, dave]);
  b4 := test.new_bill(alice, alice, NULL, 'Deleted contact', 90, ARRAY[bob, gone, carol]);
  b5 := test.new_bill(alice, alice, NULL, 'Only a deleted contact', 90, ARRAY[bob, gone]);
  b6 := test.new_bill(alice, alice, NULL, 'Deleted contact for the viewer', 90, ARRAY[bob, goneb]);

  PERFORM test.as_user(bob);
  res := public.kwenta_personal_bills();
  PERFORM test.as_owner();

  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b1::text;
  PERFORM test.assert_eq(pills, jsonb_build_array(
      jsonb_build_object('id', bob, 'label', 'You'),
      jsonb_build_object('id', alice, 'label', 'Alice'),
      jsonb_build_object('id', carol, 'label', 'Carol')),
    'a foreign contact linked to Carol renders as Carol''s account, not the nickname');

  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b2::text;
  PERFORM test.assert_eq(pills, jsonb_build_array(
      jsonb_build_object('id', bob, 'label', 'You'),
      jsonb_build_object('id', alice, 'label', 'Alice'),
      jsonb_build_object('id', carol, 'label', 'Carol')),
    'with both the contact and the account on the bill, one Carol pill by account');

  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b3::text;
  PERFORM test.assert_eq(pills, jsonb_build_array(
      jsonb_build_object('id', bob, 'label', 'You'),
      jsonb_build_object('id', alice, 'label', 'Alice'),
      jsonb_build_object('id', dave, 'label', 'Dave nick')),
    'an unlinked contact keeps the creator''s label (as Bill detail does)');

  -- A contact deleted from Alice's phonebook still names Carol through its link; it must neither
  -- print Alice's nickname nor become a second Carol pill.
  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b4::text;
  PERFORM test.assert_eq(pills, jsonb_build_array(
      jsonb_build_object('id', bob, 'label', 'You'),
      jsonb_build_object('id', alice, 'label', 'Alice'),
      jsonb_build_object('id', carol, 'label', 'Carol')),
    'a soft-deleted linked contact folds into ONE Carol pill, no nickname');

  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b5::text;
  PERFORM test.assert_eq(pills, jsonb_build_array(
      jsonb_build_object('id', bob, 'label', 'You'),
      jsonb_build_object('id', alice, 'label', 'Alice'),
      jsonb_build_object('id', carol, 'label', 'Carol')),
    'a soft-deleted linked contact alone on a bill renders as Carol''s account');

  SELECT r -> 'participants' INTO pills FROM jsonb_array_elements(res -> 'shared') r WHERE r ->> 'id' = b6::text;
  -- Labels only: the "You" pill keeps 071's lowest-id representative by design (see the header).
  PERFORM test.assert_eq((SELECT array_agg(p ->> 'label' ORDER BY ord) FROM jsonb_array_elements(pills) WITH ORDINALITY x(p, ord)),
    ARRAY['You', 'Alice'],
    'another user''s deleted contact linked to the viewer folds into "You", with no nickname pill');
END;
$$;
