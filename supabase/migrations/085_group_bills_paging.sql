-- 085 — The group bill list, one page at a time.
--
-- APPLY BEFORE THE CLIENT THAT CALLS kwenta_group_detail_paged / kwenta_group_bills_page SHIPS.
-- Additive otherwise: no existing function changes shape or output.
-- * The client that ships with this migration reads the group screen through
--   kwenta_group_detail_paged and walks the rest of the list through kwenta_group_bills_page, so
--   against a pre-085 server that screen cannot load (PostgREST answers "function not found").
-- * kwenta_group_detail(p_group_id) keeps its signature and returns exactly what 083 returned, bills
--   and all, with no new key. Installed PWAs keep their build until the user taps Refresh and keep
--   calling it; a mounted group spec with no `limit` (an old app's, named in a write's p_reads) is
--   dispatched to it by kwenta_read and so still receives every bill.
--
-- What was wrong
-- Group detail for a 59-bill group (Siquijor 23.7 kB, Vietnam 24.3 kB; 16-29 kB across groups) was
-- almost all the bill list: one row per live bill (title, note, amounts, conversion keys, payer
-- name), so the payload grew with every bill while the screen shows twenty. The client then paged
-- the list ten at a time in the browser and built its payer chips from every bill's payer.
--
-- The shape, and why
--   * kwenta_group_detail_build(p_group_id, p_uid, p_bill_limit) holds the whole of 083's body, once.
--     p_bill_limit NULL = every bill and no new key (kwenta_group_detail, byte for byte); a number =
--     the N newest bills (created_at DESC, id ASC, the order 083 used) plus `billCount` (every live
--     bill) and `billPayers` ([{userId, count}] over every live bill, count DESC then userId; a bill
--     with no payer has no entry). A removed member's bills still count: the totals describe the
--     bills, not the roster, and the client intersects billPayers with the roster itself.
--   * kwenta_group_detail_paged(p_group_id, p_limit) is that builder with the limit clamped to 1..500
--     (NULL = 20, the page size). It is a client endpoint with no viewer argument, so kwenta_read
--     can name it and a write primes the first page: the screen's re-read after a save costs no
--     request, and the limit travels in the spec like kwenta_recent_bills'.
--   * kwenta_group_bills_page(p_group_id, p_limit, p_payer, p_after) is the cursor endpoint for
--     "Show more" and for the payer filter: `{rows, matching}`. `matching` counts the whole filtered
--     set (p_payer = paid_by; NULL = every bill), with or without a cursor, so "N remaining" and
--     "no bills paid by X" come from the server. The walk is KEYSET: p_after is the last loaded
--     row's `{id, createdAt}` and the call returns the next rows strictly after that position in
--     (created_at DESC, id ASC), compared on the key VALUES, so a deleted or edited cursor row still
--     continues, a bill added between taps cannot shift a page, and the walk reaches the last bill
--     however many there are (the 500 clamp bounds one call, not the list). A cursor that is not an
--     object with a uuid `id` and a timestamp `createdAt` raises. It is NOT named in kwenta_read:
--     its payer and cursor arguments cannot travel in a spec, so a write does not prime it and the
--     client refetches the pages it holds.
--   * kwenta_group_bill_row(p_group_id, p_uid, p_bill) is the ONE implementation of the bill row,
--     used by the detail and the page, so a row in either is jsonb-identical. It is applied AFTER
--     the limit / cursor, never before: it names the payer per bill, and 084 recorded what building
--     rows for the whole list and keeping a slice costs.
--   * kwenta_group_readable(p_group_id, p_uid) is the one membership gate: the group row as the
--     caller's pull delivers it, if the group is live and the caller is an ACTIVE member. A former
--     member must not read a group they left although the pull still delivers its rows (24). The
--     detail returns NULL for a miss, the page too, exactly as group detail did; no auth.uid() raises
--     'not authenticated' in both.
--   * Every bill still comes from kwenta_pull_rows_bills (051), never an inlined WHERE over bills.
--     The pull predicate runs once per call, in a materialised CTE shared by the page, the count
--     and the payer totals.
--
-- Authorization (rule 5)
--   * The three helpers name the acting user (`p_uid`): they are SECURITY DEFINER, service_role
--     only, and the migration ends with kwenta_revoke_acting_user_helpers(), which closes them like
--     every other helper that names its caller. As a second lock each RAISEs unless p_uid =
--     auth.uid() (and refuses a NULL auth.uid()), so even a role that holds EXECUTE cannot read as
--     someone else.
--   * kwenta_group_detail_paged and kwenta_group_bills_page derive the viewer from auth.uid(),
--     are SECURITY DEFINER (they call the closed helpers) and are GRANTed to `authenticated` only
--     (REVOKE FROM PUBLIC, anon). The 073 / 079 suites name both in their allowlists. The 076
--     account gate is the pre-request hook, so an inactive account is refused whatever the mode.
--   * kwenta_read and kwenta_read_is_allowed are restated whole (CREATE OR REPLACE keeps their
--     grants) with one new name, kwenta_group_detail_paged, which takes no viewer argument.
--     kwenta_write is not restated: it reads the whitelist through kwenta_read_is_allowed.
--   * The DROP of kwenta_group_detail(uuid, integer) below is defensive: nothing in
--     supabase/migrations ever created that overload (an early plan of this migration did, and only
--     a hand-applied draft could hold it). A database that has it would make an installed app's
--     one-argument call ambiguous (PostgREST PGRST203), so it goes before anything is created.

