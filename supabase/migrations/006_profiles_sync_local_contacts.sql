-- Allow each user to sync local contacts they own (is_local + owner_id = self).
-- Those rows satisfy item_splits.user_id → profiles(id) for local-only assignees.

DROP POLICY IF EXISTS profiles_own ON profiles;

CREATE POLICY profiles_select ON profiles
  FOR SELECT
  USING (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
  );

CREATE POLICY profiles_insert ON profiles
  FOR INSERT
  WITH CHECK (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
  );

CREATE POLICY profiles_update ON profiles
  FOR UPDATE
  USING (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
  )
  WITH CHECK (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
  );

CREATE POLICY profiles_delete ON profiles
  FOR DELETE
  USING (
    auth.uid() = id
    OR (is_local = true AND owner_id = auth.uid())
  );
