-- ===========================================================================
-- 065 — Four defects found reviewing the 051–064 read migration.
--
-- 1. THE SHARED BUCKET HAD NO PAYER NAME.
--    `kwenta_personal_bills` resolved `payorName` by LEFT JOINing
--    `kwenta_pull_rows_profiles`, which by design never contains another user's
--    account row (see the pull-bundle note in CLAUDE.md). So every bill in the
--    "shared with me" bucket — the bucket that exists precisely because someone
--    ELSE paid — rendered "Paid by Someone". Worse, the participant pill on the
--    same row uses `kwenta_peer_display_name` and DID resolve, so one row showed
--    "Bob" as a pill and "Paid by Someone" beside it. The deleted client code
--    did `db.profiles.get(paid_by)` and, on a miss, fetched the profile over RPC
--    029, so it showed the name. Now both sides of the row go through
--    `kwenta_peer_display_name`, which has the group-roster fallback rule 6
--    requires. That function is SECURITY DEFINER and reads `profiles` unscoped,
--    which is safe here and no wider than the pill already was: the payer of a
--    bill in YOUR bucket is someone you demonstrably share a bill with, and the
--    function is not granted to `authenticated`.
--
-- 2. THE PER-BILL SETTLED FLAG WAS AN N+1 OVER THE WHOLE RELATIONSHIP.
--    `kwenta_bill_settled(bill, viewer)` loops the bill's participants and calls
--    `kwenta_pairwise_breakdown` for each, and `kwenta_personal_bills` called it
--    once per bill. `kwenta_pairwise_breakdown` scans every non-deleted personal
--    bill, its items, its splits and its settlements, plus `kwenta_group_pairwise`
--    for every shared group — so a user with 200 bills across 10 counterparties
--    triggered ~200 full-relationship aggregations for ONE list call instead of
--    10. The TypeScript this replaced took a `settledTabCache` that the page
--    built once per render for exactly this reason; the port dropped the memo.
--    `kwenta_bills_settled_map` restores it set-wise: one breakdown per DISTINCT
--    counterparty for the entire list, then the per-bill flag is a join.
--    `kwenta_bill_settled` is kept and unchanged — it is the single-bill answer
--    and `kwenta_bill_settled_for_me` is its client surface.
--
-- 3. A BILL YOU ARE NOT ON REPORTED "Your share 0.00".
--    `kwenta_bill_detail` computed `mySplitTotal` with `COALESCE(SUM(...), 0)`,
--    which cannot distinguish "no matching split rows" from "shares summing to
--    zero". The deleted client tracked an `included` flag and returned null, so
--    the header omitted the line. A personal bill the viewer split entirely
--    between two other people now returns NULL again. `0` remains reachable and
--    still renders — a real zero share is a different fact from not being on the
--    bill.
--
-- 4. THE STATEMENT CARRIED NO CATEGORY.
--    `kwenta_person_statement` events had no `category`, so the Person export's
--    Category column was rendered and then always filled with an empty string.
--    Added to bill events only; a payment has no category and keeps NULL.
--    Additive key — an older client ignores it, and the client maps a missing
--    key to null, which is exactly how it renders an uncategorised bill.
--
-- Apply before shipping the client that reads `category` off a statement event.
-- Everything else here is behaviour-compatible in shape: same names, same
-- argument lists, same return types, so no DROP is required.
--
-- ---------------------------------------------------------------------------
-- 5. SECURITY — APPLY THIS MIGRATION AHEAD OF THE OTHERS.
--
--    `kwenta_build_pull_bundle(p_since, uid)` and the nine `kwenta_push_<table>
--    (arr, uid)` validators are SECURITY DEFINER and take the user they act for
--    as an ARGUMENT. That argument IS the authorization decision. They were
--    reachable by any signed-in client: the push validators are explicitly
--    granted to `authenticated` (044), and the bundle was never REVOKEd from
--    PUBLIC at all — Postgres grants EXECUTE to PUBLIC by default, so every
--    definition of it since 008 has been callable by anyone.
--
--    Reproduced against the SQL harness, attacker and victim sharing nothing:
--
--      SELECT kwenta_build_pull_bundle('epoch', '<victim uuid>');
--        -> the victim's profile row (email, display name, account_status),
--           their PRIVATE LOCAL CONTACTS, their groups by name, their group
--           memberships including other members' names, and their settlements
--           with amounts, counterparties and labels.
--
--      SELECT kwenta_push_bills('[{... "created_by": "<victim uuid>" ...}]',
--                               '<victim uuid>');
--        -> inserts a bill ATTRIBUTED TO THE VICTIM. Same for every other
--           push validator: forged group memberships, splits, settlements.
--
--    `bills`, `bill_items` and `item_splits` happened to be safe on the read
--    side because those clauses resolve the caller through `auth.uid()` and
--    ignore `uid` (see the note in 051) — which is precisely why the hole was
--    invisible: the tables anyone would think to check were the ones that were
--    fine.
--
--    The fix is the grant, not the bodies. `kwenta_sync` is the only intended
--    entry point, it is SECURITY DEFINER, and it calls these internally as the
--    function owner, so revoking them from `authenticated` changes nothing the
--    app does. The client never calls any of them directly (verified against
--    every `supabase.rpc(...)` call site in src/).
--
--    Pinned by a generic sweep in the 065 suite: no `kwenta_*` function that
--    names its caller in an argument may be executable by `authenticated`. That
--    catches the NEXT one someone adds, which prose in this header would not.
-- ===========================================================================

