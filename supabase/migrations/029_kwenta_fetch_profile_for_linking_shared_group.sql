-- Peer linking: allow fetching a profile row when the caller shares any group with that user,
-- including is_local rows (name-only / phonebook entries). The previous version only returned
-- non-local accounts, so co-members could not be cached for duplicate-Sam linking.

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

  SELECT to_jsonb(p) INTO result
  FROM public.profiles p
  WHERE p.id = p_id
    AND p.is_deleted IS NOT TRUE
    AND p.is_local IS NOT TRUE;

  IF result IS NOT NULL THEN
    RETURN result;
  END IF;

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

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) TO service_role;
