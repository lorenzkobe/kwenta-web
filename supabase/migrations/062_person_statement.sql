-- 062_person_statement.sql
--
-- The Person page statement: every bill and payment between the viewer and one other person.
--
-- APPLY AFTER 061 and BEFORE the PersonStatement code that calls `kwenta_person_statement`.
--
-- ---------------------------------------------------------------------------
-- WHAT MOVES AND WHAT DOES NOT
--
-- This returns the EVENTS, not the statement. The running-balance pass — walking the events in
-- order and carrying a per-currency net — stays in TypeScript (`buildMoneyFlowRows`), because it
-- is a pure transform of a bounded list and rule 8 puts that on the TS side. What was unbounded,
-- and is now here, is deciding WHICH bills and payments involve this pair and what each one did
-- to the tab. That part re-read every bill's items and splits one bill at a time.
--
-- THE RECONCILIATION INVARIANT, which is the whole reason this file has to be careful:
--
--   per currency, Σ(event deltas) == kwenta_person_summary(other) -> 'total'
--
-- The statement's last running-balance number IS the hero number on the same screen. If they
-- disagree the page contradicts itself in front of the user. Holding it means each context here
-- mirrors, exactly, the matching rule of the balance function it reconciles to:
--
--   * PERSONAL bills use the EXPANDED id sets and take ONE split per side per item. A person can
--     hold two ids on one item (a contact plus the account it was later linked to); summing both
--     would charge them twice. Mirrors kwenta_pairwise_personal (052 header, rule 2).
--
--   * GROUP bills use EXACT ids — the viewer's own id and the other person's id ON THAT ROSTER —
--     and SUM every matching split. Exact matching means a duplicate cannot occur, so summing is
--     right. Identity expansion is used only to FIND the other person's roster id, never to
--     compute. This is the shared-ledger invariant from the 053 header.
--
--   * A bill whose currency differs from its group's is DROPPED, matching the balance function.
--
-- Effectively-zero bills are omitted: a bill a third party paid for both of you moves nothing
-- between you, and a zero row in a statement is noise the user has to mentally discard.
--
-- `kwenta_pairwise_breakdown` (which `kwenta_person_summary` wraps) is NOT reused per bill
-- here on purpose — it answers for the whole
-- relationship, and calling it once per bill is how the client version became slow.
-- ---------------------------------------------------------------------------

/**
 * Chronological events between `auth.uid()` and one other person: personal bills, group bills,
 * and payments, each with its signed effect on the tab (+ they owe the viewer, − the viewer
 * owes them).
 *
 * Ordered ascending by `createdAt` then `id`, so the client's running-balance pass is
 * deterministic across devices.
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

  v_other_name := COALESCE(NULLIF(public.kwenta_peer_display_name(v_uid, p_person_id), 'Unknown'), 'Them');

  WITH
  me    AS (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  other AS (SELECT id FROM public.kwenta_expand_identity(p_person_id, v_uid)),

  -- Groups the viewer is actively in where the other person is also an active member, with the
  -- other person resolved to their id ON THAT ROSTER.
  shared_groups AS (
    SELECT g.id AS group_id, g.name, g.currency,
           (SELECT om.user_id
              FROM public.group_members om
             WHERE om.group_id = g.id AND om.is_deleted IS FALSE
               AND om.user_id IN (SELECT id FROM other)
             ORDER BY om.id LIMIT 1) AS other_roster_id
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id AND g.is_deleted IS FALSE
    WHERE gm.user_id = v_uid AND gm.is_deleted IS FALSE
  ),
  shared AS (SELECT * FROM shared_groups WHERE other_roster_id IS NOT NULL),

  visible_bills AS (
    SELECT b.* FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.is_deleted IS FALSE
  ),

  -- PERSONAL bills: expanded ids, ONE split per side per item.
  personal_items AS (
    SELECT b.id AS bill_id, b.title, b.currency, b.created_at, b.paid_by, bi.id AS item_id
    FROM visible_bills b
    JOIN public.bill_items bi ON bi.bill_id = b.id AND bi.is_deleted IS FALSE
    WHERE b.group_id IS NULL
      AND (b.paid_by IN (SELECT id FROM me) OR b.paid_by IN (SELECT id FROM other))
  ),
  personal_deltas AS (
    SELECT pi.bill_id, pi.title, pi.currency, pi.created_at,
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
    GROUP BY pi.bill_id, pi.title, pi.currency, pi.created_at
  ),

  -- GROUP bills: exact ids, SUM every matching split, group-currency filter.
  group_deltas AS (
    SELECT b.id AS bill_id, b.title, s.currency, b.created_at, s.group_id, s.name AS group_name,
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
    GROUP BY b.id, b.title, s.currency, b.created_at, s.group_id, s.name
  ),

  settled AS (
    SELECT * FROM public.settlements
    WHERE is_deleted IS FALSE AND is_settled IS TRUE AND amount > EPS
  ),
  -- Personal payments: expanded matching, either direction.
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
  -- Group payments: exact roster ids, group currency.
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
           public.kwenta_round_money(d.delta) AS delta
    FROM personal_deltas d WHERE ABS(d.delta) > EPS

    UNION ALL
    SELECT d.bill_id, 'group_bill', d.created_at, d.currency,
           d.group_id, NULL::uuid, d.group_name,
           d.title, ABS(public.kwenta_round_money(d.delta)),
           public.kwenta_round_money(d.delta)
    FROM group_deltas d WHERE ABS(d.delta) > EPS

    UNION ALL
    SELECT p.id, 'payment', p.created_at, p.currency,
           NULL::uuid, p.bundle_id, 'Personal',
           CASE WHEN p.i_paid THEN 'You paid ' || v_other_name
                ELSE v_other_name || ' paid you' END,
           p.amount,
           CASE WHEN p.i_paid THEN p.amount ELSE -p.amount END
    FROM personal_payments p

    UNION ALL
    SELECT p.id, 'payment', p.created_at, p.currency,
           p.group_id, p.bundle_id, p.group_name,
           CASE WHEN p.i_paid THEN 'You paid ' || v_other_name
                ELSE v_other_name || ' paid you' END,
           p.amount,
           CASE WHEN p.i_paid THEN p.amount ELSE -p.amount END
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
      'delta',        e.delta
    ) ORDER BY e.created_at, e.id
  ), '[]'::jsonb)
  INTO v_events
  FROM events e;

  RETURN v_events;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_person_statement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_person_statement(uuid) TO authenticated;
