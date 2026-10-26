-- Migration 086: the Person statement, paged on the server, with the running balance in SQL.
--
-- Written from the requirements (case table of the person-statement-paging run), blind to the
-- implementation. What this file pins:
--   C1   kwenta_person_statement(uuid) is untouched: byte-identical to a frozen copy of 065's body.
--   C2   every page event carries runningNet / prevRunning = the per-currency cumulative SUM(delta)
--        over ALL events (any kind) in (created_at, id) order, on every page, under both kinds.
--   C3   the newest event per currency ends on the hero (kwenta_person_summary -> total).
--   C4   walking by cursor visits every event exactly once, newest first; `matching` counts the
--        kind-filtered set (the whole set, on every page: useKeysetMore reads it that way).
--   C5   the payments filter keeps each payment's all-kinds running number.
--   C6   a page whose oldest row is a bundle leg extends to the bundle's oldest leg, taking every
--        event of the requested kind in between, so the next cursor skips nothing.
--   C7   limit NULL -> 20, clamp 1..500; an unknown kind and a malformed cursor raise; a deleted
--        cursor event still continues.
--   C8   unauthenticated raises; scoped exactly like kwenta_person_statement.
--   C9   per-currency independence; a timestamp tie breaks by id.
--   C10  kwenta_read dispatches the page (kind 'all') and a write primes the first page.
--   C11  the buildMoneyFlowRows running-balance rules (tests/lib/money-flow.test.ts), ported.
--   C14  an authenticated caller never gets a NULL page, so a NULL can only mean "declined".
--   C15  running numbers and the hero agree after paging and filtering (C2 + C3 + C5 together).
--   C17  a write's read spec keyed statement-page:<id> comes back under exactly that key.
--   C18  latestPersonalCurrency = the newest personal bill's currency over the whole history.
--   C21  kwenta_read keeps 085's kwenta_group_detail_paged branch; grants authenticated only.
--
-- Time: every fixture call in one transaction sees the same now(), so each event's created_at is
-- set explicitly. Hand-made rows: bundle legs are test.new_settlement rows given a shared
-- bundle_id afterwards (a bundle spanning personal + group, legs at DIFFERENT instants). The real
-- write stamps each leg with its own syncFields() (src/db/operations.ts), so legs that differ by a
-- few milliseconds are the realistic shape, not an exotic one.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- The 065 implementation of kwenta_person_statement, copied verbatim from
-- 065_list_settled_map_and_payor_names.sql:477-644 (only the name changed). Do not "tidy" it: its
-- value is being an independent second opinion that the old endpoint did not move (C1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.person_statement_065(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  v_other_name text;
  v_events jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_other_name := public.kwenta_peer_display_name(v_uid, p_person_id);

  WITH
  me AS (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  other AS (SELECT id FROM public.kwenta_expand_identity(p_person_id, v_uid)),
  visible_bills AS (
    SELECT b.*
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.is_deleted IS FALSE
  ),
  shared AS (
    SELECT g.id AS group_id, g.name, g.currency, gm_other.user_id AS other_roster_id
    FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
    JOIN public.group_members gm_me
      ON gm_me.group_id = g.id AND gm_me.user_id = v_uid AND gm_me.is_deleted IS FALSE
    JOIN public.group_members gm_other
      ON gm_other.group_id = g.id AND gm_other.is_deleted IS FALSE
     AND gm_other.user_id IN (SELECT id FROM other)
    WHERE g.is_deleted IS FALSE
  ),
  personal_items AS (
    SELECT b.id AS bill_id, b.title, b.currency, b.created_at, b.paid_by, b.category, bi.id AS item_id
    FROM visible_bills b
    JOIN public.bill_items bi ON bi.bill_id = b.id AND bi.is_deleted IS FALSE
    WHERE b.group_id IS NULL
      AND (b.paid_by IN (SELECT id FROM me) OR b.paid_by IN (SELECT id FROM other))
  ),
  personal_deltas AS (
    SELECT pi.bill_id, pi.title, pi.currency, pi.created_at, pi.category,
           SUM(
             CASE
               WHEN pi.paid_by IN (SELECT id FROM me) THEN COALESCE((
                 SELECT sp.computed_amount FROM public.item_splits sp
                  WHERE sp.item_id = pi.item_id AND sp.is_deleted IS FALSE
                    AND sp.user_id IN (SELECT id FROM other)
                  ORDER BY sp.id LIMIT 1), 0)
               ELSE -COALESCE((
                 SELECT sp.computed_amount FROM public.item_splits sp
                  WHERE sp.item_id = pi.item_id AND sp.is_deleted IS FALSE
                    AND sp.user_id IN (SELECT id FROM me)
                  ORDER BY sp.id LIMIT 1), 0)
             END
           ) AS delta
    FROM personal_items pi
    GROUP BY pi.bill_id, pi.title, pi.currency, pi.created_at, pi.category
  ),
  group_deltas AS (
    SELECT b.id AS bill_id, b.title, s.currency, b.created_at, b.category,
           s.group_id, s.name AS group_name,
           SUM(
             CASE
               WHEN b.paid_by = v_uid AND sp.user_id = s.other_roster_id THEN sp.computed_amount
               WHEN b.paid_by = s.other_roster_id AND sp.user_id = v_uid THEN -sp.computed_amount
               ELSE 0
             END
           ) AS delta
    FROM visible_bills b
    JOIN shared s ON s.group_id = b.group_id
    JOIN public.bill_items bi ON bi.bill_id = b.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE (b.currency IS NULL OR b.currency = '' OR b.currency = s.currency)
      AND (b.paid_by = v_uid OR b.paid_by = s.other_roster_id)
    GROUP BY b.id, b.title, s.currency, b.created_at, b.category, s.group_id, s.name
  ),

  settled AS (
    SELECT * FROM public.settlements
    WHERE is_deleted IS FALSE AND is_settled IS TRUE AND amount > EPS
  ),
  personal_payments AS (
    SELECT s.id, s.created_at, s.currency, s.bundle_id, s.amount,
           (s.from_user_id IN (SELECT id FROM me)) AS i_paid
    FROM settled s
    WHERE s.group_id IS NULL
      AND (
        (s.from_user_id IN (SELECT id FROM me)    AND s.to_user_id IN (SELECT id FROM other))
        OR
        (s.from_user_id IN (SELECT id FROM other) AND s.to_user_id IN (SELECT id FROM me))
      )
  ),
  group_payments AS (
    SELECT s.id, s.created_at, sh.currency, s.bundle_id, s.amount, sh.group_id, sh.name AS group_name,
           (s.from_user_id = v_uid) AS i_paid
    FROM settled s
    JOIN shared sh ON sh.group_id = s.group_id
    WHERE (s.currency IS NULL OR s.currency = '' OR s.currency = sh.currency)
      AND (
        (s.from_user_id = v_uid AND s.to_user_id = sh.other_roster_id)
        OR
        (s.to_user_id = v_uid AND s.from_user_id = sh.other_roster_id)
      )
  ),

  events AS (
    SELECT d.bill_id AS id, 'personal_bill' AS type, d.created_at, d.currency,
           NULL::uuid AS group_id, NULL::uuid AS bundle_id, 'Personal' AS context_label,
           d.title, ABS(public.kwenta_round_money(d.delta)) AS raw_amount,
           public.kwenta_round_money(d.delta) AS delta,
           d.category
    FROM personal_deltas d WHERE ABS(d.delta) > EPS

    UNION ALL
    SELECT d.bill_id, 'group_bill', d.created_at, d.currency,
           d.group_id, NULL::uuid, d.group_name,
           d.title, ABS(public.kwenta_round_money(d.delta)),
           public.kwenta_round_money(d.delta),
           d.category
    FROM group_deltas d WHERE ABS(d.delta) > EPS

    UNION ALL
    SELECT p.id, 'payment', p.created_at, p.currency,
           NULL::uuid, p.bundle_id, 'Personal',
           CASE WHEN p.i_paid THEN 'You paid ' || v_other_name
                ELSE v_other_name || ' paid you' END,
           p.amount,
           CASE WHEN p.i_paid THEN p.amount ELSE -p.amount END,
           -- A payment has no category; the export renders this as a blank cell.
           NULL::text
    FROM personal_payments p

    UNION ALL
    SELECT p.id, 'payment', p.created_at, p.currency,
           p.group_id, p.bundle_id, p.group_name,
           CASE WHEN p.i_paid THEN 'You paid ' || v_other_name
                ELSE v_other_name || ' paid you' END,
           p.amount,
           CASE WHEN p.i_paid THEN p.amount ELSE -p.amount END,
           NULL::text
    FROM group_payments p
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           e.id,
      'type',         e.type,
      'createdAt',    e.created_at,
      'currency',     e.currency,
      'groupId',      e.group_id,
      'bundleId',     e.bundle_id,
      'contextLabel', e.context_label,
      'title',        e.title,
      'rawAmount',    e.raw_amount,
      'delta',        e.delta,
      'category',     e.category
    ) ORDER BY e.created_at, e.id
  ), '[]'::jsonb)
  INTO v_events
  FROM events e;

  RETURN v_events;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Event ids of an events array, in array order.
CREATE OR REPLACE FUNCTION test.p86_ids(p_events jsonb)
RETURNS uuid[]
LANGUAGE sql
AS $$
  SELECT COALESCE(array_agg((t.e ->> 'id')::uuid ORDER BY t.o), '{}'::uuid[])
  FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) WITH ORDINALITY AS t(e, o);
