-- RPC helpers for realtime fanout events.
-- Client receives an event and calls one of these functions to fetch authoritative rows under the same access rules as RLS.

CREATE OR REPLACE FUNCTION public.kwenta_fetch_group_bundle(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  g public.groups;
  members jsonb;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO g
  FROM public.groups
  WHERE id = p_group_id
    AND (
      created_by = v_uid
      OR public.is_group_member(p_group_id, v_uid)
    );

  IF g.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(gm) ORDER BY gm.joined_at), '[]'::jsonb) INTO members
  FROM public.group_members gm
  WHERE gm.group_id = p_group_id;

  RETURN jsonb_build_object(
    'group', to_jsonb(g),
    'group_members', members
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_group_bundle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_group_bundle(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.kwenta_fetch_bill_bundle(p_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  b public.bills;
  items jsonb;
  splits jsonb;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO b
  FROM public.bills
  WHERE id = p_bill_id
    AND (
      created_by = v_uid
      OR (group_id IS NOT NULL AND public.is_group_member(group_id, v_uid))
      OR (group_id IS NULL AND public.user_is_participant_on_personal_bill(p_bill_id, v_uid))
    );

  IF b.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(bi) ORDER BY bi.created_at), '[]'::jsonb) INTO items
  FROM public.bill_items bi
  WHERE bi.bill_id = p_bill_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(ish) ORDER BY ish.created_at), '[]'::jsonb) INTO splits
  FROM public.item_splits ish
  JOIN public.bill_items bi ON bi.id = ish.item_id
  WHERE bi.bill_id = p_bill_id;

  RETURN jsonb_build_object(
    'bill', to_jsonb(b),
    'bill_items', items,
    'item_splits', splits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_bill_bundle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_bill_bundle(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.kwenta_fetch_settlement(p_settlement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  s public.settlements;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO s
  FROM public.settlements
  WHERE id = p_settlement_id
    AND (
      (group_id IS NOT NULL AND public.is_group_member(group_id, v_uid))
      OR (group_id IS NULL AND (from_user_id = v_uid OR to_user_id = v_uid))
    );

  IF s.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('settlement', to_jsonb(s));
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_settlement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_settlement(uuid) TO authenticated;

