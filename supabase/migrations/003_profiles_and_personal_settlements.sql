-- Local profile metadata + personal (non-group) settlements

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_local BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_profile_id UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES profiles(id);

ALTER TABLE settlements
  ALTER COLUMN group_id DROP NOT NULL;

-- Replace settlements policy to allow personal payments between the two parties
DROP POLICY IF EXISTS settlements_access ON settlements;

CREATE POLICY settlements_access ON settlements
  FOR ALL USING (
    (
      group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = settlements.group_id
          AND user_id = auth.uid()
          AND NOT is_deleted
      )
    )
    OR (
      group_id IS NULL
      AND (from_user_id = auth.uid() OR to_user_id = auth.uid())
    )
  );
