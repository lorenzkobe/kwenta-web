-- Harden admin RPCs:
--   1. admin_list_profiles: only return real accounts (is_local = FALSE), not phonebook entries.
--   2. admin_set_account_status: prevent an admin from deactivating their own account.
--   3. admin_set_user_type: prevent an admin from demoting themselves.

CREATE OR REPLACE FUNCTION public.admin_list_profiles()
RETURNS TABLE (
  id uuid,
  email text,
  display_name text,
  user_type text,
  account_status text,
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
    p.updated_at
  FROM public.profiles p
  WHERE p.is_local IS FALSE
  ORDER BY p.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_account_status(p_user_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('unconfirmed', 'inactive', 'active') THEN
    RAISE EXCEPTION 'invalid account_status' USING ERRCODE = '22023';
  END IF;
  IF p_user_id = auth.uid() AND p_status != 'active' THEN
    RAISE EXCEPTION 'cannot deactivate your own account' USING ERRCODE = '42501';
  END IF;
  UPDATE public.profiles
  SET
    account_status = p_status,
    updated_at = now()
  WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_user_type(p_user_id uuid, p_user_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_user_type NOT IN ('user', 'admin') THEN
    RAISE EXCEPTION 'invalid user_type' USING ERRCODE = '22023';
  END IF;
  IF p_user_id = auth.uid() AND p_user_type != 'admin' THEN
    RAISE EXCEPTION 'cannot demote your own account' USING ERRCODE = '42501';
  END IF;
  UPDATE public.profiles
  SET
    user_type = p_user_type,
    updated_at = now()
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_profiles() TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_account_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_account_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_account_status(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_user_type(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_type(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_type(uuid, text) TO service_role;
