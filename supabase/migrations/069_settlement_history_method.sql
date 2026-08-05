-- Migration 069: settlement history returns `method`, so the field stops being write-only.
--
-- WHAT BROKE. `settlements.method` was added by 046 and Dexie v14, and RecordPaymentDialog writes
-- it on every payment. Nothing ever read it back: 064's history payload never emitted it,
-- src/api/balances.ts never mapped it, SettlementHistoryItem had no such field, and
-- EditSettlementDialog had no method state. A user picked "GCash", saved, and the value was
-- unreachable from that moment on -- which is why the production labels hold GCash x6, GoTyme x6
-- and BDO x3: people put the method in the one field that survived. (068 moves the unambiguous
-- ones into the column where they belong.)
--
-- SHAPE. No DROP is needed. Both functions already return jsonb and neither signature changes;
-- `kwenta_settlement_history_build` selects `s.*` from `kwenta_pull_rows_settlements`, which
-- RETURNS SETOF public.settlements, so `method` was already in scope inside the `src` CTE and
-- merely never emitted. Only these two functions change:
--   * kwenta_settlement_history_build  -- the bundled builder (adds the key)
--   * kwenta_person_settlement_history -- builds its own payload, so it needs the key separately
-- `kwenta_bill_settlement_history` and `kwenta_group_settlement_history` are UNCHANGED: they only
-- collect ids and delegate to the builder, so they inherit `method` for free. Restating them
-- would add two verbatim copies to keep in sync for no behavioural gain.
--
-- BUNDLE RULE: FIRST NON-BLANK WINS, ordered created_at DESC, id -- the same rule and the same
-- idiom already used for `label` in 064, not a second rule. It cannot disagree with itself in
-- practice: recordPersonPayment stamps every leg of a bundle with the SAME method.
--
-- DEPLOY ORDER. Apply this before or with the client. An older server simply omits the key and
-- the mapper coerces a missing `method` to null, so the field degrades to "no method" rather than
-- reporting something false; but a client shipped first would show every payment as method-less
-- and look exactly like the bug it fixes.

-- ---------------------------------------------------------------------------------------------
-- The bundled builder, with `method` alongside `label` in `meta` and in the emitted item.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_settlement_history_build(
  p_ids        uuid[],
  p_uid        uuid,
  p_group_id   uuid,
  p_group_name text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH src AS (
    SELECT s.*,
           COALESCE(s.bundle_id, s.id)      AS bundle_key,
           -- Names resolve against the settlement's OWN group when the caller passed none, so a
           -- bill-scoped list still reaches the roster.
           COALESCE(p_group_id, s.group_id) AS name_group_id
    FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, p_uid) s
    WHERE s.id = ANY (p_ids)
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
  ),
  ranked AS (
    SELECT src.*,
           ROW_NUMBER() OVER (
             PARTITION BY src.bundle_key ORDER BY src.created_at DESC, src.id
           ) AS rn
    FROM src
  ),
  prim AS (
    SELECT * FROM ranked WHERE rn = 1
  ),
  per_recipient AS (
    SELECT r.bundle_key,
           r.to_user_id,
           r.name_group_id,
           public.kwenta_round_money(SUM(r.amount)) AS amount
    FROM ranked r
    GROUP BY r.bundle_key, r.to_user_id, r.name_group_id
  ),
  recipients AS (
    SELECT c.bundle_key,
           COUNT(*)                                 AS recipient_count,
           public.kwenta_round_money(SUM(c.amount)) AS total_amount,
           (array_agg(c.to_user_id ORDER BY c.amount DESC, c.to_user_id))[1] AS top_to_user_id,
           (array_agg(public.kwenta_settlement_party_name(c.name_group_id, p_uid, c.to_user_id)
                      ORDER BY c.amount DESC, c.to_user_id))[1] AS top_to_name,
           jsonb_agg(jsonb_build_object(
             'toUserId', c.to_user_id,
             'toName',   public.kwenta_settlement_party_name(c.name_group_id, p_uid, c.to_user_id),
             'amount',   c.amount
           ) ORDER BY c.amount DESC, c.to_user_id) AS recipients
    FROM per_recipient c
    GROUP BY c.bundle_key
  ),
  legs AS (
    SELECT r.bundle_key,
           jsonb_agg(jsonb_build_object(
             'fromUserId', r.from_user_id,
             'fromName',   public.kwenta_settlement_party_name(r.name_group_id, p_uid, r.from_user_id),
             'toUserId',   r.to_user_id,
             'toName',     public.kwenta_settlement_party_name(r.name_group_id, p_uid, r.to_user_id),
             'amount',     r.amount
           ) ORDER BY r.created_at DESC, r.id) AS legs
    FROM ranked r
    GROUP BY r.bundle_key
  ),
  meta AS (
    SELECT r.bundle_key,
           array_agg(r.id ORDER BY r.created_at DESC, r.id) AS settlement_ids,
           CASE
             WHEN COUNT(r.bill_id) = COUNT(*) AND COUNT(DISTINCT r.bill_id) = 1
             THEN (array_agg(r.bill_id))[1]
           END AS bill_id,
           -- First non-blank label wins; the stored (untrimmed) text is what the UI shows.
           (array_remove(
              array_agg(
                CASE WHEN BTRIM(r.label) <> '' THEN r.label END
                ORDER BY r.created_at DESC, r.id
              ), NULL))[1] AS label,
           -- Same rule for the method (069). recordPersonPayment stamps every leg of a bundle
           -- with the same one, so this only ever has one candidate in practice.
           (array_remove(
              array_agg(
                CASE WHEN BTRIM(COALESCE(r.method, '')) <> '' THEN r.method END
                ORDER BY r.created_at DESC, r.id
              ), NULL))[1] AS method
    FROM ranked r
    GROUP BY r.bundle_key
  ),
  items AS (
    SELECT
      p.created_at AS sort_at,
      p.id         AS sort_id,
      jsonb_build_object(
        'id',            CASE WHEN p.bundle_id IS NOT NULL AND rc.recipient_count > 1
                              THEN p.bundle_id ELSE p.id END,
        'settlementIds', to_jsonb(m.settlement_ids),
        'bundleId',      CASE WHEN p.bundle_id IS NOT NULL AND rc.recipient_count > 1
                              THEN p.bundle_id END,
        'isBundled',     p.bundle_id IS NOT NULL AND rc.recipient_count > 1,
        'groupId',       p_group_id,
        'groupName',     p_group_name,
        'billId',        m.bill_id,
        'billTitle',     (SELECT b.title
                            FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, p_uid) b
                           WHERE b.id = m.bill_id AND b.is_deleted IS FALSE),
        'fromUserId',    p.from_user_id,
        'toUserId',      COALESCE(rc.top_to_user_id, p.to_user_id),
        'fromName',      public.kwenta_settlement_party_name(p.name_group_id, p_uid, p.from_user_id),
        'toName',        COALESCE(rc.top_to_name, 'Someone'),
        'amount',        rc.total_amount,
        'currency',      p.currency,
        'label',         COALESCE(m.label, p.label, ''),
        'method',        m.method,
        'createdAt',     p.created_at,
        'recipients',    rc.recipients,
        'legs',          lg.legs,
        'recordedByUserId', rb.user_id,
        'recordedByName',   CASE WHEN rb.user_id IS NOT NULL
                                 THEN public.kwenta_settlement_party_name(p.name_group_id, p_uid, rb.user_id)
                            END
      ) AS item
    FROM prim p
    JOIN recipients rc ON rc.bundle_key = p.bundle_key
    JOIN legs       lg ON lg.bundle_key = p.bundle_key
    JOIN meta       m  ON m.bundle_key  = p.bundle_key
    LEFT JOIN LATERAL (
      -- Who pressed "Pay" — may differ from the payer when recorded on someone's behalf.
      SELECT a.user_id
        FROM public.kwenta_pull_rows_activity_log('epoch'::timestamptz, p_uid) a
       WHERE a.entity_id = COALESCE(p.bundle_id, p.id)
         AND a.entity_type = 'settlement'
         AND a.action = 'settled'
         AND a.is_deleted IS FALSE
       ORDER BY a.created_at, a.id
       LIMIT 1
    ) rb ON TRUE
  )
  SELECT COALESCE(jsonb_agg(i.item ORDER BY i.sort_at DESC, i.sort_id), '[]'::jsonb)
  FROM items i;
