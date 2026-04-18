-- User types, account_status lifecycle, admin RPCs, and sync-safe profile push (no privilege columns).

-- 1. Columns + backfill (defaults apply to new rows only after NOT NULL; existing rows set explicitly)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS user_type TEXT CHECK (user_type IN ('user', 'admin'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_status TEXT CHECK (account_status IN ('unconfirmed', 'inactive', 'active'));

UPDATE public.profiles
SET
  user_type = COALESCE(user_type, 'user'),
  account_status = COALESCE(account_status, 'active')
WHERE user_type IS NULL OR account_status IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN user_type SET DEFAULT 'user',
  ALTER COLUMN user_type SET NOT NULL;

ALTER TABLE public.profiles
  ALTER COLUMN account_status SET DEFAULT 'unconfirmed',
  ALTER COLUMN account_status SET NOT NULL;

-- 2. is_admin() — SECURITY DEFINER so RLS subqueries can read own row safely
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.user_type = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

-- 3. RLS: admins can list all profiles
DROP POLICY IF EXISTS profiles_select ON public.profiles;

CREATE POLICY profiles_select ON public.profiles
  FOR SELECT
  USING (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
    OR public.is_admin()
  );

-- 4. Block non-admin changes to user_type / account_status (direct SQL still goes through RLS + trigger)
CREATE OR REPLACE FUNCTION public.profiles_block_privilege_mutations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    IF NOT public.is_admin() THEN
      IF NEW.user_type IS DISTINCT FROM 'user' THEN
        RAISE EXCEPTION 'invalid user_type' USING ERRCODE = '42501';
      END IF;
      IF NEW.account_status = 'active' THEN
        RAISE EXCEPTION 'invalid account_status' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    IF NOT public.is_admin() THEN
      IF NEW.user_type IS DISTINCT FROM OLD.user_type OR NEW.account_status IS DISTINCT FROM OLD.account_status THEN
        RAISE EXCEPTION 'cannot modify user_type or account_status' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_block_privilege_mutations_trg ON public.profiles;
CREATE TRIGGER profiles_block_privilege_mutations_trg
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_block_privilege_mutations();

-- 5. Auth: create profile on signup; sync email confirmation -> inactive
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_display text;
  v_status text;
BEGIN
  v_email := COALESCE(NEW.email, '');
  v_display := NULLIF(split_part(v_email, '@', 1), '');
  IF v_display IS NULL OR v_display = '' THEN
    v_display := 'User';
  END IF;

  v_status := CASE
    WHEN NEW.email_confirmed_at IS NOT NULL THEN 'inactive'
    ELSE 'unconfirmed'
  END;

  INSERT INTO public.profiles (
    id,
    email,
    display_name,
    avatar_url,
    created_at,
    updated_at,
    synced_at,
    is_deleted,
    device_id,
    is_local,
    linked_profile_id,
    owner_id,
    user_type,
    account_status
  )
  VALUES (
    NEW.id,
    v_email,
    v_display,
    NULL,
    now(),
    now(),
    NULL,
    false,
    '',
    false,
    NULL,
    NULL,
    'user',
    v_status
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = now(),
    account_status = CASE
      WHEN public.profiles.account_status = 'unconfirmed'
        AND NEW.email_confirmed_at IS NOT NULL
      THEN 'inactive'
      ELSE public.profiles.account_status
    END;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_user_email_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.profiles
    SET
      account_status = 'inactive',
      updated_at = now()
    WHERE id = NEW.id
      AND account_status = 'unconfirmed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_user_email_confirmed();

-- 6. Admin RPCs
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

-- 7. kwenta_push_profiles: never upsert user_type / account_status (server authority only)
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
