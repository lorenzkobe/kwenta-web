-- 059_list_pages.sql
--
-- The Bills list and the Groups list, server-side.
--
-- APPLY AFTER 058 and BEFORE the BillsPage / GroupsPage code that calls these.
--
-- ---------------------------------------------------------------------------
-- WHAT THESE REPLACE
--
-- Both lists were computed by scanning the local mirror. The Bills list was the worst offender
-- in the app: for every personal bill it re-read that bill's items, resolved each participant's
-- display name, and asked `isPersonalBillFullySettled` — which itself computes the PERSON-level
-- tab. The settled flag already moved to SQL in 056; this brings the rest of the row with it so
-- the list is one round trip instead of a fan-out that grows with the bill count.
--
-- TWO DELIBERATE DIFFERENCES FROM THE TYPESCRIPT THEY REPLACE. Both are stated here because a
-- future reader diffing the two implementations will otherwise read them as porting mistakes.
--
-- 1. PARTICIPANT REPRESENTATIVE. `dedupeParticipantIds` (src/lib/people.ts:787) picks the first
--    id in *input order*, then overrides it with the first cluster member that is one of the
--    viewer's own local contacts. Input order is Dexie iteration order — not a defined thing to
--    reproduce, and not stable across devices. Here the representative is the viewer's own local
--    contact with the lowest id, else the lowest id in the cluster. Deterministic, and identical
--    to the TS result in every case where the TS result was itself well-defined (at most one
--    owned local contact per cluster is the normal shape).
--
-- 2. THE "SHARED WITH ME" BUCKET matches the viewer's whole identity, not their literal account
--    id. The TS reads `item_splits.where('user_id').equals(currentUserId)`, so a split still
--    filed under a contact that was later linked to the viewer's account was invisible to them.
--    That is the same class of miss 049 fixed on the pull side, and the same fix applies.
--
-- Neither list carries a per-row "pending" flag any more. Whether a write is still queued is a
-- fact about THIS DEVICE, and the server cannot know it — the client merges its own unsent ids
-- in (CLAUDE.md rule 8: a queued write shows an explicit unsent state rather than a silently
-- stale number).
-- ---------------------------------------------------------------------------

/**
 * Every group the caller is an active member of, with their own standing in it.
 *
 * `totalToReceive` / `totalToPay` are the same quantities the Groups list showed:
 * the sum of positive and of |negative| per-member nets, in the group's own currency.
 */
CREATE OR REPLACE FUNCTION public.kwenta_groups_with_balances()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'groupId',        t.group_id,
      'name',           t.name,
      'currency',       t.currency,
      'memberCount',    t.member_count,
      'updatedAt',      t.updated_at,
      'totalToReceive', public.kwenta_round_money(t.to_receive),
      'totalToPay',     public.kwenta_round_money(t.to_pay)
    ) ORDER BY t.name, t.group_id
  ), '[]'::jsonb)
  FROM (
    SELECT
      g.id AS group_id,
      g.name,
      g.currency,
      g.updated_at,
      (SELECT COUNT(*) FROM public.group_members m
        WHERE m.group_id = g.id AND m.is_deleted IS FALSE) AS member_count,
      COALESCE((SELECT SUM(GREATEST(gp.net, 0))
                FROM public.kwenta_group_pairwise(g.id, auth.uid()) gp), 0) AS to_receive,
      COALESCE((SELECT SUM(GREATEST(-gp.net, 0))
                FROM public.kwenta_group_pairwise(g.id, auth.uid()) gp), 0) AS to_pay
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_deleted IS FALSE
    WHERE gm.user_id = auth.uid()
      AND gm.is_deleted IS FALSE
  ) t;
$$;

/**
 * The caller's personal bills, in the two buckets the Bills page shows:
 *   mine   — bills the caller created
 *   shared — personal bills someone else created that the caller has a split on
 *
 * Each row carries everything the list renders, so the page makes no follow-up call per bill.
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

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
  -- Bucketing. `shared` matches the viewer's whole identity — see note 2 in the header.
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
  -- The payer plus everyone with a split, matching participantsByBill (src/lib/people.ts:66-73).
  participants AS (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  -- One row per person per bill: the whole identity cluster collapses to its lowest id, which is
  -- stable because kwenta_expand_identity is transitive and undirected (see the 052/055 headers —
  -- resolving one hop at a time cannot collapse a1<->a2<->a3).
  clustered AS (
    SELECT p.bill_id,
           p.uid,
           -- Postgres has no min(uuid); canonical UUID text sorts identically to the
           -- byte order the uuid type compares on, so this is the same ordering.
           (SELECT MIN(e.id::text)::uuid FROM public.kwenta_expand_identity(p.uid, v_uid) e) AS cluster_key
    FROM participants p
  ),
  representative AS (
    SELECT c.bill_id,
           c.cluster_key,
           -- The viewer's own phonebook entry wins, so a pill reads "Mum" and not her account
           -- name. Header note 1 explains why this is by-lowest-id rather than by-input-order.
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
             -- "You" first, then alphabetical, mirroring the list's own sort.
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
        -- 'Someone' rather than 'Unknown': a payer this device cannot see is not an error state,
        -- it is the privacy boundary doing its job. Matches the old client fallback.
        'payorName',   COALESCE(NULLIF(BTRIM(pr.display_name), ''), 'Someone'),
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     public.kwenta_bill_settled(k.id, v_uid),
        'category',    k.category,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
    LEFT JOIN public.kwenta_pull_rows_profiles('epoch'::timestamptz, v_uid) pr ON pr.id = k.paid_by
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

REVOKE ALL ON FUNCTION public.kwenta_groups_with_balances() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_personal_bills() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_groups_with_balances() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills() TO authenticated;
