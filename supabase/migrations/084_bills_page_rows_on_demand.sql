-- 084 — The Bills page builds its rows on demand, for the page it returns.
--
-- ADDITIVE, NO SIGNATURE CHANGE. It can ship independently of the client: the response of every
-- endpoint here is jsonb-identical to what 079 / 083 returned, so an installed build and the new
-- one read the same payloads. (Apply order against 083 is the only constraint: this replaces
-- 083's kwenta_personal_bills_page and 079's kwenta_personal_bills.)
--
-- What was wrong
-- 083's kwenta_personal_bills_page was built OVER kwenta_personal_bills(): to hand the browser
-- twenty rows it built the whole list first, i.e. for EVERY personal bill the participant
-- representatives and identity clusters (kwenta_expand_identity per participant), every pill and
-- payer name (kwenta_peer_display_name per person), the item counts, and the settled flag from a
-- kwenta_bills_settled_map over all of them, then threw away everything but one slice of one
-- bucket. 083 said so in its header ("the server still builds the full row set once per call");
-- the payload shrank, the server cost did not, and a user with ~170 bills paid it on every open,
-- every filter tap and every "Show more".
--
-- The shape, and why
--   * The page pulls the caller's scoped rows ONCE, through kwenta_pull_rows_bills /
--     kwenta_pull_rows_bill_items / kwenta_pull_rows_item_splits exactly as 079's
--     kwenta_personal_bills does (rule: a read endpoint selects from the pull functions, never an
--     inlined WHERE over a base table), filters them as 079 does (live personal bills, the live
--     items of those bills, the live splits of those items) and hands the three arrays to two
--     helpers. The privacy-predicate passes per call stay at three, the same as 079's, and the
--     helpers read no bills / bill_items / item_splits table of their own, so there is no second
--     privacy decision to keep in step with the first.
--   * kwenta_personal_bill_index(p_uid, p_bills, p_items, p_splits) returns one row per listed
--     bill, `(id, bucket, created_at, title, category)`: the cheap columns every filter, sort,
--     count and keyset comparison needs. The bucket rule is 079's: 'mine' when the viewer created
--     it, else 'shared' when the viewer's identity holds a live split on it, else not listed.
--   * kwenta_personal_bill_rows(p_uid, p_bills, p_items, p_splits, p_ids, p_settled) builds the
--     079 row (participant pills, payer name, item count, settled flag, conversion keys) for the
--     bills named in p_ids only, and returns `(id, bucket, created_at, row)`. An id outside the
--     arrays, or a bill the viewer cannot list, builds nothing. `p_settled` is a
--     kwenta_bills_settled_map result; a bill absent from it reads settled, as in 079.
--   * kwenta_personal_bills() is now: pull -> index ids -> settled map -> rows for all of them ->
--     the same `{mine, shared}` aggregation (created_at DESC, id). The row shape has exactly ONE
--     implementation (the row builder), so the list, the page and Export cannot drift, and the
--     output is byte-identical to 079's.
--   * kwenta_personal_bills_page: pull -> index -> bucket totals, categories and the bucket's
--     (category-filtered) ids, created_at and titles from the index alone -> under a
--     settled / unsettled filter, the settled map over that filtered bucket (the filter needs
--     every candidate's flag) -> settled filter, sort and keyset on the index columns -> under
--     settled = 'all', the settled map over the page's ids only -> rows for the page's ids only.
--     The Bills page per open is one scoped pull, one index pass and the row builder for <= 20
--     bills, instead of the row builder for the whole list.
--
-- Why a subset settled map gives the same flags
-- kwenta_bills_settled_map (070) decides each bill on its own: a bill is unsettled when any of
-- its participants (payer and live-split users other than the viewer) has a non-zero overall tab
-- in the bill's currency, taken from kwenta_pairwise_breakdown_many over the DISTINCT
-- participants. A bill's flag therefore depends on its own participants' tabs and on nothing
-- about which other ids were asked for, so the map for 20 ids holds the same values the map for
-- the whole list holds for those 20. (kwenta_personal_bills() previously sent the map every
-- visible personal bill, including ones in no bucket; those never reach a row, so it now
-- asks for the bucketed ids only.) The 084 suite pins this against frozen copies of 079 and 083.
--
-- Authorization (rule 5)
--   * Both helpers take the acting user (`p_uid`) and consult identity, names and the settled map
--     FOR that user while the arrays are whatever the caller passes, so p_uid is an authorization
--     decision: they are SECURITY DEFINER, service_role only, and this migration ends with
--     kwenta_revoke_acting_user_helpers(), which closes them like every other helper that names
--     its caller. As a second lock, each RAISEs unless p_uid = auth.uid() (and refuses a NULL
--     auth.uid()), so even a role that holds EXECUTE cannot use them to read as someone else.
--   * kwenta_personal_bills_page is now SECURITY DEFINER over auth.uid() (it was SECURITY INVOKER
--     over a DEFINER function): it must call the service_role-only helpers and the pull
--     functions itself. It names no caller argument, still raises 'not authenticated' with no
--     auth.uid(), and stays GRANTed to `authenticated` only (restated below; the 073 allowlist
--     already names it). The 076 account gate is the pre-request hook, which runs for every
--     /rpc call whatever the function's security mode, so an inactive account is refused exactly
--     as before.
--
-- Unchanged: the page's argument validation (bucket / settled / sort / cursor), clamp (1..500,
-- NULL = 20), keyset order and tie rules (date_desc = created_at DESC, id; date_asc =
-- created_at ASC, id; title sorts on lower(title), ties newest first, id), the meaning of
-- `matching` (the whole filtered set, with or without a cursor) and of `mine` / `shared` /
-- `categories` (unfiltered bucket totals; the distinct non-empty categories of MINE).