DROP FUNCTION IF EXISTS public.kwenta_group_detail(uuid, integer);

/**
 * The group row as the caller's pull delivers it, only when the group is live and the caller is an
 * active member. Empty otherwise. Shared by the detail and the bill page so there is one gate.
 */
CREATE OR REPLACE FUNCTION public.kwenta_group_readable(p_group_id uuid, p_uid uuid)
RETURNS SETOF public.groups
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  RETURN QUERY
  SELECT g.*
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, p_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE
    AND EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.user_id = p_uid AND gm.is_deleted IS FALSE
    );
END;
$$;


/**
 * One group bill as the group screens list it. Applied to the bills a screen returns, after any
 * limit or cursor, never to the whole list first.
 */
CREATE OR REPLACE FUNCTION public.kwenta_group_bill_row(p_group_id uuid, p_uid uuid, p_bill public.bills)
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
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  RETURN jsonb_build_object(
    'id',          p_bill.id,
    'title',       p_bill.title,
    'note',        p_bill.note,
    'currency',    p_bill.currency,
    'totalAmount', p_bill.total_amount,
    'createdAt',   p_bill.created_at,
    'createdBy',   p_bill.created_by,
    'paidBy',      p_bill.paid_by,
    'groupId',     p_bill.group_id,
    'category',    p_bill.category,
    'originalCurrency', p_bill.original_currency,
    'originalTotal',    p_bill.original_total,
    'exchangeRate',     p_bill.exchange_rate,
    'payorName',   public.kwenta_bill_participant_name(p_group_id, p_uid, p_bill.paid_by)
  );
END;
$$;


/**
 * Group detail, 083's body. p_bill_limit NULL = every bill and no count keys (the pre-085 payload);
 * a number = that many newest bills plus billCount / billPayers over every live bill.
 */
