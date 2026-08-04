-- 054_money_contacts_and_rollups.sql
--
-- Replaces the two most expensive reads in the app.
--
-- PeoplePage built a whole-database BalanceSnapshot (every bill, every settlement, and all their
-- items and splits), walked it to discover contacts, then computed a pairwise net PER CONTACT
-- against that snapshot. `useOverallBalanceRollups` did the same thing twice more for the Home
-- headline. That is why Dexie had to hold the entire dataset, and therefore why every navigation
-- refetched it. These two RPCs return the finished numbers instead.
--
-- APPLY AFTER 053.
--
-- ---------------------------------------------------------------------------
-- EPSILON: PORTED AS-IS, INCONSISTENCIES INCLUDED
--
-- MONEY_EPSILON is 0.005 (src/lib/utils.ts:55), but the comparison operator genuinely differs
-- per call site in the TypeScript:
--   * rollup bucketing uses STRICT `v > EPS` / `v < -EPS`   (people.ts:537-540, 567-570)
--   * isEffectivelyZero uses `<=`                            (utils.ts:63)
--   * the breakdown's group filter uses `<=`                 (people.ts:440, ported in 053)
-- These are reproduced exactly rather than harmonised. Tidying them would move real numbers on
-- real accounts, which is a behaviour change wearing a cleanup's clothes. If they should agree,
-- that is a separate, deliberate decision with its own parity check.
--
-- CANONICAL PEER: a contact and the account it is linked to are ONE person in this list, or the
-- People page shows the same human twice. The precedence below is load-bearing and is ported
-- verbatim from iterCanonicalPeerIds (people.ts:469-511).
-- ---------------------------------------------------------------------------

/**
 * Profile ids the viewer shares expenses with — group co-members, bill participants, settlement
 * counterparties, and their own phonebook.
 *
 * Port of collectRelatedProfileIds (src/lib/people.ts:622-681). Two details that look like bugs
 * and are not:
 *   * memberships are found by the viewer's LITERAL id (people.ts:631), not the expanded set;
 *   * a personal bill only contributes when the viewer CREATED it (people.ts:650) — a personal
 *     bill is the creator's own ledger, so someone else's does not make them a contact. They
 *     still surface through the settlement pass if money actually moved.
 */
