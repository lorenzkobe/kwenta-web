-- Assertion + fixture helpers for the SQL suite.
--
-- Deliberately dependency-free (no pgTAP): the suite has to run on a bare Homebrew Postgres with
-- nothing installed, otherwise it will not get run.
--
-- A failing assertion RAISES, which aborts the test file, which fails the run. There is no
-- "soft" failure mode on purpose — a money rule that half-passes is not a passing money rule.

CREATE SCHEMA IF NOT EXISTS test;

/** Become a signed-in user for subsequent statements: sets auth.uid() AND drops to a non-owner
    role so RLS actually applies. Call inside a transaction; `SET LOCAL` unwinds on rollback. */
CREATE OR REPLACE FUNCTION test.as_user(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END;
$$;

/** Return to the object owner (RLS no longer applies). Use for fixture setup, never for the
    assertion under test. */
CREATE OR REPLACE FUNCTION test.as_owner()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END;
$$;

CREATE OR REPLACE FUNCTION test.fail(p_what text, p_expected text, p_actual text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION E'ASSERTION FAILED: %\n  expected: %\n  actual:   %', p_what, p_expected, p_actual;
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_true(p_value boolean, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_value IS DISTINCT FROM true THEN
    PERFORM test.fail(p_what, 'true', COALESCE(p_value::text, 'null'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_false(p_value boolean, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_value IS DISTINCT FROM false THEN
    PERFORM test.fail(p_what, 'false', COALESCE(p_value::text, 'null'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_eq(p_actual anyelement, p_expected anyelement, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    PERFORM test.fail(p_what, COALESCE(p_expected::text, 'null'), COALESCE(p_actual::text, 'null'));
  END IF;
END;
$$;

/** Compare money as integer cents, so a float representation difference cannot fail a test that
    is really about the rule. */
CREATE OR REPLACE FUNCTION test.assert_money(p_actual numeric, p_expected numeric, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROUND(COALESCE(p_actual, 0) * 100) IS DISTINCT FROM ROUND(COALESCE(p_expected, 0) * 100) THEN
    PERFORM test.fail(p_what, COALESCE(p_expected::text, 'null'), COALESCE(p_actual::text, 'null'));
  END IF;
END;
$$;

/** Set-equality on two id arrays, order-insensitive. */
CREATE OR REPLACE FUNCTION test.assert_ids(p_actual uuid[], p_expected uuid[], p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  a uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_actual, '{}')) ORDER BY 1);
  e uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_expected, '{}')) ORDER BY 1);
BEGIN
  IF a IS DISTINCT FROM e THEN
    PERFORM test.fail(p_what, e::text, a::text);
  END IF;
END;
$$;

/** Sort every array in a pull bundle by row id.

    The bundle's `jsonb_agg` calls carry no ORDER BY, so element order is whatever the planner
    produced. Comparing two bundles raw would fail on ordering alone and say nothing about
    content; this makes the comparison mean what it should. */
CREATE OR REPLACE FUNCTION test.normalize_bundle(p_bundle jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_object_agg(key, sorted), '{}'::jsonb)
  FROM (
    SELECT
      e.key,
      CASE
        WHEN jsonb_typeof(e.value) = 'array' THEN (
          SELECT COALESCE(jsonb_agg(el ORDER BY el->>'id'), '[]'::jsonb)
          FROM jsonb_array_elements(e.value) AS el
        )
        ELSE e.value
      END AS sorted
    FROM jsonb_each(p_bundle) AS e
  ) s;
$$;

CREATE OR REPLACE FUNCTION test.assert_bundle_eq(p_actual jsonb, p_expected jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  a jsonb := test.normalize_bundle(p_actual);
  e jsonb := test.normalize_bundle(p_expected);
  k text;
BEGIN
  IF a IS DISTINCT FROM e THEN
    -- Report the first differing key rather than dumping two whole bundles.
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF (a -> k) IS DISTINCT FROM (e -> k) THEN
        PERFORM test.fail(
          p_what || ' [key: ' || k || ']',
          COALESCE(jsonb_pretty(e -> k), 'null'),
          COALESCE(jsonb_pretty(a -> k), 'null')
        );
      END IF;
    END LOOP;
    PERFORM test.fail(p_what, jsonb_pretty(e), jsonb_pretty(a));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION test.note(p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE NOTICE '  - %', p_msg;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures. Thin wrappers so a test reads as a scenario, not as column lists.
--
-- NEVER call one of these inside a WHERE clause. They INSERT, so they are volatile, and Postgres
-- re-evaluates a volatile function once per scanned row — `UPDATE t SET ... WHERE id =
-- test.new_settlement(...)` inserts one row per existing settlement instead of one. Assign the
-- id to a variable first, then use the variable. (This has bitten twice; hence the note.)
-- ---------------------------------------------------------------------------

/** Create an auth user + its public.profiles row (the 025/035 trigger builds the profile). */
CREATE OR REPLACE FUNCTION test.new_account(p_email text, p_display text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (
    v_id,
    p_email,
    now(),
    CASE WHEN p_display IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('display_name', p_display) END
  );
  RETURN v_id;
END;
$$;

/** A local contact in someone's phonebook — is_local, owned by its creator. */
CREATE OR REPLACE FUNCTION test.new_contact(p_owner uuid, p_display text, p_linked uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.profiles (
    id, email, display_name, created_at, updated_at, synced_at,
    is_deleted, device_id, is_local, linked_profile_id, owner_id
  )
  -- Empty string, not NULL: `profiles.email` is NOT NULL and the app writes '' for local
  -- contacts (src/db/operations.ts:738, :833). Matching production matters — a fixture that
  -- used NULL would exercise code paths that cannot occur.
  VALUES (v_id, '', p_display, now(), now(), now(), false, 'test', true, p_linked, p_owner);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION test.new_group(p_creator uuid, p_name text, p_currency text DEFAULT 'PHP')
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.groups (
    id, name, currency, created_by, invite_code,
    created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_id, p_name, p_currency, p_creator, substr(md5(random()::text), 1, 8),
          now(), now(), now(), false, 'test');
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION test.add_member(p_group uuid, p_user uuid, p_display text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.group_members (
    id, group_id, user_id, display_name, joined_at,
    created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_id, p_group, p_user, p_display, now(), now(), now(), now(), false, 'test');
  RETURN v_id;
END;
$$;

/** A bill with a single item split across the given users, equal shares in whole cents. */
CREATE OR REPLACE FUNCTION test.new_bill(
  p_creator uuid,
  p_payer uuid,
  p_group uuid,
  p_title text,
  p_amount numeric,
  p_split_between uuid[],
  p_currency text DEFAULT 'PHP'
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_bill uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_n int := GREATEST(array_length(p_split_between, 1), 1);
  v_each numeric := ROUND(p_amount / v_n, 2);
  v_uid uuid;
  v_i int := 0;
  v_amt numeric;
BEGIN
  INSERT INTO public.bills (
    id, group_id, created_by, paid_by, title, total_amount, currency,
    created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_bill, p_group, p_creator, p_payer, p_title, p_amount, p_currency,
          now(), now(), now(), false, 'test');

  INSERT INTO public.bill_items (
    id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_item, v_bill, p_title, p_amount, now(), now(), now(), false, 'test');

  FOREACH v_uid IN ARRAY p_split_between LOOP
    v_i := v_i + 1;
    -- Remainder to the first split, mirroring computeSplits' equal mode (src/lib/splits.ts:31).
    v_amt := CASE WHEN v_i = 1 THEN p_amount - v_each * (v_n - 1) ELSE v_each END;
    INSERT INTO public.item_splits (
      id, item_id, user_id, split_type, split_value, computed_amount,
      created_at, updated_at, synced_at, is_deleted, device_id
    )
    -- split_value is NOT NULL and the form writes 1 for an equal split
    -- (src/lib/bill-split-form.ts:210).
    VALUES (gen_random_uuid(), v_item, v_uid, 'equal', 1, v_amt,
            now(), now(), now(), false, 'test');
  END LOOP;

  RETURN v_bill;
END;
$$;

CREATE OR REPLACE FUNCTION test.new_settlement(
  p_from uuid,
  p_to uuid,
  p_amount numeric,
  p_group uuid DEFAULT NULL,
  p_bill uuid DEFAULT NULL,
  p_currency text DEFAULT 'PHP',
  p_label text DEFAULT '',
  p_created_at timestamptz DEFAULT NULL,
  p_method text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_at timestamptz := COALESCE(p_created_at, now());
BEGIN
  -- There is no `settled_at`; `label` is NOT NULL with no default. `method` (046) is nullable and
  -- is appended LAST so every existing positional call keeps working.
  INSERT INTO public.settlements (
    id, group_id, bill_id, from_user_id, to_user_id, amount, currency,
    is_settled, label, method, created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_id, p_group, p_bill, p_from, p_to, p_amount, p_currency,
          true, p_label, p_method, v_at, v_at, v_at, false, 'test');
  RETURN v_id;
END;
$$;

-- One settle-up: several settlement rows sharing a `bundle_id`, which the UI renders as ONE
-- payment. `p_recipients[i]` is paid `p_amounts[i]`; the rows deliberately share `created_at` to
-- the microsecond, because that is what the real write does and it is what makes an
-- iteration-order "sort" non-deterministic.
CREATE OR REPLACE FUNCTION test.new_bundle(
  p_from uuid,
  p_recipients uuid[],
  p_amounts numeric[],
  p_group uuid DEFAULT NULL,
  p_label text DEFAULT '',
  p_currency text DEFAULT 'PHP',
  p_method text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_bundle uuid := gen_random_uuid();
  v_at timestamptz := now();
  v_i int;
BEGIN
  FOR v_i IN 1 .. array_length(p_recipients, 1) LOOP
    -- recordPersonPayment stamps every leg of a bundle with the SAME method, so the fixture takes
    -- one value rather than an array.
    INSERT INTO public.settlements (
      id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
      is_settled, label, method, created_at, updated_at, synced_at, is_deleted, device_id
    )
    VALUES (gen_random_uuid(), p_group, NULL, v_bundle, p_from, p_recipients[v_i],
            p_amounts[v_i], p_currency, true, p_label, p_method, v_at, v_at, v_at, false, 'test');
  END LOOP;
  RETURN v_bundle;
END;
$$;

-- The "Added by <name>" attribution: settlement history reads it from the activity log, keyed by
-- bundle id when there is one and by settlement id otherwise.
CREATE OR REPLACE FUNCTION test.log_settled(
  p_entity_id uuid,
  p_actor uuid,
  p_group uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.activity_log (
    id, group_id, user_id, action, entity_type, entity_id, description,
    created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (v_id, p_group, p_actor, 'settled', 'settlement', p_entity_id, '',
          now(), now(), now(), false, 'test');
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- `test.as_user` drops to the `authenticated` role so RLS applies (CLAUDE.md rule 11). Without
-- these grants the very next `test.assert_*` call fails with "permission denied for schema test",
-- which made the assertion helpers unusable in exactly the position they matter most. Every
-- earlier suite worked around it by setting `request.jwt.claim.sub` alone and staying the owner
-- — that sets auth.uid() but leaves RLS switched off, and it also cannot catch a missing GRANT
-- on the function under test.
--
-- This is a throwaway test cluster; `authenticated` gaining the assertion helpers grants it
-- nothing that matters. The fixtures stay owner-only in practice because they INSERT and would
-- simply hit RLS.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA test TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO authenticated;
