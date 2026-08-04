-- 056_bill_settled_and_search.sql
--
-- The per-bill "settled" flag — the last money rule still computed on the client — plus global
-- search.
--
-- WHY THE SETTLED FLAG HAD TO MOVE. It reads like a per-bill question and is not: a bill counts
-- as settled when you are square with each of its other participants at the PERSON level, across
-- personal and group contexts, in that bill's currency (src/lib/personal-bill-status.ts:9-13).
-- So a payment that clears your tab with someone settles every bill you share with them at once,
-- and a bill never shows "unpaid" once you are actually even. Deriving that on a client holding a
-- partial cache is impossible — the inputs are the whole relationship, not the bill.
--
-- Currency scoping matters and is easy to get wrong: the tab spans every currency, but an open
-- balance in one must not mark a bill that is settled in its own currency as unpaid.
--
-- One literal comparison is deliberately NOT identity-expanded: `id <> p_viewer`
-- (personal-bill-status.ts:28) filters the viewer out of the participant list by exact id. Every
-- other id comparison in the money path expands; this one does not, and the port keeps that.
--
-- APPLY AFTER 055.

/**
 * True when the viewer is square with every other participant on this bill, in this bill's
 * currency. A missing or soft-deleted bill is "settled" — there is nothing left to owe on it.
 */
CREATE OR REPLACE FUNCTION public.kwenta_bill_settled(p_bill_id uuid, p_viewer uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- isEffectivelyZero uses `<=` (src/lib/utils.ts:63). See the epsilon note in 054.
  EPS constant numeric := 0.005;
  v_bill public.bills;
  v_other uuid;
  v_net numeric;
BEGIN
  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id;
  IF v_bill.id IS NULL OR v_bill.is_deleted IS TRUE THEN
    RETURN true;
  END IF;

  FOR v_other IN
    SELECT DISTINCT u.user_id
    FROM (
      SELECT v_bill.paid_by AS user_id
      UNION
      SELECT sp.user_id
      FROM public.bill_items bi
      JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
      WHERE bi.bill_id = p_bill_id AND bi.is_deleted IS FALSE
    ) u
    WHERE u.user_id IS NOT NULL AND u.user_id <> p_viewer
  LOOP
    v_net := COALESCE(
      (public.kwenta_pairwise_breakdown(p_viewer, v_other) -> 'total' ->> v_bill.currency)::numeric,
      0
    );
    IF ABS(v_net) > EPS THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

/** Client surface for the settled flag. */
CREATE OR REPLACE FUNCTION public.kwenta_bill_settled_for_me(p_bill_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  -- Only answer for a bill the caller may actually read; otherwise "settled" would leak the
  -- existence of someone else's bill.
  IF NOT EXISTS (
    SELECT 1 FROM public.kwenta_pull_rows_bills('1970-01-01T00:00:00Z'::timestamptz, v_uid) b
    WHERE b.id = p_bill_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN public.kwenta_bill_settled(p_bill_id, v_uid);
END;
$$;

/**
 * Global search over the caller's own visible bills, groups and contacts.
 *
 * Replaces three client-side `.filter()` passes that walked whole Dexie tables to find at most
 * five matches each (src/components/common/GlobalSearchSheet.tsx:19-50). Same fields as before —
 * bill title, group name, profile display name — and the same five-per-type cap.
 *
 * Reads through the `kwenta_pull_rows_*` functions (CLAUDE.md rule 5) so search can never widen
 * what a caller can see.
 */
CREATE OR REPLACE FUNCTION public.kwenta_search(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPOCH constant timestamptz := '1970-01-01T00:00:00Z';
  v_uid uuid := auth.uid();
  v_like text;
  bills jsonb;
  groups jsonb;
  profiles jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_query IS NULL OR BTRIM(p_query) = '' THEN
    RETURN jsonb_build_object('bills', '[]'::jsonb, 'groups', '[]'::jsonb, 'profiles', '[]'::jsonb);
  END IF;

  -- Escape LIKE wildcards so a query containing % or _ matches literally instead of everything.
  v_like := '%' || replace(replace(replace(BTRIM(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO bills FROM (
    SELECT jsonb_build_object(
      'id', b.id, 'title', b.title, 'amount', b.total_amount,
      'currency', b.currency, 'groupId', b.group_id
    ) AS x
    FROM public.kwenta_pull_rows_bills(EPOCH, v_uid) b
    WHERE b.is_deleted IS FALSE AND b.title ILIKE v_like
    ORDER BY b.created_at DESC
    LIMIT 5
  ) s;

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO groups FROM (
    SELECT jsonb_build_object('id', g.id, 'name', g.name, 'currency', g.currency) AS x
    FROM public.kwenta_pull_rows_groups(EPOCH, v_uid) g
    WHERE g.is_deleted IS FALSE AND g.name ILIKE v_like
    ORDER BY g.name
    LIMIT 5
  ) s;

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO profiles FROM (
    SELECT jsonb_build_object('id', p.id, 'displayName', p.display_name, 'email', p.email) AS x
    FROM public.kwenta_pull_rows_profiles(EPOCH, v_uid) p
    WHERE p.is_deleted IS FALSE AND p.id <> v_uid AND p.display_name ILIKE v_like
    ORDER BY p.display_name
    LIMIT 5
  ) s;

  RETURN jsonb_build_object('bills', bills, 'groups', groups, 'profiles', profiles);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_bill_settled(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_bill_settled(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_bill_settled_for_me(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_search(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_bill_settled_for_me(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_search(text) TO authenticated;
