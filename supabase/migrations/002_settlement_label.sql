-- Optional note shown in payment history (group context + global lists)
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
