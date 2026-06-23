-- 044: Conflict integrity -- applied-id return contract.
--
-- Conflict resolution stays NEWEST-TIMESTAMP-WINS: the migration 021b server-wins guard
-- (kwenta_server_wins_updated_at_guard, installed as per-table triggers kwenta_server_wins_<table>)
-- is intentionally LEFT IN PLACE. It rejects a push whose updated_at is older than the row already
-- on the server, so a stale offline edit cannot overwrite newer data and a soft-deleted row cannot
-- be resurrected by a stale push. (An earlier draft replaced it with an unconditional server-clock
-- stamp -- that regressed conflict resolution to last-arrival-at-server-wins and was reverted.)
--
-- (b) kwenta_push_* functions now RETURN the ids they actually stored (RETURNS uuid[]); only the
--     RETURN wrapper changes -- every INSERT/SELECT/WHERE/ON CONFLICT body is reproduced verbatim
--     from each function's latest source migration (profiles=025, groups/group_members/bill_items/
--     activity_log=008, bills/item_splits/settlements=042, profile_peer_links=028), preserving the
--     042 kwenta_canonical_user_id wrappers on item_splits.user_id, bills.paid_by, and
--     settlements.from/to_user_id.
--     NOTE: changing a function's return type (void -> uuid[]) is impossible with CREATE OR REPLACE
--     alone (Postgres error 42P13), so each function is DROPped first. kwenta_sync is plpgsql and
--     therefore holds no hard dependency on these functions, so the drops succeed.
-- (c) kwenta_sync aggregates the applied ids into an `applied` object and returns it alongside the
--     pull bundle, so the client can stamp synced_at only for rows the server actually stored.

-- (b) Push functions: RETURNS uuid[] of stored ids.

-- profiles (body from migration 025).
DROP FUNCTION IF EXISTS public.kwenta_push_profiles(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_profiles(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
      owner_id = EXCLUDED.owner_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- groups (body from migration 008).
DROP FUNCTION IF EXISTS public.kwenta_push_groups(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_groups(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- group_members (body from migration 008).
DROP FUNCTION IF EXISTS public.kwenta_push_group_members(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_group_members(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- bills (body from migration 042 -- canonicalized paid_by).
DROP FUNCTION IF EXISTS public.kwenta_push_bills(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_bills(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.bills AS tgt (
      id, title, group_id, currency, created_by, paid_by, total_amount, note, category,
      created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.title, src.group_id, src.currency, src.created_by,
      public.kwenta_canonical_user_id(src.paid_by),
      src.total_amount, src.note, src.category, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id
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
      paid_by = EXCLUDED.paid_by,
      total_amount = EXCLUDED.total_amount,
      note = EXCLUDED.note,
      category = EXCLUDED.category,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- bill_items (body from migration 008).
DROP FUNCTION IF EXISTS public.kwenta_push_bill_items(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_bill_items(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- item_splits (body from migration 042 -- canonicalized user_id).
DROP FUNCTION IF EXISTS public.kwenta_push_item_splits(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_item_splits(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.item_splits AS tgt (
      id, item_id, user_id, split_type, split_value, computed_amount, created_at, updated_at, synced_at,
      is_deleted, device_id
    )
    SELECT
      src.id, src.item_id, public.kwenta_canonical_user_id(src.user_id), src.split_type, src.split_value,
      src.computed_amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- settlements (body from migration 042 -- canonicalized from/to_user_id, bundle_id, bill_id guard).
DROP FUNCTION IF EXISTS public.kwenta_push_settlements(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_settlements(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.settlements AS tgt (
      id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency, is_settled, label, created_at, updated_at,
      synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.group_id, src.bill_id, src.bundle_id,
      public.kwenta_canonical_user_id(src.from_user_id),
      public.kwenta_canonical_user_id(src.to_user_id),
      src.amount, src.currency, src.is_settled,
      src.label, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.settlements,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (
        (
          src.group_id IS NOT NULL
          AND public.is_group_member(src.group_id, uid)
        )
        OR (
          src.group_id IS NULL
          AND (src.from_user_id = uid OR src.to_user_id = uid)
        )
      )
      AND (
        src.bill_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.bills b
          WHERE b.id = src.bill_id
            AND b.is_deleted IS FALSE
            AND (
              b.created_by = uid
              OR (b.group_id IS NOT NULL AND public.is_group_member(b.group_id, uid))
              OR (b.group_id IS NULL AND public.user_is_participant_on_personal_bill(b.id, uid))
            )
        )
      )
    ON CONFLICT (id) DO UPDATE SET
      group_id = EXCLUDED.group_id,
      bill_id = EXCLUDED.bill_id,
      bundle_id = EXCLUDED.bundle_id,
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- activity_log (body from migration 008).
DROP FUNCTION IF EXISTS public.kwenta_push_activity_log(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_activity_log(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

-- profile_peer_links (body from migration 028).
DROP FUNCTION IF EXISTS public.kwenta_push_profile_peer_links(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_profile_peer_links(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.profile_peer_links AS tgt (
      id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id,
      uid,
      src.anchor_profile_id,
      src.peer_profile_id,
      src.created_at,
      src.updated_at,
      src.synced_at,
      src.is_deleted,
      src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.profile_peer_links,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE EXISTS (
        SELECT 1
        FROM public.profiles a
        WHERE a.id = src.anchor_profile_id
          AND a.is_local IS TRUE
          AND a.owner_id = uid
          AND a.is_deleted IS FALSE
      )
      AND src.anchor_profile_id <> src.peer_profile_id
    ON CONFLICT (id) DO UPDATE SET
      owner_user_id = EXCLUDED.owner_user_id,
      anchor_profile_id = EXCLUDED.anchor_profile_id,
      peer_profile_id = EXCLUDED.peer_profile_id,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_push_profiles(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profiles(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profiles(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_groups(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_groups(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_groups(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_bills(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO service_role;

-- (c) kwenta_sync aggregates applied ids and returns them alongside the bundle.
CREATE OR REPLACE FUNCTION public.kwenta_sync(p_since timestamptz, p_push jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  applied jsonb := '{}'::jsonb;
  bundle jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  applied := jsonb_build_object(
    'profiles',           to_jsonb(public.kwenta_push_profiles(coalesce(p_push->'profiles', '[]'::jsonb), uid)),
    'groups',             to_jsonb(public.kwenta_push_groups(coalesce(p_push->'groups', '[]'::jsonb), uid)),
    'group_members',      to_jsonb(public.kwenta_push_group_members(coalesce(p_push->'group_members', '[]'::jsonb), uid)),
    'bills',              to_jsonb(public.kwenta_push_bills(coalesce(p_push->'bills', '[]'::jsonb), uid)),
    'bill_items',         to_jsonb(public.kwenta_push_bill_items(coalesce(p_push->'bill_items', '[]'::jsonb), uid)),
    'item_splits',        to_jsonb(public.kwenta_push_item_splits(coalesce(p_push->'item_splits', '[]'::jsonb), uid)),
    'settlements',        to_jsonb(public.kwenta_push_settlements(coalesce(p_push->'settlements', '[]'::jsonb), uid)),
    'activity_log',       to_jsonb(public.kwenta_push_activity_log(coalesce(p_push->'activity_log', '[]'::jsonb), uid)),
    'profile_peer_links', to_jsonb(public.kwenta_push_profile_peer_links(coalesce(p_push->'profile_peer_links', '[]'::jsonb), uid))
  );

  bundle := public.kwenta_build_pull_bundle(p_since, uid);
  RETURN bundle || jsonb_build_object('applied', applied);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_sync(timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO service_role;
