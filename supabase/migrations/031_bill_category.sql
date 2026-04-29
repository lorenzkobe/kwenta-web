ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS category text
  CHECK (category IN ('food','transport','accommodation','utilities','entertainment','groceries','health','other'));
