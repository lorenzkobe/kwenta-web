-- Fix "infinite recursion detected in policy for relation group_members" by never
-- evaluating RLS on group_members inside group_members policies. Use a SECURITY DEFINER
-- helper so membership checks bypass RLS.
--
-- Also belt-and-suspenders: ensure profile columns from 003 exist if an older DB
-- only ran 001.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_local BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_profile_id UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES profiles(id);

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id = p_user_id
      AND NOT is_deleted
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid) TO service_role;

-- Policies that referenced group_members in EXISTS subqueries (recursive)

DROP POLICY IF EXISTS groups_member_read ON groups;
DROP POLICY IF EXISTS group_members_access ON group_members;
DROP POLICY IF EXISTS bills_access ON bills;
DROP POLICY IF EXISTS bill_items_access ON bill_items;
DROP POLICY IF EXISTS item_splits_access ON item_splits;
DROP POLICY IF EXISTS settlements_access ON settlements;
DROP POLICY IF EXISTS activity_log_access ON activity_log;

-- groups: members can read; creators keep groups_creator_write from 001
CREATE POLICY groups_member_read ON groups
  FOR SELECT USING (public.is_group_member(id, auth.uid()));

-- group_members: anyone in the group, or the group creator (first member / adds others)
CREATE POLICY group_members_access ON group_members
  FOR ALL
  USING (
    public.is_group_member(group_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  )
  WITH CHECK (
    public.is_group_member(group_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
    )
  );

CREATE POLICY bills_access ON bills
  FOR ALL USING (
    created_by = auth.uid()
    OR (
      bills.group_id IS NOT NULL
      AND public.is_group_member(bills.group_id, auth.uid())
    )
  );

CREATE POLICY bill_items_access ON bill_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.bills b
      WHERE b.id = bill_items.bill_id
        AND (
          b.created_by = auth.uid()
          OR (
            b.group_id IS NOT NULL
            AND public.is_group_member(b.group_id, auth.uid())
          )
        )
    )
  );

CREATE POLICY item_splits_access ON item_splits
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.bill_items bi
      JOIN public.bills b ON b.id = bi.bill_id
      WHERE bi.id = item_splits.item_id
        AND (
          b.created_by = auth.uid()
          OR (
            b.group_id IS NOT NULL
            AND public.is_group_member(b.group_id, auth.uid())
          )
        )
    )
  );

CREATE POLICY settlements_access ON settlements
  FOR ALL USING (
    (
      settlements.group_id IS NOT NULL
      AND public.is_group_member(settlements.group_id, auth.uid())
    )
    OR (
      settlements.group_id IS NULL
      AND (settlements.from_user_id = auth.uid() OR settlements.to_user_id = auth.uid())
    )
  );

CREATE POLICY activity_log_access ON activity_log
  FOR ALL USING (
    activity_log.user_id = auth.uid()
    OR (
      activity_log.group_id IS NOT NULL
      AND public.is_group_member(activity_log.group_id, auth.uid())
    )
  );

-- If 002 / 003 were never applied on this database
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
ALTER TABLE settlements ALTER COLUMN group_id DROP NOT NULL;
