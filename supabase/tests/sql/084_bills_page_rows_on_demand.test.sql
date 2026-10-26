-- Migration 084: the Bills page builds rows on demand.
--
-- 083's kwenta_personal_bills_page built the WHOLE kwenta_personal_bills() row set (pills, names,
-- item counts, settled flags for every bill) on every request and then kept 20. 084 splits that
-- into a cheap index (id, bucket, created_at, title, category) and a row builder that runs only for
-- the ids a page returns. Nothing a client sees may change. Pinned here, against FROZEN copies of
-- the previous bodies (an independent second opinion, as in 051's and 083's suites):
--
--   C1  page output is jsonb-identical to 083's page for every bucket x sort x settled x category,
--       first pages and keyset cursor pages, including a cursor whose row was deleted since.
--   C2  kwenta_personal_bills() is identical to 079's body (mine and shared, order included), and
--       the two new helpers agree with it (index buckets, rows per id).
--   C3  a settled='all' page resolves names / identity clusters only for its own rows, hands the
--       settled map at most p_limit ids, and pulls the privacy-scoped rows no more often than 079.
--   C4  settled / unsettled filters: same matching counts and rows as 083.
--   C5  the helpers take p_uid, are SECURITY DEFINER, service_role only, survive the acting-user
--       sweep closed, and refuse a p_uid other than auth.uid() (and a NULL auth.uid()).
--   C6  the endpoints refuse an unauthenticated caller and stay scoped to auth.uid().
--   C7  an inactive account is refused by the endpoint gate exactly as before 084.
--   C8  an empty account gets empty rows, zero counts and empty buckets.
--
-- Hand-made rows (everything else comes from the 001 fixtures new_account / new_contact /
-- new_bill / new_group / new_settlement):
--   * created_at / category / is_deleted are UPDATEd onto new_bill rows (now() is constant inside a
--     transaction, so dates and ties must be set by hand), as 083's suite does;
--   * the conversion columns of two bills (079's four bill columns plus bill_items/item_splits
--     .original_amount), set by UPDATE in the order the stale-conversion trigger allows;
--   * one bill whose only item is soft-deleted (itemCount 0, no split participants);
--   * one contact soft-deleted after its bill was filed (073's deleted-contact pill rule);
--   * C3's bulk fixture: 120 local contacts in new_contact's exact column shape (email '') and 125
--     bills in new_bill's shape (one item, equal splits, split_value = 1) via generate_series.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 079's kwenta_personal_bills, copied verbatim from 079_foreign_currency_bills.sql:528-693 with
-- only its name changed. Do not "tidy" it: its value is being the pre-084 answer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.personal_bills_079_reference()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_bills public.bills[];
  v_bill_ids uuid[];
  v_settled jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- The visible personal bills, read once through the privacy boundary and reused below.
  v_bills := ARRAY(
    SELECT b
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  );
  v_bill_ids := ARRAY(SELECT vb.id FROM unnest(v_bills) vb);

  -- One pass for the whole list, so each counterparty's cross-context tab is computed once.
  v_settled := public.kwenta_bills_settled_map(v_bill_ids, v_uid);

  WITH
  me AS MATERIALIZED (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  visible_bills AS MATERIALIZED (SELECT vb.* FROM unnest(v_bills) vb),
  active_items AS MATERIALIZED (
    SELECT bi.id, bi.bill_id
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
    WHERE bi.is_deleted IS FALSE
  ),
  active_splits AS MATERIALIZED (
    SELECT ai.bill_id, sp.user_id
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.is_deleted IS FALSE
  ),
  -- Bills the viewer holds a live split on, once, rather than a scan of every split per bill.
  my_split_bills AS MATERIALIZED (
    SELECT DISTINCT s.bill_id FROM active_splits s WHERE s.user_id IN (SELECT id FROM me)
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = v_uid THEN 'mine'
             WHEN vb.id IN (SELECT bill_id FROM my_split_bills) THEN 'shared'
             ELSE NULL
           END AS bucket
    FROM visible_bills vb
  ),
  kept AS MATERIALIZED (SELECT * FROM bucketed WHERE bucket IS NOT NULL),
  participants AS MATERIALIZED (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  -- Identity is a property of the id, not of the bill: expand each distinct id once.
  -- A soft-deleted contact is outside its account's identity cluster (067), but on a pill it still
  -- names that account: key it by the account so it shares the account's pill (073).
  cluster_keys AS MATERIALIZED (
    SELECT u.uid,
           (SELECT MIN(e.id::text)::uuid
              FROM public.kwenta_expand_identity(
                     COALESCE((SELECT pr.linked_profile_id FROM public.profiles pr
                                WHERE pr.id = u.uid AND pr.is_local IS TRUE AND pr.is_deleted IS TRUE),
                              u.uid),
                     v_uid) e) AS cluster_key
    FROM (SELECT DISTINCT p.uid FROM participants p) u
  ),
  -- Own contact, else the person's live account, else the lowest id: another user's private
  -- contact must not name someone who has an account of their own (073).
  representative AS MATERIALIZED (
    SELECT p.bill_id,
           ck.cluster_key,
           COALESCE(
             MIN(p.uid::text) FILTER (
               WHERE pr.is_deleted IS FALSE AND pr.is_local IS TRUE AND pr.owner_id = v_uid
             ),
             -- The viewer's own pill reads "You" whatever represents it; its id stays as 071 chose.
             CASE WHEN NOT bool_or(p.uid IN (SELECT id FROM me)) THEN MIN(acct.id::text) END,
             MIN(p.uid::text)
           )::uuid AS rep,
           bool_or(p.uid IN (SELECT id FROM me)) AS is_me
    FROM participants p
    JOIN cluster_keys ck ON ck.uid = p.uid
    LEFT JOIN public.profiles pr ON pr.id = p.uid
    LEFT JOIN public.profiles acct
      ON acct.id = CASE WHEN pr.is_local IS TRUE THEN pr.linked_profile_id ELSE p.uid END
     AND acct.is_local IS FALSE
     AND acct.is_deleted IS FALSE
    GROUP BY p.bill_id, ck.cluster_key
  ),
  -- Every name this response prints, resolved once per id (pill labels, their sort key, payers).
  names AS MATERIALIZED (
    SELECT x.id, public.kwenta_peer_display_name(v_uid, x.id) AS name
    FROM (
      SELECT r.rep AS id FROM representative r WHERE NOT r.is_me
      UNION
      SELECT k.paid_by FROM kept k
    ) x
  ),
  pills AS (
    SELECT r.bill_id,
           jsonb_agg(
             jsonb_build_object(
               'id',    r.rep,
               'label', CASE WHEN r.is_me THEN 'You' ELSE n.name END
             )
             ORDER BY r.is_me DESC,
                      CASE WHEN r.is_me THEN '' ELSE n.name END,
                      r.rep
           ) AS pills
    FROM representative r
    LEFT JOIN names n ON n.id = r.rep
    GROUP BY r.bill_id
  ),
  item_counts AS (
    SELECT ai.bill_id, COUNT(*) AS n FROM active_items ai GROUP BY ai.bill_id
  ),
  rows AS (
    SELECT
      k.bucket,
      jsonb_build_object(
        'id',          k.id,
        'title',       k.title,
        'currency',    k.currency,
        'totalAmount', k.total_amount,
        'createdAt',   k.created_at,
        'createdBy',   k.created_by,
        -- Rule 6's roster fallback, via the same resolver as the pills (065). The viewer's own
        -- bills name the viewer here; only the PILL says "You".
        'payorName',   COALESCE(pn.name, 'Someone'),
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     COALESCE((v_settled ->> k.id::text)::boolean, true),
        'category',    k.category,
        'originalCurrency', k.original_currency,
        'originalTotal',    k.original_total,
        'exchangeRate',     k.exchange_rate,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at,
      k.id
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
    LEFT JOIN names pn ON pn.id = k.paid_by
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


-- ---------------------------------------------------------------------------
-- 083's kwenta_personal_bills_page, copied verbatim from 083_smaller_screen_payloads.sql:298-411.
-- Two tokens differ: its name, and `v_all := test.personal_bills_079_reference()` where 083 calls
-- public.kwenta_personal_bills(), so the reference does not lean on the function 084 replaces.
-- It stays SECURITY INVOKER, as 083 shipped it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.personal_bills_page_083_reference(
  p_bucket   text,
  p_limit    integer DEFAULT 20,
  p_settled  text DEFAULT 'all',
  p_category text DEFAULT NULL,
  p_sort     text DEFAULT 'date_desc',
  p_after    jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_settled text := COALESCE(p_settled, 'all');
  v_sort text := COALESCE(p_sort, 'date_desc');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 500);
  v_has_after boolean := p_after IS NOT NULL;
  v_after_id uuid;
  v_after_created_at timestamptz;
  v_after_title text;
  v_all jsonb;
  v_rows jsonb;
  v_matching integer;
BEGIN
  IF p_bucket IS NULL OR p_bucket NOT IN ('mine', 'shared') THEN
    RAISE EXCEPTION 'unknown bucket';
  END IF;
  IF v_settled NOT IN ('all', 'settled', 'unsettled') THEN
    RAISE EXCEPTION 'unknown settled filter';
  END IF;
  IF v_sort NOT IN ('date_desc', 'date_asc', 'title_asc', 'title_desc') THEN
    RAISE EXCEPTION 'unknown sort';
  END IF;

  IF v_has_after THEN
    IF jsonb_typeof(p_after) <> 'object'
       OR NOT (p_after ? 'id') OR NOT (p_after ? 'createdAt')
       OR (v_sort IN ('title_asc', 'title_desc') AND NOT (p_after ? 'title')) THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
    v_after_id := (p_after ->> 'id')::uuid;
    v_after_created_at := (p_after ->> 'createdAt')::timestamptz;
    v_after_title := lower(COALESCE(p_after ->> 'title', ''));
    IF v_after_id IS NULL OR v_after_created_at IS NULL THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
  END IF;

  v_all := test.personal_bills_079_reference();

  WITH filtered AS (
    SELECT r.x AS row,
           (r.x ->> 'createdAt')::timestamptz AS created_at,
           (r.x ->> 'id')::uuid AS id,
           lower(COALESCE(r.x ->> 'title', '')) AS ltitle
    FROM jsonb_array_elements(v_all -> p_bucket) r(x)
    WHERE (v_settled = 'all' OR ((r.x ->> 'settled')::boolean) = (v_settled = 'settled'))
      AND (p_category IS NULL OR r.x ->> 'category' = p_category)
  ),
  total AS (SELECT count(*)::integer AS n FROM filtered),
  ordered AS (
    SELECT f.row,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_sort = 'title_asc'  THEN f.ltitle END ASC,
               CASE WHEN v_sort = 'title_desc' THEN f.ltitle END DESC,
               CASE WHEN v_sort = 'date_asc'   THEN f.created_at END ASC,
               f.created_at DESC,
               f.id
           ) AS rn
    FROM filtered f
    WHERE NOT v_has_after
       OR CASE v_sort
            WHEN 'date_desc' THEN
              f.created_at < v_after_created_at
              OR (f.created_at = v_after_created_at AND f.id > v_after_id)
            WHEN 'date_asc' THEN
              f.created_at > v_after_created_at
              OR (f.created_at = v_after_created_at AND f.id > v_after_id)
            WHEN 'title_asc' THEN
              f.ltitle > v_after_title
              OR (f.ltitle = v_after_title
                  AND (f.created_at < v_after_created_at
                       OR (f.created_at = v_after_created_at AND f.id > v_after_id)))
            ELSE
              f.ltitle < v_after_title
              OR (f.ltitle = v_after_title
                  AND (f.created_at < v_after_created_at
                       OR (f.created_at = v_after_created_at AND f.id > v_after_id)))
          END
  )
  SELECT COALESCE(jsonb_agg(o.row ORDER BY o.rn) FILTER (WHERE o.rn <= v_limit), '[]'::jsonb),
         (SELECT t.n FROM total t)
  INTO v_rows, v_matching
  FROM ordered o;

  RETURN jsonb_build_object(
    'rows',       v_rows,
    'matching',   v_matching,
    'mine',       jsonb_array_length(v_all -> 'mine'),
    'shared',     jsonb_array_length(v_all -> 'shared'),
    'categories', COALESCE((
      SELECT jsonb_agg(c.category ORDER BY c.category)
      FROM (
        SELECT DISTINCT m.x ->> 'category' AS category
        FROM jsonb_array_elements(v_all -> 'mine') m(x)
        WHERE COALESCE(m.x ->> 'category', '') <> ''
      ) c
    ), '[]'::jsonb)
  );
END;
$$;


-- ===========================================================================
-- Shared fixture and helpers
-- ===========================================================================

/** Alice's personal bills: solo, split with an account, with a linked contact, with an unlinked
    contact, with a contact deleted after filing, a converted one, one with no live item, ties on
    created_at and on lower(title); bills Bob and Carl share with her (one reaching her through
    Bob's contact linked to her account, one settled by a payment); Carl's private bill with Dana.
    Returns every id in a jsonb map. */
CREATE OR REPLACE FUNCTION test.b84_fixture(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  alice uuid; bob uuid; carl uuid; dana uuid;
  c_bob uuid; c_eve uuid; c_gone uuid; bob_c_alice uuid;
  ids jsonb := '{}'::jsonb; b uuid;
  base timestamptz := '2026-09-01T12:00:00+00'::timestamptz;
BEGIN
  alice := test.new_account('b84-alice-' || p_tag || '@example.com', 'Alice');
  bob   := test.new_account('b84-bob-' || p_tag || '@example.com', 'Bob');
  carl  := test.new_account('b84-carl-' || p_tag || '@example.com', 'Carl');
  dana  := test.new_account('b84-dana-' || p_tag || '@example.com', 'Dana');
  c_bob  := test.new_contact(alice, 'Bobby', bob);
  c_eve  := test.new_contact(alice, 'Eve');
  c_gone := test.new_contact(alice, 'Dee', dana);
  bob_c_alice := test.new_contact(bob, 'Al', alice);
  ids := ids || jsonb_build_object('alice', alice, 'bob', bob, 'carl', carl, 'dana', dana,
                                   'c_bob', c_bob, 'c_eve', c_eve, 'c_gone', c_gone);

  b := test.new_bill(alice, alice, NULL, 'apple', 10, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '1 day', category = 'food' WHERE id = b;
  ids := ids || jsonb_build_object('m1', b);
  b := test.new_bill(alice, alice, NULL, 'Banana', 20, ARRAY[alice, bob]);
  UPDATE public.bills SET created_at = base + interval '2 days' WHERE id = b;
  ids := ids || jsonb_build_object('m2', b);
  b := test.new_bill(alice, alice, NULL, 'cherry', 30, ARRAY[alice, c_bob]);
  UPDATE public.bills SET created_at = base + interval '3 days', category = 'transport' WHERE id = b;
  ids := ids || jsonb_build_object('m3', b);
  -- Converted: typed as 0.70 USD, stored in PHP. Children first, so the 079 stale-conversion
  -- trigger (it fires on a live item whose original_amount is NULL) never clears the bill.
  b := test.new_bill(alice, alice, NULL, 'Apple', 40, ARRAY[alice, bob]);
  UPDATE public.bill_items SET original_amount = 0.70 WHERE bill_id = b;
  UPDATE public.item_splits SET original_amount = 0.35
   WHERE item_id IN (SELECT id FROM public.bill_items WHERE bill_id = b);
  UPDATE public.bills SET created_at = base + interval '4 days', category = 'food',
         original_currency = 'USD', exchange_rate = 57.142857, rate_source = 'online', original_total = 0.70
   WHERE id = b;
  ids := ids || jsonb_build_object('m4', b);
  b := test.new_bill(alice, alice, NULL, 'date', 50, ARRAY[alice, c_eve]);
  UPDATE public.bills SET created_at = base + interval '5 days' WHERE id = b;
  ids := ids || jsonb_build_object('m5', b);
  b := test.new_bill(alice, alice, NULL, 'APPLE', 60, ARRAY[alice]);
  UPDATE public.bills SET created_at = base + interval '6 days' WHERE id = b;
  ids := ids || jsonb_build_object('m6', b);
  -- Shares m5's created_at: the id tiebreak is crossed by every date sort and cursor.
  b := test.new_bill(alice, alice, NULL, 'Elder', 70, ARRAY[alice, c_gone]);
  UPDATE public.bills SET created_at = base + interval '5 days', category = 'groceries' WHERE id = b;
  ids := ids || jsonb_build_object('m7', b);
  -- Its only item is deleted: no item, no split participant.
  b := test.new_bill(alice, alice, NULL, 'Fig', 15, ARRAY[alice, bob]);
  UPDATE public.bill_items SET is_deleted = true WHERE bill_id = b;
  UPDATE public.bills SET created_at = base + interval '8 days' WHERE id = b;
  ids := ids || jsonb_build_object('m8', b);
  -- Never listed: a deleted personal bill, a group bill.
  b := test.new_bill(alice, alice, NULL, 'Deleted', 99, ARRAY[alice, bob]);
  UPDATE public.bills SET is_deleted = true, created_at = base + interval '9 days' WHERE id = b;
  ids := ids || jsonb_build_object('m_deleted', b);
  b := test.new_bill(alice, alice, test.new_group(alice, 'G84 ' || p_tag), 'Group thing', 80, ARRAY[alice]);
  ids := ids || jsonb_build_object('g_bill', b);

  -- The contact is deleted from the phonebook after its bill was filed.
  UPDATE public.profiles SET is_deleted = true WHERE id = c_gone;

  b := test.new_bill(bob, bob, NULL, 'Bob lunch', 100, ARRAY[bob, alice]);
  UPDATE public.bills SET created_at = base + interval '1 day', category = 'health' WHERE id = b;
  ids := ids || jsonb_build_object('s1', b);
  b := test.new_bill(bob, bob, NULL, 'bob coffee', 8, ARRAY[bob, alice]);
  UPDATE public.bill_items SET original_amount = 7.50 WHERE bill_id = b;
  UPDATE public.item_splits SET original_amount = 3.75
   WHERE item_id IN (SELECT id FROM public.bill_items WHERE bill_id = b);
  UPDATE public.bills SET created_at = base + interval '7 days',
         original_currency = 'EUR', exchange_rate = 1.066667, rate_source = 'manual', original_total = 7.50
   WHERE id = b;
  ids := ids || jsonb_build_object('s2', b);
  b := test.new_bill(bob, bob, NULL, 'Bob taxi', 12, ARRAY[bob, alice, carl]);
  UPDATE public.bills SET created_at = base + interval '3 days' WHERE id = b;
  ids := ids || jsonb_build_object('s3', b);
  b := test.new_bill(carl, carl, NULL, 'Carl dinner', 60, ARRAY[carl, alice]);
  UPDATE public.bills SET created_at = base + interval '9 days', category = 'other' WHERE id = b;
  ids := ids || jsonb_build_object('s4', b);
  -- Alice pays Carl her whole share: the Alice-Carl tab is zero, so s4 reads settled.
  PERFORM test.new_settlement(alice, carl, 30.00);
  b := test.new_bill(bob, bob, NULL, 'Bob groceries', 30, ARRAY[bob, bob_c_alice]);
  UPDATE public.bills SET created_at = base + interval '10 days', category = 'groceries' WHERE id = b;
  ids := ids || jsonb_build_object('s5', b);

  b := test.new_bill(carl, carl, NULL, 'Carl secret', 500, ARRAY[carl, dana]);
  UPDATE public.bills SET created_at = base + interval '2 days' WHERE id = b;
  ids := ids || jsonb_build_object('carl_bill', b);
  RETURN ids;
END;
$$;

CREATE OR REPLACE FUNCTION test.b84_ids(p_page jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg((x ->> 'id')::uuid ORDER BY o), '{}')
  FROM jsonb_array_elements(COALESCE(p_page -> 'rows', '[]'::jsonb)) WITH ORDINALITY t(x, o);
$$;

CREATE OR REPLACE FUNCTION test.b84_bucket_ids(p_rows jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg((x ->> 'id')::uuid ORDER BY o), '{}')
  FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY t(x, o);
$$;

CREATE OR REPLACE FUNCTION test.b84_of(p_map jsonb, VARIADIC p_keys text[])
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_agg((p_map ->> k)::uuid ORDER BY o) FROM unnest(p_keys) WITH ORDINALITY t(k, o);
$$;

/** The cursor a client sends: the last loaded row's id, createdAt and title (083's contract). */
CREATE OR REPLACE FUNCTION test.b84_cursor(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('id', p_row -> 'id', 'createdAt', p_row -> 'createdAt', 'title', p_row -> 'title');
$$;

/** The page's outcome as text: its jsonb, or the error it raised. Lets a refusal be compared with
    the reference's refusal as directly as a result with a result. */
CREATE OR REPLACE FUNCTION test.b84_page_outcome(
  p_ref boolean, p_bucket text, p_limit int, p_settled text, p_category text, p_sort text, p_after jsonb
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ref THEN
    RETURN test.personal_bills_page_083_reference(p_bucket, p_limit, p_settled, p_category, p_sort, p_after)::text;
  END IF;
  RETURN public.kwenta_personal_bills_page(p_bucket, p_limit, p_settled, p_category, p_sort, p_after)::text;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERROR: ' || SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION test.b84_full_outcome(p_ref boolean)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ref THEN
    RETURN test.personal_bills_079_reference()::text;
  END IF;
  RETURN public.kwenta_personal_bills()::text;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERROR: ' || SQLERRM;
END;
$$;

/** Calls of public.<name> in this transaction (pg_stat_xact_user_functions; needs
    track_functions = 'all' for LANGUAGE sql functions). */
CREATE OR REPLACE FUNCTION test.b84_calls(p_name text)
RETURNS bigint
LANGUAGE sql
VOLATILE
AS $$
  SELECT COALESCE(SUM(calls), 0)::bigint
  FROM pg_stat_xact_user_functions
  WHERE schemaname = 'public' AND funcname = p_name;
$$;

-- ---------------------------------------------------------------------------
-- C2: kwenta_personal_bills() is byte-identical to 079's body, for every viewer of the fixture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; who text; ref jsonb; got text;
BEGIN
  f := test.b84_fixture('c2');

  -- The fixture means what it says (literal, from the requirements, not from either body).
  PERFORM test.as_user((f ->> 'alice')::uuid);
  ref := test.personal_bills_079_reference();
  PERFORM test.assert_ids(test.b84_bucket_ids(ref -> 'mine'),
    test.b84_of(f, 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'),
    'C2 fixture: Alice''s mine is her eight live personal bills (deleted and group bills excluded)');
  PERFORM test.assert_ids(test.b84_bucket_ids(ref -> 'shared'),
    test.b84_of(f, 's1', 's2', 's3', 's4', 's5'),
    'C2 fixture: Alice''s shared is the five bills others put her on (s5 through Bob''s contact linked to her)');
  PERFORM test.as_owner();

  FOREACH who IN ARRAY ARRAY['alice', 'bob', 'carl', 'dana'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    got := test.b84_full_outcome(false);
    PERFORM test.assert_eq(got, test.b84_full_outcome(true),
      format('C2: kwenta_personal_bills() for %s is byte-identical to 079''s', who));
    PERFORM test.as_owner();
  END LOOP;

  -- Converted and no-item rows carry what 079 carried (keys, item count).
  PERFORM test.as_user((f ->> 'alice')::uuid);
  ref := public.kwenta_personal_bills();
  PERFORM test.assert_eq(
    (SELECT x ->> 'originalCurrency' FROM jsonb_array_elements(ref -> 'mine') x WHERE x ->> 'id' = f ->> 'm4'),
    'USD', 'C2: a converted bill keeps originalCurrency');
  PERFORM test.assert_eq(
    (SELECT (x ->> 'itemCount')::int FROM jsonb_array_elements(ref -> 'mine') x WHERE x ->> 'id' = f ->> 'm8'),
    0, 'C2: a bill whose only item is deleted counts 0 items');
  PERFORM test.as_owner();
  PERFORM test.note('C2: kwenta_personal_bills unchanged against a frozen 079 body');
END;
$$;

-- ---------------------------------------------------------------------------
-- C1: the page is jsonb-identical to 083's for every bucket x sort x settled x category, at
-- several limits, and on a cursor after every row (two categories, to bound the run time).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; bucket text; sort text; settled text; cat text; lim int; ref_full jsonb; i int; cur jsonb;
  n_cmp int := 0; n_rows int := 0; got text; want text;
BEGIN
  f := test.b84_fixture('c1');
  PERFORM test.as_user((f ->> 'alice')::uuid);

  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
      FOREACH settled IN ARRAY ARRAY['all', 'settled', 'unsettled'] LOOP
        FOREACH cat IN ARRAY ARRAY[NULL, 'food', 'transport', 'health', 'groceries', 'other', 'utilities'] LOOP
          FOREACH lim IN ARRAY ARRAY[1, 3, 20, 500] LOOP
            got  := test.b84_page_outcome(false, bucket, lim, settled, cat, sort, NULL);
            want := test.b84_page_outcome(true,  bucket, lim, settled, cat, sort, NULL);
            PERFORM test.assert_eq(got, want,
              format('C1: %s/%s/%s/%s limit %s equals 083''s page', bucket, sort, settled, COALESCE(cat, 'any'), lim));
            n_cmp := n_cmp + 1;
          END LOOP;
          IF cat IS NULL OR cat = 'food' THEN
            ref_full := test.personal_bills_page_083_reference(bucket, 500, settled, cat, sort, NULL);
            n_rows := n_rows + jsonb_array_length(ref_full -> 'rows');
            FOR i IN 0 .. jsonb_array_length(ref_full -> 'rows') - 1 LOOP
              cur := test.b84_cursor(ref_full -> 'rows' -> i);
              got  := test.b84_page_outcome(false, bucket, 2, settled, cat, sort, cur);
              want := test.b84_page_outcome(true,  bucket, 2, settled, cat, sort, cur);
              PERFORM test.assert_eq(got, want,
                format('C1: %s/%s/%s/%s cursor after row %s equals 083''s page', bucket, sort, settled, COALESCE(cat, 'any'), i));
              n_cmp := n_cmp + 1;
            END LOOP;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM test.assert_true(n_rows > 50, 'C1: the cursor loop walked real rows (got ' || n_rows || ')');
  PERFORM test.assert_true(n_cmp > 700, 'C1: the comparison loop ran (got ' || n_cmp || ')');

  -- Literal anchors: the unfiltered newest-first page IS the full bucket, in order.
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc') -> 'rows',
    test.personal_bills_079_reference() -> 'mine', 'C1: mine/all/date_desc rows are 079''s mine');
  PERFORM test.assert_eq(public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc') -> 'rows',
    test.personal_bills_079_reference() -> 'shared', 'C1: shared/all/date_desc rows are 079''s shared');
  PERFORM test.assert_eq(
    test.b84_ids(public.kwenta_personal_bills_page('mine', 3, 'all', NULL, 'title_asc')),
    test.b84_of(f, 'm6', 'm4', 'm1'), 'C1: title_asc puts APPLE / Apple / apple first, newest first');
  PERFORM test.assert_eq(
    public.kwenta_personal_bills_page('mine', 20, 'all', NULL, 'date_desc') -> 'categories',
    '["food", "groceries", "transport"]'::jsonb, 'C1: categories are mine''s distinct categories, sorted');
  PERFORM test.as_owner();
  PERFORM test.note('C1: page equals 083''s, first pages and cursor pages');
END;
$$;

-- C1: a cursor whose row was deleted since it was loaded continues from where it was, as in 083.
DO $$
DECLARE
  f jsonb; sort text; settled text; ref_full jsonb; before_ids uuid[]; cur jsonb; cur_id uuid; got text; p jsonb;
BEGIN
  f := test.b84_fixture('c1d');
  FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
    FOREACH settled IN ARRAY ARRAY['all', 'settled', 'unsettled'] LOOP
      PERFORM test.as_user((f ->> 'alice')::uuid);
      ref_full := test.personal_bills_page_083_reference('mine', 500, settled, NULL, sort, NULL);
      before_ids := test.b84_ids(ref_full);
      PERFORM test.as_owner();
      CONTINUE WHEN cardinality(before_ids) < 2;
      cur := test.b84_cursor(ref_full -> 'rows' -> 1);
      cur_id := (cur ->> 'id')::uuid;

      UPDATE public.bills SET is_deleted = true WHERE id = cur_id;
      PERFORM test.as_user((f ->> 'alice')::uuid);
      got := test.b84_page_outcome(false, 'mine', 500, settled, NULL, sort, cur);
      PERFORM test.assert_eq(got, test.b84_page_outcome(true, 'mine', 500, settled, NULL, sort, cur),
        format('C1: %s/%s after a deleted cursor row equals 083''s page', sort, settled));
      IF settled = 'all' THEN
        p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, sort, cur);
        PERFORM test.assert_eq(test.b84_ids(p), before_ids[3:],
          format('C1: %s continues right after the deleted cursor row', sort));
        PERFORM test.assert_eq((p ->> 'matching')::int, 7, format('C1: %s matching no longer counts the deleted bill', sort));
        PERFORM test.assert_eq((p ->> 'mine')::int, 7, format('C1: %s mine no longer counts it either', sort));
      END IF;
      PERFORM test.as_owner();
      UPDATE public.bills SET is_deleted = false WHERE id = cur_id;
    END LOOP;
  END LOOP;
  PERFORM test.note('C1: deleted cursor rows behave as in 083');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: settled / unsettled filters give 083's matching counts and rows, with literal anchors.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; bucket text; sort text; settled text; p jsonb; ref jsonb; s_ids uuid[]; u_ids uuid[]; u_ids_mine uuid[];
BEGIN
  f := test.b84_fixture('c4');
  PERFORM test.as_user((f ->> 'alice')::uuid);

  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
      FOREACH settled IN ARRAY ARRAY['settled', 'unsettled'] LOOP
        p   := public.kwenta_personal_bills_page(bucket, 500, settled, NULL, sort);
        ref := test.personal_bills_page_083_reference(bucket, 500, settled, NULL, sort, NULL);
        PERFORM test.assert_eq((p ->> 'matching')::int, (ref ->> 'matching')::int,
          format('C4: %s/%s/%s matching equals 083''s', bucket, settled, sort));
        PERFORM test.assert_eq(p -> 'rows', ref -> 'rows', format('C4: %s/%s/%s rows equal 083''s', bucket, settled, sort));
        -- A limit below the filtered count: matching still counts the whole filtered set.
        p   := public.kwenta_personal_bills_page(bucket, 1, settled, NULL, sort);
        ref := test.personal_bills_page_083_reference(bucket, 1, settled, NULL, sort, NULL);
        PERFORM test.assert_eq(p::text, ref::text, format('C4: %s/%s/%s limit 1 equals 083''s', bucket, settled, sort));
      END LOOP;
    END LOOP;
  END LOOP;

  -- Literal anchors. Solo bills and a bill with no live item owe nobody; Bob (and Bobby, linked to
  -- him) and Eve owe Alice; Alice paid Carl her whole share of s4; Alice owes Bob on s1-s3.
  s_ids := test.b84_ids(public.kwenta_personal_bills_page('mine', 500, 'settled', NULL, 'date_desc'));
  u_ids := test.b84_ids(public.kwenta_personal_bills_page('mine', 500, 'unsettled', NULL, 'date_desc'));
  PERFORM test.assert_true(test.b84_of(f, 'm1', 'm6', 'm8') <@ s_ids, 'C4: m1, m6, m8 are settled');
  PERFORM test.assert_true(test.b84_of(f, 'm2', 'm3', 'm4', 'm5') <@ u_ids, 'C4: m2, m3, m4, m5 are unsettled');
  PERFORM test.assert_false(s_ids && u_ids, 'C4: no bill is both settled and unsettled');
  PERFORM test.assert_eq(cardinality(s_ids) + cardinality(u_ids), 8, 'C4: settled + unsettled = every mine bill');
  u_ids_mine := u_ids;
  s_ids := test.b84_ids(public.kwenta_personal_bills_page('shared', 500, 'settled', NULL, 'date_desc'));
  u_ids := test.b84_ids(public.kwenta_personal_bills_page('shared', 500, 'unsettled', NULL, 'date_desc'));
  PERFORM test.assert_true(test.b84_of(f, 's4') <@ s_ids, 'C4: s4 (paid off) is settled');
  PERFORM test.assert_true(test.b84_of(f, 's1', 's2', 's3') <@ u_ids, 'C4: s1, s2, s3 are unsettled');
  PERFORM test.assert_eq(cardinality(s_ids) + cardinality(u_ids), 5, 'C4: settled + unsettled = every shared bill');

  p := public.kwenta_personal_bills_page('mine', 20, 'unsettled', 'food', 'date_desc');
  PERFORM test.assert_eq(test.b84_ids(p), test.b84_of(f, 'm4'), 'C4: unsettled + food is m4 alone (m1 is settled)');
  PERFORM test.assert_eq((p ->> 'matching')::int, 1, 'C4: matching = 1');
  p := public.kwenta_personal_bills_page('mine', 20, 'settled', 'food', 'date_desc');
  PERFORM test.assert_eq(test.b84_ids(p), test.b84_of(f, 'm1'), 'C4: settled + food is m1 alone');
  p := public.kwenta_personal_bills_page('mine', 1, 'unsettled', NULL, 'date_desc');
  -- m8 (day 8) and m6 (day 6) are settled; the newest open bill is on day 5 (m5, or m7 by id).
  PERFORM test.assert_eq(cardinality(test.b84_ids(p)), 1, 'C4: filter then limit 1: one row');
  PERFORM test.assert_true(test.b84_ids(p) <@ test.b84_of(f, 'm5', 'm7'), 'C4: filter then limit: the newest open bill (day 5)');
  PERFORM test.assert_eq((p ->> 'matching')::int, cardinality(u_ids_mine), 'C4: matching counts every open mine bill');

  -- A settled flag the page reports is the full endpoint's flag for that bill.
  PERFORM test.assert_eq(
    (SELECT (x ->> 'settled')::boolean FROM jsonb_array_elements(
       public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc') -> 'rows') x
     WHERE x ->> 'id' = f ->> 's4'),
    true, 'C4: s4 reads settled on an unfiltered page too');
  PERFORM test.as_owner();
  PERFORM test.note('C4: settled filters unchanged');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: unauthenticated is refused; each viewer sees only their own buckets.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; who text; bucket text; sort text; settled text; ids uuid[]; got text; p jsonb;
BEGIN
  f := test.b84_fixture('c6');

  -- Signed-in role, no auth.uid(): both endpoints refuse, for every bucket.
  PERFORM test.as_user((f ->> 'alice')::uuid);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    got := test.b84_page_outcome(false, bucket, 20, 'all', NULL, 'date_desc', NULL);
    PERFORM test.assert_true(got ILIKE 'ERROR:%not authenticated%',
      format('C6: an unauthenticated %s page raises not authenticated (got: %s)', bucket, left(got, 120)));
  END LOOP;
  got := test.b84_full_outcome(false);
  PERFORM test.assert_true(got ILIKE 'ERROR:%not authenticated%',
    'C6: unauthenticated kwenta_personal_bills raises not authenticated (got: ' || left(got, 120) || ')');
  PERFORM test.as_owner();

  -- Alice never receives Carl's private bill with Dana, under any sort or filter.
  PERFORM test.as_user((f ->> 'alice')::uuid);
  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    FOREACH sort IN ARRAY ARRAY['date_desc', 'title_asc'] LOOP
      FOREACH settled IN ARRAY ARRAY['all', 'settled', 'unsettled'] LOOP
        ids := test.b84_ids(public.kwenta_personal_bills_page(bucket, 500, settled, NULL, sort));
        PERFORM test.assert_false(test.b84_of(f, 'carl_bill', 'm_deleted', 'g_bill') && ids,
          format('C6: %s/%s/%s holds no other account''s, deleted or group bill', bucket, sort, settled));
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM test.as_owner();

  -- Carl: his own two bills (s4, carl_bill); shared = Bob's taxi he is split on. None of Alice's.
  PERFORM test.as_user((f ->> 'carl')::uuid);
  p := public.kwenta_personal_bills_page('mine', 500, 'all', NULL, 'date_desc');
  PERFORM test.assert_eq(test.b84_ids(p), test.b84_of(f, 's4', 'carl_bill'), 'C6: Carl''s mine, newest first');
  PERFORM test.assert_eq((p ->> 'shared')::int, 1, 'C6: Carl''s shared count is 1');
  PERFORM test.assert_eq(p -> 'categories', '["other"]'::jsonb, 'C6: Carl''s categories are his own');
  PERFORM test.assert_eq(test.b84_ids(public.kwenta_personal_bills_page('shared', 500, 'all', NULL, 'date_desc')),
    test.b84_of(f, 's3'), 'C6: Carl''s shared is Bob''s taxi only');
  PERFORM test.as_owner();

  -- Every fixture viewer: page equals 083's, and the full list equals 079's.
  FOREACH who IN ARRAY ARRAY['bob', 'carl', 'dana'] LOOP
    PERFORM test.as_user((f ->> who)::uuid);
    FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
      PERFORM test.assert_eq(test.b84_page_outcome(false, bucket, 500, 'all', NULL, 'date_desc', NULL),
        test.b84_page_outcome(true, bucket, 500, 'all', NULL, 'date_desc', NULL),
        format('C6: %s''s %s page equals 083''s', who, bucket));
    END LOOP;
    PERFORM test.as_owner();
  END LOOP;
  PERFORM test.note('C6: unauthenticated refused; scoped to auth.uid()');
END;
$$;

-- ---------------------------------------------------------------------------
-- C7: an inactive account is refused exactly as before 084. 076's endpoint gate is the
-- pre-request hook (076 header, gate 3): it refuses /rpc/<endpoint> with 42501 and
-- kwenta_account_inactive:<status>, as 076's C33 asserts for client endpoints. A direct call (no
-- PostgREST) must behave as 083's page did, whatever that was.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ina uuid; unc uuid; path text; st text; msg text; bucket text;
BEGIN
  ina := test.new_account('b84-ina@example.com', 'Ina', 'inactive');
  unc := test.new_account('b84-unc@example.com', 'Unc', 'unconfirmed');
  PERFORM test.new_bill(ina, ina, NULL, 'Ina lunch', 40, ARRAY[ina]);
  PERFORM test.new_bill(unc, unc, NULL, 'Unc lunch', 40, ARRAY[unc]);
  PERFORM test.assert_eq((SELECT account_status FROM public.profiles WHERE id = ina), 'inactive',
    'C7 fixture: the account is inactive');

  FOREACH path IN ARRAY ARRAY['/rpc/kwenta_personal_bills_page', '/rpc/kwenta_personal_bills'] LOOP
    PERFORM test.as_user(ina);
    PERFORM set_config('request.path', path, true);
    st := NULL; msg := NULL;
    BEGIN
      PERFORM public.kwenta_pre_request();
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    END;
    PERFORM test.as_owner();
    PERFORM test.assert_true(COALESCE(st IN ('42501', 'PT403'), false),
      format('C7: the pre-request gate refuses an inactive caller on %s with a 403-mapped code (got: %s)', path, COALESCE(st, 'no error')));
    PERFORM test.assert_true(COALESCE(msg LIKE '%kwenta_account_inactive:inactive%', false),
      format('C7: the refusal on %s carries kwenta_account_inactive:inactive (got: %s)', path, COALESCE(msg, 'null')));

    PERFORM test.as_user(unc);
    PERFORM set_config('request.path', path, true);
    msg := NULL;
    BEGIN
      PERFORM public.kwenta_pre_request();
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    END;
    PERFORM test.as_owner();
    PERFORM test.assert_true(COALESCE(msg LIKE '%kwenta_account_inactive:unconfirmed%', false),
      format('C7: an unconfirmed caller on %s gets kwenta_account_inactive:unconfirmed (got: %s)', path, COALESCE(msg, 'null')));
  END LOOP;

  -- A direct call: the same outcome 083's page and 079's list gave.
  PERFORM test.as_user(ina);
  FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
    PERFORM test.assert_eq(test.b84_page_outcome(false, bucket, 20, 'all', NULL, 'date_desc', NULL),
      test.b84_page_outcome(true, bucket, 20, 'all', NULL, 'date_desc', NULL),
      format('C7: an inactive caller''s direct %s page call behaves as 083''s', bucket));
  END LOOP;
  PERFORM test.assert_eq(test.b84_full_outcome(false), test.b84_full_outcome(true),
    'C7: an inactive caller''s direct kwenta_personal_bills call behaves as 079''s');
  PERFORM test.as_owner();
  PERFORM test.note('C7: inactive / unconfirmed refused by the endpoint gate as before');
END;
$$;

-- ---------------------------------------------------------------------------
-- C8: an empty account, and one whose only bills are a deleted personal bill and a group bill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  e1 uuid; e2 uuid; gone uuid; who uuid; bucket text; sort text; settled text; p jsonb;
  empty_page jsonb := '{"rows": [], "mine": 0, "shared": 0, "matching": 0, "categories": []}'::jsonb;
BEGIN
  e1 := test.new_account('b84-empty1@example.com', 'Empty');
  e2 := test.new_account('b84-empty2@example.com', 'Nearly');
  gone := test.new_bill(e2, e2, NULL, 'Gone', 10, ARRAY[e2]);
  UPDATE public.bills SET is_deleted = true WHERE id = gone;
  PERFORM test.new_bill(e2, e2, test.new_group(e2, 'G84 empty'), 'Group only', 10, ARRAY[e2]);

  FOREACH who IN ARRAY ARRAY[e1, e2] LOOP
    PERFORM test.as_user(who);
    FOREACH bucket IN ARRAY ARRAY['mine', 'shared'] LOOP
      FOREACH sort IN ARRAY ARRAY['date_desc', 'date_asc', 'title_asc', 'title_desc'] LOOP
        FOREACH settled IN ARRAY ARRAY['all', 'settled', 'unsettled'] LOOP
          p := public.kwenta_personal_bills_page(bucket, 20, settled, NULL, sort);
          PERFORM test.assert_eq(p, empty_page, format('C8: %s/%s/%s on an empty account', bucket, sort, settled));
        END LOOP;
      END LOOP;
      p := public.kwenta_personal_bills_page(bucket, 20, 'all', 'food', 'title_asc',
             jsonb_build_object('id', gen_random_uuid(), 'createdAt', '2026-01-01T00:00:00+00', 'title', 'x'));
      PERFORM test.assert_eq(p, empty_page, format('C8: %s with a category and a cursor is still the empty page', bucket));
    END LOOP;
    PERFORM test.assert_eq(public.kwenta_personal_bills(), '{"mine": [], "shared": []}'::jsonb,
      'C8: kwenta_personal_bills on an empty account');
    PERFORM test.as_owner();
  END LOOP;
  PERFORM test.note('C8: empty account');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5: the helpers are SECURITY DEFINER, service_role only, closed after the acting-user sweep,
-- and refuse a p_uid that is not auth.uid().
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  sig_index text := 'public.kwenta_personal_bill_index(uuid, public.bills[], public.bill_items[], public.item_splits[])';
  sig_rows  text := 'public.kwenta_personal_bill_rows(uuid, public.bills[], public.bill_items[], public.item_splits[], uuid[], jsonb)';
  sig text; alice uuid; bob uuid; st text; msg text; who text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[sig_index, sig_rows] LOOP
    PERFORM test.assert_true(to_regprocedure(sig) IS NOT NULL, 'C5: ' || sig || ' exists');
  END LOOP;

  -- The sweep runs again (as a later migration would) and must leave them closed.
  PERFORM public.kwenta_revoke_acting_user_helpers();

  FOREACH sig IN ARRAY ARRAY[sig_index, sig_rows] LOOP
    PERFORM test.assert_true((SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(sig)),
      'C5: ' || sig || ' is SECURITY DEFINER');
    PERFORM test.assert_eq((SELECT p.proargnames[1] FROM pg_proc p WHERE p.oid = to_regprocedure(sig)), 'p_uid',
      'C5: ' || sig || ' names the acting user p_uid, so the sweep matches it');
    PERFORM test.assert_false(has_function_privilege('anon', sig, 'EXECUTE'), 'C5: anon may not execute ' || sig);
    PERFORM test.assert_false(has_function_privilege('authenticated', sig, 'EXECUTE'),
      'C5: authenticated may not execute ' || sig);
    PERFORM test.assert_true(has_function_privilege('service_role', sig, 'EXECUTE'),
      'C5: service_role may execute ' || sig);
    PERFORM test.assert_false(
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = to_regprocedure(sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
      'C5: PUBLIC holds no EXECUTE on ' || sig);
  END LOOP;

  -- Client allowlist (what 073 pins): the endpoints are in it, the helpers are not.
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('kwenta_personal_bill_index', 'kwenta_personal_bill_rows')
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
    'C5: no overload of either helper is executable by authenticated');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kwenta_personal_bills_page'), 1,
    'C5: kwenta_personal_bills_page keeps one signature');
  PERFORM test.assert_true(has_function_privilege('authenticated',
    'public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb)', 'EXECUTE'),
    'C5: authenticated still executes the page endpoint');
  PERFORM test.assert_false(has_function_privilege('anon',
    'public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb)', 'EXECUTE'),
    'C5: anon still may not');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_personal_bills()', 'EXECUTE'),
    'C5: authenticated still executes kwenta_personal_bills');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_personal_bills()', 'EXECUTE'),
    'C5: anon still may not execute kwenta_personal_bills');
  PERFORM test.assert_eq(
    (SELECT format_type(p.prorettype, NULL) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb)')),
    'jsonb', 'C5: the page still returns jsonb');

  alice := test.new_account('b84-c5-alice@example.com', 'Alice');
  bob   := test.new_account('b84-c5-bob@example.com', 'Bob');
  PERFORM test.new_bill(bob, bob, NULL, 'Bob private', 10, ARRAY[bob]);

  -- A signed-in client calling a helper directly: permission denied, not data.
  PERFORM test.as_user(alice);
  st := NULL;
  BEGIN
    PERFORM * FROM public.kwenta_personal_bill_index(alice, '{}'::public.bills[], '{}'::public.bill_items[], '{}'::public.item_splits[]);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C5: authenticated calling the index directly gets 42501');
  PERFORM test.as_user(alice);
  st := NULL;
  BEGIN
    PERFORM * FROM public.kwenta_personal_bill_rows(alice, '{}'::public.bills[], '{}'::public.bill_items[],
      '{}'::public.item_splits[], '{}'::uuid[], '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(st, '42501', 'C5: authenticated calling the row builder directly gets 42501');

  -- Even with EXECUTE (the owner here), a p_uid other than auth.uid(), or no auth.uid(), raises.
  FOREACH who IN ARRAY ARRAY['other', 'none'] LOOP
    PERFORM set_config('request.jwt.claim.sub', CASE WHEN who = 'other' THEN alice::text ELSE '' END, true);
    msg := NULL;
    BEGIN
      PERFORM * FROM public.kwenta_personal_bill_index(bob,
        ARRAY(SELECT b FROM public.bills b WHERE b.created_by = bob),
        ARRAY(SELECT bi FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id WHERE b.created_by = bob),
        ARRAY(SELECT sp FROM public.item_splits sp WHERE sp.user_id = bob));
    EXCEPTION WHEN OTHERS THEN
      msg := SQLERRM;
    END;
    PERFORM test.assert_true(msg IS NOT NULL,
      format('C5: the index refuses p_uid = Bob when auth.uid() is %s', CASE WHEN who = 'other' THEN 'Alice' ELSE 'NULL' END));
    msg := NULL;
    BEGIN
      PERFORM * FROM public.kwenta_personal_bill_rows(bob,
        ARRAY(SELECT b FROM public.bills b WHERE b.created_by = bob),
        ARRAY(SELECT bi FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id WHERE b.created_by = bob),
        ARRAY(SELECT sp FROM public.item_splits sp WHERE sp.user_id = bob),
        ARRAY(SELECT b.id FROM public.bills b WHERE b.created_by = bob), '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      msg := SQLERRM;
    END;
    PERFORM test.assert_true(msg IS NOT NULL,
      format('C5: the row builder refuses p_uid = Bob when auth.uid() is %s', CASE WHEN who = 'other' THEN 'Alice' ELSE 'NULL' END));
  END LOOP;

  -- The permitted side: p_uid = auth.uid() answers.
  PERFORM set_config('request.jwt.claim.sub', bob::text, true);
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_index(bob,
       ARRAY(SELECT b FROM public.bills b WHERE b.created_by = bob),
       ARRAY(SELECT bi FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id WHERE b.created_by = bob),
       ARRAY(SELECT sp FROM public.item_splits sp WHERE sp.user_id = bob))),
    1, 'C5: with p_uid = auth.uid() the index answers (Bob''s one bill)');
  PERFORM test.as_owner();
  PERFORM test.note('C5: helpers are server-only and bound to auth.uid()');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2 (helpers): the index and the row builder agree with 079's list. They take the rows the
-- endpoint pulled; here they are pulled through kwenta_pull_rows_* and filtered exactly as 079's
-- body filters them (live personal bills, live items of those bills, live splits of those items).
-- Run as the owner (the helpers are service_role only) with auth.uid() = Alice.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; ref jsonb; v_bills public.bills[]; v_items public.bill_items[]; v_splits public.item_splits[];
  all_ids uuid[]; settled jsonb; n int; pick uuid[];
BEGIN
  f := test.b84_fixture('c2h');
  alice := (f ->> 'alice')::uuid;
  PERFORM test.as_user(alice);
  ref := test.personal_bills_079_reference();
  PERFORM test.as_owner();
  PERFORM set_config('request.jwt.claim.sub', alice::text, true);

  v_bills := ARRAY(SELECT b FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, alice) b
                   WHERE b.group_id IS NULL AND b.is_deleted IS FALSE);
  v_items := ARRAY(SELECT bi FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, alice) bi
                   WHERE bi.is_deleted IS FALSE AND bi.bill_id IN (SELECT (vb).id FROM unnest(v_bills) vb));
  v_splits := ARRAY(SELECT sp FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, alice) sp
                    WHERE sp.is_deleted IS FALSE AND sp.item_id IN (SELECT (vi).id FROM unnest(v_items) vi));

  -- Index: exactly 079's buckets, with the bill's own columns.
  SELECT count(*) INTO n FROM (
    SELECT i.id, i.bucket FROM public.kwenta_personal_bill_index(alice, v_bills, v_items, v_splits) i
    EXCEPT
    (SELECT (x ->> 'id')::uuid, 'mine' FROM jsonb_array_elements(ref -> 'mine') x
     UNION ALL
     SELECT (x ->> 'id')::uuid, 'shared' FROM jsonb_array_elements(ref -> 'shared') x)
  ) d;
  PERFORM test.assert_eq(n, 0, 'C2: the index holds no (id, bucket) 079 does not');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_index(alice, v_bills, v_items, v_splits)),
    jsonb_array_length(ref -> 'mine') + jsonb_array_length(ref -> 'shared'),
    'C2: and every bill 079 lists, once');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_index(alice, v_bills, v_items, v_splits) i
       JOIN public.bills b ON b.id = i.id
      WHERE i.created_at IS DISTINCT FROM b.created_at OR i.title IS DISTINCT FROM b.title
         OR i.category IS DISTINCT FROM b.category),
    0, 'C2: index created_at / title / category are the bill''s columns');

  -- Rows: for any id subset, exactly those bills, each row jsonb-identical to 079's.
  all_ids := test.b84_bucket_ids(ref -> 'mine') || test.b84_bucket_ids(ref -> 'shared');
  settled := public.kwenta_bills_settled_map(all_ids, alice);
  SELECT count(*) INTO n
  FROM public.kwenta_personal_bill_rows(alice, v_bills, v_items, v_splits, all_ids, settled) r
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ref -> r.bucket) x WHERE x = r.row);
  PERFORM test.assert_eq(n, 0, 'C2: every built row is 079''s row for that bill, in its bucket');
  pick := test.b84_of(f, 'm3', 'm7', 's5');
  PERFORM test.assert_ids(
    ARRAY(SELECT r.id FROM public.kwenta_personal_bill_rows(alice, v_bills, v_items, v_splits, pick, settled) r),
    pick, 'C2: rows are built for the asked ids only');
  -- Another account's bill, or a deleted one, named in p_ids builds nothing.
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_rows(alice, v_bills, v_items, v_splits,
       test.b84_of(f, 'carl_bill', 'm_deleted', 'g_bill'), settled)),
    0, 'C2: ids outside the viewer''s pulled personal bills build no row');
  -- A repeated id builds its bill once (the id list is a filter, not a join).
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_rows(alice, v_bills, v_items, v_splits,
       test.b84_of(f, 'm3', 'm3', 'm3', 's5', 's5'), settled)),
    2, 'C2: a repeated id in p_ids builds that bill exactly once');
  PERFORM test.assert_eq(
    (SELECT count(*)::int FROM public.kwenta_personal_bill_rows(alice, v_bills, v_items, v_splits,
       all_ids || all_ids, settled)),
    cardinality(all_ids), 'C2: the whole id list passed twice still builds each bill once');
  -- Structural pin (timing-free): `= ANY(p_ids)` re-scans the id array once per bill, which is
  -- quadratic when kwenta_personal_bills() passes every id. The helpers must filter by semi-join.
  PERFORM test.assert_false(
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid IN (to_regprocedure('public.kwenta_personal_bill_rows(uuid, public.bills[], public.bill_items[], public.item_splits[], uuid[], jsonb)'),
                             to_regprocedure('public.kwenta_personal_bill_index(uuid, public.bills[], public.bill_items[], public.item_splits[])'))
               AND p.prosrc ~* '=\s*ANY\s*\(\s*p_ids'),
    'C2: the helpers do not filter by = ANY(p_ids) (quadratic over the full list)');
  PERFORM test.as_owner();
  PERFORM test.note('C2: index and row builder agree with 079');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: cost. 120 own bills, each split with a different contact (so 079 resolves ~120 names and
-- ~120 identity clusters), plus 5 of Bob's. Counted with pg_stat_xact_user_functions.
-- The harness connects as the initdb superuser (scripts/sql-test.sh: PGUSER=postgres), which is
-- what allows SET track_functions; 'all' (not 'pl') because kwenta_peer_display_name,
-- kwenta_expand_identity and the kwenta_pull_rows_* functions are LANGUAGE sql. They are SECURITY
-- DEFINER with a SET clause, so they are never inlined and every call is counted.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; p jsonb; cur jsonb;
  n0 bigint; n1 bigint; n2 bigint; e0 bigint; e1 bigint; e2 bigint; sm_n bigint; sm_e bigint;
  page_n bigint; page_e bigint; ref_n bigint; ref_e bigint;
  pull_fns text[] := ARRAY['kwenta_pull_rows_bills', 'kwenta_pull_rows_bill_items',
                           'kwenta_pull_rows_item_splits', 'relevant_bill_ids_for_user'];
  page_pulls bigint[]; ref_pulls bigint[]; k int; sort text;