/**
 * The viewer's listed personal bills, cheap columns only. The arrays are the caller's scoped
 * rows as kwenta_personal_bills filters them: live personal bills, live items of those bills,
 * live splits of those items. Reads no table of its own.
 */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bill_index(
  p_uid    uuid,
  p_bills  public.bills[],
  p_items  public.bill_items[],
  p_splits public.item_splits[]
)
RETURNS TABLE (id uuid, bucket text, created_at timestamptz, title text, category text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  RETURN QUERY
  WITH
  me AS MATERIALIZED (SELECT e.id FROM public.kwenta_expand_identity(p_uid, p_uid) e),
  active_items AS MATERIALIZED (
    SELECT bi.id, bi.bill_id
    FROM unnest(p_items) bi
    JOIN unnest(p_bills) vb ON vb.id = bi.bill_id
  ),
  -- Bills the viewer holds a live split on, once, rather than a scan of every split per bill.
  my_split_bills AS MATERIALIZED (
    SELECT DISTINCT ai.bill_id
    FROM unnest(p_splits) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.user_id IN (SELECT m.id FROM me m)
  )
  SELECT vb.id,
         CASE WHEN vb.created_by = p_uid THEN 'mine' ELSE 'shared' END,
         vb.created_at,
         vb.title,
         vb.category::text
  FROM unnest(p_bills) vb
  WHERE vb.created_by = p_uid
     OR vb.id IN (SELECT s.bill_id FROM my_split_bills s);
END;
$$;


/**
 * 079's list row for the bills named in p_ids: participant pills, payer name, item count, settled
 * flag (from p_settled, a kwenta_bills_settled_map result), category and conversion keys. The
 * arrays are the same ones the index takes. Reads no bills / bill_items / item_splits table.
 */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bill_rows(
  p_uid     uuid,
  p_bills   public.bills[],
  p_items   public.bill_items[],
  p_splits  public.item_splits[],
  p_ids     uuid[],
  p_settled jsonb
)
RETURNS TABLE (id uuid, bucket text, created_at timestamptz, "row" jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_uid must be the signed-in user';
  END IF;

  RETURN QUERY
  WITH
  me AS MATERIALIZED (SELECT e.id FROM public.kwenta_expand_identity(p_uid, p_uid) e),
  visible_bills AS MATERIALIZED (
    -- A semi-join: the list passes every id, and an array ANY would re-scan it once per bill.
    SELECT vb.* FROM unnest(p_bills) vb WHERE vb.id IN (SELECT x FROM unnest(p_ids) x)
  ),
  active_items AS MATERIALIZED (
    SELECT bi.id, bi.bill_id
    FROM unnest(p_items) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
  ),
  active_splits AS MATERIALIZED (
    SELECT ai.bill_id, sp.user_id
    FROM unnest(p_splits) sp
    JOIN active_items ai ON ai.id = sp.item_id
  ),
  my_split_bills AS MATERIALIZED (
    SELECT DISTINCT s.bill_id FROM active_splits s WHERE s.user_id IN (SELECT m.id FROM me m)
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = p_uid THEN 'mine'
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
    WHERE s.bill_id IN (SELECT k.id FROM kept k)
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
                     p_uid) e) AS cluster_key
    FROM (SELECT DISTINCT p.uid FROM participants p) u
  ),
  -- Own contact, else the person's live account, else the lowest id: another user's private
  -- contact must not name someone who has an account of their own (073).
  representative AS MATERIALIZED (
    SELECT p.bill_id,
           ck.cluster_key,
           COALESCE(
             MIN(p.uid::text) FILTER (
               WHERE pr.is_deleted IS FALSE AND pr.is_local IS TRUE AND pr.owner_id = p_uid
             ),
             -- The viewer's own pill reads "You" whatever represents it; its id stays as 071 chose.
             CASE WHEN NOT bool_or(p.uid IN (SELECT m.id FROM me m)) THEN MIN(acct.id::text) END,
             MIN(p.uid::text)
           )::uuid AS rep,
           bool_or(p.uid IN (SELECT m.id FROM me m)) AS is_me
    FROM participants p
    JOIN cluster_keys ck ON ck.uid = p.uid
    LEFT JOIN public.profiles pr ON pr.id = p.uid
    LEFT JOIN public.profiles acct
      ON acct.id = CASE WHEN pr.is_local IS TRUE THEN pr.linked_profile_id ELSE p.uid END
     AND acct.is_local IS FALSE
     AND acct.is_deleted IS FALSE
    GROUP BY p.bill_id, ck.cluster_key
  ),
  -- Every name these rows print, resolved once per id (pill labels, their sort key, payers).
  names AS MATERIALIZED (
    SELECT x.id, public.kwenta_peer_display_name(p_uid, x.id) AS name
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
  )
  SELECT
    k.id,
    k.bucket,
    k.created_at,
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
      'settled',     COALESCE((p_settled ->> k.id::text)::boolean, true),
      'category',    k.category,
      'originalCurrency', k.original_currency,
      'originalTotal',    k.original_total,
      'exchangeRate',     k.exchange_rate,
      'participants', COALESCE(pl.pills, '[]'::jsonb)
    )
  FROM kept k
  LEFT JOIN item_counts ic ON ic.bill_id = k.id
  LEFT JOIN pills pl ON pl.bill_id = k.id
  LEFT JOIN names pn ON pn.id = k.paid_by;