$$;

-- The events with the two new fields dropped: what must equal the old statement's events.
CREATE OR REPLACE FUNCTION test.p86_strip(p_events jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT COALESCE(jsonb_agg(t.e - 'runningNet' - 'prevRunning' ORDER BY t.o), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) WITH ORDINALITY AS t(e, o);
$$;

-- The OLD endpoint's events, newest first, optionally only payments. The reference event set.
CREATE OR REPLACE FUNCTION test.p86_old_newest_first(p_person uuid, p_kind text)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT COALESCE(jsonb_agg(t.e ORDER BY t.o DESC), '[]'::jsonb)
  FROM jsonb_array_elements(public.kwenta_person_statement(p_person)) WITH ORDINALITY AS t(e, o)
  WHERE p_kind = 'all' OR t.e ->> 'type' = 'payment';
$$;

-- Expected running numbers, computed from the OLD endpoint's ascending (created_at, id) order:
-- the per-currency cumulative sum over ALL events, whatever their kind.
CREATE OR REPLACE FUNCTION test.p86_expected(p_person uuid)
RETURNS TABLE (id uuid, currency text, delta numeric, running numeric)
LANGUAGE sql
AS $$
  SELECT (t.e ->> 'id')::uuid, t.e ->> 'currency', (t.e ->> 'delta')::numeric,
         SUM((t.e ->> 'delta')::numeric) OVER (
           PARTITION BY t.e ->> 'currency' ORDER BY t.o
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  FROM jsonb_array_elements(public.kwenta_person_statement(p_person)) WITH ORDINALITY AS t(e, o);
$$;

-- C2: every event in p_events carries the running numbers the full history implies.
CREATE OR REPLACE FUNCTION test.p86_check_running(p_person uuid, p_events jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  e jsonb;
  x record;
BEGIN
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) LOOP
    SELECT * INTO x FROM test.p86_expected(p_person) ex WHERE ex.id = (e ->> 'id')::uuid;
    IF NOT FOUND THEN
      PERFORM test.fail(p_what || ': page event is an event of the old statement', 'present', e ->> 'id');
    END IF;
    PERFORM test.assert_true(e ? 'runningNet' AND e ? 'prevRunning',
      p_what || ': ' || (e ->> 'title') || ' carries runningNet and prevRunning');
    PERFORM test.assert_money((e ->> 'runningNet')::numeric, x.running,
      p_what || ': runningNet of ' || (e ->> 'title') || ' (' || (e ->> 'currency') || ')');
    PERFORM test.assert_money((e ->> 'prevRunning')::numeric, x.running - x.delta,
      p_what || ': prevRunning of ' || (e ->> 'title') || ' = runningNet - delta');
  END LOOP;
END;
$$;

-- Walk the statement newest-first by cursor (the last event of each page), like the client does.
-- Returns the pages as an array of event arrays.
CREATE OR REPLACE FUNCTION test.p86_walk(p_person uuid, p_limit integer, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  pages jsonb := '[]'::jsonb;
  p jsonb;
  cur jsonb := NULL;
  last_ev jsonb;
  n integer := 0;
BEGIN
  LOOP
    n := n + 1;
    IF n > 300 THEN
      PERFORM test.fail('walk terminates', 'under 300 pages', n::text);
    END IF;
    p := public.kwenta_person_statement_page(p_person, p_limit, p_kind, cur);
    IF p IS NULL OR jsonb_typeof(p -> 'events') IS DISTINCT FROM 'array' THEN
      PERFORM test.fail('every page is an object with an events array', 'array', COALESCE(p::text, 'NULL'));
    END IF;
    EXIT WHEN jsonb_array_length(p -> 'events') = 0;
    pages := pages || jsonb_build_array(p -> 'events');
    last_ev := p -> 'events' -> -1;
    cur := jsonb_build_object('createdAt', last_ev -> 'createdAt', 'id', last_ev -> 'id');
  END LOOP;
  RETURN pages;
END;
$$;

CREATE OR REPLACE FUNCTION test.p86_flat(p_pages jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT COALESCE(jsonb_agg(b.e ORDER BY a.po, b.eo), '[]'::jsonb)
  FROM jsonb_array_elements(p_pages) WITH ORDINALITY AS a(pg, po),
       jsonb_array_elements(a.pg) WITH ORDINALITY AS b(e, eo);
$$;

-- C2/C4/C5/C15 over one person: both kinds, limits 1..5, every page checked against the old
-- endpoint. p_bundles_whole: also assert no bundle's legs land on two pages (only meaningful when
-- no two bundles interleave in time).
CREATE OR REPLACE FUNCTION test.p86_check_walks(p_person uuid, p_what text, p_bundles_whole boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  k text;
  l integer;
  i integer;
  pages jsonb;
  flat jsonb;
  expected jsonb;
  one_page jsonb;
  split_bundles integer;
  cur jsonb;
  p jsonb;
BEGIN
  FOREACH k IN ARRAY ARRAY['all', 'payments'] LOOP
    expected := test.p86_old_newest_first(p_person, k);
    one_page := public.kwenta_person_statement_page(p_person, 500, k, NULL);

    PERFORM test.assert_eq(test.p86_strip(one_page -> 'events'), expected,
      p_what || ' C2: kind ' || k || ': the page events are the old statement''s events, newest first, every old field intact');
    PERFORM test.assert_eq((one_page ->> 'matching')::int, jsonb_array_length(expected),
      p_what || ' C4: kind ' || k || ': matching counts the kind-filtered events');
    PERFORM test.p86_check_running(p_person, one_page -> 'events', p_what || ' C2/C5 kind ' || k);

    FOR l IN 1 .. 5 LOOP
      pages := test.p86_walk(p_person, l, k);
      flat := test.p86_flat(pages);
      PERFORM test.assert_eq(test.p86_ids(flat), test.p86_ids(expected),
        p_what || ' C4: kind ' || k || ', limit ' || l || ': the walk visits every event exactly once, newest first');
      PERFORM test.assert_eq(flat, one_page -> 'events',
        p_what || ' C2/C15: kind ' || k || ', limit ' || l || ': a paged event carries the same running numbers as on one page');

      FOR i IN 0 .. jsonb_array_length(pages) - 2 LOOP
        PERFORM test.assert_true(jsonb_array_length(pages -> i) >= l,
          p_what || ' C4: kind ' || k || ', limit ' || l || ': page ' || (i + 1) || ' before the last is full');
      END LOOP;

      -- matching is the whole kind-filtered count on every page, cursor or not.
      cur := NULL;
      FOR i IN 0 .. jsonb_array_length(pages) - 1 LOOP
        p := public.kwenta_person_statement_page(p_person, l, k, cur);
        PERFORM test.assert_eq((p ->> 'matching')::int, jsonb_array_length(expected),
          p_what || ' C4: kind ' || k || ', limit ' || l || ': matching on page ' || (i + 1));
        cur := jsonb_build_object('createdAt', pages -> i -> -1 -> 'createdAt', 'id', pages -> i -> -1 -> 'id');
      END LOOP;

      IF p_bundles_whole THEN
        SELECT count(*)::int INTO split_bundles FROM (
          SELECT b.e ->> 'bundleId'
          FROM jsonb_array_elements(pages) WITH ORDINALITY AS a(pg, po),
               jsonb_array_elements(a.pg) AS b(e)
          WHERE b.e ->> 'bundleId' IS NOT NULL
          GROUP BY 1
          HAVING count(DISTINCT a.po) > 1
        ) s;
        PERFORM test.assert_eq(split_bundles, 0,
          p_what || ' C6: kind ' || k || ', limit ' || l || ': no bundle''s legs are split across two pages');
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- One event between p_me and p_other with a chosen delta (from p_me's side) at a chosen instant.
-- A bill: the side owed pays 2|d| split equally, so the other side's share is |d|. A payment:
-- the side owing pays |d|. Both shapes are what the app writes (equal split_value 1, label '').
CREATE OR REPLACE FUNCTION test.p86_ev(
  p_me uuid, p_other uuid, p_kind text, p_delta numeric, p_at timestamptz, p_currency text DEFAULT 'PHP',
  p_title text DEFAULT 'Bill'
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_payer uuid := CASE WHEN p_delta > 0 THEN p_me ELSE p_other END;
  v_payee uuid := CASE WHEN p_delta > 0 THEN p_other ELSE p_me END;
BEGIN
  IF p_kind = 'bill' THEN
    v_id := test.new_bill(v_payer, v_payer, NULL, p_title, 2 * abs(p_delta), ARRAY[p_me, p_other], p_currency);
    UPDATE public.bills SET created_at = p_at WHERE id = v_id;
  ELSE
    v_id := test.new_settlement(v_payer, v_payee, abs(p_delta), NULL, NULL, p_currency, '', p_at);
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION test.p86_run(p_page jsonb, p_id uuid)
RETURNS numeric
LANGUAGE sql
AS $$
  SELECT (e ->> 'runningNet')::numeric FROM jsonb_array_elements(p_page -> 'events') e
  WHERE (e ->> 'id')::uuid = p_id;
$$;

CREATE OR REPLACE FUNCTION test.p86_prev(p_page jsonb, p_id uuid)
RETURNS numeric
LANGUAGE sql
AS $$
  SELECT (e ->> 'prevRunning')::numeric FROM jsonb_array_elements(p_page -> 'events') e
  WHERE (e ->> 'id')::uuid = p_id;
$$;

/**
 * The rich fixture (C1, C2, C3, C5, C8). Alice is the viewer; Bob is an account; c_bob is Alice's
 * contact LINKED to Bob; Cara shares only "Trip". Two PHP groups. Events at base + n minutes:
 *   1 personal  Alice paid 100 [Alice, Bob]                     +50 PHP
 *   2 personal  Bob paid 80 [Alice, Bob]                        -40 PHP
 *   3 personal  Alice paid 100 [Alice, c_bob] (linked contact)  +50 PHP
 *   4 Flat      Bob paid 60 [Alice, Bob]                        -30 PHP
 *   5 Trip      Alice paid 90 [Alice, Bob, Cara]                +30 PHP
 *   6 personal  Alice paid 40 USD [Alice, Bob]                  +20 USD
 *   7 bundle    Bob -> Alice 30 personal + 20 in Flat, same instant (new_bundle shape)   -50 PHP
 *   8 payment   Bob -> Alice 100 personal: an overpayment, flips the PHP tab to -90
 *   9 personal  Alice paid 200 [Alice, Bob], DELETED (never an event)
 *  10 personal  Bob paid 100 USD [Alice, Bob]                   -50 USD
 *  11 payment   Alice -> Bob 15 USD                             +15 USD
 *  12 Trip      Alice paid 120 [Alice, Bob, Cara]               +40 PHP
 * Hero: PHP -50, USD -15.
 */
CREATE OR REPLACE FUNCTION test.p86_rich(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '20 days';
  alice uuid; bob uuid; cara uuid; zed uuid; c_bob uuid; g1 uuid; g2 uuid;
  b uuid; s1 uuid; s2 uuid; bundle uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('p86' || p_tag || '-alice@example.com', 'Alice');
  bob   := test.new_account('p86' || p_tag || '-bob@example.com', 'Bob');
  cara  := test.new_account('p86' || p_tag || '-cara@example.com', 'Cara');
  zed   := test.new_account('p86' || p_tag || '-zed@example.com', 'Zed');
  c_bob := test.new_contact(alice, 'Bobby', bob);
  g1 := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g1, alice, 'Alice');
  PERFORM test.add_member(g1, bob, 'Bob');
  g2 := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, bob, 'Bob');
  PERFORM test.add_member(g2, cara, 'Cara');

  b := test.new_bill(alice, alice, NULL, 'R1 dinner', 100, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '1 minute' WHERE id = b;
  b := test.new_bill(bob, bob, NULL, 'R2 taxi', 80, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '2 minutes' WHERE id = b;
  b := test.new_bill(alice, alice, NULL, 'R3 linked lunch', 100, ARRAY[alice, c_bob]);
  UPDATE public.bills SET created_at = base + interval '3 minutes' WHERE id = b;
  b := test.new_bill(bob, bob, g1, 'R4 wifi', 60, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '4 minutes' WHERE id = b;
  b := test.new_bill(alice, alice, g2, 'R5 hotel', 90, ARRAY[alice, bob, cara]);
  UPDATE public.bills SET created_at = base + interval '5 minutes' WHERE id = b;
  b := test.new_bill(alice, alice, NULL, 'R6 usd books', 40, ARRAY[alice, bob], 'USD');
  UPDATE public.bills SET created_at = base + interval '6 minutes' WHERE id = b;
  s1 := test.new_settlement(bob, alice, 30, NULL, NULL, 'PHP', '', base + interval '7 minutes');
  s2 := test.new_settlement(bob, alice, 20, g1, NULL, 'PHP', '', base + interval '7 minutes');
  UPDATE public.settlements SET bundle_id = bundle WHERE id IN (s1, s2);
  PERFORM test.new_settlement(bob, alice, 100, NULL, NULL, 'PHP', '', base + interval '8 minutes');
  b := test.new_bill(alice, alice, NULL, 'R9 deleted', 200, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '9 minutes', is_deleted = true WHERE id = b;
  b := test.new_bill(bob, bob, NULL, 'R10 usd museum', 100, ARRAY[alice, bob], 'USD');
  UPDATE public.bills SET created_at = base + interval '10 minutes' WHERE id = b;
  PERFORM test.new_settlement(alice, bob, 15, NULL, NULL, 'USD', '', base + interval '11 minutes');
  b := test.new_bill(alice, alice, g2, 'R12 ferry', 120, ARRAY[alice, bob, cara]);
  UPDATE public.bills SET created_at = base + interval '12 minutes' WHERE id = b;

  RETURN jsonb_build_object('alice', alice, 'bob', bob, 'cara', cara, 'zed', zed, 'c_bob', c_bob,
                            'g1', g1, 'g2', g2, 'bundle', bundle);
END;
$$;

-- ---------------------------------------------------------------------------
-- C1: kwenta_person_statement(uuid) is untouched — signature, grant, and byte-identical output.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; cara uuid; zed uuid; c_bob uuid;
  got jsonb; ref jsonb;
BEGIN
  f := test.p86_rich('c1');
  alice := (f ->> 'alice')::uuid; bob := (f ->> 'bob')::uuid; cara := (f ->> 'cara')::uuid;
  zed := (f ->> 'zed')::uuid; c_bob := (f ->> 'c_bob')::uuid;

  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_person_statement'), 1,
    'C1: kwenta_person_statement keeps exactly one signature');
  PERFORM test.assert_true(to_regprocedure('public.kwenta_person_statement(uuid)') IS NOT NULL,
    'C1: kwenta_person_statement(uuid) exists');
  PERFORM test.assert_eq(
    (SELECT format_type(p.prorettype, NULL) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.kwenta_person_statement(uuid)')),
    'jsonb', 'C1: and still returns jsonb');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_person_statement(uuid)', 'EXECUTE'),
    'C1: installed apps (authenticated) still execute it');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_person_statement(uuid)', 'EXECUTE'),
    'C1: anon still does not');

  -- Every viewer/person pair the fixture makes interesting, including the linked contact's id,
  -- the reverse perspective, a one-group co-member and a stranger.
  PERFORM test.as_user(alice);
  got := public.kwenta_person_statement(bob); ref := test.person_statement_065(bob);
  PERFORM test.assert_eq(jsonb_array_length(ref), 12, 'C1: the reference sees 12 events (bundle = 2 legs, deleted bill excluded)');
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> Bob is byte-identical to 065');
  got := public.kwenta_person_statement(c_bob); ref := test.person_statement_065(c_bob);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> her linked contact is byte-identical to 065');
  got := public.kwenta_person_statement(zed); ref := test.person_statement_065(zed);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> a stranger is byte-identical ([])');
  PERFORM test.assert_eq(got, '[]'::jsonb, 'C1: and that is the empty array');
  PERFORM test.as_owner();

  PERFORM test.as_user(bob);
  got := public.kwenta_person_statement(alice); ref := test.person_statement_065(alice);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Bob -> Alice (the mirror) is byte-identical to 065');
  PERFORM test.as_owner();

  PERFORM test.as_user(cara);
  got := public.kwenta_person_statement(alice); ref := test.person_statement_065(alice);
  PERFORM test.assert_eq(jsonb_array_length(ref), 2, 'C1: Cara -> Alice sees the two Trip bills');
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Cara -> Alice (Trip only) is byte-identical to 065');
  got := public.kwenta_person_statement(bob); ref := test.person_statement_065(bob);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Cara -> Bob (shared group, nothing between them) is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.note('086 C1: kwenta_person_statement untouched (signature, grants, byte-identical output)');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2, C3, C4, C5, C15: running numbers on every page under both kinds; the hero agrees.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; c_bob uuid; cara uuid;
  p jsonb; pay jsonb; hero jsonb; cur text; newest jsonb;
BEGIN
  f := test.p86_rich('c2');
  alice := (f ->> 'alice')::uuid; bob := (f ->> 'bob')::uuid; c_bob := (f ->> 'c_bob')::uuid;
  cara := (f ->> 'cara')::uuid;

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 500, 'all', NULL);
  PERFORM test.assert_true(jsonb_typeof(p) = 'object', 'C2: the page is an object');
  PERFORM test.assert_eq(jsonb_array_length(p -> 'events'), 12, 'C2: all 12 events on one page');
  PERFORM test.assert_eq((p ->> 'matching')::int, 12, 'C4: matching 12 under kind all');

  -- Literal anchors for the newest-first order and the running numbers, from the fixture comment.
  PERFORM test.assert_eq(p -> 'events' -> 0 ->> 'title', 'R12 ferry', 'C2: newest first');
  PERFORM test.assert_eq(p -> 'events' -> 11 ->> 'title', 'R1 dinner', 'C2: oldest last');
  PERFORM test.assert_money((p -> 'events' -> 11 ->> 'runningNet')::numeric, 50, 'C2: R1 runs to +50');
  PERFORM test.assert_money((p -> 'events' -> 11 ->> 'prevRunning')::numeric, 0, 'C2: R1 starts from 0');
  PERFORM test.assert_money((p -> 'events' -> 0 ->> 'runningNet')::numeric, -50, 'C2: R12 ends PHP at -50');
  PERFORM test.assert_money((p -> 'events' -> 0 ->> 'prevRunning')::numeric, -90,
    'C2: R12 starts from the overpaid -90');
  SELECT e INTO newest FROM jsonb_array_elements(p -> 'events') e WHERE e ->> 'title' = 'R6 usd books';
  PERFORM test.assert_money((newest ->> 'runningNet')::numeric, 20, 'C9: the first USD event runs from USD 0, not from PHP');

  -- C3: the newest event of each currency ends on the hero.
  hero := public.kwenta_person_summary(bob) -> 'total';
  PERFORM test.assert_money((hero ->> 'PHP')::numeric, -50, 'C3: hero PHP is -50');
  PERFORM test.assert_money((hero ->> 'USD')::numeric, -15, 'C3: hero USD is -15');
  FOREACH cur IN ARRAY ARRAY['PHP', 'USD'] LOOP
    SELECT e INTO newest FROM jsonb_array_elements(p -> 'events') WITH ORDINALITY t(e, o)
     WHERE e ->> 'currency' = cur ORDER BY o LIMIT 1;
    PERFORM test.assert_money((newest ->> 'runningNet')::numeric, (hero ->> cur)::numeric,
      'C3: the newest ' || cur || ' event''s runningNet is the hero total');
  END LOOP;
  -- C3 on the FIRST page at the default size: the newest event is the hero's PHP number.
  p := public.kwenta_person_statement_page(bob, 1);
  PERFORM test.assert_money((p -> 'events' -> 0 ->> 'runningNet')::numeric, (hero ->> 'PHP')::numeric,
    'C3: a one-event first page already shows the hero number');

  -- C5: payments only, each with the all-kinds running number (bills between them still count).
  pay := public.kwenta_person_statement_page(bob, 500, 'payments', NULL);
  PERFORM test.assert_eq((pay ->> 'matching')::int, 4, 'C5: 4 payments (two bundle legs, the overpayment, the USD one)');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM jsonb_array_elements(pay -> 'events') e WHERE e ->> 'type' <> 'payment'), 0,
    'C5: only payment events');
  SELECT e INTO newest FROM jsonb_array_elements(pay -> 'events') e
   WHERE e ->> 'currency' = 'PHP' AND e ->> 'bundleId' IS NULL;
  PERFORM test.assert_money((newest ->> 'runningNet')::numeric, -90,
    'C5: the overpayment reads -90 under the filter, the bills before it counted');
  PERFORM test.assert_money((newest ->> 'prevRunning')::numeric, 10, 'C5: and starts from +10');

  -- The same walk invariants from every interesting perspective.
  PERFORM test.p86_check_walks(bob, 'Alice->Bob', true);
  PERFORM test.p86_check_walks(c_bob, 'Alice->linked contact', true);
  PERFORM test.as_owner();

  PERFORM test.as_user(bob);
  PERFORM test.p86_check_walks(alice, 'Bob->Alice', true);
  hero := public.kwenta_person_summary(alice) -> 'total';
  p := public.kwenta_person_statement_page(alice, 20);
  FOREACH cur IN ARRAY ARRAY['PHP', 'USD'] LOOP
    SELECT e INTO newest FROM jsonb_array_elements(p -> 'events') WITH ORDINALITY t(e, o)
     WHERE e ->> 'currency' = cur ORDER BY o LIMIT 1;
    PERFORM test.assert_money((newest ->> 'runningNet')::numeric, (hero ->> cur)::numeric,
      'C3: from Bob''s side too, the newest ' || cur || ' event is the hero');
  END LOOP;
  PERFORM test.as_owner();

  PERFORM test.as_user(cara);
  PERFORM test.p86_check_walks(alice, 'Cara->Alice', true);
  PERFORM test.as_owner();

  PERFORM test.note('086 C2/C3/C4/C5/C15: running numbers on every page, both kinds, hero agrees');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: bundle completion. A bundle's two legs sit at DIFFERENT instants with a bill and another
-- payment between them; walking with limits 1..5 under both kinds skips nothing.
--   t1 B1 bill +500 | t2 L1 leg (bundle X, personal) -100 | t3 B2 bill -30 | t4 P1 payment +20
--   t5 L2 leg (bundle X, in group Flat) -50 | t6 G1 group bill +40
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '15 days';
  alice uuid; bob uuid; g uuid; bx uuid := gen_random_uuid();
  b1 uuid; l1 uuid; b2 uuid; p1 uuid; l2 uuid; g1 uuid;
  pages jsonb; p jsonb;
BEGIN
  alice := test.new_account('p86c6-alice@example.com', 'Alice');
  bob   := test.new_account('p86c6-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  b1 := test.p86_ev(alice, bob, 'bill', 500, base + interval '1 minute', 'PHP', 'B1');
  l1 := test.new_settlement(bob, alice, 100, NULL, NULL, 'PHP', '', base + interval '2 minutes');
  b2 := test.p86_ev(alice, bob, 'bill', -30, base + interval '3 minutes', 'PHP', 'B2');
  p1 := test.p86_ev(alice, bob, 'payment', 20, base + interval '4 minutes');
  l2 := test.new_settlement(bob, alice, 50, g, NULL, 'PHP', '', base + interval '5 minutes');
  UPDATE public.settlements SET bundle_id = bx WHERE id IN (l1, l2);
  g1 := test.new_bill(alice, alice, g, 'G1', 80, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '6 minutes' WHERE id = g1;

  PERFORM test.as_user(alice);

  -- kind all, limit 1: [G1] | [L2 .. down to L1, with P1 and B2 between] | [B1]
  pages := test.p86_walk(bob, 1, 'all');
  PERFORM test.assert_eq(jsonb_array_length(pages), 3, 'C6: all/1 walks in three pages');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[g1], 'C6: all/1 page 1 is the newest bill');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[l2, p1, b2, l1],
    'C6: all/1 page 2 starts at a leg and extends to its bundle''s oldest leg, taking the payment and bill between');
  PERFORM test.assert_eq(test.p86_ids(pages -> 2), ARRAY[b1], 'C6: all/1 page 3 is the oldest bill, nothing skipped');

  -- kind all, limit 2: [G1, L2 -> extended to L1] | [B1]
  pages := test.p86_walk(bob, 2, 'all');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[g1, l2, p1, b2, l1], 'C6: all/2 page 1 extends to L1');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[b1], 'C6: all/2 page 2');
  PERFORM test.assert_eq(jsonb_array_length(pages), 2, 'C6: all/2 two pages');

  -- kind all, limit 3: the oldest row is P1, a payment in no bundle: no extension.
  pages := test.p86_walk(bob, 3, 'all');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[g1, l2, p1], 'C6: all/3 an unbundled payment does not extend the page');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[b2, l1, b1], 'C6: all/3 page 2 (L1 is its bundle''s oldest leg)');

  pages := test.p86_walk(bob, 4, 'all');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[g1, l2, p1, b2], 'C6: all/4 page 1 ends on a bill: no extension');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[l1, b1], 'C6: all/4 page 2');

  pages := test.p86_walk(bob, 5, 'all');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[g1, l2, p1, b2, l1], 'C6: all/5 page 1 ends on the bundle''s oldest leg');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[b1], 'C6: all/5 page 2');

  -- kind payments, limit 1: [L2 -> extended down to L1, taking P1, a payment of ANOTHER bundle-less kind]
  pages := test.p86_walk(bob, 1, 'payments');
  PERFORM test.assert_eq(jsonb_array_length(pages), 1, 'C6: payments/1 one page');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[l2, p1, l1],
    'C6: payments/1 extends from L2 to L1 and takes the payment between, but no bill');
  pages := test.p86_walk(bob, 2, 'payments');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[l2, p1], 'C6: payments/2 ends on an unbundled payment');
  PERFORM test.assert_eq(test.p86_ids(pages -> 1), ARRAY[l1], 'C6: payments/2 page 2');
  pages := test.p86_walk(bob, 3, 'payments');
  PERFORM test.assert_eq(test.p86_ids(pages -> 0), ARRAY[l2, p1, l1], 'C6: payments/3 one page');
  PERFORM test.assert_eq(jsonb_array_length(pages), 1, 'C6: payments/3 nothing after');

  -- The running numbers inside an extended page are still the all-kinds ones.
  p := public.kwenta_person_statement_page(bob, 1, 'payments', NULL);
  PERFORM test.assert_money(test.p86_run(p, l1), 400, 'C6: L1 runs 500 -> 400');
  PERFORM test.assert_money(test.p86_run(p, p1), 390, 'C6: P1 runs 370 -> 390 (B2 -30 counted)');
  PERFORM test.assert_money(test.p86_prev(p, p1), 370, 'C6: P1 prevRunning 370');
  PERFORM test.assert_money(test.p86_run(p, l2), 340, 'C6: L2 runs 390 -> 340');
  PERFORM test.assert_eq((p ->> 'matching')::int, 3, 'C6: matching 3 payments although the page holds 3 for limit 1');

  -- Not "bundles whole" here: by the stated rule the extension triggers only when the OLDEST row
  -- is a leg, so all/3 legitimately ends on P1 with L2 above and L1 on the next page. The legs are
  -- not adjacent, so collapsePaymentLegs would not merge them on one page either.
  PERFORM test.p86_check_walks(bob, 'C6 fixture', false);
  PERFORM test.as_owner();
  PERFORM test.note('086 C6: a page never ends mid-bundle and the next cursor skips nothing');