BEGIN
  alice := test.new_account('b84-big-alice@example.com', 'Alice');
  bob   := test.new_account('b84-big-bob@example.com', 'Bob');
  CREATE TEMP TABLE b84_big ON COMMIT DROP AS
    SELECT gen_random_uuid() AS bill_id, gen_random_uuid() AS item_id, gen_random_uuid() AS contact_id, i
    FROM generate_series(1, 120) i;
  INSERT INTO public.profiles (id, email, display_name, created_at, updated_at, synced_at,
                               is_deleted, device_id, is_local, linked_profile_id, owner_id)
  SELECT contact_id, '', 'Friend ' || i, now(), now(), now(), false, 'test', true, NULL, alice FROM b84_big;
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT bill_id, NULL, alice, alice, 'Bill ' || i, 120, 'PHP',
         '2026-01-01'::timestamptz + make_interval(hours => i), now(), now(), false, 'test'
  FROM b84_big;
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT item_id, bill_id, 'Bill ' || i, 120, now(), now(), now(), false, 'test' FROM b84_big;
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), item_id, u, 'equal', 1, 60, now(), now(), now(), false, 'test'
  FROM b84_big, LATERAL (VALUES (alice), (contact_id)) v(u);
  FOR k IN 1 .. 5 LOOP
    PERFORM test.new_bill(bob, bob, NULL, 'Bob bill ' || k, 20, ARRAY[bob, alice]);
  END LOOP;

  PERFORM set_config('track_functions', 'all', true);

  FOREACH sort IN ARRAY ARRAY['date_desc', 'title_asc'] LOOP
    -- First page, settled = 'all'.
    n0 := test.b84_calls('kwenta_peer_display_name'); e0 := test.b84_calls('kwenta_expand_identity');
    page_pulls := ARRAY(SELECT test.b84_calls(x) FROM unnest(pull_fns) x);
    PERFORM test.as_user(alice);
    p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, sort);
    PERFORM test.as_owner();
    n1 := test.b84_calls('kwenta_peer_display_name'); e1 := test.b84_calls('kwenta_expand_identity');
    page_pulls := ARRAY(SELECT test.b84_calls(pull_fns[j]) - page_pulls[j] FROM generate_subscripts(pull_fns, 1) j ORDER BY j);

    ref_pulls := ARRAY(SELECT test.b84_calls(x) FROM unnest(pull_fns) x);
    PERFORM test.as_user(alice);
    PERFORM test.personal_bills_079_reference();
    PERFORM test.as_owner();
    n2 := test.b84_calls('kwenta_peer_display_name'); e2 := test.b84_calls('kwenta_expand_identity');
    ref_pulls := ARRAY(SELECT test.b84_calls(pull_fns[j]) - ref_pulls[j] FROM generate_subscripts(pull_fns, 1) j ORDER BY j);

    -- What the settled map alone costs for the page's ids is not the row builder's: subtract it.
    sm_n := test.b84_calls('kwenta_peer_display_name'); sm_e := test.b84_calls('kwenta_expand_identity');
    PERFORM public.kwenta_bills_settled_map(test.b84_ids(p), alice);
    sm_n := test.b84_calls('kwenta_peer_display_name') - sm_n; sm_e := test.b84_calls('kwenta_expand_identity') - sm_e;
    page_n := n1 - n0 - sm_n; page_e := e1 - e0 - sm_e;
    ref_n := n2 - n1; ref_e := e2 - e1;

    PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 20, format('C3 %s: the page has 20 rows', sort));
    PERFORM test.assert_eq((p ->> 'mine')::int, 120, format('C3 %s: mine = 120', sort));
    PERFORM test.assert_true(ref_n >= 120,
      format('C3 %s: 079''s list resolves a name per contact (counting works): %s calls', sort, ref_n));
    PERFORM test.assert_true(page_n <= 2 * 20 + 5,
      format('C3 %s: the page resolves names for its 20 rows only: %s calls (079 made %s)', sort, page_n, ref_n));
    PERFORM test.assert_true(ref_e >= 120,
      format('C3 %s: 079''s list expands an identity per participant: %s calls', sort, ref_e));
    PERFORM test.assert_true(page_e <= 2 * 20 + 5,
      format('C3 %s: the page expands identities for its rows only: %s calls (079 made %s)', sort, page_e, ref_e));
    PERFORM test.assert_true(ref_pulls[1] >= 1, format('C3 %s: 079 pulls bills through kwenta_pull_rows_bills', sort));
    FOR k IN 1 .. cardinality(pull_fns) LOOP
      PERFORM test.assert_true(page_pulls[k] <= ref_pulls[k],
        format('C3 %s: the page calls %s no more often than 079 (%s vs %s)', sort, pull_fns[k], page_pulls[k], ref_pulls[k]));
    END LOOP;

    -- A cursor page, settled = 'all': still bounded by its own rows.
    cur := test.b84_cursor(p -> 'rows' -> 19);
    n0 := test.b84_calls('kwenta_peer_display_name'); e0 := test.b84_calls('kwenta_expand_identity');
    PERFORM test.as_user(alice);
    p := public.kwenta_personal_bills_page('mine', 20, 'all', NULL, sort, cur);
    PERFORM test.as_owner();
    n1 := test.b84_calls('kwenta_peer_display_name'); e1 := test.b84_calls('kwenta_expand_identity');
    sm_n := test.b84_calls('kwenta_peer_display_name'); sm_e := test.b84_calls('kwenta_expand_identity');
    PERFORM public.kwenta_bills_settled_map(test.b84_ids(p), alice);
    sm_n := test.b84_calls('kwenta_peer_display_name') - sm_n; sm_e := test.b84_calls('kwenta_expand_identity') - sm_e;
    page_n := n1 - n0 - sm_n; page_e := e1 - e0 - sm_e;
    PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), 20, format('C3 %s: the cursor page has 20 rows', sort));
    PERFORM test.assert_true(page_n <= 2 * 20 + 5,
      format('C3 %s: a cursor page resolves names for its rows only: %s calls', sort, page_n));
    PERFORM test.assert_true(page_e <= 2 * 20 + 5,
      format('C3 %s: a cursor page expands identities for its rows only: %s calls', sort, page_e));
  END LOOP;

  -- Under a settled filter the row builder still runs for the page only (the settled map may
  -- cover the bucket, but names are a row-builder cost). Pull counts stay within 079's.
  page_pulls := ARRAY(SELECT test.b84_calls(x) FROM unnest(pull_fns) x);
  PERFORM test.as_user(alice);
  p := public.kwenta_personal_bills_page('mine', 20, 'unsettled', NULL, 'date_desc');
  PERFORM test.as_owner();
  page_pulls := ARRAY(SELECT test.b84_calls(pull_fns[j]) - page_pulls[j] FROM generate_subscripts(pull_fns, 1) j ORDER BY j);
  PERFORM test.assert_eq((p ->> 'matching')::int, 120, 'C3: every own bill is unsettled (each contact owes 60)');
  FOR k IN 1 .. cardinality(pull_fns) LOOP
    PERFORM test.assert_true(page_pulls[k] <= ref_pulls[k],
      format('C3: an unsettled page calls %s no more often than 079 (%s vs %s)', pull_fns[k], page_pulls[k], ref_pulls[k]));
  END LOOP;
  PERFORM test.note('C3: names, identities and pulls scale with the page, not the list');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: the settled map is handed at most p_limit ids on a settled = 'all' page. Its arguments are
