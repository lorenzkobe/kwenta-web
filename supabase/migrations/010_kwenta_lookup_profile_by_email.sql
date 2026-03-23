-- Discover profile id by email only when caller shares a group with that profile (privacy).
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

  IF target IS NULL THEN
    RETURN NULL;
  END IF;

  IF target = caller THEN
    RETURN target;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_members gm1
    INNER JOIN public.group_members gm2
      ON gm1.group_id = gm2.group_id
      AND gm2.user_id = target
      AND gm2.is_deleted IS NOT TRUE
    WHERE gm1.user_id = caller
      AND gm1.is_deleted IS NOT TRUE
  ) THEN
    RETURN target;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_lookup_profile_id_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_lookup_profile_id_by_email(text) TO authenticated;
