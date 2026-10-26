-- 086 — The Person statement, one page at a time, with the running balance computed in SQL.
--
-- APPLY BEFORE THE CLIENT THAT CALLS kwenta_person_statement_page SHIPS. Additive otherwise: no
-- existing function changes shape or output.
-- * The client that ships with this migration reads the statement through
--   kwenta_person_statement_page, so against a pre-086 server the statement cannot load
--   (PostgREST answers "function not found"; online the screen shows its unavailable message, with
--   no fallback to the whole list). Apply the migration first.
-- * kwenta_person_statement(p_person_id) keeps its signature and returns, jsonb for jsonb, exactly
--   what 065 returned. Installed PWAs keep their build until the user taps Refresh and keep calling
--   it, and the new client's exports (PDF, CSV, the personal-bill list) fetch it whole on tap. A
--   mounted statement spec with no page name (an old app's, named in a write's p_reads) is still
--   dispatched to it by kwenta_read.
--
-- What was wrong
-- The Person screen's statement was 30-43 kB (Nek 94 events / 30 kB, Yumi 136 events / 43 kB) and
-- grew with every bill and payment a pair ever shared, while the screen shows twenty rows. The
-- client then walked the whole list to compute each row's running balance and filtered it for the
-- Payments view in the browser.
--
-- Why the running balance moves from TypeScript to SQL
-- 062's header kept the running walk in buildMoneyFlowRows because the event list was a bounded
-- list the client held in full, so the walk was a pure transform of bounded input. Paging ends
-- that: the client holds twenty events, and a row's balance depends on every event before it,
-- including the ones it never downloaded. That is aggregation over unbounded data, which rule 8
-- puts in SQL, once. buildMoneyFlowRows becomes a mapper over numbers the server computed, and the
-- 13 Vitest cases that pinned the walk now live in 086_person_statement_paging.test.sql.
--
-- The shape, and why
--   * kwenta_person_statement_events(p_person_id, p_uid) holds the whole of 065's event rules,
--     once, as a table of sort keys plus `event` (the jsonb object 065 emitted per event). 065's
--     kwenta_person_statement is now `jsonb_agg(event ORDER BY created_at, id)` over it, which is
--     what 065 did, so its output is byte for byte the old one (the 086 suite compares it with a
--     frozen copy of 065's body for every viewer/person pair the fixtures make interesting).
--   * kwenta_person_statement_page(p_person_id, p_limit, p_kind, p_before) returns
--     `{events, matching, latestPersonalCurrency}`:
--       - every event is 065's event plus `runningNet` and `prevRunning`: the per-currency
--         cumulative SUM(delta) over ALL of the pair's events, whatever their kind, in (created_at,
--         id) ascending order, and the same minus the event's own delta. The window runs before
--         the kind filter and the cursor, so a payments-only page and a page deep in history carry
--         the numbers the full history implies, and the newest event of each currency ends on the
--         hero (kwenta_person_summary). Timestamp ties break by id, as the order is a total one.
--         Sums are numeric, so there is no float drift to round away.
--       - p_kind is 'all' or 'payments' (anything else raises). `matching` counts the whole
--         kind-filtered set on every page, cursor or not.
--       - the walk is KEYSET: p_before is the oldest loaded row's `{createdAt, id}` and the call
--         returns the events strictly older in (created_at, id), newest first, compared on the key
--         VALUES, so a deleted or edited cursor event still continues and an event added between
--         taps cannot shift a page. A cursor that is not an object with a uuid `id` and a
--         timestamp `createdAt` raises. NULL p_limit is 20; the limit is clamped to 1..500, and
--         the clamp bounds the rows asked for, not the rows returned (see the bundle rule).
--       - latestPersonalCurrency is the currency of the newest live personal bill over the whole
--         history, independent of kind and cursor, NULL when there is none. The payment dialog's
--         default currency used to come from the loaded statement and would now see only a page.
--   * A page never ends inside a payment bundle that its next cursor would orphan. collapsePaymentLegs
--     merges only ADJACENT legs of one bundle into a single payment row, so a page that ended on one
--     leg of a bundle whose older legs sit on the next page would show the bundle as two payments.
--     So when the oldest row of a page is a payment leg whose bundle has older legs, the page
--     extends down to the bundle's oldest leg, and takes EVERY event of the requested kind in
--     between: legs do not share one timestamp (each leg is stamped by its own syncFields), and a
--     bill or another payment can sit between two of them. The next cursor is then the oldest leg,
--     and nothing between is skipped. A page can therefore hold more than p_limit rows, and more
--     than 500: bundle_id is set by the client and the validators accept it as sent, so the
--     extension reaches back to the bundle's oldest leg however far back that is. There is no cap
--     on purpose: a cap would split the bundle across two pages for no real gain, and a call can
--     never return more than the pair's whole history, which the old endpoint already returned in
--     one response. The rule
--     fires only when the OLDEST row is a leg, so a bundle that is not at the page boundary but is
--     split by interleaved events can still straddle two pages; there the legs were never
--     adjacent, and would not have merged on one page either.
--   * kwenta_read and kwenta_read_is_allowed are restated whole (CREATE OR REPLACE keeps their
--     grants) with one new name, kwenta_person_statement_page, dispatched with the spec's limit,
--     kind 'all' and no cursor: a write primes the first page, so the screen's re-read costs no
--     request. The cursor and kind arguments cannot travel in a spec, so older pages and the
--     Payments view are refetched. 085's kwenta_group_detail_paged branch is kept.
--
-- Cost
-- Every call, a cursor page included, builds the pair's whole event set and its window sum, because
-- a row's running number needs the events before it. The bytes sent shrink to a page; the server
-- CPU per call stays what the old endpoint cost (and kwenta_write's priming already ran it).
--
-- Authorization (rule 5)
--   * kwenta_person_statement_events names the acting user (`p_uid`): it is SECURITY DEFINER,
--     service_role only, and the migration ends with kwenta_revoke_acting_user_helpers(), which
--     closes it like every other helper that names its caller. As a second lock it RAISEs unless
--     p_uid = auth.uid() (and refuses a NULL auth.uid()), so even a role that holds EXECUTE cannot
--     read as someone else. Its rows come from kwenta_pull_rows_* (051), as 065's did.
--   * kwenta_person_statement and kwenta_person_statement_page derive the viewer from auth.uid()
--     and are GRANTed to `authenticated` only (REVOKE FROM PUBLIC, anon). The 073 / 079 suites name
--     the new endpoint in their allowlists. An authenticated caller always gets an object back
--     (an empty page for a pair with nothing, never NULL), so a NULL can only mean "declined".

/**
 * 065's event rules for the Person statement, once. One row per event, ascending order is the
 * caller's to apply. `event` is the object 065 returned per event, key for key.
 */
CREATE OR REPLACE FUNCTION public.kwenta_person_statement_events(p_person_id uuid, p_uid uuid)
RETURNS TABLE (
  e_created_at timestamptz,
  e_id         uuid,
  e_type       text,
  e_currency   text,
  e_bundle_id  uuid,
  e_delta      numeric,
  event        jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPS constant numeric := 0.005;
  v_other_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  v_other_name := public.kwenta_peer_display_name(p_uid, p_person_id);

  RETURN QUERY
  WITH
  me AS (SELECT id FROM public.kwenta_expand_identity(p_uid, p_uid)),
  other AS (SELECT id FROM public.kwenta_expand_identity(p_person_id, p_uid)),
  visible_bills AS (
    SELECT b.*
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, p_uid) b
    WHERE b.is_deleted IS FALSE
  ),
  shared AS (
    SELECT g.id AS group_id, g.name, g.currency, gm_other.user_id AS other_roster_id
    FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, p_uid) g
    JOIN public.group_members gm_me
      ON gm_me.group_id = g.id AND gm_me.user_id = p_uid AND gm_me.is_deleted IS FALSE
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
               WHEN b.paid_by = p_uid AND sp.user_id = s.other_roster_id THEN sp.computed_amount
               WHEN b.paid_by = s.other_roster_id AND sp.user_id = p_uid THEN -sp.computed_amount
               ELSE 0
             END
           ) AS delta
    FROM visible_bills b
    JOIN shared s ON s.group_id = b.group_id
    JOIN public.bill_items bi ON bi.bill_id = b.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE (b.currency IS NULL OR b.currency = '' OR b.currency = s.currency)
      AND (b.paid_by = p_uid OR b.paid_by = s.other_roster_id)
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
           (s.from_user_id = p_uid) AS i_paid
    FROM settled s
    JOIN shared sh ON sh.group_id = s.group_id
    WHERE (s.currency IS NULL OR s.currency = '' OR s.currency = sh.currency)
      AND (
        (s.from_user_id = p_uid AND s.to_user_id = sh.other_roster_id)
        OR
        (s.to_user_id = p_uid AND s.from_user_id = sh.other_roster_id)
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
  SELECT e.created_at, e.id, e.type, e.currency, e.bundle_id, e.delta,
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
         )
  FROM events e;
