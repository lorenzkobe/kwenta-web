-- Migration 066: a write returns its own rows and the recomputed screens, not the whole dataset.
--
-- The two load-bearing claims:
--   * the echo is SCOPED to what this submission stored (that is the ~213 kB → ~1 kB saving, and
--     it must not become a second, sloppier pull bundle);
--   * `reads` is computed AFTER the push in the SAME transaction, so the payload the caller gets
--     back already reflects the write — otherwise the client would still have to fetch again and
--     the whole migration buys nothing.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Fixture helper: the push payload for one personal bill, as the client sends it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.bill_push(
  p_bill uuid, p_item uuid, p_actor uuid, p_title text, p_amount numeric, p_split uuid[]
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'bills', jsonb_build_array(jsonb_build_object(
      'id', p_bill, 'title', p_title, 'group_id', NULL, 'currency', 'PHP',
      'created_by', p_actor, 'paid_by', p_actor, 'total_amount', p_amount,
      -- `bills.note` is NOT NULL DEFAULT '' and the client writes '' (001:54). A fixture using
      -- NULL would exercise a row the app can never produce.
      'note', '', 'category', NULL,
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')),
    'bill_items', jsonb_build_array(jsonb_build_object(
      'id', p_item, 'bill_id', p_bill, 'name', p_title, 'amount', p_amount,
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test')),
    'item_splits', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', gen_random_uuid(), 'item_id', p_item, 'user_id', u,
        'split_type', 'equal', 'split_value', 1,
        'computed_amount', ROUND(p_amount / array_length(p_split, 1), 2),
        'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
        'is_deleted', false, 'device_id', 'test'))
      FROM unnest(p_split) u)
  );
$$;
GRANT EXECUTE ON FUNCTION test.bill_push(uuid, uuid, uuid, text, numeric, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 1. The write applies, and the echo carries ONLY this submission's rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; older uuid; bill uuid; item uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66a-alice@example.com', 'Alice');
  bob   := test.new_account('p66a-bob@example.com', 'Bob');
  -- Pre-existing data that the OLD write path would have shipped back in full.
  older := test.new_bill(alice, alice, NULL, 'Last week', 500, ARRAY[alice, bob]);

  bill := gen_random_uuid();
  item := gen_random_uuid();

  PERFORM test.as_user(alice);
  res := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Dinner', 100, ARRAY[alice, bob]),
    NULL,
    '[]'::jsonb);

  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? bill::text,
    'the bill id comes back in `applied`');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'bills'), 1,
    'the echo carries exactly the one bill this write stored');
  PERFORM test.assert_eq(res -> 'bills' -> 0 ->> 'id', bill::text,
    'and it is that bill, not some other row');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'item_splits'), 2,
    'both splits echo back');

  -- The point of the migration: the caller's other rows are NOT in the response.
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM jsonb_array_elements(res -> 'bills') e WHERE e ->> 'id' = older::text),
    'the pre-existing bill is NOT shipped back — an echo is not a pull bundle');

  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT title FROM public.bills WHERE id = bill), 'Dinner',
    'and the row really landed');

  PERFORM test.note('066 write: applies the push, echoes only its own rows');
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. `reads` reflects the write that just happened, in the same transaction.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bill uuid; item uuid; res jsonb; mine jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66b-alice@example.com', 'Alice');
  bob   := test.new_account('p66b-bob@example.com', 'Bob');
  bill := gen_random_uuid();
  item := gen_random_uuid();

  PERFORM test.as_user(alice);
  res := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Ramen', 200, ARRAY[alice, bob]),
    NULL,
    jsonb_build_array(
      jsonb_build_object('key', 'personal-bills', 'fn', 'kwenta_personal_bills'),
      jsonb_build_object('key', 'overview', 'fn', 'kwenta_balances_overview')));

  mine := res -> 'reads' -> 'personal-bills' -> 'mine';
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM jsonb_array_elements(mine) e WHERE e ->> 'id' = bill::text),
    'the bill just written is ALREADY in the returned personal-bills payload');

  -- Bob owes Alice 100 of the 200 — the number the Home headline shows, without a second call.
  PERFORM test.assert_money(
    (res -> 'reads' -> 'overview' -> 'combinedReceive' ->> 'PHP')::numeric, 100,
    'and the recomputed overview already includes what this write moved');

  PERFORM test.note('066 reads: computed after the push, in the same transaction');
