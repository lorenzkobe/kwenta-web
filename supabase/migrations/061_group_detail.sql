-- 061_group_detail.sql
--
-- The Group detail screen in one call.
--
-- APPLY AFTER 060 and BEFORE the GroupDetailPage code that calls `kwenta_group_detail`.
--
-- ---------------------------------------------------------------------------
-- WHERE THE LINE IS DRAWN
--
-- This returns AGGREGATES, not suggestions. The settle-up decomposition (fewest transfers)
-- stays in TypeScript: it is a pure transform of a bounded input, and CLAUDE.md rule 8 puts
-- exactly that on the TS side of the line, with its Vitest coverage intact
-- (`settlement-suggestions.ts`). So the endpoint hands back `rawDebts` — the directed debt
-- graph over every bill split and settled payment — and the client decomposes it.
--
-- Returning the graph rather than the finished suggestions also keeps ONE implementation of
-- the decomposition. Porting it here would have created a second, and two greedy algorithms
-- that disagree by one transfer produce two different "who pays whom" screens.
--
-- IDENTITY IS MATCHED EXACTLY, everywhere in this file. This is the shared group ledger: the
-- 053 header explains at length why viewer-scoped identity expansion must never touch it, and
-- src/lib/settlement.ts:354-366 carries the same warning. Every member has to compute the same
-- numbers, or the same group shows different balances — and different settle-up suggestions —
-- to different people looking at it.
--
-- TWO BALANCE VIEWS, both of which the screen shows, and they are not the same quantity:
--   * `pairwise` — what each OTHER member owes the viewer, one number per member. This is what
--     a member row displays, and it never involves a third party.
--   * `memberBalances` — each member's net against the GROUP POOL (what they fronted minus what
--     they consumed). This is what the export card shows and what the debt graph reconciles to.
-- A member can be square with the viewer pairwise and still be deep in the red against the pool.
--
-- CURRENCY: rows whose currency differs from the group's are DROPPED, never converted, matching
-- the client. NULL and empty string count as matching. There is no FX anywhere in Kwenta.
-- ---------------------------------------------------------------------------

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

  -- The directed debt graph the client decomposes into transfers. A split is a debt from the
  -- splitter to the payer; a settled payment is a debt in the OPPOSITE direction, which cancels
  -- against it rather than being subtracted (the client's buildDebtGraph nets the pair).
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  bill_debts AS (
    SELECT s.user_id AS from_id, gb.paid_by AS to_id, s.computed_amount AS amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL AND s.user_id <> gb.paid_by
  ),
  settlement_debts AS (
    SELECT s.to_user_id AS from_id, s.from_user_id AS to_id, s.amount
    FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'from', d.from_id, 'to', d.to_id, 'amount', d.amount
  )), '[]'::jsonb)
  INTO v_raw_debts
  FROM (
    SELECT * FROM bill_debts
    UNION ALL
    SELECT * FROM settlement_debts
  ) d;

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

REVOKE ALL ON FUNCTION public.kwenta_group_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_group_detail(uuid) TO authenticated;
