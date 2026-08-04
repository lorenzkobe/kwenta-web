-- 064_settlement_history_and_group_math.sql
--
-- The last money the client still aggregated for itself: payment history, per-member group
-- spending, and the two write-path guards.
--
-- APPLY AFTER 063 and BEFORE the code that calls these functions.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- After 051-063 every screen read its money from the server except four surfaces, all of which
-- re-derived it from Dexie: the settlement history lists, the group Total Spending pie, the
-- per-member payment breakdown, and `owedInGroup`. Two implementations of the same money rules
-- is what CLAUDE.md rule 8 forbids, and the drift is not theoretical — the pie summed EVERY
-- currency in the group into one number and then labelled it with the group's currency, while
-- every other group aggregate in the app drops off-currency rows. This file makes the server the
-- only implementation, and the pie currency-scoped like everything else.
--
-- WHAT DID *NOT* MOVE, and why:
--   * `buildMovementChains` (src/lib/settlement.ts) stays in TypeScript. It is a pure transform
--     of a bounded input — the legs of ONE payment — which is the TS side of rule 8's line, same
--     reasoning as `settlement-suggestions.ts` under 061.
--   * No push validator rejects anything here. The two guards these functions feed are
--     deliberately CONDITIONAL on the client side: `enforceCap` is set only by the two group
--     payment flows because a PERSONAL overpayment is legal and flips the sign (the general-credit
--     model was removed 2026-07-11), and `removeGroupMember`'s settle check is skipped by
--     `force: true` for the `deletePerson` cascade. A server rule that rejected either
--     unconditionally would break documented behaviour, and a rejection keyed off a flag the
--     client puts on the row is not enforcement at all — the client can simply omit it. So the
--     server owns the ARITHMETIC and the client keeps the policy.
--
-- IDENTITY: group endpoints match ids EXACTLY (the shared-ledger rule the 053 and 061 headers
-- explain — viewer-scoped expansion must never touch a shared group ledger). The PERSON history
-- expands identity via `kwenta_expand_identity`, mirroring `expandProfileIdsForSplitMatching`,
-- because a personal payment may be filed under a local-contact id.
--
-- CURRENCY: never converted. Group aggregates drop rows whose currency differs from the group's;
-- NULL and '' count as matching. There is no FX anywhere in Kwenta.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Name of a payment party.
--
-- Same resolution as `kwenta_bill_participant_name` (roster first — a co-member's local contact
-- row is never on this device, CLAUDE.md rule 6), but an unresolvable PAYMENT party reads as
-- "Someone" rather than "Unknown": the row still says a real person paid, we just do not have
-- their name. Wrapping rather than copying keeps one resolution order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_settlement_party_name(
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
  SELECT CASE
    WHEN p_user_id IS NULL THEN NULL
    ELSE COALESCE(
      NULLIF(public.kwenta_bill_participant_name(p_group_id, p_viewer, p_user_id), 'Unknown'),
      'Someone'
    )
  END;
$$;


-- Is this user on the group's roster right now? One definition, because every group endpoint
-- below asks it and a divergent copy is a privacy bug. Membership is checked against the base
-- table on purpose: the pull-row functions deliberately deliver rows to FORMER members (024),
-- which is exactly the case this must reject.
CREATE OR REPLACE FUNCTION public.kwenta_is_active_group_member(p_group_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = p_uid AND gm.is_deleted IS FALSE
  );
$$;


-- ---------------------------------------------------------------------------
-- Build history items from a set of settlement ids.
--
-- Reproduces `buildSettlementHistoryItem` (src/lib/settlement.ts) exactly, including the parts
-- that look odd until you know why:
--   * Rows are grouped by `COALESCE(bundle_id, id)`: one settle-up writes one row per recipient
--     sharing a bundle_id, and the UI shows that as ONE payment.
--   * `recipients` collapses the rows by recipient, but `legs` keeps one entry per stored row.
--     The two differ whenever money moved through an intermediary, and that difference is the
--     whole input to `buildMovementChains` ("You -> Cha -> Yumi").
--   * `isBundled` needs MORE THAN ONE recipient, not merely a bundle_id. A one-recipient bundle
--     is just a payment, and rendering it as a bundle produces "You paid 1 people".
--   * `billId` is set only when EVERY row in the bundle carries the same non-null bill_id.
--   * The caller stamps `groupId`/`groupName`, matching the client: the bill-scoped list passes
--     NULL so a bill payment is not labelled with a group.
--
-- Ties on `created_at` are broken by `id`. The client relied on a stable sort over Dexie's
-- iteration order, which is not an order at all; a bundle's rows are written in one transaction
-- and routinely share a timestamp to the millisecond.
--
-- NOT granted to `authenticated`: it takes the viewer as an argument (CLAUDE.md rule 5).
-- ---------------------------------------------------------------------------
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
              ), NULL))[1] AS label
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


-- Payments recorded against one bill. `p_group_id` is NULL on purpose: the client's bill-scoped
-- list does the same, and the row already names the bill.
CREATE OR REPLACE FUNCTION public.kwenta_bill_settlement_history(p_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT COALESCE(array_agg(s.id), '{}')
  INTO v_ids
  FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, v_uid) s
  WHERE s.bill_id = p_bill_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE;

  RETURN public.kwenta_settlement_history_build(v_ids, v_uid, NULL, NULL);
END;
$$;