/**
 * Settled flags for a LIST of bills, computing each counterparty's tab once.
 *
 * Same rule as `kwenta_bill_settled` (056), evaluated set-wise: a bill is settled
 * when every other participant nets to zero against the viewer IN THAT BILL'S
 * CURRENCY, because payments are never tagged to a bill and the flag is really a
 * statement about the PERSON. Missing and deleted bills are settled.
 *
 * Reads base tables rather than `kwenta_pull_rows_*` for the same reason 056
 * does: it takes the bill ids AND the viewer as arguments and is server-internal,
 * so the caller has already scoped the ids it passes. It is not granted to
 * `authenticated` — a client-callable version would answer for any bill id.
 */
CREATE OR REPLACE FUNCTION public.kwenta_bills_settled_map(
  p_bill_ids uuid[],
  p_viewer uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  EPS AS (SELECT 0.005::numeric AS v),
  subject AS (
    SELECT b.id, b.currency, b.paid_by, b.is_deleted
    FROM public.bills b
    WHERE b.id = ANY(p_bill_ids)
  ),
  live AS (SELECT * FROM subject WHERE is_deleted IS FALSE),
  participants AS (
    SELECT l.id AS bill_id, l.paid_by AS uid
    FROM live l
    WHERE l.paid_by IS NOT NULL AND l.paid_by <> p_viewer
    UNION
    SELECT bi.bill_id, sp.user_id
    FROM public.bill_items bi
    JOIN live l ON l.id = bi.bill_id
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE bi.is_deleted IS FALSE
      AND sp.user_id IS NOT NULL
      AND sp.user_id <> p_viewer
  ),
  -- The whole point of this function. DISTINCT must be taken BEFORE the call, not
  -- in the same SELECT as it — `SELECT DISTINCT uid, f(uid)` evaluates f per input
  -- row and dedupes afterwards, which is the N+1 all over again. MATERIALIZED stops
  -- the planner inlining the call back into the join below.
  peers AS (SELECT DISTINCT p.uid FROM participants p),
  peer_totals AS MATERIALIZED (
    SELECT pe.uid,
           public.kwenta_pairwise_breakdown(p_viewer, pe.uid) -> 'total' AS totals
    FROM peers pe
  ),
  unsettled AS (
    SELECT DISTINCT p.bill_id
    FROM participants p
    JOIN peer_totals pt ON pt.uid = p.uid
    JOIN live l ON l.id = p.bill_id
    WHERE ABS(COALESCE((pt.totals ->> l.currency)::numeric, 0)) > (SELECT v FROM EPS)
  )
  SELECT COALESCE(
    jsonb_object_agg(
      s.id::text,
      s.is_deleted IS TRUE
        OR NOT EXISTS (SELECT 1 FROM unsettled u WHERE u.bill_id = s.id)
    ),
    '{}'::jsonb
  )
  FROM subject s;
$$;

/**
 * The Bills page in one call. See migration 059 for the bucketing rules; this
 * revision changes only the payer name and how the settled flag is obtained.
 */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bills()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_settled jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- One pass for the whole list, so each counterparty's cross-context tab is
  -- computed once rather than once per bill they appear on.
  SELECT public.kwenta_bills_settled_map(
           COALESCE(ARRAY(
             SELECT b.id
             FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
             WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
           ), ARRAY[]::uuid[]),
           v_uid)
  INTO v_settled;

  WITH
  me AS (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  visible_bills AS (
    SELECT b.*
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  ),
  active_items AS (
    SELECT bi.id, bi.bill_id
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
    WHERE bi.is_deleted IS FALSE
  ),
  active_splits AS (
    SELECT ai.bill_id, sp.user_id
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.is_deleted IS FALSE
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = v_uid THEN 'mine'
             WHEN EXISTS (
               SELECT 1 FROM active_splits s
               WHERE s.bill_id = vb.id AND s.user_id IN (SELECT id FROM me)
             ) THEN 'shared'
             ELSE NULL
           END AS bucket
    FROM visible_bills vb
  ),
  kept AS (SELECT * FROM bucketed WHERE bucket IS NOT NULL),
  participants AS (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  clustered AS (
    SELECT p.bill_id,
           p.uid,
           (SELECT MIN(e.id::text)::uuid FROM public.kwenta_expand_identity(p.uid, v_uid) e) AS cluster_key
    FROM participants p
  ),
  representative AS (
    SELECT c.bill_id,
           c.cluster_key,
           COALESCE(
             MIN(c.uid::text) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM public.profiles pr
                 WHERE pr.id = c.uid AND pr.is_deleted IS FALSE
                   AND pr.is_local IS TRUE AND pr.owner_id = v_uid
               )
             ),
             MIN(c.uid::text)
           )::uuid AS rep,
           bool_or(c.uid IN (SELECT id FROM me)) AS is_me
    FROM clustered c
    GROUP BY c.bill_id, c.cluster_key
  ),
  pills AS (
    SELECT r.bill_id,
           jsonb_agg(
             jsonb_build_object(
               'id',    r.rep,
               'label', CASE WHEN r.is_me THEN 'You'
                             ELSE public.kwenta_peer_display_name(v_uid, r.rep) END
             )
             ORDER BY r.is_me DESC,
                      CASE WHEN r.is_me THEN '' ELSE public.kwenta_peer_display_name(v_uid, r.rep) END,
                      r.rep
           ) AS pills
    FROM representative r
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
        -- Same resolver as the participant pill on this row, with rule 6's roster
        -- fallback. The old pull-rows join could not see another account's profile,
        -- so every shared-bucket row read "Paid by Someone" while the pill beside it
        -- said "Bob". The viewer's own bills keep naming the viewer, exactly as
        -- before — the participant PILL says "You", the payer line does not, and
        -- 059's suite pins that.
        'payorName',   CASE
                         WHEN k.paid_by IS NULL THEN 'Someone'
                         ELSE public.kwenta_peer_display_name(v_uid, k.paid_by)
                       END,
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     COALESCE((v_settled ->> k.id::text)::boolean, true),
        'category',    k.category,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC)
                        FROM rows WHERE bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC)
                        FROM rows WHERE bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