END;
$$;


/** Bills list: 079's output, with the row shape built by kwenta_personal_bill_rows. */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bills()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_bills public.bills[];
  v_items public.bill_items[];
  v_splits public.item_splits[];
  v_ids uuid[];
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
  v_items := ARRAY(
    SELECT bi
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    WHERE bi.is_deleted IS FALSE
      AND bi.bill_id IN (SELECT vb.id FROM unnest(v_bills) vb)
  );
  v_splits := ARRAY(
    SELECT sp
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    WHERE sp.is_deleted IS FALSE
      AND sp.item_id IN (SELECT vi.id FROM unnest(v_items) vi)
  );

  v_ids := ARRAY(SELECT i.id FROM public.kwenta_personal_bill_index(v_uid, v_bills, v_items, v_splits) i);

  -- One pass for the whole list, so each counterparty's cross-context tab is computed once.
  v_settled := public.kwenta_bills_settled_map(v_ids, v_uid);

  WITH built AS MATERIALIZED (
    SELECT r.id, r.bucket, r.created_at, r.row
    FROM public.kwenta_personal_bill_rows(v_uid, v_bills, v_items, v_splits, v_ids, v_settled) r
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(b.row ORDER BY b.created_at DESC, b.id)
                        FROM built b WHERE b.bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(b.row ORDER BY b.created_at DESC, b.id)
                        FROM built b WHERE b.bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


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
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_settled text := COALESCE(p_settled, 'all');
  v_sort text := COALESCE(p_sort, 'date_desc');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 500);
  v_has_after boolean := p_after IS NOT NULL;
  v_after_id uuid;
  v_after_created_at timestamptz;
  v_after_title text;
  v_bills public.bills[];
  v_items public.bill_items[];
  v_splits public.item_splits[];
  v_mine integer;
  v_shared integer;
  v_categories text[];
  v_cand_ids uuid[];
  v_cand_created timestamptz[];
  v_cand_titles text[];
  v_map jsonb;
  v_page_ids uuid[];
  v_matching integer;
  v_rows jsonb;
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

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- The caller's scoped rows, once, filtered as kwenta_personal_bills filters them.
  v_bills := ARRAY(
    SELECT b
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  );
  v_items := ARRAY(
    SELECT bi
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    WHERE bi.is_deleted IS FALSE
      AND bi.bill_id IN (SELECT vb.id FROM unnest(v_bills) vb)
  );
  v_splits := ARRAY(
    SELECT sp
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    WHERE sp.is_deleted IS FALSE
      AND sp.item_id IN (SELECT vi.id FROM unnest(v_items) vi)
  );

  -- Totals, chips and the candidate set from the index alone. The candidate arrays are aligned
  -- (same filter, same ORDER BY).
  SELECT count(*) FILTER (WHERE i.bucket = 'mine')::integer,
         count(*) FILTER (WHERE i.bucket = 'shared')::integer,
         array_agg(DISTINCT i.category ORDER BY i.category)
           FILTER (WHERE i.bucket = 'mine' AND COALESCE(i.category, '') <> ''),
         array_agg(i.id ORDER BY i.id)
           FILTER (WHERE i.bucket = p_bucket AND (p_category IS NULL OR i.category = p_category)),
         array_agg(i.created_at ORDER BY i.id)
           FILTER (WHERE i.bucket = p_bucket AND (p_category IS NULL OR i.category = p_category)),
         array_agg(i.title ORDER BY i.id)
           FILTER (WHERE i.bucket = p_bucket AND (p_category IS NULL OR i.category = p_category))
  INTO v_mine, v_shared, v_categories, v_cand_ids, v_cand_created, v_cand_titles
  FROM public.kwenta_personal_bill_index(v_uid, v_bills, v_items, v_splits) i;

  v_cand_ids := COALESCE(v_cand_ids, '{}');

  -- A settled / unsettled filter needs every candidate's flag, so the map covers the filtered bucket.
  IF v_settled <> 'all' THEN
    v_map := public.kwenta_bills_settled_map(v_cand_ids, v_uid);
  END IF;

  WITH filtered AS (
    SELECT u.id,
           u.created_at,
           lower(COALESCE(u.title, '')) AS ltitle
    FROM unnest(v_cand_ids, v_cand_created, v_cand_titles) u(id, created_at, title)
    WHERE v_settled = 'all'
       OR COALESCE((v_map ->> u.id::text)::boolean, true) = (v_settled = 'settled')
  ),
  total AS (SELECT count(*)::integer AS n FROM filtered),
  ordered AS (
    SELECT f.id,
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
  SELECT COALESCE(array_agg(o.id ORDER BY o.rn) FILTER (WHERE o.rn <= v_limit), '{}'),
         (SELECT t.n FROM total t)
  INTO v_page_ids, v_matching
  FROM ordered o;

  -- Settled = 'all': the flags are only printed, so only the page's bills need one.
  IF v_settled = 'all' THEN
    v_map := public.kwenta_bills_settled_map(v_page_ids, v_uid);
  END IF;

  SELECT COALESCE(jsonb_agg(r.row ORDER BY array_position(v_page_ids, r.id)), '[]'::jsonb)
  INTO v_rows
  FROM public.kwenta_personal_bill_rows(v_uid, v_bills, v_items, v_splits, v_page_ids, v_map) r;

  RETURN jsonb_build_object(
    'rows',       v_rows,
    'matching',   v_matching,
    'mine',       v_mine,
    'shared',     v_shared,
    'categories', to_jsonb(COALESCE(v_categories, '{}'::text[]))
  );
END;
$$;


REVOKE ALL ON FUNCTION public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills_page(text, integer, text, text, text, jsonb) TO authenticated;

-- Last, so it also covers the two helpers this migration created (they name p_uid).
SELECT public.kwenta_revoke_acting_user_helpers();
