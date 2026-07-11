-- Migration 047: authoritative server-side repair for orphaned settlements.
--
-- Companion to the client-side src/lib/kwenta-data-repair.ts. The client repairs rows it can
-- pull (respecting RLS) for instant local effect; this RPC is the authority — it can reach rows
-- the client hasn't pulled. Self-scoped by auth.uid(): a caller may only repair settlements they
-- are a party to, or that belong to a group they're a member of. Non-destructive to real
-- payments — it only soft-deletes rows pointing at a bill/group/profile that no longer exists
-- (or is soft-deleted). Idempotent.

CREATE OR REPLACE FUNCTION public.kwenta_repair_orphan_settlements()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  affected integer := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  WITH repaired AS (
    UPDATE public.settlements s
    SET is_deleted = TRUE,
        updated_at = now(),
        synced_at = NULL
    WHERE s.is_deleted IS FALSE
      -- Only rows this user owns: a party, or (for group rows) a member of the group.
      AND (
        (s.group_id IS NULL AND (s.from_user_id = uid OR s.to_user_id = uid))
        OR (s.group_id IS NOT NULL AND public.is_group_member(s.group_id, uid))
      )
      -- Orphan conditions (any one):
      AND (
        (s.bill_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.bills b WHERE b.id = s.bill_id AND b.is_deleted IS FALSE))
        OR (s.group_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.groups g WHERE g.id = s.group_id AND g.is_deleted IS FALSE))
        OR NOT EXISTS (
          SELECT 1 FROM public.profiles p WHERE p.id = s.from_user_id AND p.is_deleted IS FALSE)
        OR NOT EXISTS (
          SELECT 1 FROM public.profiles p WHERE p.id = s.to_user_id AND p.is_deleted IS FALSE)
      )
    RETURNING 1
  )
  SELECT count(*) INTO affected FROM repaired;

  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_repair_orphan_settlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_orphan_settlements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_orphan_settlements() TO service_role;