END;
$$;

-- C6/C4 with two bundles interleaved in time (Y1 X1 bill Y2 X2): whatever pages come out, every
-- event is visited exactly once, in order, with the right running numbers.
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '14 days';
  alice uuid; bob uuid; bx uuid := gen_random_uuid(); byy uuid := gen_random_uuid();
  x1 uuid; x2 uuid; y1 uuid; y2 uuid;
BEGIN
  alice := test.new_account('p86c6i-alice@example.com', 'Alice');
  bob   := test.new_account('p86c6i-bob@example.com', 'Bob');
  PERFORM test.p86_ev(alice, bob, 'bill', 500, base, 'PHP', 'Opening');
  y1 := test.new_settlement(bob, alice, 10, NULL, NULL, 'PHP', '', base + interval '1 minute');
  x1 := test.new_settlement(bob, alice, 20, NULL, NULL, 'PHP', '', base + interval '2 minutes');
  PERFORM test.p86_ev(alice, bob, 'bill', 60, base + interval '3 minutes', 'PHP', 'Between');
  y2 := test.new_settlement(bob, alice, 30, NULL, NULL, 'PHP', '', base + interval '4 minutes');
  x2 := test.new_settlement(alice, bob, 40, NULL, NULL, 'PHP', '', base + interval '5 minutes');
  UPDATE public.settlements SET bundle_id = bx WHERE id IN (x1, x2);
  UPDATE public.settlements SET bundle_id = byy WHERE id IN (y1, y2);
  PERFORM test.p86_ev(alice, bob, 'bill', -70, base + interval '6 minutes', 'PHP', 'Last');

  PERFORM test.as_user(alice);
  PERFORM test.p86_check_walks(bob, 'interleaved bundles', false);
  PERFORM test.as_owner();
  PERFORM test.note('086 C6/C4: interleaved bundles still walk exactly once');
