-- Admin-only hard delete for real user accounts.
-- Most legacy FKs in this project are not ON DELETE CASCADE, so the RPC deletes
-- dependent rows explicitly before removing the profile and auth user.

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_profile_ids uuid[];
  v_group_ids uuid[];
  v_bill_ids uuid[];
  v_item_ids uuid[];
  v_split_ids uuid[];
  v_settlement_ids uuid[];
  v_entity_ids uuid[];
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = v_actor_id THEN
    RAISE EXCEPTION 'admins cannot delete their own account' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_user_id
      AND p.is_local IS FALSE
  ) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
  INTO v_profile_ids
  FROM public.profiles p
  WHERE p.id = p_user_id
     OR p.owner_id = p_user_id;

  SELECT COALESCE(array_agg(g.id), ARRAY[]::uuid[])
  INTO v_group_ids
  FROM public.groups g
  WHERE g.created_by = ANY(v_profile_ids);

  SELECT COALESCE(array_agg(b.id), ARRAY[]::uuid[])
  INTO v_bill_ids
  FROM public.bills b
  WHERE b.created_by = ANY(v_profile_ids)
     OR b.group_id = ANY(v_group_ids);

  SELECT COALESCE(array_agg(bi.id), ARRAY[]::uuid[])
  INTO v_item_ids
  FROM public.bill_items bi
  WHERE bi.bill_id = ANY(v_bill_ids);

  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[])
  INTO v_split_ids
  FROM public.item_splits s
  WHERE s.item_id = ANY(v_item_ids)
     OR s.user_id = ANY(v_profile_ids);

  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[])
  INTO v_settlement_ids
  FROM public.settlements s
  WHERE s.group_id = ANY(v_group_ids)
     OR s.bill_id = ANY(v_bill_ids)
     OR s.from_user_id = ANY(v_profile_ids)
     OR s.to_user_id = ANY(v_profile_ids);

  v_entity_ids := v_profile_ids || v_group_ids || v_bill_ids || v_item_ids || v_split_ids || v_settlement_ids;

  UPDATE public.profiles
  SET
    linked_profile_id = NULL,
    updated_at = now()
  WHERE linked_profile_id = ANY(v_profile_ids)
    AND NOT (id = ANY(v_profile_ids));

  DELETE FROM public.kwenta_notifications
  WHERE recipient_id = ANY(v_profile_ids)
     OR actor_id = ANY(v_profile_ids)
     OR group_id = ANY(v_group_ids)
     OR entity_id = ANY(v_entity_ids);

  DELETE FROM public.kwenta_user_events
  WHERE user_id = ANY(v_profile_ids)
     OR entity_id = ANY(v_entity_ids);

  DELETE FROM public.profile_peer_links
  WHERE owner_user_id = ANY(v_profile_ids)
     OR anchor_profile_id = ANY(v_profile_ids)
     OR peer_profile_id = ANY(v_profile_ids);

  DELETE FROM public.activity_log
  WHERE user_id = ANY(v_profile_ids)
     OR group_id = ANY(v_group_ids)
     OR entity_id = ANY(v_entity_ids);

  DELETE FROM public.settlements
  WHERE id = ANY(v_settlement_ids);

  DELETE FROM public.item_splits
  WHERE id = ANY(v_split_ids);

  DELETE FROM public.bill_items
  WHERE id = ANY(v_item_ids);

  DELETE FROM public.bills
  WHERE id = ANY(v_bill_ids);

  DELETE FROM public.group_members
  WHERE group_id = ANY(v_group_ids)
     OR user_id = ANY(v_profile_ids);

  DELETE FROM public.groups
  WHERE id = ANY(v_group_ids);

  DELETE FROM public.profiles
  WHERE id = ANY(v_profile_ids);

  DELETE FROM auth.users
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO service_role;
