-- 060_bill_detail.sql
--
-- The Bill detail screen in one call.
--
-- APPLY AFTER 059 and BEFORE the BillDetailPage code that calls `kwenta_bill_detail`.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REPLACES
--
-- `getBillWithDetails` (src/db/operations.ts:2294) plus, on the same screen, a per-participant
-- loop that called `computePairwiseNetForBill` AND `computePairwiseNetAllContexts` for every
-- other person on the bill. The second of those computes a whole person-level tab across every
-- shared group — once per participant, to decide whether one line reads "settled".
--
-- THE PER-ITEM FIRST-MATCH RULE. `kwenta_bill_pairwise` takes at most ONE split per side per
-- item, exactly like `computePairwiseNetForBill` (src/lib/people.ts:305-306, and rule 2 of the
-- 052 header). Under identity expansion a single person can hold two ids on one item — a local
-- contact and the account it was later linked to — and summing both would charge them twice.
-- The group ledger sums instead, because it matches ids exactly and cannot see a duplicate.
--
-- SETTLED IS A PROPERTY OF THE PERSON, NOT THE BILL. `squareOverall` asks the combined tab
-- (kwenta_pairwise_breakdown), scoped to THIS bill's currency. Payments are never tagged to a
-- bill, so a per-bill net can never go to zero on its own; the tab is what actually moves. The
-- currency scope stops an unrelated balance in another currency from flipping the line.
--
-- NAME RESOLUTION goes through this bill's own group roster first, then the general resolver.
-- A co-member's local contact row is not on this device by design (CLAUDE.md rule 6), so the
-- roster is the only place some names exist.
--
-- NOT INCLUDED: the bill's settlement HISTORY list. Those rows drive an edit dialog and carry
-- their own leg ids; they are records the viewer already holds, not derived money, so they stay
-- on the local mirror for now.
-- ---------------------------------------------------------------------------

/**
 * A participant's name on one bill.
 *
 * The bill's OWN group roster wins, then the general resolver (054), then 'Unknown'. Roster-first
 * matters because a co-member's local contact row is never sent to this device (CLAUDE.md rule 6)
 * — for those people `group_members.display_name` is the only name that exists, and it is also
 * the name every other member of that group sees.
 *
 * Deleted roster rows count: a member who was removed still has to render their name rather than
 * "Unknown" on the bills they were part of.
 */
CREATE OR REPLACE FUNCTION public.kwenta_bill_participant_name(
  p_group_id uuid,
  p_viewer   uuid,
  p_user_id  uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(BTRIM(gm.display_name), '')
       FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id
        AND NULLIF(BTRIM(gm.display_name), '') IS NOT NULL
      ORDER BY gm.is_deleted, gm.id
      LIMIT 1),
    NULLIF(public.kwenta_peer_display_name(p_viewer, p_user_id), 'Unknown'),
    'Unknown'
  );
$$;

/**
 * Viewer-perspective net contributed by ONE bill with ONE other person.
 * `+` they owe the viewer, `-` the viewer owes them.
 *
 * Port of computePairwiseNetForBill (src/lib/people.ts:289).
 */
CREATE OR REPLACE FUNCTION public.kwenta_bill_pairwise(
  p_bill_id uuid,
  p_viewer  uuid,
  p_other   uuid
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  b AS (
    SELECT * FROM public.bills WHERE id = p_bill_id AND is_deleted IS FALSE
  ),
  me    AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  other AS (SELECT id FROM public.kwenta_expand_identity(p_other,  p_viewer)),
  items AS (
    SELECT bi.id FROM public.bill_items bi, b
    WHERE bi.bill_id = p_bill_id AND bi.is_deleted IS FALSE
  ),
  -- At most one split per side per item. `MIN(id)` picks a stable one; which one does not
  -- matter for the amount, only that a duplicate identity is not counted twice.
  per_item AS (
    SELECT
      i.id AS item_id,
      (SELECT sp.computed_amount FROM public.item_splits sp
        WHERE sp.item_id = i.id AND sp.is_deleted IS FALSE
          AND sp.user_id IN (SELECT id FROM me)
        ORDER BY sp.id LIMIT 1) AS my_amount,
      (SELECT sp.computed_amount FROM public.item_splits sp
        WHERE sp.item_id = i.id AND sp.is_deleted IS FALSE
          AND sp.user_id IN (SELECT id FROM other)
        ORDER BY sp.id LIMIT 1) AS other_amount
    FROM items i
  ),
  bill_delta AS (
    SELECT COALESCE(SUM(
      CASE
        WHEN (SELECT paid_by FROM b) IN (SELECT id FROM me)    THEN COALESCE(pi.other_amount, 0)
        WHEN (SELECT paid_by FROM b) IN (SELECT id FROM other) THEN -COALESCE(pi.my_amount, 0)
        ELSE 0
      END
    ), 0) AS v
    FROM per_item pi
  ),
  settlement_delta AS (
    SELECT COALESCE(SUM(
      CASE
        WHEN s.from_user_id IN (SELECT id FROM me) AND s.to_user_id IN (SELECT id FROM other)
          THEN s.amount
        WHEN s.from_user_id IN (SELECT id FROM other) AND s.to_user_id IN (SELECT id FROM me)
          THEN -s.amount
        ELSE 0
      END
    ), 0) AS v
    FROM public.settlements s, b
    WHERE s.bill_id = p_bill_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
  )
  SELECT public.kwenta_round_money(
    (SELECT v FROM bill_delta) + (SELECT v FROM settlement_delta)
  )
  FROM b;
$$;

/**
 * Everything the Bill detail screen renders, for the calling user.
 *
 * Returns NULL when the bill is not readable — the caller cannot distinguish "deleted" from
 * "not yours", which is the point.
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
  IF v_bill.group_id IS NULL THEN
    SELECT COALESCE(SUM(sp.computed_amount), 0) INTO v_my_split_total
    FROM public.item_splits sp
    JOIN public.bill_items bi ON bi.id = sp.item_id AND bi.is_deleted IS FALSE
    WHERE bi.bill_id = p_bill_id
      AND sp.is_deleted IS FALSE
      AND sp.user_id IN (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid));
  END IF;

  -- One row per other person on the bill, skipping anyone this bill nets to zero against.
  -- One row per PERSON, with the representative chosen the same way migration 059 chooses it for
  -- the Bills list: the viewer's own phonebook entry wins over the account it links to. Picking
  -- per-id instead of per-cluster made this screen call someone by their account name while the
  -- list two taps away called them by the name the viewer gave them.
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

REVOKE ALL ON FUNCTION public.kwenta_bill_participant_name(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_bill_pairwise(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_bill_detail(uuid) FROM PUBLIC;
-- kwenta_bill_pairwise takes the viewer as an ARGUMENT, so it stays server-internal: a
-- client-callable version would answer for any pair of users.
GRANT EXECUTE ON FUNCTION public.kwenta_bill_detail(uuid) TO authenticated;
