-- Allow linking by email without requiring a shared group.
-- The caller provides the email explicitly, so returning the profile UUID
-- is not a privacy leak — it only enables local contact → account linking.
CREATE OR REPLACE FUNCTION public.kwenta_lookup_profile_id_by_email(p_email text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller uuid := auth.uid();
  target uuid;
  em text := lower(trim(p_email));
BEGIN
  IF caller IS NULL OR em = '' OR em NOT LIKE '%@%' THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO target
  FROM public.profiles p
  WHERE lower(trim(p.email)) = em
    AND p.is_deleted IS NOT TRUE
    AND p.is_local IS NOT TRUE
  LIMIT 1;

  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_lookup_profile_id_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_lookup_profile_id_by_email(text) TO authenticated;

-- Fetch a single profile by ID for linking (bypasses RLS so the caller
-- can cache a profile that hasn't been synced to their device yet).
-- Only returns non-deleted, non-local profiles to prevent leaking local contacts.
CREATE OR REPLACE FUNCTION public.kwenta_fetch_profile_for_linking(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT to_jsonb(p) INTO result
  FROM public.profiles p
  WHERE p.id = p_id
    AND p.is_deleted IS NOT TRUE
    AND p.is_local IS NOT TRUE;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_profile_for_linking(uuid) TO authenticated;
