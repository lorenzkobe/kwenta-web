-- Add 'quantity' to the allowed split_type values on item_splits.
ALTER TABLE item_splits
  DROP CONSTRAINT item_splits_split_type_check;

ALTER TABLE item_splits
  ADD CONSTRAINT item_splits_split_type_check
    CHECK (split_type IN ('equal', 'percentage', 'custom', 'quantity'));
