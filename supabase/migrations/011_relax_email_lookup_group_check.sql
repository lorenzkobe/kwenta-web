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
