-- Personal bills: split participants can read/write related rows (not only the creator).
-- Sync helpers so pull queries can see bills where the user is on an item_split.
--
-- Fixes: FK push failures when item_splits.user_id points at a local-only profile UUID
--        (client maps to linked_profile_id before upsert — see sync-service).
--        Participants not seeing bills on their device (RLS + pull scope).

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
      AND EXISTS (
        SELECT 1
        FROM public.bill_items bi
        JOIN public.item_splits ish ON ish.item_id = bi.id
        WHERE bi.bill_id = bills.id
          AND ish.user_id = auth.uid()
          AND NOT COALESCE(ish.is_deleted, false)
          AND NOT COALESCE(bi.is_deleted, false)
      )
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
            AND EXISTS (
              SELECT 1
              FROM public.bill_items bi2
              JOIN public.item_splits ish ON ish.item_id = bi2.id
              WHERE bi2.bill_id = b.id
                AND ish.user_id = auth.uid()
                AND NOT COALESCE(ish.is_deleted, false)
                AND NOT COALESCE(bi2.is_deleted, false)
            )
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
            AND EXISTS (
              SELECT 1
              FROM public.bill_items bi2
              JOIN public.item_splits ish ON ish.item_id = bi2.id
              WHERE bi2.bill_id = b.id
                AND ish.user_id = auth.uid()
                AND NOT COALESCE(ish.is_deleted, false)
                AND NOT COALESCE(bi2.is_deleted, false)
            )
          )
        )
    )
  );

-- PostgREST cannot express “created_by OR split participant” in one .or() filter; use DEFINER RPCs
-- that mirror the same rules as RLS (auth.uid() only).

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
        AND EXISTS (
          SELECT 1
          FROM public.bill_items bi
          JOIN public.item_splits ish ON ish.item_id = bi.id
          WHERE bi.bill_id = b.id
            AND ish.user_id = (SELECT auth.uid())
            AND NOT COALESCE(ish.is_deleted, false)
            AND NOT COALESCE(bi.is_deleted, false)
        )
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
      AND EXISTS (
        SELECT 1
        FROM public.bill_items bi
        JOIN public.item_splits ish ON ish.item_id = bi.id
        WHERE bi.bill_id = b.id
          AND ish.user_id = (SELECT auth.uid())
          AND NOT COALESCE(ish.is_deleted, false)
          AND NOT COALESCE(bi.is_deleted, false)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.bills_for_sync(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bills_for_sync(timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.relevant_bill_ids_for_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relevant_bill_ids_for_user() TO authenticated;