END;
$$;

-- Requesting no reads returns an empty object rather than a missing key, so the client can always
-- index into it.
DO $$
DECLARE
  alice uuid; bill uuid; item uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66c-alice@example.com', 'Alice');
  bill := gen_random_uuid(); item := gen_random_uuid();

  PERFORM test.as_user(alice);
  res := public.kwenta_write(test.bill_push(bill, item, alice, 'Solo', 50, ARRAY[alice]), NULL, NULL);
  PERFORM test.assert_eq(res -> 'reads', '{}'::jsonb, 'reads defaults to an empty object');

  PERFORM test.note('066 reads: absent p_reads yields {}');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The read whitelist. A client naming an arbitrary function would be a remote
--    procedure call primitive, so the dispatch answers only for known endpoints.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bill uuid; item uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66d-alice@example.com', 'Alice');
  bill := gen_random_uuid(); item := gen_random_uuid();

  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_build_pull_bundle'),
    'the pull bundle is not reachable by name');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_push_bills'),
    'neither is a push validator');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('pg_read_file'),
    'nor anything else');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_balances_overview'),
    'a real read endpoint is allowed');

  PERFORM test.as_user(alice);
  -- An unknown name must not fail the WRITE: the mutation is valid and already applied.
  res := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Coffee', 30, ARRAY[alice]),
    NULL,
    jsonb_build_array(
      jsonb_build_object('key', 'evil', 'fn', 'kwenta_build_pull_bundle'),
      jsonb_build_object('key', 'overview', 'fn', 'kwenta_balances_overview')));

  PERFORM test.assert_false(res -> 'reads' ? 'evil', 'the disallowed key is omitted');
  PERFORM test.assert_true(res -> 'reads' ? 'overview', 'the allowed one still answers');
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? bill::text,
    'and the write itself succeeded regardless');

  PERFORM test.note('066 whitelist: unknown names are dropped, never dispatched');
END;
$$;

-- A read that fails for a legitimate reason (a stale or unreadable id) also must not fail the
-- write — the user may simply have lost access to the screen they were on.
DO $$
DECLARE
  alice uuid; bob uuid; foreign_group uuid; bill uuid; item uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66e-alice@example.com', 'Alice');
  bob   := test.new_account('p66e-bob@example.com', 'Bob');
  foreign_group := test.new_group(bob, 'Bob only');
  PERFORM test.add_member(foreign_group, bob, 'Bob');
  bill := gen_random_uuid(); item := gen_random_uuid();

  PERFORM test.as_user(alice);
  res := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Tea', 20, ARRAY[alice]),
    NULL,
    jsonb_build_array(
      jsonb_build_object('key', 'group:x', 'fn', 'kwenta_group_detail', 'id', foreign_group),
      jsonb_build_object('key', 'overview', 'fn', 'kwenta_balances_overview')));

  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? bill::text,
    'the write lands even though one requested read is not the caller''s to see');
  PERFORM test.assert_true(res -> 'reads' ? 'overview', 'the other read still answers');
  -- kwenta_group_detail returns null for a non-member rather than raising, so the key is present
  -- and carries JSON null. Either way the client just refetches; what matters is the write stood.
  PERFORM test.assert_true(
    NOT (res -> 'reads' ? 'group:x') OR res -> 'reads' -> 'group:x' = 'null'::jsonb,
    'a non-member group read never leaks a payload');

  PERFORM test.note('066 reads: a failing or refused read never fails the write');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Replay. The same submission id applies ONCE, but its reads are recomputed —
