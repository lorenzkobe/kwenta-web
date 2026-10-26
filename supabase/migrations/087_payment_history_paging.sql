-- 087 — The group payment history one page at a time, and the Person payment items by leg id.
--
-- APPLY BEFORE THE CLIENT THAT CALLS kwenta_group_settlement_history_page OR
-- kwenta_person_payment_items SHIPS. Additive otherwise: no existing function changes shape or
-- output.
-- * The client that ships with this migration reads the group's payments through the page endpoint
--   and the Person statement's note/method/edit lookup through the items endpoint, so against a
--   pre-087 server neither can load (PostgREST answers "function not found"; online the screen
--   shows its unavailable message, with no fallback to the whole history). Apply the migration
--   first.
-- * kwenta_group_settlement_history(p_group_id), kwenta_person_settlement_history(p_person_id) and
--   kwenta_settlement_history_build are not touched. Installed PWAs keep their build until the
--   user taps Refresh and keep calling them (and naming them in a write's p_reads); the new
--   client's exports fetch them whole on tap.
--
-- What was wrong
-- Two payment lists grew with every payment and were downloaded whole on every open:
--   * Group detail's payments: 19 kB for a group with 14 bundles of 41 legs, while the screen shows
--     the newest few. A bundle carries every leg and recipient, so a busy group is dominated by it.
--   * The Person page downloaded the pair's whole payment history (12.5 kB) on mount for a lookup
--     nobody sees: the statement rows read their edit target, method and note from it, and the
--     export card read the payments. The list itself is not shown on that page.
--
-- The shape, and why
--   * kwenta_group_settlement_history_page(p_group_id, p_limit, p_before) returns
--     `{items, matching, totals}` and is built ON the old endpoint: it calls
--     kwenta_group_settlement_history and slices its items, so there is ONE implementation of the
--     item shape and of the membership gate (a non-member, a removed member, a deleted group or an
--     unknown group is NULL, as before; no auth.uid() raises). An authenticated member always gets
--     an object back (an empty page for a group with no payments), so a NULL can only mean
--     "declined".
--       - items are the full history's items, jsonb for jsonb, in the same order: createdAt DESC,
--         then the item's primary leg ASC. The primary leg is settlementIds[0]: the builder orders
--         a bundle's legs by (created_at DESC, id) and takes the first as the item's representative,
--         which is also its sort key.
--       - the walk is KEYSET: p_before is the last loaded item's `{createdAt, id}` (id = its
--         settlementIds[0]) and the call returns the items strictly older in that order, compared
--         as `(createdAt)::timestamptz` and `(id)::uuid`, never as text (text sorts differently
--         from uuid and carries the session's UTC offset). It compares key VALUES, so a deleted
--         cursor item still continues and a payment added between taps cannot shift a page. A
--         cursor that is not an object with a uuid `id` and a timestamp `createdAt` raises. NULL
--         p_limit is 20; the limit is clamped to 1..500. A bundle is always one item, never split.
--       - matching is the full history's item count, on every page.
--       - totals is the dialog's "Total paid" over ALL items: [{userId, name, currency, amount}],
--         one per item fromUserId + currency, amount money-rounded, name that payer's fromName,
--         ordered amount DESC, userId, currency; [] with no payments. It comes from the server
--         because a sum over a loaded page would be wrong money (rule 8), and it is identical on
--         every page and cursor.
--   * kwenta_person_payment_items(p_person_id, p_settlement_ids) returns the items of
--     kwenta_person_settlement_history whose settlementIds intersect the given ids, in that
--     function's order, once each. Scoping is therefore EXACTLY the history's (the viewer's
--     identity set and the person's, settled and live rows only): naming another account's payment
--     id returns nothing. The auth check comes first, so it raises even for an empty list; an empty
--     (or NULL) list is []; more than 500 ids raises, and the client chunks by 500. The statement
--     (086) already holds each row's leg ids, so the client looks up only the legs it loaded.
--   * kwenta_read and kwenta_read_is_allowed are restated whole (CREATE OR REPLACE keeps their
--     grants) with one new name, kwenta_group_settlement_history_page, dispatched with the spec's
--     limit and no cursor: a write primes the first page, so the screen's re-read costs no request.
--     085/086's branches are kept. kwenta_person_payment_items is NOT named there: its argument
--     is a list a spec cannot carry, and the lookup follows the legs the screen has loaded.
--
-- Cost
-- Every call, a cursor page included, builds the group's whole history through the old endpoint
-- (all bundles, party-name lookups, the activity_log lookup) and then slices it, and the items
-- lookup builds the pair's whole person history. Server work per call stays O(all payments); what
-- shrinks is the payload, and with it the download, the JSON parse and the re-render. That is the
-- right trade at this size, and rewriting the builder to cut work per page would mean a second
-- item-shape implementation.
--
-- Known and unchanged: the Person statement (086) and the person history (069) scope a group
-- payment differently (the statement matches the roster id the payment is filed under, the history
-- expands the person's identity set), so a statement leg can have no item. Such a row shows no
-- note/method and no edit, as it did before; it is not a regression.
--
-- Authorization (rule 5)
-- Both new endpoints derive the viewer from auth.uid() and are GRANTed to `authenticated` only
-- (REVOKE FROM PUBLIC, anon); the 073 / 079 suites name them in their allowlists. Neither takes
-- the acting user as an argument, so no helper here needs kwenta_revoke_acting_user_helpers().

CREATE OR REPLACE FUNCTION public.kwenta_group_settlement_history_page(
  p_group_id uuid,
  p_limit    integer,
  p_before   jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 500);
  v_has_before boolean := p_before IS NOT NULL;
  v_before_id uuid;
  v_before_at timestamptz;
  v_items jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF v_has_before THEN
    IF jsonb_typeof(p_before) <> 'object' OR NOT (p_before ? 'id') OR NOT (p_before ? 'createdAt') THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
    v_before_id := (p_before ->> 'id')::uuid;
    v_before_at := (p_before ->> 'createdAt')::timestamptz;
    IF v_before_id IS NULL OR v_before_at IS NULL THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
  END IF;

  v_items := public.kwenta_group_settlement_history(p_group_id);
  IF v_items IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(pg.e ORDER BY pg.n)
      FROM (
        SELECT x.e, x.n
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS x(e, n)
        WHERE NOT v_has_before
           OR (x.e ->> 'createdAt')::timestamptz < v_before_at
           OR ((x.e ->> 'createdAt')::timestamptz = v_before_at
               AND (x.e -> 'settlementIds' ->> 0)::uuid > v_before_id)
        ORDER BY x.n
        LIMIT v_limit
      ) pg
    ), '[]'::jsonb),
    'matching', jsonb_array_length(v_items),
    'totals', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'userId', t.user_id, 'name', t.name, 'currency', t.currency, 'amount', t.amount)
               ORDER BY t.amount DESC, t.user_id, t.currency)
      FROM (
        SELECT (e ->> 'fromUserId')::uuid AS user_id,
               MIN(e ->> 'fromName')       AS name,
               e ->> 'currency'            AS currency,
               public.kwenta_round_money(SUM((e ->> 'amount')::numeric)) AS amount
        FROM jsonb_array_elements(v_items) e
        GROUP BY (e ->> 'fromUserId')::uuid, e ->> 'currency'
      ) t
    ), '[]'::jsonb)
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.kwenta_person_payment_items(
  p_person_id      uuid,
  p_settlement_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF COALESCE(cardinality(p_settlement_ids), 0) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF cardinality(p_settlement_ids) > 500 THEN
    RAISE EXCEPTION 'too many settlement ids';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(h.e ORDER BY h.n)
    FROM jsonb_array_elements(public.kwenta_person_settlement_history(p_person_id))
         WITH ORDINALITY AS h(e, n)
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(h.e -> 'settlementIds') sid
      WHERE sid::uuid = ANY (p_settlement_ids)
    )
  ), '[]'::jsonb);
