-- Include created_at in admin_list_profiles for sorting and display.

DROP FUNCTION IF EXISTS public.admin_list_profiles();

CREATE OR REPLACE FUNCTION public.admin_list_profiles()
RETURNS TABLE (
  id uuid,
  email text,
  display_name text,
  user_type text,
  account_status text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.email,
    p.display_name,
    p.user_type,
    p.account_status,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  WHERE p.is_local IS FALSE
  ORDER BY p.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO service_role;