-- Every payment in a group. Gated on ACTIVE membership: the pull bundle still delivers a group's
-- rows to former members by design (024), so being sent the rows is not permission to read the
-- screen — the same check `kwenta_group_detail` makes.
CREATE OR REPLACE FUNCTION public.kwenta_group_settlement_history(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.kwenta_is_active_group_member(p_group_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(s.id), '{}')
  INTO v_ids
  FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, v_uid) s
  WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE;

  RETURN public.kwenta_settlement_history_build(v_ids, v_uid, p_group_id, NULL);
END;
$$;


-- ---------------------------------------------------------------------------
-- Payments between the caller and one other person, across every context.
--
-- Deliberately NOT bundled: the client's `listPairwiseSettlementsBetween` emits one item per
-- stored row, because a bundle spanning several recipients is not one payment *to this person* —
-- collapsing it would show the person a total that includes money that went to someone else.
--
-- Each row is labelled with its own group name (or "Personal"), which is why this cannot reuse
-- the shared builder: that one stamps a single caller-supplied label on every item.
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- Gross spend per member in a group: the sum of the shares assigned to each person, regardless
-- of who fronted the money. This is CONSUMPTION, not a balance — it never nets anything off and
-- payments do not touch it.
--
-- Currency-scoped, unlike the client version it replaces. That one summed every currency in the
-- group into one number and rendered it with the group's currency symbol; every other group
-- aggregate in the app drops off-currency rows, so this now does too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_group_spending(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_currency text;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT g.currency INTO v_currency
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE;

  IF NOT FOUND OR NOT public.kwenta_is_active_group_member(p_group_id, v_uid) THEN
    RETURN NULL;
  END IF;

  WITH gb AS (
    SELECT b.id
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_currency)
  ),
  spend AS (
    SELECT sp.user_id, public.kwenta_round_money(SUM(sp.computed_amount)) AS amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
    WHERE sp.user_id IS NOT NULL
    GROUP BY sp.user_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId',      s.user_id,
    'displayName', public.kwenta_bill_participant_name(p_group_id, v_uid, s.user_id),
    'amount',      s.amount
  ) ORDER BY s.amount DESC, s.user_id), '[]'::jsonb)
  INTO v_rows
  FROM spend s
  WHERE s.amount > 0;

  RETURN jsonb_build_object('currency', v_currency, 'rows', v_rows);
END;
$$;


-- ---------------------------------------------------------------------------
-- One member's pending balances inside a group, from THAT member's perspective: who they still
-- pay, and who still pays them.
--
-- Answering for someone other than the caller discloses nothing new — `kwenta_group_detail`
-- already hands every active member `rawDebts`, the complete directed debt graph for the group.
-- The caller must still be an active member; the SUBJECT need not be (a removed member can have
-- a balance left behind, which is exactly what the removal guard asks about).
--
-- Relationships within rounding noise are omitted from both lists (MONEY_EPSILON = 0.005,
-- src/lib/utils.ts) — "settled" is not a line item.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_group_member_breakdown(p_group_id uuid, p_member_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  v_currency text;
  v_pays jsonb;
  v_receives jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT g.currency INTO v_currency
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE;

  IF NOT FOUND OR NOT public.kwenta_is_active_group_member(p_group_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'memberUserId', gp.member_user_id, 'displayName', gp.display_name, 'amount', -gp.net
    ) ORDER BY gp.display_name, gp.member_user_id) FILTER (WHERE gp.net < -EPS), '[]'::jsonb),
    COALESCE(jsonb_agg(jsonb_build_object(
      'memberUserId', gp.member_user_id, 'displayName', gp.display_name, 'amount', gp.net
    ) ORDER BY gp.display_name, gp.member_user_id) FILTER (WHERE gp.net > EPS), '[]'::jsonb)
  INTO v_pays, v_receives
  FROM public.kwenta_group_pairwise(p_group_id, p_member_id) gp;

  RETURN jsonb_build_object(
    'memberUserId', p_member_id,
    'displayName',  public.kwenta_bill_participant_name(p_group_id, v_uid, p_member_id),
    'currency',     v_currency,
    'pays',         v_pays,
    'receives',     v_receives
  );
END;
$$;


-- ---------------------------------------------------------------------------
-- The most `p_from` can pay `p_to` in this group right now: exactly what they owe.
--
-- Returns 0 when there is no debt — you cannot pay down a debt you do not have. This feeds the
-- client's `enforceCap` pre-check; see the header on why no server-side rejection accompanies it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_owed_in_group(p_group_id uuid, p_from uuid, p_to uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_net numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.kwenta_is_active_group_member(p_group_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT gp.net INTO v_net
  FROM public.kwenta_group_pairwise(p_group_id, p_from) gp
  WHERE gp.member_user_id = p_to;

  IF v_net IS NULL OR v_net >= 0 THEN
    RETURN 0;
  END IF;
  RETURN public.kwenta_round_money(-v_net);
END;
$$;


-- ---------------------------------------------------------------------------
-- Grants. The two helpers that take a viewer/subject as an ARGUMENT stay server-internal: a
-- client-callable version would answer for any pair of users (CLAUDE.md rule 5).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.kwenta_settlement_party_name(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_settlement_history_build(uuid[], uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_is_active_group_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_bill_settlement_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_group_settlement_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_person_settlement_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_group_spending(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_group_member_breakdown(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_owed_in_group(uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.kwenta_bill_settlement_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_settlement_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_person_settlement_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_spending(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_member_breakdown(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_owed_in_group(uuid, uuid, uuid) TO authenticated;