END;
$$;


/**
 * The Person statement's events, all of them. See migration 062; 065 added `category` on bill
 * events; 086 only moved the event rules into kwenta_person_statement_events.
 */
CREATE OR REPLACE FUNCTION public.kwenta_person_statement(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(s.event ORDER BY s.e_created_at, s.e_id)
    FROM public.kwenta_person_statement_events(p_person_id, v_uid) s
  ), '[]'::jsonb);
END;
$$;


CREATE OR REPLACE FUNCTION public.kwenta_person_statement_page(
  p_person_id uuid,
  p_limit     integer DEFAULT 20,
  p_kind      text DEFAULT 'all',
  p_before    jsonb DEFAULT NULL
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
  v_payments_only boolean;
  v_has_before boolean := p_before IS NOT NULL;
  v_before_id uuid;
  v_before_at timestamptz;
  v_events jsonb;
  v_matching integer;
  v_currency text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('all', 'payments') THEN
    RAISE EXCEPTION 'unknown statement kind';
  END IF;
  v_payments_only := p_kind = 'payments';

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

  WITH
  ev AS MATERIALIZED (
    SELECT s.*,
           SUM(s.e_delta) OVER (
             PARTITION BY s.e_currency
             ORDER BY s.e_created_at, s.e_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running
    FROM public.kwenta_person_statement_events(p_person_id, v_uid) s
  ),
  shown AS MATERIALIZED (
    SELECT * FROM ev WHERE NOT v_payments_only OR e_type = 'payment'
  ),
  older AS (
    SELECT * FROM shown
    WHERE NOT v_has_before OR (e_created_at, e_id) < (v_before_at, v_before_id)
  ),
  last_row AS (
    SELECT o.e_created_at, o.e_id, o.e_type, o.e_bundle_id
    FROM older o
    ORDER BY o.e_created_at DESC, o.e_id DESC
    LIMIT 1 OFFSET v_limit - 1
  ),
  floor_row AS (
    SELECT x.f_at, x.f_id
    FROM (
      SELECT l.e_created_at AS f_at, l.e_id AS f_id FROM last_row l
      UNION ALL
      SELECT leg.e_created_at, leg.e_id
      FROM last_row l
      JOIN ev leg ON leg.e_type = 'payment' AND leg.e_bundle_id = l.e_bundle_id
      WHERE l.e_type = 'payment' AND l.e_bundle_id IS NOT NULL
    ) x
    ORDER BY x.f_at, x.f_id
    LIMIT 1
  ),
  page AS (
    SELECT o.*
    FROM older o
    LEFT JOIN floor_row f ON true
    WHERE f.f_at IS NULL OR (o.e_created_at, o.e_id) >= (f.f_at, f.f_id)
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(
       pg.event || jsonb_build_object('runningNet', pg.running, 'prevRunning', pg.running - pg.e_delta)
       ORDER BY pg.e_created_at DESC, pg.e_id DESC
     ), '[]'::jsonb) FROM page pg),
    (SELECT count(*)::integer FROM shown),
    (SELECT e.e_currency FROM ev e WHERE e.e_type = 'personal_bill'
      ORDER BY e.e_created_at DESC, e.e_id DESC LIMIT 1)
  INTO v_events, v_matching, v_currency;

  RETURN jsonb_build_object(
    'events', v_events,
    'matching', v_matching,
    'latestPersonalCurrency', v_currency
  );
END;
$$;


REVOKE ALL ON FUNCTION public.kwenta_person_statement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_person_statement_page(uuid, integer, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_person_statement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_person_statement_page(uuid, integer, text, jsonb) TO authenticated;


-- kwenta_read: 085's body plus the paged statement, dispatched with the spec's limit.
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
    'kwenta_person_settlement_history',
    'kwenta_group_spending'
  );
$$;

-- Last, so it also covers the helper this migration created (it names p_uid).
SELECT public.kwenta_revoke_acting_user_helpers();
