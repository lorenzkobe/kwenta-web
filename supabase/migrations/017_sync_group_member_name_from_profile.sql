-- Keep group_members.display_name aligned when a user's profile display_name changes.

CREATE OR REPLACE FUNCTION public.kwenta_sync_group_member_display_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
    UPDATE public.group_members gm
    SET
      display_name = NEW.display_name,
      updated_at = now(),
      synced_at = NULL
    WHERE gm.user_id = NEW.id
      AND NOT COALESCE(gm.is_deleted, false);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_profile_name_to_group_members ON public.profiles;
CREATE TRIGGER kwenta_profile_name_to_group_members
AFTER UPDATE OF display_name ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_sync_group_member_display_name();

