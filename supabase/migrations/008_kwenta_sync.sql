-- Single RPC: apply client push payload (validated) then return all visible rows changed since p_since.

CREATE OR REPLACE FUNCTION public.kwenta_push_profiles(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.profiles AS tgt (
    id, email, display_name, avatar_url, created_at, updated_at, synced_at, is_deleted, device_id,
    is_local, linked_profile_id, owner_id
  )
  SELECT
    src.id, src.email, src.display_name, src.avatar_url, src.created_at, src.updated_at, src.synced_at,
    src.is_deleted, src.device_id, src.is_local, src.linked_profile_id, src.owner_id
  FROM jsonb_populate_recordset(
    NULL::public.profiles,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE src.id = uid OR (src.is_local IS TRUE AND src.owner_id = uid)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    avatar_url = EXCLUDED.avatar_url,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id,
    is_local = EXCLUDED.is_local,
    linked_profile_id = EXCLUDED.linked_profile_id,
    owner_id = EXCLUDED.owner_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_groups(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.groups AS tgt (
    id, name, currency, created_by, invite_code, created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.name, src.currency, src.created_by, src.invite_code, src.created_at, src.updated_at,
    src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.groups,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE src.created_by = uid
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    currency = EXCLUDED.currency,
    created_by = EXCLUDED.created_by,
    invite_code = EXCLUDED.invite_code,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_group_members(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.group_members AS tgt (
    id, group_id, user_id, display_name, joined_at, created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.group_id, src.user_id, src.display_name, src.joined_at, src.created_at, src.updated_at,
    src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.group_members,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE EXISTS (SELECT 1 FROM public.groups g WHERE g.id = src.group_id AND g.created_by = uid)
     OR src.user_id = uid
  ON CONFLICT (id) DO UPDATE SET
    group_id = EXCLUDED.group_id,
    user_id = EXCLUDED.user_id,
    display_name = EXCLUDED.display_name,
    joined_at = EXCLUDED.joined_at,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_bills(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.bills AS tgt (
    id, title, group_id, currency, created_by, total_amount, note, created_at, updated_at, synced_at,
    is_deleted, device_id
  )
  SELECT
    src.id, src.title, src.group_id, src.currency, src.created_by, src.total_amount, src.note, src.created_at,
    src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.bills,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE src.created_by = uid
     OR (src.group_id IS NOT NULL AND public.is_group_member(src.group_id, uid))
     OR (
       src.group_id IS NULL
       AND public.user_is_participant_on_personal_bill(src.id, uid)
     )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    group_id = EXCLUDED.group_id,
    currency = EXCLUDED.currency,
    created_by = EXCLUDED.created_by,
    total_amount = EXCLUDED.total_amount,
    note = EXCLUDED.note,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_bill_items(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.bill_items AS tgt (
    id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.bill_id, src.name, src.amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted,
    src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.bill_items,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = src.bill_id
      AND (
        b.created_by = uid
        OR (b.group_id IS NOT NULL AND public.is_group_member(b.group_id, uid))
        OR (b.group_id IS NULL AND public.user_is_participant_on_personal_bill(b.id, uid))
      )
  )
  ON CONFLICT (id) DO UPDATE SET
    bill_id = EXCLUDED.bill_id,
    name = EXCLUDED.name,
    amount = EXCLUDED.amount,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_item_splits(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.item_splits AS tgt (
    id, item_id, user_id, split_type, split_value, computed_amount, created_at, updated_at, synced_at,
    is_deleted, device_id
  )
  SELECT
    src.id, src.item_id, src.user_id, src.split_type, src.split_value, src.computed_amount, src.created_at,
    src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.item_splits,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE EXISTS (
    SELECT 1
    FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE bi.id = src.item_id
      AND (
        b.created_by = uid
        OR (b.group_id IS NOT NULL AND public.is_group_member(b.group_id, uid))
        OR (b.group_id IS NULL AND public.user_is_participant_on_personal_bill(b.id, uid))
      )
  )
  ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    user_id = EXCLUDED.user_id,
    split_type = EXCLUDED.split_type,
    split_value = EXCLUDED.split_value,
    computed_amount = EXCLUDED.computed_amount,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_settlements(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.settlements AS tgt (
    id, group_id, from_user_id, to_user_id, amount, currency, is_settled, label, created_at, updated_at,
    synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.group_id, src.from_user_id, src.to_user_id, src.amount, src.currency, src.is_settled,
    src.label, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.settlements,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE (
      src.group_id IS NOT NULL
      AND public.is_group_member(src.group_id, uid)
    )
    OR (
      src.group_id IS NULL
      AND (src.from_user_id = uid OR src.to_user_id = uid)
    )
  ON CONFLICT (id) DO UPDATE SET
    group_id = EXCLUDED.group_id,
    from_user_id = EXCLUDED.from_user_id,
    to_user_id = EXCLUDED.to_user_id,
    amount = EXCLUDED.amount,
    currency = EXCLUDED.currency,
    is_settled = EXCLUDED.is_settled,
    label = EXCLUDED.label,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_push_activity_log(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.activity_log AS tgt (
    id, group_id, user_id, action, entity_type, entity_id, description, created_at, updated_at, synced_at,
    is_deleted, device_id
  )
  SELECT
    src.id, src.group_id, src.user_id, src.action, src.entity_type, src.entity_id, src.description,
    src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.activity_log,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE src.user_id = uid
     OR (src.group_id IS NOT NULL AND public.is_group_member(src.group_id, uid))
  ON CONFLICT (id) DO UPDATE SET
    group_id = EXCLUDED.group_id,
    user_id = EXCLUDED.user_id,
    action = EXCLUDED.action,
    entity_type = EXCLUDED.entity_type,
    entity_id = EXCLUDED.entity_id,
    description = EXCLUDED.description,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_build_pull_bundle(p_since timestamptz, uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profiles',
    (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
     FROM public.profiles p
     WHERE p.updated_at > p_since
       AND (p.id = uid OR (p.is_local IS TRUE AND p.owner_id = uid))),
    'groups',
    (SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
     FROM public.groups g
     WHERE g.updated_at > p_since
       AND g.id IN (
         SELECT gm.group_id FROM public.group_members gm
         WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
       )),
    'group_members',
    (SELECT COALESCE(jsonb_agg(to_jsonb(gm)), '[]'::jsonb)
     FROM public.group_members gm
     WHERE gm.updated_at > p_since
       AND gm.group_id IN (
         SELECT m.group_id FROM public.group_members m
         WHERE m.user_id = uid AND m.is_deleted IS FALSE
       )),
    'bills',
    (SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
     FROM public.bills_for_sync(p_since) AS b),
    'bill_items',
    (SELECT COALESCE(jsonb_agg(to_jsonb(bi)), '[]'::jsonb)
     FROM public.bill_items bi
     WHERE bi.updated_at > p_since
       AND bi.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())),
    'item_splits',
    (SELECT COALESCE(jsonb_agg(to_jsonb(ish)), '[]'::jsonb)
     FROM public.item_splits ish
     WHERE ish.updated_at > p_since
       AND ish.item_id IN (
         SELECT bi2.id FROM public.bill_items bi2
         WHERE bi2.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())
       )),
    'settlements',
    (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
     FROM (
       SELECT s.*
       FROM public.settlements s
       WHERE s.updated_at > p_since
         AND s.group_id IS NOT NULL
         AND s.group_id IN (
           SELECT gm.group_id FROM public.group_members gm
           WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
         )
       UNION ALL
       SELECT s2.*
       FROM public.settlements s2
       WHERE s2.updated_at > p_since
         AND s2.group_id IS NULL
         AND (s2.from_user_id = uid OR s2.to_user_id = uid)
     ) AS s),
    'activity_log',
    (SELECT COALESCE(jsonb_agg(to_jsonb(al)), '[]'::jsonb)
     FROM public.activity_log al
     WHERE al.updated_at > p_since
       AND (
         al.user_id = uid
         OR (
           al.group_id IS NOT NULL
           AND al.group_id IN (
             SELECT gm.group_id FROM public.group_members gm
             WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
           )
         )
       ))
  );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_sync(p_since timestamptz, p_push jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  PERFORM public.kwenta_push_profiles(coalesce(p_push->'profiles', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_groups(coalesce(p_push->'groups', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_group_members(coalesce(p_push->'group_members', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_bills(coalesce(p_push->'bills', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_bill_items(coalesce(p_push->'bill_items', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_item_splits(coalesce(p_push->'item_splits', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_settlements(coalesce(p_push->'settlements', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_activity_log(coalesce(p_push->'activity_log', '[]'::jsonb), uid);

  RETURN public.kwenta_build_pull_bundle(p_since, uid);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_sync(timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO service_role;
