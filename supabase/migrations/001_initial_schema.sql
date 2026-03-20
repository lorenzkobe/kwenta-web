-- Kwenta Bill Splitter — Initial Schema
-- All tables mirror the local Dexie schema with sync fields.

-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Groups
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PHP',
  created_by UUID NOT NULL REFERENCES profiles(id),
  invite_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Group members
CREATE TABLE IF NOT EXISTS group_members (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  display_name TEXT NOT NULL DEFAULT '',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT '',
  UNIQUE(group_id, user_id)
);

-- Bills
CREATE TABLE IF NOT EXISTS bills (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  group_id UUID REFERENCES groups(id),
  currency TEXT NOT NULL DEFAULT 'PHP',
  created_by UUID NOT NULL REFERENCES profiles(id),
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Bill items
CREATE TABLE IF NOT EXISTS bill_items (
  id UUID PRIMARY KEY,
  bill_id UUID NOT NULL REFERENCES bills(id),
  name TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Item splits
CREATE TABLE IF NOT EXISTS item_splits (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES bill_items(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  split_type TEXT NOT NULL CHECK (split_type IN ('equal', 'percentage', 'custom')),
  split_value NUMERIC(12,4) NOT NULL DEFAULT 0,
  computed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Settlements
CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id),
  from_user_id UUID NOT NULL REFERENCES profiles(id),
  to_user_id UUID NOT NULL REFERENCES profiles(id),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'PHP',
  is_settled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY,
  group_id UUID REFERENCES groups(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'settled')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('bill', 'bill_item', 'item_split', 'settlement', 'group')),
  entity_id UUID NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  device_id TEXT NOT NULL DEFAULT ''
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_bills_group ON bills(group_id);
CREATE INDEX IF NOT EXISTS idx_bills_created_by ON bills(created_by);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_item_splits_item ON item_splits(item_id);
CREATE INDEX IF NOT EXISTS idx_item_splits_user ON item_splits(user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_group ON activity_log(group_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- RLS policies (enable row-level security)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/write their own profile
CREATE POLICY profiles_own ON profiles
  FOR ALL USING (auth.uid() = id);

-- Groups: members can read groups they belong to
CREATE POLICY groups_member_read ON groups
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM group_members WHERE group_id = groups.id AND user_id = auth.uid() AND NOT is_deleted)
  );

CREATE POLICY groups_creator_write ON groups
  FOR ALL USING (created_by = auth.uid());

-- Group members: members can read/write within their groups
CREATE POLICY group_members_access ON group_members
  FOR ALL USING (
    EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_members.group_id AND gm.user_id = auth.uid() AND NOT gm.is_deleted)
  );

-- Bills: accessible if created by user or in a group the user belongs to
CREATE POLICY bills_access ON bills
  FOR ALL USING (
    created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM group_members WHERE group_id = bills.group_id AND user_id = auth.uid() AND NOT is_deleted)
  );

-- Bill items: accessible if parent bill is accessible
CREATE POLICY bill_items_access ON bill_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM bills
      WHERE bills.id = bill_items.bill_id
      AND (bills.created_by = auth.uid()
        OR EXISTS (SELECT 1 FROM group_members WHERE group_id = bills.group_id AND user_id = auth.uid() AND NOT is_deleted))
    )
  );

-- Item splits: accessible if parent item is accessible
CREATE POLICY item_splits_access ON item_splits
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM bill_items
      JOIN bills ON bills.id = bill_items.bill_id
      WHERE bill_items.id = item_splits.item_id
      AND (bills.created_by = auth.uid()
        OR EXISTS (SELECT 1 FROM group_members WHERE group_id = bills.group_id AND user_id = auth.uid() AND NOT is_deleted))
    )
  );

-- Settlements: accessible to group members
CREATE POLICY settlements_access ON settlements
  FOR ALL USING (
    EXISTS (SELECT 1 FROM group_members WHERE group_id = settlements.group_id AND user_id = auth.uid() AND NOT is_deleted)
  );

-- Activity log: accessible if user or in relevant group
CREATE POLICY activity_log_access ON activity_log
  FOR ALL USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM group_members WHERE group_id = activity_log.group_id AND user_id = auth.uid() AND NOT is_deleted)
  );
