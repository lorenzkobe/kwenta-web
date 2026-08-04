-- 052_money_identity_and_personal_net.sql
--
-- First half of moving balance arithmetic to the server (CLAUDE.md rule 8): identity expansion
-- and the personal pairwise net. Nothing calls these yet — 053 adds the client-facing RPCs.
--
-- WHY THIS MOVED. Kwenta is multi-user: group bills are collaborative and payments cross
-- accounts, so the local dataset was never authoritative. A balance computed from it was only as
-- correct as the last sync, which is why the app ended up refetching the entire dataset on every
-- navigation, focus and save — it was buying freshness the only way a complete-mirror design can.
-- Computing on the server makes a balance a number rather than every bill that produced it.
--
-- APPLY BEFORE the client code that calls 053. Additive only; nothing existing reads these.
--
-- ---------------------------------------------------------------------------
-- The four rules a port of this gets wrong. Each has a test in
-- supabase/tests/sql/052_money_identity_and_personal_net.test.sql.
--
-- 1. ROUNDING. JS `Math.round(x)` is `floor(x + 0.5)` — it breaks ties toward +INFINITY, so
--    `Math.round(-0.5)` is -0. Postgres `ROUND(numeric)` breaks ties away from zero, so
--    `ROUND(-0.5)` is -1. On a negative half-cent those disagree by a cent. Every money value
--    here goes through `kwenta_round_money`, which reproduces the JS rule exactly.
--
-- 2. ONE SPLIT PER SIDE PER ITEM. The personal net uses `Array.find` (people.ts:354-355), not a
--    sum: if one person appears on the same item under two ids — their local contact row AND the
--    linked account, which is exactly what identity expansion produces — their share must count
--    ONCE. The group net does the opposite and sums every matching split
--    (settlement.ts:205-223). Reversing either is a silent double-count.
--    Faithfulness note: JS takes the first element of a Dexie array, ordered by the [item_id]
--    index and then by primary key; `ORDER BY id` is the same choice. It only matters when two
--    splits on one item match the same identity set, where the intent is "pick one".
--
-- 3. VIEWER-RELATIVE IDENTITY. `linked_profile_id` lives only on the linking user's own local
--    contacts, and `profile_peer_links` is scoped to its owner — so two people can legitimately
--    compute different PERSONAL nets for the same pair. Group balances deliberately refuse this
--    expansion (settlement.ts:355-366) so every member agrees. 052 keeps the asymmetry.
--
-- 4. OVERPAYMENT FLIPS THE SIGN. There is no "credit" concept: the net is a plain signed sum,
--    and paying more than you owe pushes it past zero into the other direction. Caps exist only
--    on the write path.
-- ---------------------------------------------------------------------------

/**
 * Round to cents the way JavaScript's Math.round does — see rule 1 above.
 * Kept as its own function so every money site shares one definition.
 */
