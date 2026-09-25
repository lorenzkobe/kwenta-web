-- 077_profile_and_peer_link_events.sql
--
-- WHAT BROKE: profile and peer-link changes emitted no `kwenta_user_events` at all. A contact
-- renamed or deleted on one device, an account renaming itself, or a "same person" merge
-- (`profile_peer_links`) made on another device reached this one only through the periodic full
-- refresh — the full ~213 kB bundle every 5 minutes on tab activation. The only profile event was
-- 034's link notice to the ACCOUNT a contact gets linked to, and its `linked_profile_id` payload
-- key makes a client run a full sync.
--
-- THE SHAPE NOW: two AFTER INSERT OR UPDATE row triggers, each emitting one event per recipient
-- with 072's `row = {table, id, updated_at}` (the stored version, so the client's echo skip works):
--   * `profiles`, a local contact (`is_local`)  -> its OWNER. The contact is private to its owner
--     (the pull bundle's privacy boundary), so nobody else is told.
--   * `profiles`, an account                    -> the account itself, and the owners of LIVE
--     contacts linked to it (they render its name through that link). Soft-deleted contacts, other
--     members of a shared group and strangers are not told: 017 already renames the group roster,
--     which emits the group's own events.
--   * `profile_peer_links`                      -> its `owner_user_id` only (a merge is private to
--     whoever made it; the peer is not told).
-- Entity types 'profiles' and 'profile_peer_links' are the ones `kwenta_reconcile_user_event`
-- (028) already serves, so a client reconciles exactly that row.
--
-- Deliberately:
--   * NO `linked_profile_id` key in the payload. An older client treats that key as 034's link
--     event and runs a full sync — shipping it would put a full bundle behind every rename, the
--     opposite of the point. 034's trigger is left as it is.
--   * An UPDATE emits only when a column the client renders changed — for a contact display_name,
--     email, avatar_url, is_deleted, linked_profile_id; for an account display_name, email,
--     avatar_url, is_deleted. A no-op UPDATE, or one touching only device_id / synced_at /
--     account_status, emits nothing.
--   * An account INSERT emits nothing: only signup (`handle_new_user`) inserts one, when no client
--     is subscribed yet and no contact can be linked to it.
--
-- The trigger functions are SECURITY DEFINER (they must write events for other users) and
-- service-role only (rule 5 — they are never called by a client).
--
-- APPLY: BEFORE the client that relaxes its periodic full refresh to 60 minutes. Without these
-- events that client would take up to an hour to see a rename or a merge made elsewhere. An older
-- client reconciles the new events the ordinary way.

CREATE OR REPLACE FUNCTION public.kwenta_on_profile_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb := jsonb_build_object(
    'row', public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at));
  r record;
BEGIN
  IF NEW.is_local IS TRUE THEN
    IF TG_OP = 'UPDATE'
       AND ROW(NEW.display_name, NEW.email, NEW.avatar_url, NEW.is_deleted, NEW.linked_profile_id)
           IS NOT DISTINCT FROM
           ROW(OLD.display_name, OLD.email, OLD.avatar_url, OLD.is_deleted, OLD.linked_profile_id) THEN
      RETURN NULL;
    END IF;
    IF NEW.owner_id IS NOT NULL THEN
      PERFORM public.kwenta_emit_user_event(NEW.owner_id, 'profile_changed', 'profiles', NEW.id, TG_OP, v_payload);
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP <> 'UPDATE'
     OR ROW(NEW.display_name, NEW.email, NEW.avatar_url, NEW.is_deleted)
        IS NOT DISTINCT FROM
        ROW(OLD.display_name, OLD.email, OLD.avatar_url, OLD.is_deleted) THEN
    RETURN NULL;
  END IF;

  PERFORM public.kwenta_emit_user_event(NEW.id, 'profile_changed', 'profiles', NEW.id, TG_OP, v_payload);
  -- profiles_linked_profile_id_idx (048) serves this lookup.
  FOR r IN
    SELECT DISTINCT c.owner_id
    FROM public.profiles c
    WHERE c.linked_profile_id = NEW.id
      AND c.is_local IS TRUE
      AND c.is_deleted IS FALSE
      AND c.owner_id IS NOT NULL
      AND c.owner_id <> NEW.id
  LOOP
    PERFORM public.kwenta_emit_user_event(r.owner_id, 'profile_changed', 'profiles', NEW.id, TG_OP, v_payload);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_profiles_user_event ON public.profiles;
CREATE TRIGGER kwenta_profiles_user_event
AFTER INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_profile_changed();

CREATE OR REPLACE FUNCTION public.kwenta_on_profile_peer_link_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NULL;
  END IF;
  IF NEW.owner_user_id IS NOT NULL THEN
    PERFORM public.kwenta_emit_user_event(
      NEW.owner_user_id, 'peer_link_changed', 'profile_peer_links', NEW.id, TG_OP,
      jsonb_build_object('row', public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at)));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_profile_peer_links_user_event ON public.profile_peer_links;
CREATE TRIGGER kwenta_profile_peer_links_user_event
AFTER INSERT OR UPDATE ON public.profile_peer_links
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_profile_peer_link_changed();

REVOKE ALL ON FUNCTION public.kwenta_on_profile_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_on_profile_peer_link_changed() FROM PUBLIC, anon, authenticated;

SELECT public.kwenta_revoke_acting_user_helpers();