CREATE OR REPLACE FUNCTION public.kwenta_group_detail_build(
  p_group_id    uuid,
  p_uid         uuid,
  p_bill_limit  integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := p_uid;
  v_group public.groups%ROWTYPE;
  v_members jsonb;
  v_bills jsonb;
  v_bill_count integer;
  v_bill_payers jsonb;
  v_pairwise jsonb;
  v_to_receive numeric := 0;
  v_to_pay numeric := 0;
  v_member_balances jsonb;
  v_raw_debts jsonb;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  SELECT * INTO v_group FROM public.kwenta_group_readable(p_group_id, v_uid);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',            m.id,
      'userId',        m.user_id,
      'profileName',   COALESCE(NULLIF(BTRIM(p.display_name), ''), NULLIF(BTRIM(m.display_name), ''), 'Unknown'),
      'isCurrentUser', m.user_id = v_uid
    ) ORDER BY (m.user_id = v_uid) DESC, m.joined_at, m.id
  ), '[]'::jsonb)
  INTO v_members
  FROM public.group_members m
  LEFT JOIN public.kwenta_pull_rows_profiles('epoch'::timestamptz, v_uid) p ON p.id = m.user_id
  WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE;

  WITH
  live AS MATERIALIZED (
    SELECT b AS bill
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
  ),
  page AS (
    SELECT l.bill
    FROM live l
    ORDER BY (l.bill).created_at DESC, (l.bill).id
    LIMIT p_bill_limit
  ),
  payers AS (
    SELECT (l.bill).paid_by AS user_id, count(*)::integer AS n
    FROM live l
    WHERE (l.bill).paid_by IS NOT NULL
    GROUP BY (l.bill).paid_by
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(
       public.kwenta_group_bill_row(p_group_id, v_uid, pg.bill)
       ORDER BY (pg.bill).created_at DESC, (pg.bill).id
     ), '[]'::jsonb) FROM page pg),
    (SELECT count(*)::integer FROM live),
    (SELECT COALESCE(jsonb_agg(
       jsonb_build_object('userId', py.user_id, 'count', py.n) ORDER BY py.n DESC, py.user_id
     ), '[]'::jsonb) FROM payers py)
  INTO v_bills, v_bill_count, v_bill_payers;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'memberUserId', gp.member_user_id,
      'displayName',  gp.display_name,
      'net',          gp.net
    ) ORDER BY gp.display_name, gp.member_user_id), '[]'::jsonb),
    COALESCE(SUM(GREATEST(gp.net, 0)), 0),
    COALESCE(SUM(GREATEST(-gp.net, 0)), 0)
  INTO v_pairwise, v_to_receive, v_to_pay
  FROM public.kwenta_group_pairwise(p_group_id, v_uid) gp;

  -- Net against the group pool: credited for what you fronted, debited for your own shares.
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  sp AS (
    SELECT gb.paid_by, s.user_id, s.computed_amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL
  ),
  gs AS (
    SELECT s.* FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  ),
  deltas AS (
    SELECT sp.paid_by AS uid,  sp.computed_amount AS delta FROM sp
    UNION ALL
    SELECT sp.user_id AS uid, -sp.computed_amount        FROM sp
    UNION ALL
    -- Paying someone reduces what you owe the pool; receiving increases it.
    SELECT gs.from_user_id, gs.amount FROM gs
    UNION ALL
    SELECT gs.to_user_id, -gs.amount FROM gs
    UNION ALL
    -- Active members appear at zero: "settled" is a real answer the roster has to show.
    SELECT m.user_id, 0 FROM public.group_members m
    WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId',      t.uid,
    'displayName', public.kwenta_bill_participant_name(p_group_id, v_uid, t.uid),
    'amount',      t.amount
  ) ORDER BY t.amount DESC, t.uid), '[]'::jsonb)
  INTO v_member_balances
  FROM (
    SELECT d.uid, public.kwenta_round_money(SUM(d.delta)) AS amount
    FROM deltas d
    WHERE d.uid IS NOT NULL
    GROUP BY d.uid
  ) t;

  -- The directed debt graph the client decomposes into transfers, netted per unordered pair of
  -- literal ids in integer cents (083). A split is a debt from the splitter to the payer; a settled
  -- payment is a debt in the OPPOSITE direction and cancels against it. Zero nets are dropped; the
  -- edge runs debtor -> creditor.
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  bill_debts AS (
    SELECT s.user_id AS from_id, gb.paid_by AS to_id, ROUND(s.computed_amount * 100)::bigint AS cents
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL AND s.user_id <> gb.paid_by
  ),
  settlement_debts AS (
    SELECT s.to_user_id AS from_id, s.from_user_id AS to_id, ROUND(s.amount * 100)::bigint AS cents
    FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  ),
  signed AS (
    SELECT LEAST(d.from_id, d.to_id) AS a,
           GREATEST(d.from_id, d.to_id) AS b,
           CASE WHEN d.from_id < d.to_id THEN d.cents ELSE -d.cents END AS cents
    FROM (
      SELECT * FROM bill_debts
      UNION ALL
      SELECT * FROM settlement_debts
    ) d
    WHERE d.from_id <> d.to_id
  ),
  pair_net AS (
    SELECT sg.a, sg.b, SUM(sg.cents) AS net
    FROM signed sg
    GROUP BY sg.a, sg.b
    HAVING SUM(sg.cents) <> 0
  ),
  edges AS (
    SELECT CASE WHEN pn.net > 0 THEN pn.a ELSE pn.b END AS from_id,
           CASE WHEN pn.net > 0 THEN pn.b ELSE pn.a END AS to_id,
           ABS(pn.net) AS cents
    FROM pair_net pn
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'from', e.from_id, 'to', e.to_id, 'amount', ROUND(e.cents::numeric / 100, 2)
  ) ORDER BY e.from_id, e.to_id), '[]'::jsonb)
  INTO v_raw_debts
  FROM edges e;

  v_result := jsonb_build_object(
    'group', jsonb_build_object(
      'id',         v_group.id,
      'name',       v_group.name,
      'currency',   v_group.currency,
      'createdBy',  v_group.created_by,
      'inviteCode', v_group.invite_code,
      'updatedAt',  v_group.updated_at
    ),
    'members',        v_members,
    'bills',          v_bills,
    'pairwise',       v_pairwise,
    'totalToReceive', public.kwenta_round_money(v_to_receive),
    'totalToPay',     public.kwenta_round_money(v_to_pay),
    'memberBalances', v_member_balances,
    'rawDebts',       v_raw_debts
  );

  IF p_bill_limit IS NOT NULL THEN
    v_result := v_result || jsonb_build_object('billCount', v_bill_count, 'billPayers', v_bill_payers);
  END IF;

  RETURN v_result;
