-- bill_items / item_splits / bills policies from 005 referenced the same tables they
-- protect, causing "infinite recursion detected in policy for relation bill_items".
-- Use SECURITY DEFINER helpers so participant checks bypass RLS (same pattern as 004).

CREATE OR REPLACE FUNCTION public.user_is_participant_on_personal_bill(p_bill_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
      AND ish.user_id = p_user_id
      AND NOT COALESCE(ish.is_deleted, false)
      AND NOT COALESCE(bi.is_deleted, false)
  );
$$;

REVOKE ALL ON FUNCTION public.user_is_participant_on_personal_bill(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_is_participant_on_personal_bill(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_participant_on_personal_bill(uuid, uuid) TO service_role;

DROP POLICY IF EXISTS bills_access ON bills;
DROP POLICY IF EXISTS bill_items_access ON bill_items;
DROP POLICY IF EXISTS item_splits_access ON item_splits;

CREATE POLICY bills_access ON bills
  FOR ALL
  USING (
    created_by = auth.uid()
    OR (
      bills.group_id IS NOT NULL
      AND public.is_group_member(bills.group_id, auth.uid())
    )
    OR (
      bills.group_id IS NULL
      AND public.user_is_participant_on_personal_bill(bills.id, auth.uid())
    )
  );

CREATE POLICY bill_items_access ON bill_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.bills b
      WHERE b.id = bill_items.bill_id
        AND (
          b.created_by = auth.uid()
          OR (
            b.group_id IS NOT NULL
            AND public.is_group_member(b.group_id, auth.uid())
          )
          OR (
            b.group_id IS NULL
            AND public.user_is_participant_on_personal_bill(b.id, auth.uid())
          )
        )
    )
  );

CREATE POLICY item_splits_access ON item_splits
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.bill_items bi
      JOIN public.bills b ON b.id = bi.bill_id
      WHERE bi.id = item_splits.item_id
        AND (
          b.created_by = auth.uid()
          OR (
            b.group_id IS NOT NULL
            AND public.is_group_member(b.group_id, auth.uid())
          )
          OR (
            b.group_id IS NULL
            AND public.user_is_participant_on_personal_bill(b.id, auth.uid())
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.bills_for_sync(p_since timestamptz)
RETURNS SETOF public.bills
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.*
  FROM public.bills b
  WHERE b.updated_at > p_since
    AND (
      b.created_by = (SELECT auth.uid())
      OR (
        b.group_id IS NOT NULL
        AND public.is_group_member(b.group_id, (SELECT auth.uid()))
      )
      OR (
        b.group_id IS NULL
        AND public.user_is_participant_on_personal_bill(b.id, (SELECT auth.uid()))
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.relevant_bill_ids_for_user()
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.bills b
  WHERE
    b.created_by = (SELECT auth.uid())
    OR (
      b.group_id IS NOT NULL
      AND public.is_group_member(b.group_id, (SELECT auth.uid()))
    )
    OR (
      b.group_id IS NULL
      AND public.user_is_participant_on_personal_bill(b.id, (SELECT auth.uid()))
    );
$$;