-- not visible to pg_stat, so, inside this rolled-back transaction only, the real function is
-- renamed and a pass-through recording cardinality(p_bill_ids) takes its name. (Plans that
-- referenced the old function are invalidated by the rename.) The GUC is set non-locally because
-- a function SET clause unwinds SET LOCAL at its exit; the rollback still discards it.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.kwenta_bills_settled_map(uuid[], uuid) RENAME TO kwenta_bills_settled_map_b84_real;

CREATE FUNCTION public.kwenta_bills_settled_map(p_bill_ids uuid[], p_viewer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  PERFORM set_config('test_b84.settled_map_sizes',
    COALESCE(NULLIF(current_setting('test_b84.settled_map_sizes', true), ''), '') || COALESCE(cardinality(p_bill_ids), 0) || ',',
    false);
  RETURN public.kwenta_bills_settled_map_b84_real(p_bill_ids, p_viewer);
END;
$$;

DO $$
DECLARE
  alice uuid; p jsonb; sizes int[]; sort text; lim int;
BEGIN
  alice := (SELECT b.created_by FROM public.bills b WHERE b.title = 'Bill 1' AND b.total_amount = 120 LIMIT 1);
  -- Reuses the bulk fixture of the C3 block above (same transaction).
  IF alice IS NULL THEN
    PERFORM test.fail('C3 settled map', 'C3 bulk fixture present', 'missing');
  END IF;

  PERFORM set_config('test_b84.settled_map_sizes', '', false);
  PERFORM test.as_user(alice);
  PERFORM test.personal_bills_079_reference();
  PERFORM test.as_owner();
  sizes := ARRAY(SELECT x::int FROM unnest(string_to_array(rtrim(current_setting('test_b84.settled_map_sizes'), ','), ',')) x);
  PERFORM test.assert_true(COALESCE((SELECT max(s) FROM unnest(sizes) s), 0) >= 120,
    'C3: the probe sees 079 hand the settled map the whole list (got sizes ' || COALESCE(sizes::text, '{}') || ')');

  FOREACH sort IN ARRAY ARRAY['date_desc', 'title_desc'] LOOP
    FOREACH lim IN ARRAY ARRAY[20, 5] LOOP
      PERFORM set_config('test_b84.settled_map_sizes', '', false);
      PERFORM test.as_user(alice);
      p := public.kwenta_personal_bills_page('mine', lim, 'all', NULL, sort);
      PERFORM test.as_owner();
      sizes := ARRAY(SELECT x::int FROM unnest(string_to_array(NULLIF(rtrim(current_setting('test_b84.settled_map_sizes'), ','), ''), ',')) x);
      PERFORM test.assert_eq(jsonb_array_length(p -> 'rows'), lim, format('C3 %s: limit %s page has %s rows', sort, lim, lim));
      PERFORM test.assert_true(COALESCE((SELECT max(s) FROM unnest(sizes) s), 0) <= lim,
        format('C3 %s: a settled=all page hands the settled map at most %s ids (got sizes %s)', sort, lim, COALESCE(sizes::text, '{}')));
      -- Its flags are still the full list's flags (each bill's flag depends only on its parties).
      PERFORM test.assert_eq(
        (SELECT count(*)::int FROM jsonb_array_elements(p -> 'rows') r WHERE (r ->> 'settled')::boolean),
        0, format('C3 %s: every page row reads unsettled, as in the full list', sort));
    END LOOP;
  END LOOP;
  PERFORM test.note('C3: the settled map sees only the page''s ids');
END;
$$;
