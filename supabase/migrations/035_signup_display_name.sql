-- Migration 035: Use display_name from user metadata on signup
-- When a user provides a nickname at signup, it is passed via raw_user_meta_data.
-- This update prefers that value over the email-prefix fallback.

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

  -- Prefer the display_name provided in user metadata (set at signup), fall back to email prefix.
  v_display := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'display_name', '')), '');
  IF v_display IS NULL OR v_display = '' THEN
    v_display := NULLIF(split_part(v_email, '@', 1), '');
  END IF;
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
