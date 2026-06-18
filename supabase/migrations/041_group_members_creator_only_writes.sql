-- Tighten group_members writes to the group creator (or a member managing their OWN
-- row), matching the kwenta_push_group_members validator in migration 008.
--
-- The previous group_members_access policy (migration 004) granted FOR ALL to ANY
-- active member of the group, so a non-creator member could UPDATE/soft-DELETE any
-- other member's row (remove members, rename them) directly via PostgREST/RLS — broader
-- than the sync layer allows and not the intended membership-management model.
--
-- SELECT stays open to all members (they need to see who's in the group); only
-- INSERT/UPDATE/DELETE are restricted.

DROP POLICY IF EXISTS group_members_access ON public.group_members;

-- Read: any active member of the group, or the group creator.
CREATE POLICY group_members_read ON public.group_members
  FOR SELECT
  USING (
    public.is_group_member(group_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  );

-- Write: only the group creator, or a member acting on their own membership row.
CREATE POLICY group_members_write ON public.group_members
  FOR INSERT
  WITH CHECK (
    group_members.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  );

CREATE POLICY group_members_modify ON public.group_members
  FOR UPDATE
  USING (
    group_members.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  )
  WITH CHECK (
    group_members.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  );

CREATE POLICY group_members_delete ON public.group_members
  FOR DELETE
  USING (
    group_members.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  );
