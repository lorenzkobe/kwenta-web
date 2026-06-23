-- 043: One-time identity data repair. Functions only; not auto-run.
-- Operator workflow: SELECT * FROM kwenta_identity_repair_report();  -- review
--                    SELECT kwenta_identity_repair_apply(false);     -- linked + email
--                    SELECT kwenta_identity_repair_apply(true);      -- also name matches

-- Resolve a (possibly leaked) user id to its canonical id WITHIN a group's roster.
-- Order: linked chain -> roster member by email -> roster member by display_name (gated).
CREATE OR REPLACE FUNCTION public.kwenta_repair_resolve_in_group(
  p_user_id uuid,
  p_group_id uuid,
  p_include_name boolean
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canon uuid;
  v_email text;
  v_name text;
  v_match uuid;
BEGIN
  -- 1. linked chain (works regardless of group)
  v_canon := public.kwenta_canonical_user_id(p_user_id);
  IF v_canon <> p_user_id THEN
    RETURN v_canon;
  END IF;

  IF p_group_id IS NULL THEN
    RETURN p_user_id;
  END IF;

  -- already a roster member?
  IF EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.is_deleted IS FALSE
  ) THEN
    RETURN p_user_id;
  END IF;

  SELECT lower(btrim(p.email)), lower(btrim(p.display_name))
    INTO v_email, v_name
    FROM public.profiles p WHERE p.id = p_user_id;

  -- 2. roster member by email
  IF v_email IS NOT NULL AND v_email <> '' THEN
    SELECT gm.user_id INTO v_match
      FROM public.group_members gm
      JOIN public.profiles mp ON mp.id = gm.user_id
     WHERE gm.group_id = p_group_id AND gm.is_deleted IS FALSE
       AND lower(btrim(mp.email)) = v_email
     LIMIT 1;
    IF v_match IS NOT NULL THEN RETURN v_match; END IF;
  END IF;

  -- 3. roster member by display_name (gated)
  IF p_include_name AND v_name IS NOT NULL AND v_name <> '' THEN
    SELECT gm.user_id INTO v_match
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id AND gm.is_deleted IS FALSE
       AND lower(btrim(coalesce(
             (SELECT mp.display_name FROM public.profiles mp WHERE mp.id = gm.user_id),
             gm.display_name))) = v_name
     LIMIT 1;
    IF v_match IS NOT NULL THEN RETURN v_match; END IF;
  END IF;

  RETURN p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_identity_repair_report()
RETURNS TABLE(table_name text, kind text, affected bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'item_splits', 'linked_chain', count(*)
    FROM public.item_splits s
    WHERE public.kwenta_canonical_user_id(s.user_id) <> s.user_id
  UNION ALL
  SELECT 'bills', 'linked_chain', count(*)
    FROM public.bills b
    WHERE public.kwenta_canonical_user_id(b.paid_by) <> b.paid_by
  UNION ALL
  SELECT 'settlements', 'linked_chain', count(*)
    FROM public.settlements st
    WHERE public.kwenta_canonical_user_id(st.from_user_id) <> st.from_user_id
       OR public.kwenta_canonical_user_id(st.to_user_id) <> st.to_user_id
  UNION ALL
  SELECT 'item_splits', 'group_email', count(*)
    FROM public.item_splits s
    JOIN public.bill_items bi ON bi.id = s.item_id
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE b.group_id IS NOT NULL
      AND public.kwenta_repair_resolve_in_group(s.user_id, b.group_id, false) <> s.user_id
      AND public.kwenta_canonical_user_id(s.user_id) = s.user_id
  UNION ALL
  SELECT 'item_splits', 'group_name', count(*)
    FROM public.item_splits s
    JOIN public.bill_items bi ON bi.id = s.item_id
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE b.group_id IS NOT NULL
      AND public.kwenta_repair_resolve_in_group(s.user_id, b.group_id, true) <> s.user_id
      AND public.kwenta_repair_resolve_in_group(s.user_id, b.group_id, false) = s.user_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_identity_repair_apply(p_include_name_matches boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_splits bigint := 0;
  n_bills bigint := 0;
  n_settle_from bigint := 0;
  n_settle_to bigint := 0;
BEGIN
  -- item_splits: resolve within the owning bill's group (or linked chain for personal).
  UPDATE public.item_splits s
     SET user_id = public.kwenta_repair_resolve_in_group(s.user_id, b.group_id, p_include_name_matches),
         updated_at = now()
    FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
   WHERE bi.id = s.item_id
     AND public.kwenta_repair_resolve_in_group(s.user_id, b.group_id, p_include_name_matches) <> s.user_id;
  GET DIAGNOSTICS n_splits = ROW_COUNT;

  -- bills.paid_by
  UPDATE public.bills b
     SET paid_by = public.kwenta_repair_resolve_in_group(b.paid_by, b.group_id, p_include_name_matches),
         updated_at = now()
   WHERE public.kwenta_repair_resolve_in_group(b.paid_by, b.group_id, p_include_name_matches) <> b.paid_by;
  GET DIAGNOSTICS n_bills = ROW_COUNT;

  -- settlements from/to
  UPDATE public.settlements st
     SET from_user_id = public.kwenta_repair_resolve_in_group(st.from_user_id, st.group_id, p_include_name_matches),
         updated_at = now()
   WHERE public.kwenta_repair_resolve_in_group(st.from_user_id, st.group_id, p_include_name_matches) <> st.from_user_id;
  GET DIAGNOSTICS n_settle_from = ROW_COUNT;

  UPDATE public.settlements st
     SET to_user_id = public.kwenta_repair_resolve_in_group(st.to_user_id, st.group_id, p_include_name_matches),
         updated_at = now()
   WHERE public.kwenta_repair_resolve_in_group(st.to_user_id, st.group_id, p_include_name_matches) <> st.to_user_id;
  GET DIAGNOSTICS n_settle_to = ROW_COUNT;

  RETURN jsonb_build_object(
    'item_splits', n_splits,
    'bills', n_bills,
    'settlements_from', n_settle_from,
    'settlements_to', n_settle_to,
    'include_name_matches', p_include_name_matches
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_identity_repair_report() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_identity_repair_apply(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_identity_repair_report() TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_identity_repair_apply(boolean) TO service_role;
