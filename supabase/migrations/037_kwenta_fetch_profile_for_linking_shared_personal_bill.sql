-- Extend kwenta_fetch_profile_for_linking so a profile row (including is_local phonebook
-- entries) is also returnable when the caller shares a *personal* bill (group_id IS NULL)
-- with that profile. Mirrors the shared-group allowance from migration 029.
--
-- Why: on a personal bill, splits may reference the bill creator's local contacts (e.g. "Ayna").
-- A co-participant (the payer's account) can see the bill + splits but, under the pull-bundle
-- privacy boundary, never receives another user's local contacts — so those names resolve to
-- "Unknown". This lets such a co-participant fetch the name on demand (via fetchRemoteProfileIntoDexie),
-- without adding the contact to their own phonebook.
--
-- Participation = recorded payer (bills.paid_by) OR appears on any active item split of the bill.

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

  -- Non-local accounts are always returnable.
  SELECT to_jsonb(p) INTO result
  FROM public.profiles p
  WHERE p.id = p_id
    AND p.is_deleted IS NOT TRUE
    AND p.is_local IS NOT TRUE;

  IF result IS NOT NULL THEN
    RETURN result;
  END IF;

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
    SELECT to_jsonb(p) INTO result
    FROM public.profiles p
    WHERE p.id = p_id
      AND p.is_deleted IS NOT TRUE;
    RETURN result;
  END IF;

  -- Shared personal bill (incl. is_local rows).
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
    SELECT to_jsonb(p) INTO result
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
