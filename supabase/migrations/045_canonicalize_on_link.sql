-- 045: Canonicalize all shared rows the moment a local contact is linked.
--
-- Problem this closes: linkProfileToRemote (client) only rewrites rows in the
-- LINKER's own Dexie, then pushes them. Rows created by OTHER members that
-- reference the just-linked local-contact id are never re-pushed, so the
-- push-time canonicalization in migration 042 never fires on them and they keep
-- the stale id. After the roster flips to the linked account, those stale rows
-- become a phantom duplicate identity (e.g. "Trisha" alongside the linked "Cha")
-- that shows up as a separate node in balances and settle-up suggestions.
--
-- Fix: a SECURITY DEFINER trigger that, when profiles.linked_profile_id is set,
-- rewrites every identity column on every row referencing the old local id to
-- the linked account id — across ALL users' rows, bypassing RLS. Bumping
-- updated_at makes the canonicalized rows fall into every member's next pull.
--
-- This mirrors the one-time repair in migration 043, but runs automatically and
-- is scoped to the single id being linked, so the duplicate-identity gap cannot
-- recur on future links. (043 remains the tool for repairing data that predates
-- this trigger — run it once after deploying.)

CREATE OR REPLACE FUNCTION public.kwenta_canonicalize_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old uuid := NEW.id;
  v_new uuid := NEW.linked_profile_id;
BEGIN
  -- Only act when linked_profile_id transitions to a new non-null value.
  IF v_new IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.linked_profile_id IS NOT DISTINCT FROM NEW.linked_profile_id THEN
    RETURN NULL;
  END IF;

  -- item_splits.user_id
  UPDATE public.item_splits
     SET user_id = v_new, updated_at = now()
   WHERE user_id = v_old;

  -- bills.paid_by
  UPDATE public.bills
     SET paid_by = v_new, updated_at = now()
   WHERE paid_by = v_old;

  -- settlements.from_user_id / to_user_id
  UPDATE public.settlements
     SET from_user_id = v_new, updated_at = now()
   WHERE from_user_id = v_old;
  UPDATE public.settlements
     SET to_user_id = v_new, updated_at = now()
   WHERE to_user_id = v_old;

  -- group_members.user_id — rewrite, but never create a duplicate active
  -- membership. If the linked account is already an active member of a group
  -- where the old id is also a member, soft-delete the old (now redundant) row
  -- instead of rewriting it onto the same [group_id+user_id].
  UPDATE public.group_members gm
     SET is_deleted = true, updated_at = now()
   WHERE gm.user_id = v_old
     AND gm.is_deleted IS FALSE
     AND EXISTS (
       SELECT 1 FROM public.group_members gm2
        WHERE gm2.group_id = gm.group_id
          AND gm2.user_id = v_new
          AND gm2.is_deleted IS FALSE
     );

  UPDATE public.group_members gm
     SET user_id = v_new, updated_at = now()
   WHERE gm.user_id = v_old
     AND NOT EXISTS (
       SELECT 1 FROM public.group_members gm2
        WHERE gm2.group_id = gm.group_id
          AND gm2.user_id = v_new
          AND gm2.is_deleted IS FALSE
     );

  RETURN NULL;
END;
$$;

-- Separate trigger from kwenta_profiles_link_user_event (034) so each concern is
-- independent. Both are AFTER UPDATE; the row rewrites and the catch-up event
-- commit in the same transaction, so the linked user pulls canonical rows.
DROP TRIGGER IF EXISTS kwenta_profiles_canonicalize_on_link ON public.profiles;
CREATE TRIGGER kwenta_profiles_canonicalize_on_link
AFTER UPDATE OF linked_profile_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.kwenta_canonicalize_on_link();
