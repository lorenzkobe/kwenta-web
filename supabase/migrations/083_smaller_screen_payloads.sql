-- 083 — Smaller screen payloads: a netted `rawDebts`, and the Bills page one page at a time.
--
-- APPLY BEFORE THE CLIENT THAT CALLS kwenta_personal_bills_page SHIPS. Additive otherwise.
-- * kwenta_personal_bills_page is new. The Bills page of the client that ships with this migration
--   calls it and nothing else, so against a pre-083 server that page cannot load (PostgREST answers
--   "function not found"; online the page shows its unavailable message, with no fallback to the
--   full list). Apply the migration first.
-- * kwenta_group_detail keeps its shape: only the CONTENT of `rawDebts` shrinks. The client that
--   ships with this migration still works against a pre-083 server for group detail (it just
--   receives the long list and `buildDebtGraph` nets it as it always did), and an older installed
--   build works against this server (it nets an already-netted list, a no-op).
-- * kwenta_personal_bills is NOT touched. Installed PWAs keep their build until the user taps
--   Refresh, and Export on the new client fetches the whole list through it on tap.
--
-- What was wrong (sizes measured live from the browser console)
-- Group detail for a 59-bill, 8-member group (Siquijor) was 80.8 kB, and 48.9 kB of that was
-- `rawDebts`: one `{from, to, amount}` per split row plus one per settled payment, roughly
-- bills x members edges, so it grew with every bill. The only consumer is
-- `buildSuggestedPayers` -> `buildDebtGraph` (src/lib/settlement-suggestions.ts), which nets the
-- edges per unordered pair in integer cents and throws the rest away. The Bills page (every
-- personal bill, ~109 own + ~60 shared, 90.8 kB) downloaded all of them to show ten and filtered,
-- sorted and counted the list in the browser.
--
-- rawDebts, netted
-- The server now does what `buildDebtGraph` did: for each unordered pair of LITERAL user ids it
-- sums the signed edges in integer cents (a split is a debt from the splitter to the payer; a
-- settled payment is a debt in the opposite direction and cancels against it), drops a zero net,
-- and emits one `{from, to, amount}` from the debtor to the creditor, `amount` = cents / 100 at
-- scale 2. At most n(n-1)/2 edges, however many bills, so the Siquijor payload drops from 413+
-- edges to at most 28. The debt graph `buildDebtGraph` builds is identical (the same pair nets),
-- so every member's position is settled by the same amounts, and netting an already-netted list is
-- a no-op, which is also why an older client works against this endpoint. `buildSuggestedPayers`
-- is greedy and order-dependent: the specific transfers may differ from an old load only where
-- ties were broken by the old heap order, and are stable from now on (see the ORDER BY bullet).
--   * Ids stay literal (a legacy split filed under a local contact stays its own edge): identity
--     canonicalisation is the client's job, as it was, and doing it here would merge pairs the
--     client does not.
--   * Cents, not numeric amounts, are summed: ROUND(amount * 100) is exact for numeric(16,2), and
--     the SQL ROUND (half away from zero) is the rule 8 reference rather than JS Math.round.
--   * Edges come ORDER BY from, to. The old list followed heap order, so two loads of an unchanged
--     group could hand `buildSuggestedPayers` its ties in a different order and suggest a
--     different (equally valid) set of transfers; now they are stable.
--   * Every filter of 079 is kept verbatim: foreign-currency bills and payments (other than the
--     group's currency) stay out, deleted rows stay out, only `is_settled` payments count, and the
--     payer's own share is never an edge. Every other key of the response is 079's body verbatim.
--
-- kwenta_personal_bills_page(p_bucket, p_limit, p_settled, p_category, p_sort, p_after)
-- One bucket of `kwenta_personal_bills()`, filtered, sorted and sliced on the server, plus the
-- counts the page needs: `{rows, matching, mine, shared, categories}`.
--   * It is built OVER kwenta_personal_bills() rather than beside it, so the row shape (participant
--     pills, payor name, settled flag, conversion keys) has exactly one implementation and a row
--     here is jsonb-identical to the same bill's row there. The cost is that the server still
--     builds the full row set once per call (the same CPU as the old endpoint); what shrinks is
--     the payload and the client's work.
--   * SECURITY INVOKER, no viewer argument. kwenta_personal_bills() is SECURITY DEFINER and reads
--     auth.uid() itself, so this wrapper adds no authority and names no caller: it needs no
--     service_role-only helper, and (rule 5) there is nothing for the acting-user sweep to close.
--     An unauthenticated call raises 'not authenticated' from the inner function.
--   * GRANTed to `authenticated` only. Since 073 a new function is closed by default; the 073
--     suite's allowlist names this one on purpose.
--   * Arguments are validated, never spliced into SQL: bucket in ('mine','shared'), settled in
--     ('all','settled','unsettled'), sort in ('date_desc','date_asc','title_asc','title_desc');
--     anything else raises. `p_limit` is clamped to 1..500 (NULL = 20, the page size). A NULL
--     `p_settled` / `p_sort` mean the defaults ('all' / 'date_desc'); a NULL `p_category` means
--     every category. The filters run BEFORE the limit and `matching` counts the whole filtered
--     set, with or without a cursor.
--   * `mine` and `shared` are the unfiltered bucket totals whichever bucket was asked for, and
--     `categories` are the distinct non-empty categories of MINE, sorted, so the filter chips do
--     not depend on the page or on the filter.
--   * Sort ties are fixed so a position in the order is unambiguous: date_desc = created_at DESC,
--     id ASC (kwenta_personal_bills() orders `created_at DESC, id`); date_asc = created_at ASC,
--     id ASC; title_asc / title_desc order on lower(title) with ties newest first, id ASC.
--     lower() follows the database collation, so accented titles may order differently from the
--     browser's localeCompare, which the old client-side sort used (accepted).
--   * Paging is KEYSET. `p_after` is the last loaded row's `{id, createdAt, title}`; the call
--     returns the next `p_limit` rows strictly AFTER that position in the chosen order. The
--     position is compared on the key VALUES in `p_after` (created_at, lower(title), id), never by
--     looking the id up, so a cursor row that was deleted or edited since still continues
--     correctly. A bill added or removed between two taps cannot shift a page, so no row repeats
--     or is skipped, and the walk reaches the last row however many bills there are: the 500
--     clamp bounds ONE call, not the list (growing the limit would have stranded every bill past
--     500 and re-sent all loaded rows on each tap). `p_after` must be a JSON object with a uuid
--     `id` and a timestamp `createdAt` (and a `title` key for the title sorts); anything else
--     raises. NULL = the first page.
--   * The migration first drops the five-argument draft signature, so a database that ever held it
--     does not keep two overloads that make PostgREST's first-page call (no `p_after`) ambiguous.
--   * It is not primed by a write: `kwenta_write` hands rows to kwenta_read, which dispatches only
--     `fn`, `id` and `limit` (081), so a call with filter arguments cannot be named there. The
--     page refetches after a write (the pages it holds, from the first cursor on).

CREATE OR REPLACE FUNCTION public.kwenta_group_detail(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group public.groups%ROWTYPE;
  v_members jsonb;
  v_bills jsonb;
  v_pairwise jsonb;
  v_to_receive numeric := 0;
  v_to_pay numeric := 0;
  v_member_balances jsonb;
  v_raw_debts jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_group
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A former member must not read a group they have left. The pull bundle still delivers the
  -- rows (24: deletion events have to reach former members), so absence from the bundle is not
  -- the check — active membership is.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_uid AND gm.is_deleted IS FALSE
  ) THEN
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

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',          b.id,
      'title',       b.title,
      'note',        b.note,
      'currency',    b.currency,
      'totalAmount', b.total_amount,
      'createdAt',   b.created_at,
      'createdBy',   b.created_by,
      'paidBy',      b.paid_by,
      'groupId',     b.group_id,
      'category',    b.category,
      'originalCurrency', b.original_currency,
      'originalTotal',    b.original_total,
      'exchangeRate',     b.exchange_rate,
      'payorName',   public.kwenta_bill_participant_name(p_group_id, v_uid, b.paid_by)
    ) ORDER BY b.created_at DESC, b.id
  ), '[]'::jsonb)
  INTO v_bills
  FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
  WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE;

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

  RETURN jsonb_build_object(
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
END;
$$;


DROP FUNCTION IF EXISTS public.kwenta_personal_bills_page(text, integer, text, text, text);

CREATE OR REPLACE FUNCTION public.kwenta_personal_bills_page(
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

  v_all := public.kwenta_personal_bills();

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


REVOKE ALL ON FUNCTION public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb) TO authenticated;