END;
$$;

-- ---------------------------------------------------------------------------
-- C7: limits, kind, cursor.
-- 505 personal payments (Bob -> Alice, 1 each, one second apart) and one group bill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '10 days';
  alice uuid; bob uuid; g uuid; gb uuid; i integer; p jsonb; msg text; bad jsonb;
  newest jsonb;
BEGIN
  alice := test.new_account('p86c7-alice@example.com', 'Alice');
  bob   := test.new_account('p86c7-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  gb := test.new_bill(alice, alice, g, 'Big group bill', 2000, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base WHERE id = gb;
  FOR i IN 1 .. 505 LOOP
    PERFORM test.new_settlement(bob, alice, 1, NULL, NULL, 'PHP', '', base + make_interval(secs => i));
  END LOOP;

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, NULL) -> 'events'), 20,
    'C7: a NULL limit means 20');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 20) -> 'events'), 20,
    'C7: limit 20');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 0) -> 'events'), 1,
    'C7: limit 0 clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, -5) -> 'events'), 1,
    'C7: a negative limit clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 499) -> 'events'), 499,
    'C7: limit 499');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 500) -> 'events'), 500,
    'C7: limit 500');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 501) -> 'events'), 500,
    'C7: limit 501 clamps to 500');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_statement_page(bob, 100000) -> 'events'), 500,
    'C7: a huge limit clamps to 500');

  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_eq(p, public.kwenta_person_statement_page(bob, 20, 'all', NULL),
    'C7: kind defaults to all and the cursor to none');
  PERFORM test.assert_eq((p ->> 'matching')::int, 506, 'C7: matching counts all 506 events');
  PERFORM test.assert_eq((public.kwenta_person_statement_page(bob, 20, 'payments') ->> 'matching')::int, 505,
    'C7: matching under payments counts 505');
  PERFORM test.assert_money((p -> 'events' -> 0 ->> 'runningNet')::numeric, 1000 - 505,
    'C7: the newest of 506 events runs to 495');
  PERFORM test.assert_money((p -> 'events' -> 19 ->> 'runningNet')::numeric, 1000 - 486,
    'C7: the 20th newest runs to 514 (the 486 older payments counted, not just the page)');
  PERFORM test.assert_eq(p ->> 'latestPersonalCurrency', NULL::text,
    'C18: no personal bill in the whole history -> latestPersonalCurrency is null');

  -- The oldest event, reached past a 500 page: the full history is visible through the cursor.
  newest := public.kwenta_person_statement_page(bob, 500) -> 'events' -> 499;
  p := public.kwenta_person_statement_page(bob, 500, 'all',
         jsonb_build_object('createdAt', newest -> 'createdAt', 'id', newest -> 'id'));
  PERFORM test.assert_eq(jsonb_array_length(p -> 'events'), 6, 'C7: past the first 500, the remaining 6');
  PERFORM test.assert_eq((p -> 'events' -> 5 ->> 'id')::uuid, gb, 'C7: the oldest is the group bill');
  PERFORM test.assert_money((p -> 'events' -> 5 ->> 'runningNet')::numeric, 1000, 'C7: which runs to +1000');

  -- Unknown kinds raise.
  FOREACH msg IN ARRAY ARRAY['bills', 'everything', 'ALL '] LOOP
    DECLARE got text := NULL;
    BEGIN
      BEGIN
        PERFORM public.kwenta_person_statement_page(bob, 20, msg, NULL);
      EXCEPTION WHEN OTHERS THEN
        got := SQLERRM;
      END;
      PERFORM test.assert_true(got IS NOT NULL, 'C7: kind ''' || msg || ''' raises');
    END;
  END LOOP;

  -- Malformed cursors raise rather than silently returning an empty or a first page.
  FOREACH bad IN ARRAY ARRAY[
    jsonb_build_object('createdAt', 'not a time', 'id', gen_random_uuid()),
    jsonb_build_object('createdAt', base, 'id', 'not-a-uuid'),
    jsonb_build_object('createdAt', base),
    jsonb_build_object('id', gen_random_uuid()),
    '[1, 2]'::jsonb,
    '"2026-01-01"'::jsonb
  ] LOOP
    DECLARE got text := NULL;
    BEGIN
      BEGIN
        PERFORM public.kwenta_person_statement_page(bob, 20, 'all', bad);
      EXCEPTION WHEN OTHERS THEN
        got := SQLERRM;
      END;
      PERFORM test.assert_true(got IS NOT NULL, 'C7: cursor ' || bad::text || ' raises');
    END;
  END LOOP;
  PERFORM test.as_owner();
  PERFORM test.note('086 C7: limit default and clamp, kind and cursor refusals');
END;
$$;

-- C7: a cursor naming an event that was deleted since (or never existed) still continues by its
-- (createdAt, id) position.
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '9 days';
  alice uuid; bob uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; p jsonb; cur jsonb;
BEGIN
  alice := test.new_account('p86c7d-alice@example.com', 'Alice');
  bob   := test.new_account('p86c7d-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', 100, base + interval '1 minute', 'PHP', 'E1');
  e2 := test.p86_ev(alice, bob, 'bill', 200, base + interval '2 minutes', 'PHP', 'E2');
  e3 := test.p86_ev(alice, bob, 'bill', 300, base + interval '3 minutes', 'PHP', 'E3');
  e4 := test.p86_ev(alice, bob, 'bill', 400, base + interval '4 minutes', 'PHP', 'E4');

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 2);
  PERFORM test.assert_eq(test.p86_ids(p -> 'events'), ARRAY[e4, e3], 'C7: first page E4, E3');
  cur := jsonb_build_object('createdAt', p -> 'events' -> 1 -> 'createdAt', 'id', p -> 'events' -> 1 -> 'id');
  PERFORM test.as_owner();

  UPDATE public.bills SET is_deleted = true WHERE id = e3;

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20, 'all', cur);
  PERFORM test.assert_eq(test.p86_ids(p -> 'events'), ARRAY[e2, e1],
    'C7: the cursor''s own event was deleted, the next page still continues below it');
  PERFORM test.assert_eq((p ->> 'matching')::int, 3, 'C7: matching no longer counts the deleted bill');
  PERFORM test.assert_money(test.p86_run(p, e2), 300, 'C7: E2 runs to 300');

  cur := jsonb_build_object('createdAt', base + interval '2 minutes 30 seconds', 'id', gen_random_uuid());
  p := public.kwenta_person_statement_page(bob, 20, 'all', cur);
  PERFORM test.assert_eq(test.p86_ids(p -> 'events'), ARRAY[e2, e1],
    'C7: a cursor naming no event at all still pages by its position');
  PERFORM test.as_owner();
  PERFORM test.note('086 C7: a deleted cursor event continues');
END;
$$;

-- ---------------------------------------------------------------------------
-- C8 + C14: refusals and scoping, exactly like kwenta_person_statement.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; cara uuid; zed uuid; c_dan uuid; c_bob uuid;
  p jsonb; msg text;
BEGIN
  f := test.p86_rich('c8');
  alice := (f ->> 'alice')::uuid; bob := (f ->> 'bob')::uuid; cara := (f ->> 'cara')::uuid;
  zed := (f ->> 'zed')::uuid; c_bob := (f ->> 'c_bob')::uuid;
  -- Alice's PRIVATE, unlinked contact, with a bill and a payment between them.
  c_dan := test.new_contact(alice, 'Dan');
  PERFORM test.new_bill(alice, alice, NULL, 'Dan dinner', 300, ARRAY[alice, c_dan]);
  PERFORM test.new_settlement(c_dan, alice, 50, NULL, NULL, 'PHP', '', now() - interval '1 day');

  -- Alice sees her contact's events.
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(c_dan, 500);
  PERFORM test.assert_eq(test.p86_strip(p -> 'events'), test.p86_old_newest_first(c_dan, 'all'),
    'C8: Alice''s own contact: the page is her statement, newest first');
  PERFORM test.assert_eq((p ->> 'matching')::int, 2, 'C8: two events with Dan');
  PERFORM test.as_owner();

  -- Bob (another account) asking for Alice's private contact sees nothing, exactly as the old endpoint.
  PERFORM test.as_user(bob);
  PERFORM test.assert_eq(public.kwenta_person_statement(c_dan), '[]'::jsonb,
    'C8: the old endpoint shows Bob nothing for Alice''s contact');
  p := public.kwenta_person_statement_page(c_dan, 500);
  PERFORM test.assert_true(p IS NOT NULL AND jsonb_typeof(p) = 'object',
    'C14: an authenticated caller gets an object, never NULL, even with nothing to show');
  PERFORM test.assert_eq(p -> 'events', '[]'::jsonb, 'C8: Bob gets no events for Alice''s private contact');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C8: and matching 0');
  PERFORM test.assert_eq((public.kwenta_person_statement_page(c_dan, 500, 'payments') ->> 'matching')::int, 0,
    'C8: and nothing under payments either');
  PERFORM test.assert_eq(p ->> 'latestPersonalCurrency', NULL::text,
    'C8: and no personal currency leaks from Alice''s bills with Dan');
  -- Bob's statement of Alice never includes Alice's events with Dan.
  p := public.kwenta_person_statement_page(alice, 500);
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'events') e WHERE e ->> 'title' IN ('Dan dinner', 'Dan paid you', 'You paid Dan')),
    'C8: Bob''s statement of Alice never shows her events with her private contact');
  PERFORM test.assert_eq(test.p86_strip(p -> 'events'), test.p86_old_newest_first(alice, 'all'),
    'C8: Bob -> Alice is exactly the old endpoint''s event set');
  PERFORM test.as_owner();

  -- Zed shares nothing with Bob; Cara shares only Trip.
  PERFORM test.as_user(zed);
  p := public.kwenta_person_statement_page(bob, 500);
  PERFORM test.assert_eq(p -> 'events', '[]'::jsonb, 'C8: a stranger sees no events');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C8: matching 0 for a stranger');
  PERFORM test.as_owner();
  PERFORM test.as_user(cara);
  p := public.kwenta_person_statement_page(alice, 500);
  PERFORM test.assert_eq(test.p86_strip(p -> 'events'), test.p86_old_newest_first(alice, 'all'),
    'C8: Cara -> Alice is exactly the old endpoint''s event set (Trip only)');
  PERFORM test.assert_eq((p ->> 'matching')::int, 2, 'C8: Cara sees the two Trip bills');
  p := public.kwenta_person_statement_page(bob, 500);
  PERFORM test.assert_eq(p -> 'events', '[]'::jsonb,
    'C8: Cara -> Bob: a shared group with nothing between them is no events');
  PERFORM test.as_owner();

  -- Unauthenticated.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_person_statement_page(bob, 20);
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C8: no auth.uid() raises ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  msg := NULL;
  BEGIN
    PERFORM public.kwenta_person_statement_page(bob, 20, 'payments',
      jsonb_build_object('createdAt', now(), 'id', gen_random_uuid()));
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C8: with a cursor too (got: ' || COALESCE(msg, 'no error') || ')');
  PERFORM test.note('086 C8/C14: scoping and refusals');
END;
$$;

-- ---------------------------------------------------------------------------
-- C9: per-currency independence and the id tiebreak.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  at timestamptz := date_trunc('second', now()) - interval '8 days';
  alice uuid; bob uuid; a uuid; b uuid; c uuid; lo uuid; mid uuid; hi uuid; p jsonb;
BEGIN
  alice := test.new_account('p86c9-alice@example.com', 'Alice');
  bob   := test.new_account('p86c9-bob@example.com', 'Bob');
  -- Three events at the SAME instant: two bills and a payment (different tables, one order).
  a := test.p86_ev(alice, bob, 'bill', 10, at, 'PHP', 'Tie A');
  b := test.p86_ev(alice, bob, 'bill', 20, at, 'PHP', 'Tie B');
  c := test.p86_ev(alice, bob, 'payment', -5, at);
  SELECT x[1], x[2], x[3] INTO lo, mid, hi
  FROM (SELECT array_agg(i ORDER BY i) AS x FROM unnest(ARRAY[a, b, c]) i) s;

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_eq(test.p86_ids(p -> 'events'), ARRAY[hi, mid, lo],
    'C9: a timestamp tie is ordered by id (newest-first = id descending)');
  PERFORM test.assert_money(test.p86_prev(p, lo), 0, 'C9: the lowest id starts the walk');
  PERFORM test.assert_money(test.p86_run(p, hi), 25, 'C9: the highest id ends it on 10 + 20 - 5');
  PERFORM test.assert_money(test.p86_prev(p, mid), test.p86_run(p, lo), 'C9: each tie member starts where the lower id ended');
  PERFORM test.assert_money(test.p86_prev(p, hi), test.p86_run(p, mid), 'C9: and so on');
  -- Paging through the tie one at a time agrees.
  PERFORM test.p86_check_walks(bob, 'C9 tie', true);
  PERFORM test.as_owner();
  PERFORM test.note('086 C9: timestamp ties break by id');
END;
$$;

-- ---------------------------------------------------------------------------
-- C11: the running-balance rules formerly pinned by tests/lib/money-flow.test.ts
-- (buildMoneyFlowRows), restated against the server's runningNet/prevRunning.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t1 timestamptz := date_trunc('second', now()) - interval '5 days';
  t2 timestamptz := date_trunc('second', now()) - interval '4 days';
  t3 timestamptz := date_trunc('second', now()) - interval '3 days';
  alice uuid; bob uuid; e1 uuid; e2 uuid; e3 uuid; p jsonb;
BEGIN
  -- 'carries a signed running total across events': 500, then their payment of 200 -> 300.
  alice := test.new_account('p86m1-alice@example.com', 'Alice');
  bob   := test.new_account('p86m1-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', 500, t1);
  e2 := test.p86_ev(alice, bob, 'payment', -200, t2);
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_money(test.p86_run(p, e1), 500, 'C11 signed total: 500');
  PERFORM test.assert_money(test.p86_run(p, e2), 300, 'C11 signed total: then 300');
  PERFORM test.assert_money((public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric, 300,
    'C11 signed total: currentNet (the hero) is 300');
  -- 'reports each row's own effect on the balance': runningNet - prevRunning = 500, -200.
  PERFORM test.assert_money(test.p86_run(p, e1) - test.p86_prev(p, e1), 500, 'C11 own effect: the bill +500');
  PERFORM test.assert_money(test.p86_run(p, e2) - test.p86_prev(p, e2), -200, 'C11 own effect: the payment -200');
  PERFORM test.as_owner();

  -- 'an overpayment from them flips the tab past zero': 500, -800 -> -300.
  alice := test.new_account('p86m2-alice@example.com', 'Alice');
  bob   := test.new_account('p86m2-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', 500, t1);
  e2 := test.p86_ev(alice, bob, 'payment', -800, t2);
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_money(test.p86_run(p, e2), -300, 'C11 overpayment flips past zero: -300');
  PERFORM test.assert_money((public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric, -300,
    'C11 overpayment: the hero agrees, no credit clamp');
  PERFORM test.as_owner();

  -- 'a later bill moves a flipped tab back': 500, -800, +200 -> -100.
  alice := test.new_account('p86m3-alice@example.com', 'Alice');
  bob   := test.new_account('p86m3-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', 500, t1);
  e2 := test.p86_ev(alice, bob, 'payment', -800, t2);
  e3 := test.p86_ev(alice, bob, 'bill', 200, t3);
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_money(test.p86_run(p, e3), -100, 'C11 later bill moves a flipped tab back: -100');
  PERFORM test.assert_money(test.p86_prev(p, e3), -300, 'C11 from -300');
  PERFORM test.as_owner();

  -- 'my own overpayment flips the tab the other way': -300, +500 -> 200.
  alice := test.new_account('p86m4-alice@example.com', 'Alice');
  bob   := test.new_account('p86m4-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', -300, t1);
  e2 := test.p86_ev(alice, bob, 'payment', 500, t2);
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_money(test.p86_run(p, e1), -300, 'C11 my overpayment: -300 first');
  PERFORM test.assert_money(test.p86_run(p, e2), 200, 'C11 my overpayment flips the other way: 200');
  PERFORM test.as_owner();

  -- 'sorts events chronologically regardless of input order': inserted t3, t1, t2.
  alice := test.new_account('p86m5-alice@example.com', 'Alice');
  bob   := test.new_account('p86m5-bob@example.com', 'Bob');
  e3 := test.p86_ev(alice, bob, 'bill', 100, t3, 'PHP', 'b3');
  e1 := test.p86_ev(alice, bob, 'bill', 500, t1, 'PHP', 'b1');
  e2 := test.p86_ev(alice, bob, 'bill', -200, t2, 'PHP', 'b2');
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_eq(test.p86_ids(p -> 'events'), ARRAY[e3, e2, e1], 'C11 chronological: newest first regardless of insert order');
  PERFORM test.assert_money(test.p86_run(p, e1), 500, 'C11 chronological: 500');
  PERFORM test.assert_money(test.p86_run(p, e2), 300, 'C11 chronological: 300');
  PERFORM test.assert_money(test.p86_run(p, e3), 400, 'C11 chronological: 400');
  PERFORM test.as_owner();

  -- 'keeps an independent running balance per currency': PHP 500, USD -20, PHP 100.
  alice := test.new_account('p86m6-alice@example.com', 'Alice');
  bob   := test.new_account('p86m6-bob@example.com', 'Bob');
  e1 := test.p86_ev(alice, bob, 'bill', 500, t1, 'PHP');
  e2 := test.p86_ev(alice, bob, 'bill', -20, t2, 'USD');
  e3 := test.p86_ev(alice, bob, 'bill', 100, t3, 'PHP');
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_money(test.p86_run(p, e3), 600, 'C11 per currency: PHP ends at 600');
  PERFORM test.assert_money(test.p86_run(p, e2), -20, 'C11 per currency: the USD row does not inherit the PHP total');
  PERFORM test.assert_money(test.p86_prev(p, e2), 0, 'C11 per currency: USD starts from 0');
  PERFORM test.assert_money(test.p86_prev(p, e3), 500, 'C11 per currency: PHP resumes from 500, skipping USD');
  PERFORM test.assert_money((public.kwenta_person_summary(bob) -> 'total' ->> 'USD')::numeric, -20,
    'C11 per currency: the USD hero is -20');
  PERFORM test.as_owner();

  -- 'returns an empty statement for no events'.
  alice := test.new_account('p86m7-alice@example.com', 'Alice');
  bob   := test.new_account('p86m7-bob@example.com', 'Bob');
  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_eq(p -> 'events', '[]'::jsonb, 'C11 empty: no events');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C11 empty: matching 0');
  PERFORM test.as_owner();

  PERFORM test.note('086 C11: buildMoneyFlowRows running-balance rules hold in SQL');
END;
$$;

-- ---------------------------------------------------------------------------
-- C18: latestPersonalCurrency is the newest personal bill's currency over the WHOLE history,
-- not the page's: here the last personal bill is older than 25 newer group events.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '7 days';
  alice uuid; bob uuid; g uuid; b uuid; i integer; p jsonb;
BEGIN
  alice := test.new_account('p86c18-alice@example.com', 'Alice');
  bob   := test.new_account('p86c18-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Euro trip', 'EUR');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.p86_ev(alice, bob, 'bill', 50, base + interval '1 minute', 'PHP', 'old php');
  PERFORM test.p86_ev(alice, bob, 'bill', -30, base + interval '2 minutes', 'USD', 'newest live personal (USD)');
  -- A newer personal bill in JPY, deleted: not an event, so it cannot be the default.
  b := test.p86_ev(alice, bob, 'bill', 70, base + interval '3 minutes', 'JPY', 'deleted jpy');
  UPDATE public.bills SET is_deleted = true WHERE id = b;
  FOR i IN 1 .. 25 LOOP
    b := test.new_bill(alice, alice, g, 'group ' || i, 20, ARRAY[alice, bob], 'EUR');
    UPDATE public.bills SET created_at = base + interval '10 minutes' + make_interval(mins => i) WHERE id = b;
  END LOOP;
  PERFORM test.new_settlement(bob, alice, 5, g, NULL, 'EUR', '', base + interval '1 hour');

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 20);
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'events') e WHERE e ->> 'type' = 'personal_bill'),
    'C18: the first page holds no personal bill at all');
  PERFORM test.assert_eq(p ->> 'latestPersonalCurrency', 'USD',
    'C18: yet latestPersonalCurrency is USD, from the newest live personal bill in the whole history');
  PERFORM test.assert_eq(public.kwenta_person_statement_page(bob, 1) ->> 'latestPersonalCurrency', 'USD',
    'C18: on a one-event page too');
  PERFORM test.assert_eq(public.kwenta_person_statement_page(bob, 20, 'payments') ->> 'latestPersonalCurrency', 'USD',
    'C18: and under the payments filter (it is over the whole history, not the filtered set)');
  PERFORM test.as_owner();

  PERFORM test.as_user(bob);
  PERFORM test.assert_eq(public.kwenta_person_statement_page(alice, 20) ->> 'latestPersonalCurrency', 'USD',
    'C18: from the other side as well (a bill either side paid counts)');
  PERFORM test.as_owner();
  PERFORM test.note('086 C18: latestPersonalCurrency is whole-history');
END;
$$;

-- ---------------------------------------------------------------------------
-- C10 + C17 + C21: kwenta_read dispatch, write priming, and 085's branch kept.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '6 days';
  alice uuid; bob uuid; g uuid; i integer; bill uuid := gen_random_uuid(); item uuid := gen_random_uuid();
  res jsonb; primed jsonb; key text;
BEGIN
  alice := test.new_account('p86c10-alice@example.com', 'Alice');
  bob   := test.new_account('p86c10-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  bill := test.new_bill(alice, alice, g, 'Group dinner', 100, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base WHERE id = bill;
  bill := gen_random_uuid();
  FOR i IN 1 .. 24 LOOP
    PERFORM test.new_settlement(bob, alice, 1, NULL, NULL, 'PHP', '', base + make_interval(mins => i));
  END LOOP;

  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_person_statement_page'),
    'C10: kwenta_read_is_allowed admits kwenta_person_statement_page');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_person_statement'),
    'C10: and still admits kwenta_person_statement (old apps prime it)');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_detail_paged'),
    'C21: and still admits 085''s kwenta_group_detail_paged');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_detail'),
    'C21: and kwenta_group_detail');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_group_bills_page'),
    'C21: kwenta_group_bills_page stays unnameable');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_statement_page', bob, 20),
    public.kwenta_person_statement_page(bob, 20, 'all', NULL),
    'C10: kwenta_read dispatches the page with its limit and kind all');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_statement_page', bob, 3),
    public.kwenta_person_statement_page(bob, 3, 'all', NULL),
    'C10: with the limit it was given');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_read('kwenta_person_statement_page', bob, NULL) -> 'events'), 20,
    'C10: a spec without a limit gets the default 20');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_statement', bob, NULL),
    public.kwenta_person_statement(bob), 'C10: the old statement still dispatches whole');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail_paged', g, 20),
    public.kwenta_group_detail_paged(g, 20), 'C21: kwenta_read still dispatches kwenta_group_detail_paged');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail', g, NULL),
    public.kwenta_group_detail(g), 'C21: and kwenta_group_detail');

  -- A personal bill written now primes the statement's first page under the client's key.
  key := 'statement-page:' || bob;
  res := public.kwenta_write(
    jsonb_build_object(
      'bills', jsonb_build_array(jsonb_build_object(
        'id', bill, 'title', 'Fresh lunch', 'group_id', NULL, 'currency', 'PHP',
        'created_by', alice, 'paid_by', alice, 'total_amount', 300,
        'note', '', 'category', NULL,
        'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
        'is_deleted', false, 'device_id', 'test')),
      'bill_items', jsonb_build_array(jsonb_build_object(
        'id', item, 'bill_id', bill, 'name', 'Fresh lunch', 'amount', 300,
        'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
        'is_deleted', false, 'device_id', 'test')),
      'item_splits', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid(), 'item_id', item, 'user_id', alice,
          'split_type', 'equal', 'split_value', 1, 'computed_amount', 150,
          'created_at', now(), 'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test'),
        jsonb_build_object('id', gen_random_uuid(), 'item_id', item, 'user_id', bob,
          'split_type', 'equal', 'split_value', 1, 'computed_amount', 150,
          'created_at', now(), 'updated_at', now(), 'synced_at', NULL, 'is_deleted', false, 'device_id', 'test'))),
    gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('key', key, 'fn', 'kwenta_person_statement_page', 'id', bob, 'limit', 20)));
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? bill::text, 'C10: the personal bill is applied');
  primed := res -> 'reads' -> key;
  PERFORM test.assert_true(primed IS NOT NULL AND jsonb_typeof(primed) = 'object',
    'C10/C17: the write returns the statement page under statement-page:<id>');
  PERFORM test.assert_eq(jsonb_array_length(primed -> 'events'), 20, 'C10: with 20 events');
  PERFORM test.assert_eq((primed -> 'events' -> 0 ->> 'id')::uuid, bill, 'C10: the bill just written is already first');
  PERFORM test.assert_eq((primed ->> 'matching')::int, 26, 'C10: matching already includes it (24 + 1 group + 1)');
  PERFORM test.assert_money((primed -> 'events' -> 0 ->> 'runningNet')::numeric,
    (public.kwenta_person_summary(bob) -> 'total' ->> 'PHP')::numeric,
    'C10/C3: the primed first event already shows the new hero number');
  PERFORM test.assert_eq(primed ->> 'latestPersonalCurrency', 'PHP', 'C18: the new bill sets latestPersonalCurrency');
  PERFORM test.assert_eq(primed, public.kwenta_person_statement_page(bob, 20),
    'C10: the primed payload equals a direct call after the write');
  PERFORM test.as_owner();
  PERFORM test.note('086 C10/C17/C21: kwenta_read dispatch and write priming');
END;
$$;

-- ---------------------------------------------------------------------------
-- C21: grants. authenticated only, one signature, returns jsonb.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  sig text := 'public.kwenta_person_statement_page(uuid, integer, text, jsonb)';
BEGIN
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_person_statement_page'), 1,
    'C21: kwenta_person_statement_page has one signature');
  PERFORM test.assert_true(to_regprocedure(sig) IS NOT NULL, 'C21: ' || sig || ' exists');
  PERFORM test.assert_true(has_function_privilege('authenticated', sig, 'EXECUTE'), 'C21: authenticated executes it');
  PERFORM test.assert_false(has_function_privilege('anon', sig, 'EXECUTE'), 'C21: anon may not');
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.oid = to_regprocedure(sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
    'C21: PUBLIC holds no EXECUTE on it');
  PERFORM test.assert_eq(
    (SELECT format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.oid = to_regprocedure(sig)),
    'jsonb', 'C21: it returns jsonb');
  PERFORM test.note('086 C21: grants');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: the 500 clamp bounds the rows asked for, not the rows returned. A bundle's two legs are 600
-- events apart; with the newest row the newer leg and limit 1, the page extends down to the older
-- leg (601 rows), and the next cursor continues below it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '12 days';
  alice uuid; bob uuid; bx uuid := gen_random_uuid();
  l1 uuid; l2 uuid; i integer; p jsonb; p2 jsonb; cur jsonb;
BEGIN
  alice := test.new_account('p86c6w-alice@example.com', 'Alice');
  bob   := test.new_account('p86c6w-bob@example.com', 'Bob');
  PERFORM test.p86_ev(alice, bob, 'bill', 100, base, 'PHP', 'Opening');
  l1 := test.new_settlement(bob, alice, 5, NULL, NULL, 'PHP', '', base + interval '1 second');
  FOR i IN 1 .. 600 LOOP
    PERFORM test.new_settlement(bob, alice, 1, NULL, NULL, 'PHP', '', base + make_interval(secs => 1 + i));
  END LOOP;
  l2 := test.new_settlement(bob, alice, 7, NULL, NULL, 'PHP', '', base + interval '602 seconds');
  UPDATE public.settlements SET bundle_id = bx WHERE id IN (l1, l2);

  PERFORM test.as_user(alice);
  p := public.kwenta_person_statement_page(bob, 1, 'all', NULL);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'events'), 602,
    'C6: limit 1 on the newer leg extends past the 500 clamp, down to the older leg (602 events)');
  PERFORM test.assert_eq((p -> 'events' -> 0 ->> 'id')::uuid, l2, 'C6: the page starts at the newer leg');
  PERFORM test.assert_eq((p -> 'events' -> 601 ->> 'id')::uuid, l1, 'C6: and ends at the older leg');
  PERFORM test.p86_check_running(bob, p -> 'events', 'C6 wide bundle');

  cur := jsonb_build_object('createdAt', p -> 'events' -> 601 -> 'createdAt', 'id', p -> 'events' -> 601 -> 'id');
  p2 := public.kwenta_person_statement_page(bob, 1, 'all', cur);
  PERFORM test.assert_eq(jsonb_array_length(p2 -> 'events'), 1, 'C6: the next page is the one event below the older leg');
  PERFORM test.assert_eq(p2 -> 'events' -> 0 ->> 'title', 'Opening', 'C6: the opening bill, nothing skipped');
  PERFORM test.assert_eq((p2 ->> 'matching')::int, 603, 'C6: matching is the whole history on every page');

  p := public.kwenta_person_statement_page(bob, 1, 'payments', NULL);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'events'), 602, 'C6: under payments too, every payment between the legs is taken');
  PERFORM test.as_owner();
  PERFORM test.note('086 C6: a bundle wider than the clamp still extends whole');
END;
$$;
