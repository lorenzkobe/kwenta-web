-- Reduce the data returned by kwenta_fetch_profile_for_linking for the shared-group
-- and shared-personal-bill branches.
--
-- Those two branches are only ever reached when the requested profile is is_local
-- (the first branch already returns every non-local real account in full). They
-- previously returned `to_jsonb(p)` — the ENTIRE local-contact row — which leaks
-- another user's phonebook metadata to a co-member/co-participant: owner_id (reveals
-- which account created the contact), email, device_id, user_type, account_status.
--
-- The intent is name-only resolution (so a shared participant isn't shown "Unknown").
-- Return just the fields needed to resolve + upsert a display name, omitting the PII.
-- owner_id is intentionally NOT returned, so the fetched row never surfaces in the
-- caller's own phonebook (which filters by owner_id = caller).

CREATE OR REPLACE FUNCTION public.kwenta_fetch_profile_for_linking(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  caller uuid := auth.uid();
BEGIN
  IF caller IS NULL OR p_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Non-local accounts are always returnable (real accounts you may link to).
  SELECT to_jsonb(p) INTO result
  FROM public.profiles p
  WHERE p.id = p_id
    AND p.is_deleted IS NOT TRUE
    AND p.is_local IS NOT TRUE;

  IF result IS NOT NULL THEN
    RETURN result;
  END IF;

  -- From here, p_id is an is_local contact owned by someone else. Return a reduced,
  -- name-resolution-only projection (no owner_id / email / device_id / user_type /
  -- account_status).

  -- Shared group (incl. is_local rows) — migration 029.
  IF EXISTS (
    SELECT 1
    FROM public.group_members gm_self
    INNER JOIN public.group_members gm_peer
      ON gm_self.group_id = gm_peer.group_id
      AND gm_peer.user_id = p_id
      AND gm_peer.is_deleted IS NOT TRUE
    WHERE gm_self.user_id = caller
      AND gm_self.is_deleted IS NOT TRUE
  ) THEN
    SELECT jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'is_local', p.is_local,
      'linked_profile_id', p.linked_profile_id,
      'is_deleted', p.is_deleted,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) INTO result
    FROM public.profiles p
    WHERE p.id = p_id
      AND p.is_deleted IS NOT TRUE;
    RETURN result;
  END IF;

  -- Shared personal bill (incl. is_local rows) — migration 037.
  IF EXISTS (
    SELECT 1
    FROM public.bills b
    WHERE b.group_id IS NULL
      AND b.is_deleted IS NOT TRUE
      AND (
        b.paid_by = caller
        OR EXISTS (
          SELECT 1
          FROM public.item_splits s
          INNER JOIN public.bill_items bi
            ON bi.id = s.item_id
            AND bi.bill_id = b.id
            AND bi.is_deleted IS NOT TRUE
          WHERE s.user_id = caller
            AND s.is_deleted IS NOT TRUE
        )
      )
      AND (
        b.paid_by = p_id
        OR EXISTS (
          SELECT 1
          FROM public.item_splits s2
          INNER JOIN public.bill_items bi2
            ON bi2.id = s2.item_id
            AND bi2.bill_id = b.id
            AND bi2.is_deleted IS NOT TRUE
          WHERE s2.user_id = p_id
            AND s2.is_deleted IS NOT TRUE
        )
      )
  ) THEN
    SELECT jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'is_local', p.is_local,
      'linked_profile_id', p.linked_profile_id,
      'is_deleted', p.is_deleted,
      'created_at', p.created_at,
      'updated_at', p.updated_at
    ) INTO result
    FROM public.profiles p
    WHERE p.id = p_id
      AND p.is_deleted IS NOT TRUE;
    RETURN result;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) TO service_role;