CREATE OR REPLACE FUNCTION public.kwenta_related_profile_ids(p_viewer uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  my_groups AS (
    SELECT DISTINCT gm.group_id
    FROM public.group_members gm
    WHERE gm.user_id = p_viewer AND gm.is_deleted IS FALSE
  ),
  owned_locals AS (
    SELECT p.id FROM public.profiles p
    WHERE p.owner_id = p_viewer AND p.is_deleted IS FALSE
  ),
  co_members AS (
    SELECT gm.user_id AS id
    FROM public.group_members gm
    JOIN my_groups g ON g.group_id = gm.group_id
    WHERE gm.is_deleted IS FALSE
      AND gm.user_id NOT IN (SELECT id FROM me_ids)
  ),
  candidate_bills AS (
    SELECT b.* FROM public.bills b
    WHERE b.is_deleted IS FALSE
      AND (
        (b.group_id IS NOT NULL AND b.group_id IN (SELECT group_id FROM my_groups))
        OR (b.group_id IS NULL AND b.created_by IN (SELECT id FROM me_ids))
      )
  ),
  bill_participants AS (
    SELECT cb.id AS bill_id, cb.paid_by AS user_id FROM candidate_bills cb
    UNION
    SELECT bi.bill_id, sp.user_id
    FROM candidate_bills cb
    JOIN public.bill_items bi ON bi.bill_id = cb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
  ),
  -- Only bills the viewer actually takes part in contribute their other participants.
  my_bills AS (
    SELECT DISTINCT bp.bill_id
    FROM bill_participants bp
    WHERE bp.user_id IN (SELECT id FROM me_ids)
  ),
  bill_people AS (
    SELECT bp.user_id AS id
    FROM bill_participants bp
    JOIN my_bills mb ON mb.bill_id = bp.bill_id
    WHERE bp.user_id NOT IN (SELECT id FROM me_ids)
  ),
  settlement_people AS (
    SELECT s.from_user_id AS id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.to_user_id IN (SELECT id FROM me_ids)
      AND s.from_user_id NOT IN (SELECT id FROM me_ids)
    UNION
    SELECT s.to_user_id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.from_user_id IN (SELECT id FROM me_ids)
      AND s.to_user_id NOT IN (SELECT id FROM me_ids)
  )
  SELECT DISTINCT x.id FROM (
    SELECT id FROM owned_locals
    UNION SELECT id FROM co_members
    UNION SELECT id FROM bill_people
    UNION SELECT id FROM settlement_people
  ) x
  WHERE x.id IS NOT NULL;
$$;

/**
 * One id per real person: collapses a local contact and the account it links to into a single
 * peer, so the People page never lists the same human twice.
 *
 * Port of iterCanonicalPeerIds (src/lib/people.ts:469-511). Precedence, first match wins:
 *   1. the id is already one of the viewer's own local contacts -> keep it
 *   2. the viewer has a local contact LINKED to this id          -> use that contact
 *   3. the id appears as the `peer` of one of the viewer's merges -> use the merge's anchor
 *   4. the id is a contact carrying `linked_profile_id`           -> use the linked account
 *   5. otherwise keep the id
 * Anything that resolves back onto the viewer is dropped.
 */
CREATE OR REPLACE FUNCTION public.kwenta_canonical_peer_ids(p_viewer uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  related AS (
    SELECT r.id FROM public.kwenta_related_profile_ids(p_viewer) r
    WHERE r.id <> p_viewer AND r.id NOT IN (SELECT id FROM me_ids)
  ),
  resolved AS (
    SELECT
      COALESCE(
        -- 1. already the viewer's own local contact
        (SELECT p.id FROM public.profiles p
          WHERE p.id = rel.id AND p.is_deleted IS FALSE
            AND p.is_local IS TRUE AND p.owner_id = p_viewer),
        -- 2. a local contact of the viewer's linked to this id
        (SELECT p.id FROM public.profiles p
          WHERE p.owner_id = p_viewer AND p.is_deleted IS FALSE
            AND p.is_local IS TRUE AND p.linked_profile_id = rel.id
          ORDER BY p.id LIMIT 1),
        -- 3. this id is the peer side of one of the viewer's merges
        (SELECT l.anchor_profile_id FROM public.profile_peer_links l
          WHERE l.owner_user_id = p_viewer AND l.is_deleted IS FALSE
            AND l.peer_profile_id = rel.id
          ORDER BY l.id LIMIT 1),
        -- 4. follow this contact's own account link
        (SELECT p.linked_profile_id FROM public.profiles p
          WHERE p.id = rel.id AND p.linked_profile_id IS NOT NULL),
        -- 5. keep it
        rel.id
      ) AS canonical
    FROM related rel
  )
  SELECT DISTINCT r.canonical
  FROM resolved r
  WHERE r.canonical IS NOT NULL
    AND r.canonical NOT IN (SELECT id FROM me_ids);
$$;

/**
 * Display name for a peer, with the group-roster fallback CLAUDE.md rule 6 requires: a
 * co-member's local contact row is not on this device, so `profiles` alone returns nothing for
 * them and the name would render "Unknown".
 */
CREATE OR REPLACE FUNCTION public.kwenta_peer_display_name(p_viewer uuid, p_peer uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(BTRIM(p.display_name), '') FROM public.profiles p WHERE p.id = p_peer),
    (SELECT NULLIF(BTRIM(gm.display_name), '')
       FROM public.group_members gm
      WHERE gm.user_id = p_peer
        AND gm.group_id IN (
          SELECT g.group_id FROM public.group_members g
          WHERE g.user_id = p_viewer AND g.is_deleted IS FALSE
        )
      ORDER BY gm.is_deleted, gm.id
      LIMIT 1),
    'Unknown'
  );
$$;

-- ---------------------------------------------------------------------------
-- Client-facing. Viewer is auth.uid(), never an argument.
-- ---------------------------------------------------------------------------

/**
 * The People page: one row per real person, with their combined standing across every context.
 * Replaces a full-database scan plus a pairwise computation per contact.
 */
CREATE OR REPLACE FUNCTION public.kwenta_contacts_with_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  out jsonb := '[]'::jsonb;
  peer uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  FOR peer IN SELECT id FROM public.kwenta_canonical_peer_ids(v_uid) LOOP
    out := out || jsonb_build_array(jsonb_build_object(
      'peerId',      peer,
      'displayName', public.kwenta_peer_display_name(v_uid, peer),
      'net',         public.kwenta_pairwise_breakdown(v_uid, peer) -> 'total'
    ));
  END LOOP;

  RETURN out;
END;
$$;

/**
 * The Home headline: personal-only and combined to-receive / to-pay, per currency.
 *
 * Each person is netted to a single figure BEFORE bucketing, so the headline agrees with what
 * their Person page shows instead of double-counting someone who owes on one bill and is owed
 * on another.
 */
CREATE OR REPLACE FUNCTION public.kwenta_balances_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Strict comparison, matching people.ts:537-540 / 567-570. See the header note on epsilon.
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  peer uuid;
  r record;
  personal_receive jsonb := '{}'::jsonb;
  personal_pay     jsonb := '{}'::jsonb;
  combined_receive jsonb := '{}'::jsonb;
  combined_pay     jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  FOR peer IN SELECT id FROM public.kwenta_canonical_peer_ids(v_uid) LOOP
    -- personal-only
    FOR r IN SELECT currency, net FROM public.kwenta_pairwise_personal(v_uid, peer) LOOP
      IF r.net > EPS THEN
        personal_receive := personal_receive || jsonb_build_object(
          r.currency, COALESCE((personal_receive ->> r.currency)::numeric, 0) + r.net);
      ELSIF r.net < -EPS THEN
        personal_pay := personal_pay || jsonb_build_object(
          r.currency, COALESCE((personal_pay ->> r.currency)::numeric, 0) + ABS(r.net));
      END IF;
    END LOOP;

    -- combined (personal + every shared group)
    FOR r IN
      SELECT key AS currency, value::text::numeric AS net
      FROM jsonb_each(public.kwenta_pairwise_breakdown(v_uid, peer) -> 'total')
    LOOP
      IF r.net > EPS THEN
        combined_receive := combined_receive || jsonb_build_object(
          r.currency, COALESCE((combined_receive ->> r.currency)::numeric, 0) + r.net);
      ELSIF r.net < -EPS THEN
        combined_pay := combined_pay || jsonb_build_object(
          r.currency, COALESCE((combined_pay ->> r.currency)::numeric, 0) + ABS(r.net));
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'personalReceive', personal_receive,
    'personalPay',     personal_pay,
    'combinedReceive', combined_receive,
    'combinedPay',     combined_pay
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_related_profile_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_canonical_peer_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_peer_display_name(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_related_profile_ids(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_canonical_peer_ids(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_peer_display_name(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_contacts_with_balances() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_balances_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_contacts_with_balances() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_balances_overview() TO authenticated;
