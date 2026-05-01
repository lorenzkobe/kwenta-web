-- Emit a kwenta_user_event to the remote user when a local contact is linked
-- to their account. This triggers their realtime handler to do a pull so they
-- immediately see the linked profile and any historical bills they were added to.

CREATE OR REPLACE FUNCTION public.kwenta_on_profile_linked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (OLD.linked_profile_id IS NULL OR OLD.linked_profile_id <> NEW.linked_profile_id)
     AND NEW.linked_profile_id IS NOT NULL THEN
    PERFORM public.kwenta_emit_user_event(
      NEW.linked_profile_id,
      'profile_changed',
      'profiles',
      NEW.id,
      'UPDATE',
      jsonb_build_object('linked_profile_id', NEW.linked_profile_id)
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_profiles_link_user_event ON public.profiles;
CREATE TRIGGER kwenta_profiles_link_user_event
AFTER UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_profile_linked();