CREATE OR REPLACE FUNCTION public.kwenta_round_money(p_value numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT FLOOR(COALESCE(p_value, 0) * 100 + 0.5) / 100;
$$;

/**
 * Every profile id that represents the same person as `p_anchor`, from `p_viewer`'s point of view.
 *
 * Port of expandProfileIdsForSplitMatching (src/lib/people.ts:723-751). Order matters:
 *   1. self — always, even for a missing or soft-deleted profile
 *   2. the anchor's own `linked_profile_id` (no is_deleted check on the target, matching TS)
 *   3. sibling local contacts pointing at that same remote account (soft-deleted excluded)
 *   4. reverse links: contacts pointing AT the anchor (soft-deleted excluded)
 *   5. the transitive, undirected `profile_peer_links` cluster owned by `p_viewer`
 *
 * Steps 2-4 are ONE hop, deliberately, not a transitive closure. Step 5 IS transitive, and is
 * skipped entirely when `p_viewer` is null. A missing/soft-deleted anchor short-circuits to
 * self + step 5.
 */
CREATE OR REPLACE FUNCTION public.kwenta_expand_identity(p_anchor uuid, p_viewer uuid DEFAULT NULL)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE
  anchor_profile AS (
    SELECT p.* FROM public.profiles p
    WHERE p.id = p_anchor AND p.is_deleted IS FALSE
  ),
  seed AS (
    SELECT p_anchor AS id
    UNION
    SELECT ap.linked_profile_id FROM anchor_profile ap WHERE ap.linked_profile_id IS NOT NULL
    UNION
    SELECT sib.id
    FROM anchor_profile ap
    JOIN public.profiles sib ON sib.linked_profile_id = ap.linked_profile_id
    WHERE ap.linked_profile_id IS NOT NULL AND sib.is_deleted IS FALSE
    UNION
    SELECT rev.id
    FROM anchor_profile ap
    JOIN public.profiles rev ON rev.linked_profile_id = ap.id
    WHERE rev.is_deleted IS FALSE
  ),
  cluster AS (
    SELECT s.id FROM seed s
    UNION
    SELECT CASE WHEN l.anchor_profile_id = c.id THEN l.peer_profile_id ELSE l.anchor_profile_id END
    FROM cluster c
    JOIN public.profile_peer_links l
      ON (l.anchor_profile_id = c.id OR l.peer_profile_id = c.id)
    WHERE p_viewer IS NOT NULL
      AND l.owner_user_id = p_viewer
      AND l.is_deleted IS FALSE
  )
  SELECT DISTINCT c.id FROM cluster c WHERE c.id IS NOT NULL;
$$;

/**
 * Personal-only pairwise net between the viewer and one other person, per currency.
 * `+` means they owe the viewer, `-` means the viewer owes them.
 *
 * Port of computePairwiseNetPersonalOnly (src/lib/people.ts:333-389). Non-group bills plus every
 * personal payment, bill-tagged or not.
 */
CREATE OR REPLACE FUNCTION public.kwenta_pairwise_personal(p_viewer uuid, p_other uuid)
RETURNS TABLE (currency text, net numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids    AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  other_ids AS (SELECT id FROM public.kwenta_expand_identity(p_other,  p_viewer)),

  personal_bills AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  ),
  -- Active items and splits only, mirroring loadBalanceSnapshot's filters (people.ts:45-51).
  active_splits AS (
    SELECT sp.id, sp.user_id, sp.computed_amount, bi.id AS item_id, bi.bill_id
    FROM public.item_splits sp
    JOIN public.bill_items bi ON bi.id = sp.item_id
    JOIN personal_bills pb ON pb.id = bi.bill_id
    WHERE sp.is_deleted IS FALSE AND bi.is_deleted IS FALSE
  ),
  -- payer + everyone on an active split (people.ts:66-73)
  participants AS (
    SELECT pb.id AS bill_id, pb.paid_by AS user_id FROM personal_bills pb
    UNION
    SELECT a.bill_id, a.user_id FROM active_splits a
  ),
  -- profileSetTouchesBill (people.ts:803-810)
  relevant_bills AS (
    SELECT pb.*
    FROM personal_bills pb
    WHERE (
      EXISTS (SELECT 1 FROM participants pt JOIN me_ids m ON m.id = pt.user_id WHERE pt.bill_id = pb.id)
      OR pb.paid_by IN (SELECT id FROM me_ids)
    ) AND (
      EXISTS (SELECT 1 FROM participants pt JOIN other_ids o ON o.id = pt.user_id WHERE pt.bill_id = pb.id)
      OR pb.paid_by IN (SELECT id FROM other_ids)
    )
  ),
  -- Rule 2: the FIRST matching split on each item per side, never a sum.
  per_item AS (
    SELECT
      rb.currency,
      rb.paid_by,
      (SELECT a.computed_amount FROM active_splits a
        WHERE a.item_id = bi.id AND a.user_id IN (SELECT id FROM me_ids)
        ORDER BY a.id LIMIT 1) AS my_amount,
      (SELECT a.computed_amount FROM active_splits a
        WHERE a.item_id = bi.id AND a.user_id IN (SELECT id FROM other_ids)
        ORDER BY a.id LIMIT 1) AS other_amount
    FROM relevant_bills rb
    JOIN public.bill_items bi ON bi.bill_id = rb.id AND bi.is_deleted IS FALSE
  ),
  bill_net AS (
    SELECT
      pi.currency,
      SUM(
        CASE
          -- The viewer paid: the other side's share is owed to the viewer. `me` wins when an id
          -- is somehow in both sets, matching the if/else-if order in TS.
          WHEN pi.paid_by IN (SELECT id FROM me_ids)
            THEN COALESCE(pi.other_amount, 0)
          WHEN pi.paid_by IN (SELECT id FROM other_ids)
            THEN -COALESCE(pi.my_amount, 0)
          ELSE 0
        END
      ) AS net
    FROM per_item pi
    GROUP BY pi.currency
  ),
  settlement_net AS (
    SELECT
      s.currency,
      SUM(
        CASE
          -- Same precedence as TS: from-other-to-me is tested first.
          WHEN s.from_user_id IN (SELECT id FROM other_ids)
           AND s.to_user_id   IN (SELECT id FROM me_ids)    THEN -s.amount
          WHEN s.from_user_id IN (SELECT id FROM me_ids)
           AND s.to_user_id   IN (SELECT id FROM other_ids) THEN  s.amount
          ELSE 0
        END
      ) AS net
    FROM public.settlements s
    WHERE s.group_id IS NULL
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (
        (s.from_user_id IN (SELECT id FROM me_ids)    AND s.to_user_id IN (SELECT id FROM other_ids))
        OR
        (s.from_user_id IN (SELECT id FROM other_ids) AND s.to_user_id IN (SELECT id FROM me_ids))
      )
    GROUP BY s.currency
  ),
  combined AS (
    SELECT currency, net FROM bill_net
    UNION ALL
    SELECT currency, net FROM settlement_net
  )
  SELECT c.currency, public.kwenta_round_money(SUM(c.net)) AS net
  FROM combined c
  GROUP BY c.currency;
$$;

-- Not client-callable: these take the viewer as an argument, so a grant to `authenticated` would
-- let any signed-in user compute (and therefore learn) another user's balances. The RPCs in 053
-- derive the viewer from auth.uid() and are the only client-facing surface.
REVOKE ALL ON FUNCTION public.kwenta_expand_identity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_pairwise_personal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_expand_identity(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_pairwise_personal(uuid, uuid) TO service_role;

-- kwenta_round_money is pure arithmetic over its argument and leaks nothing.
GRANT EXECUTE ON FUNCTION public.kwenta_round_money(numeric) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS profile_peer_links_owner_anchor_idx
  ON public.profile_peer_links (owner_user_id, anchor_profile_id) WHERE is_deleted IS FALSE;
CREATE INDEX IF NOT EXISTS profile_peer_links_owner_peer_idx
  ON public.profile_peer_links (owner_user_id, peer_profile_id) WHERE is_deleted IS FALSE;