END;
$$;


REVOKE ALL ON FUNCTION public.kwenta_group_settlement_history_page(uuid, integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_person_payment_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_group_settlement_history_page(uuid, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_person_payment_items(uuid, uuid[]) TO authenticated;


-- kwenta_read: 086's body plus the paged group payments, dispatched with the spec's limit.
CREATE OR REPLACE FUNCTION public.kwenta_read(
  p_fn text,
  p_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
-- Deliberately VOLATILE (the default): several dispatched endpoints are plpgsql and volatile
-- themselves, and marking the wrapper stronger than what it calls is how a planner ends up
-- caching a balance.
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN CASE p_fn
    WHEN 'kwenta_balances_overview'        THEN public.kwenta_balances_overview()
    WHEN 'kwenta_groups_with_balances'     THEN public.kwenta_groups_with_balances()
    WHEN 'kwenta_contacts_with_balances'   THEN public.kwenta_contacts_with_balances()
    WHEN 'kwenta_personal_bills'           THEN public.kwenta_personal_bills()
    WHEN 'kwenta_recent_bills'             THEN public.kwenta_recent_bills(COALESCE(p_limit, 5))
    WHEN 'kwenta_bill_detail'              THEN public.kwenta_bill_detail(p_id)
    WHEN 'kwenta_group_detail'             THEN public.kwenta_group_detail(p_id)
    WHEN 'kwenta_group_detail_paged'       THEN public.kwenta_group_detail_paged(p_id, p_limit)
    WHEN 'kwenta_person_summary'           THEN public.kwenta_person_summary(p_id)
    WHEN 'kwenta_person_statement'         THEN public.kwenta_person_statement(p_id)
    WHEN 'kwenta_person_statement_page'    THEN public.kwenta_person_statement_page(p_id, p_limit, 'all', NULL)
    WHEN 'kwenta_bill_settlement_history'  THEN public.kwenta_bill_settlement_history(p_id)
    WHEN 'kwenta_group_settlement_history' THEN public.kwenta_group_settlement_history(p_id)
    WHEN 'kwenta_group_settlement_history_page' THEN public.kwenta_group_settlement_history_page(p_id, p_limit, NULL)
    WHEN 'kwenta_person_settlement_history' THEN public.kwenta_person_settlement_history(p_id)
    WHEN 'kwenta_group_spending'           THEN public.kwenta_group_spending(p_id)
    ELSE NULL
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_read_is_allowed(p_fn text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_fn IN (
    'kwenta_balances_overview',
    'kwenta_groups_with_balances',
    'kwenta_contacts_with_balances',
    'kwenta_personal_bills',
    'kwenta_recent_bills',
    'kwenta_bill_detail',
    'kwenta_group_detail',
    'kwenta_group_detail_paged',
    'kwenta_person_summary',
    'kwenta_person_statement',
    'kwenta_person_statement_page',
    'kwenta_bill_settlement_history',
    'kwenta_group_settlement_history',
    'kwenta_group_settlement_history_page',
    'kwenta_person_settlement_history',
    'kwenta_group_spending'
  );
$$;