/**
 * The Bill detail screen. See migration 060; this revision changes only how
 * `mySplitTotal` distinguishes "not on this bill" from "a zero share".
 */
CREATE OR REPLACE FUNCTION public.kwenta_bill_detail(p_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  v_bill public.bills%ROWTYPE;
  v_group_name text;
  v_items jsonb;
  v_pairs jsonb := '[]'::jsonb;
  v_my_split_total numeric := NULL;
  r record;
  v_net numeric;
  v_tab numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_bill
  FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
  WHERE b.id = p_bill_id AND b.is_deleted IS FALSE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT g.name INTO v_group_name
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = v_bill.group_id AND g.is_deleted IS FALSE;

  SELECT COALESCE(jsonb_agg(t.item ORDER BY t.created_at, t.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      bi.id,
      bi.created_at,
      jsonb_build_object(
        'id',     bi.id,
        'name',   bi.name,
        'amount', bi.amount,
        'splits', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id',             sp.id,
              'userId',         sp.user_id,
              'displayName',    public.kwenta_bill_participant_name(v_bill.group_id, v_uid, sp.user_id),
              'splitType',      sp.split_type,
              'splitValue',     sp.split_value,
              'computedAmount', sp.computed_amount
            ) ORDER BY sp.id
          )
          FROM public.item_splits sp
          WHERE sp.item_id = bi.id AND sp.is_deleted IS FALSE
        ), '[]'::jsonb)
      ) AS item
    FROM public.bill_items bi
    WHERE bi.bill_id = p_bill_id AND bi.is_deleted IS FALSE
  ) t;

  -- Personal bills only: what the viewer's own share of this bill comes to. On a group bill the
  -- screen does not show it, and the old client returned null there.
  --
  -- SUM over zero rows is NULL, and that NULL is the answer: it means the viewer holds no split
  -- on this bill. COALESCE-ing it to 0 made a bill someone split entirely between two OTHER
  -- people render "Your share 0.00" on the payer's screen. A genuine zero share still comes back
  -- as 0 and still renders, because that is a different fact.
  IF v_bill.group_id IS NULL THEN
    SELECT SUM(sp.computed_amount) INTO v_my_split_total
    FROM public.item_splits sp
    JOIN public.bill_items bi ON bi.id = sp.item_id AND bi.is_deleted IS FALSE
    WHERE bi.bill_id = p_bill_id
      AND sp.is_deleted IS FALSE
      AND sp.user_id IN (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid));
  END IF;

  FOR r IN
    SELECT
      c.cluster_key,
      COALESCE(
        MIN(c.uid::text) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM public.profiles pr
            WHERE pr.id = c.uid AND pr.is_deleted IS FALSE
              AND pr.is_local IS TRUE AND pr.owner_id = v_uid
          )
        ),
        MIN(c.uid::text)
      )::uuid AS rep
    FROM (
      SELECT
        p.uid,
        (SELECT MIN(e.id::text)::uuid
           FROM public.kwenta_expand_identity(p.uid, v_uid) e) AS cluster_key
      FROM (
        SELECT v_bill.paid_by AS uid
        UNION
        SELECT sp.user_id
        FROM public.item_splits sp
        JOIN public.bill_items bi ON bi.id = sp.item_id AND bi.is_deleted IS FALSE
        WHERE bi.bill_id = p_bill_id AND sp.is_deleted IS FALSE
      ) p
      WHERE p.uid IS NOT NULL
        AND p.uid NOT IN (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid))
    ) c
    GROUP BY c.cluster_key
    ORDER BY c.cluster_key
  LOOP
    v_net := public.kwenta_bill_pairwise(p_bill_id, v_uid, r.rep);
    CONTINUE WHEN v_net IS NULL OR ABS(v_net) < EPS;

    v_tab := COALESCE(
      (public.kwenta_pairwise_breakdown(v_uid, r.rep) -> 'total' ->> v_bill.currency)::numeric,
      0);

    v_pairs := v_pairs || jsonb_build_array(jsonb_build_object(
      'otherId',       r.rep,
      'displayName',   public.kwenta_bill_participant_name(v_bill.group_id, v_uid, r.rep),
      'net',           v_net,
      'squareOverall', ABS(v_tab) <= EPS
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'bill', jsonb_build_object(
      'id',          v_bill.id,
      'title',       v_bill.title,
      'note',        v_bill.note,
      'currency',    v_bill.currency,
      'totalAmount', v_bill.total_amount,
      'createdAt',   v_bill.created_at,
      'createdBy',   v_bill.created_by,
      'paidBy',      v_bill.paid_by,
      'groupId',     v_bill.group_id,
      'category',    v_bill.category,
      'creatorName', public.kwenta_bill_participant_name(v_bill.group_id, v_uid, v_bill.created_by),
      'payorName',   public.kwenta_bill_participant_name(v_bill.group_id, v_uid, v_bill.paid_by)
    ),
    'groupName',    v_group_name,
    'items',        v_items,
    'mySplitTotal', v_my_split_total,
    'pairs',        v_pairs
  );
END;
$$;

/**
 * The Person statement's events. See migration 062; this revision adds only
 * `category` on bill events.
 */
CREATE OR REPLACE FUNCTION public.kwenta_person_statement(p_person_id uuid)
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

-- `kwenta_bills_settled_map` takes the viewer as an ARGUMENT, so it stays
-- server-internal: a client-callable version would answer for any bill id and
-- any viewer. Same rule as every other `p_viewer`-taking helper (051, 060).
REVOKE ALL ON FUNCTION public.kwenta_bills_settled_map(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_bills_settled_map(uuid[], uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Close the hole described in note 5. These take the acting user as an argument,
-- so a client that can call them can name any user. `kwenta_sync` reaches them
-- as the function owner and is unaffected.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.kwenta_build_pull_bundle(timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_build_pull_bundle(timestamptz, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_build_pull_bundle(timestamptz, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_push_profiles(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_groups(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bills(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.kwenta_push_profiles(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_groups(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_personal_bills() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_bill_detail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_person_statement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_bill_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_person_statement(uuid) TO authenticated;