--    `applied` is a stored outcome, a read is a view of current state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bill uuid; item uuid; sub uuid := gen_random_uuid();
  first jsonb; second jsonb; extra uuid; extra_item uuid;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66f-alice@example.com', 'Alice');
  bob   := test.new_account('p66f-bob@example.com', 'Bob');
  bill := gen_random_uuid(); item := gen_random_uuid();

  PERFORM test.as_user(alice);
  first := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Replayed', 100, ARRAY[alice, bob]), sub,
    jsonb_build_array(jsonb_build_object('key', 'overview', 'fn', 'kwenta_balances_overview')));

  -- Something else happens between the two attempts, exactly as it would while a client retries.
  extra := gen_random_uuid(); extra_item := gen_random_uuid();
  PERFORM public.kwenta_write(
    test.bill_push(extra, extra_item, alice, 'Meanwhile', 60, ARRAY[alice, bob]), NULL, '[]'::jsonb);

  second := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Replayed EDITED', 999, ARRAY[alice, bob]), sub,
    jsonb_build_array(jsonb_build_object('key', 'overview', 'fn', 'kwenta_balances_overview')));

  PERFORM test.assert_eq(second -> 'replayed', 'true'::jsonb, 'the replay is reported as such');
  PERFORM test.assert_eq(second -> 'applied', first -> 'applied',
    'and returns the ORIGINAL applied map');

  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT title FROM public.bills WHERE id = bill), 'Replayed',
    'the replayed payload was NOT applied a second time');
  PERFORM test.assert_eq((SELECT COUNT(*)::int FROM public.bills WHERE created_by = alice), 2,
    'exactly two bills exist: the original and the one written in between');

  -- 50 from the first bill + 30 from the one written in between.
  PERFORM test.assert_money((second -> 'reads' -> 'overview' -> 'combinedReceive' ->> 'PHP')::numeric, 80,
    'the replay recomputes its reads rather than replaying a stale snapshot');

  PERFORM test.note('066 replay: applies once, reads stay live');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Privacy. One user's write can never echo another user's rows, and the echo
--    honours the same pull-rows predicates the bundle does.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bob_contact uuid; bill uuid; item uuid; res jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('p66g-alice@example.com', 'Alice');
  bob   := test.new_account('p66g-bob@example.com', 'Bob');
  bob_contact := test.new_contact(bob, 'Bob''s private contact');
  bill := gen_random_uuid(); item := gen_random_uuid();

  PERFORM test.as_user(alice);
  -- Alice tries to smuggle Bob's private contact into her own submission's applied set by pushing
  -- it. The validators refuse it, so it is neither stored nor echoed.
  res := public.kwenta_write(
    test.bill_push(bill, item, alice, 'Nice try', 10, ARRAY[alice]) ||
      jsonb_build_object('profiles', jsonb_build_array(
        jsonb_build_object(
          'id', bob_contact, 'email', '', 'display_name', 'HIJACKED',
          'avatar_url', NULL, 'user_type', 'user', 'account_status', 'active',
          'is_local', true, 'linked_profile_id', NULL, 'owner_id', bob,
          'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
          'is_deleted', false, 'device_id', 'test'))),
    NULL, '[]'::jsonb);

  PERFORM test.assert_false(res -> 'applied' -> 'profiles' ? bob_contact::text,
    'the push validator refuses another user''s contact');
  PERFORM test.assert_eq(jsonb_array_length(res -> 'profiles'), 0,
    'and it is not echoed back either');

  PERFORM test.as_owner();
  PERFORM test.assert_eq((SELECT display_name FROM public.profiles WHERE id = bob_contact),
    'Bob''s private contact', 'Bob''s row is untouched');

  PERFORM test.note('066 privacy: the echo cannot carry rows the writer may not see');
END;
$$;

-- kwenta_write derives the actor from auth.uid(), so an unauthenticated caller gets nothing.
DO $$
DECLARE
  failed boolean := false;
BEGIN
  PERFORM test.as_owner();
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.kwenta_write('{}'::jsonb, NULL, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    failed := true;
  END;
  RESET ROLE;
  PERFORM test.assert_true(failed, 'kwenta_write refuses an unauthenticated caller');

  PERFORM test.note('066 auth: no session, no write');
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants. Same generic sweep 065 introduced: a helper that takes the acting
--    user as an ARGUMENT must never be reachable by `authenticated`, because
--    that argument IS the authorization decision.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leaked text;
BEGIN
  PERFORM test.as_owner();

  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
  INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('kwenta_write_echo')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  PERFORM test.assert_eq(COALESCE(leaked, ''), '',
    'no viewer-argument helper added by 066 is client-callable');

  PERFORM test.assert_true(
    has_function_privilege('authenticated',
      'public.kwenta_write(jsonb, uuid, jsonb)', 'EXECUTE'),
    'kwenta_write itself IS client-callable — it names no viewer');
  PERFORM test.assert_true(
    has_function_privilege('authenticated',
      'public.kwenta_read(text, uuid, integer)', 'EXECUTE'),
    'and so is kwenta_read, which adds no authority of its own');

  PERFORM test.note('066 grants: the viewer-argument rule holds');
END;
$$;