END;
$$;


-- Same signature and grants as 079 / 083 (CREATE OR REPLACE keeps them); only the body moved.
CREATE OR REPLACE FUNCTION public.kwenta_group_detail(p_group_id uuid)
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

  RETURN public.kwenta_group_detail_build(p_group_id, auth.uid(), NULL);
END;
$$;


CREATE OR REPLACE FUNCTION public.kwenta_group_detail_paged(p_group_id uuid, p_limit integer DEFAULT 20)
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

  RETURN public.kwenta_group_detail_build(
    p_group_id, auth.uid(), LEAST(GREATEST(COALESCE(p_limit, 20), 1), 500)
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.kwenta_group_bills_page(
  p_group_id uuid,
  p_limit    integer DEFAULT 20,
  p_payer    uuid DEFAULT NULL,
  p_after    jsonb DEFAULT NULL
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
  v_has_after boolean := p_after IS NOT NULL;
  v_after_id uuid;
  v_after_created_at timestamptz;
  v_rows jsonb;
  v_matching integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.kwenta_group_readable(p_group_id, v_uid)) THEN
    RETURN NULL;
  END IF;

  IF v_has_after THEN
    IF jsonb_typeof(p_after) <> 'object' OR NOT (p_after ? 'id') OR NOT (p_after ? 'createdAt') THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
    v_after_id := (p_after ->> 'id')::uuid;
    v_after_created_at := (p_after ->> 'createdAt')::timestamptz;
    IF v_after_id IS NULL OR v_after_created_at IS NULL THEN
      RAISE EXCEPTION 'malformed cursor';
    END IF;
  END IF;

  WITH
  live AS MATERIALIZED (
    SELECT b AS bill
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (p_payer IS NULL OR b.paid_by = p_payer)
  ),
  page AS (
    SELECT l.bill
    FROM live l
    WHERE NOT v_has_after
       OR (l.bill).created_at < v_after_created_at
       OR ((l.bill).created_at = v_after_created_at AND (l.bill).id > v_after_id)
    ORDER BY (l.bill).created_at DESC, (l.bill).id
    LIMIT v_limit
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(
       public.kwenta_group_bill_row(p_group_id, v_uid, pg.bill)
       ORDER BY (pg.bill).created_at DESC, (pg.bill).id
     ), '[]'::jsonb) FROM page pg),
    (SELECT count(*)::integer FROM live)
  INTO v_rows, v_matching;

  RETURN jsonb_build_object('rows', v_rows, 'matching', v_matching);
END;
$$;


REVOKE ALL ON FUNCTION public.kwenta_group_detail_paged(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_group_bills_page(uuid, integer, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_group_detail_paged(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_bills_page(uuid, integer, uuid, jsonb) TO authenticated;


-- kwenta_read: 066's body plus the paged group detail, dispatched with the spec's limit.
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
    'kwenta_bill_settlement_history',
    'kwenta_group_settlement_history',
    'kwenta_person_settlement_history',
    'kwenta_group_spending'
  );
$$;

-- Last, so it also covers the three helpers this migration created (they name p_uid).
SELECT public.kwenta_revoke_acting_user_helpers();