$$;


-- ---------------------------------------------------------------------------------------------
-- The person list builds its own payload (it is deliberately NOT bundled — see 064's header), so
-- it needs the key added separately. One stored row per item here, hence no first-non-blank rule.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_person_settlement_history(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  WITH me AS (
    SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)
  ),
  them AS (
    SELECT id FROM public.kwenta_expand_identity(p_person_id, v_uid)
  ),
  pair_rows AS (
    SELECT s.*
    FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, v_uid) s
    WHERE s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (
           (s.from_user_id IN (SELECT id FROM me)   AND s.to_user_id IN (SELECT id FROM them))
        OR (s.from_user_id IN (SELECT id FROM them) AND s.to_user_id IN (SELECT id FROM me))
      )
  ),
  named AS (
    SELECT r.*,
           public.kwenta_settlement_party_name(r.group_id, v_uid, r.from_user_id) AS from_name,
           public.kwenta_settlement_party_name(r.group_id, v_uid, r.to_user_id)   AS to_name,
           COALESCE(
             (SELECT g.name
                FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
               WHERE g.id = r.group_id),
             CASE WHEN r.group_id IS NULL THEN 'Personal' ELSE 'Group' END
           ) AS group_name
    FROM pair_rows r
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',            n.id,
    'settlementIds', jsonb_build_array(n.id),
    'bundleId',      n.bundle_id,
    'isBundled',     false,
    'groupId',       n.group_id,
    'groupName',     n.group_name,
    'billId',        NULL,
    'billTitle',     NULL,
    'fromUserId',    n.from_user_id,
    'toUserId',      n.to_user_id,
    'fromName',      n.from_name,
    'toName',        n.to_name,
    'amount',        n.amount,
    'currency',      n.currency,
    'label',         COALESCE(n.label, ''),
    'method',        CASE WHEN BTRIM(COALESCE(n.method, '')) <> '' THEN n.method END,
    'createdAt',     n.created_at,
    'recipients',    jsonb_build_array(jsonb_build_object(
                       'toUserId', n.to_user_id, 'toName', n.to_name, 'amount', n.amount)),
    'legs',          jsonb_build_array(jsonb_build_object(
                       'fromUserId', n.from_user_id, 'fromName', n.from_name,
                       'toUserId',   n.to_user_id,   'toName',   n.to_name,
                       'amount',     n.amount)),
    'recordedByUserId', NULL,
    'recordedByName',   NULL
  ) ORDER BY n.created_at DESC, n.id), '[]'::jsonb)
  INTO v_out
  FROM named n;

  RETURN v_out;
END;
$$;


-- CREATE OR REPLACE keeps existing privileges, but rule 3 wants them restated so the migration is
-- self-describing. The builder takes the acting user as an ARGUMENT and stays service_role only
-- (rule 5); the person endpoint derives the viewer from auth.uid() and is client-facing.
REVOKE ALL ON FUNCTION public.kwenta_settlement_history_build(uuid[], uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_person_settlement_history(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.kwenta_settlement_history_build(uuid[], uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_person_settlement_history(uuid) TO authenticated;
