-- Realtime fanout stream for offline-first clients.
-- Clients subscribe to events filtered by recipient user_id and then fetch/apply relevant rows to local Dexie.

CREATE TABLE IF NOT EXISTS public.kwenta_user_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  op TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kwenta_user_events_user_created_idx
  ON public.kwenta_user_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS kwenta_user_events_user_entity_idx
  ON public.kwenta_user_events (user_id, entity_type, entity_id);

ALTER TABLE public.kwenta_user_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kwenta_user_events_select_own ON public.kwenta_user_events;
CREATE POLICY kwenta_user_events_select_own
  ON public.kwenta_user_events
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- No client inserts/updates/deletes; events are server-emitted (triggers / RPCs).
REVOKE ALL ON public.kwenta_user_events FROM PUBLIC;
GRANT SELECT ON public.kwenta_user_events TO authenticated;

-- Helper to emit a single event row.
CREATE OR REPLACE FUNCTION public.kwenta_emit_user_event(
  p_user_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_op text,
  p_payload jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.kwenta_user_events(user_id, event_type, entity_type, entity_id, op, payload)
  VALUES (p_user_id, p_event_type, p_entity_type, p_entity_id, p_op, p_payload);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_emit_user_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC;

-- Fan out an event to all active members of a group.
CREATE OR REPLACE FUNCTION public.kwenta_fanout_group_event(
  p_group_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_op text,
  p_payload jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT gm.user_id
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND NOT COALESCE(gm.is_deleted, false)
  LOOP
    PERFORM public.kwenta_emit_user_event(r.user_id, p_event_type, p_entity_type, p_entity_id, p_op, p_payload);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fanout_group_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC;

-- Emit settlement events (group -> all members, personal -> both parties).
CREATE OR REPLACE FUNCTION public.kwenta_on_settlement_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
  v_from uuid;
  v_to uuid;
  v_entity_id uuid;
  v_op text;
BEGIN
  v_op := TG_OP;
  v_entity_id := COALESCE(NEW.id, OLD.id);
  v_group_id := COALESCE(NEW.group_id, OLD.group_id);
  v_from := COALESCE(NEW.from_user_id, OLD.from_user_id);
  v_to := COALESCE(NEW.to_user_id, OLD.to_user_id);

  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'settlement_changed',
      'settlements',
      v_entity_id,
      v_op,
      jsonb_build_object('group_id', v_group_id)
    );
  ELSE
    IF v_from IS NOT NULL THEN
      PERFORM public.kwenta_emit_user_event(
        v_from,
        'settlement_changed',
        'settlements',
        v_entity_id,
        v_op,
        jsonb_build_object('from_user_id', v_from, 'to_user_id', v_to)
      );
    END IF;
    IF v_to IS NOT NULL AND v_to <> v_from THEN
      PERFORM public.kwenta_emit_user_event(
        v_to,
        'settlement_changed',
        'settlements',
        v_entity_id,
        v_op,
        jsonb_build_object('from_user_id', v_from, 'to_user_id', v_to)
      );
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_settlements_user_events ON public.settlements;
CREATE TRIGGER kwenta_settlements_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.settlements
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_settlement_changed();

-- Emit group membership change events (so recipients can refresh group + members lists).
CREATE OR REPLACE FUNCTION public.kwenta_on_group_member_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
  v_entity_id uuid;
  v_op text;
BEGIN
  v_op := TG_OP;
  v_group_id := COALESCE(NEW.group_id, OLD.group_id);
  v_entity_id := COALESCE(NEW.id, OLD.id);
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'group_member_changed',
      'group_members',
      v_entity_id,
      v_op,
      jsonb_build_object('group_id', v_group_id)
    );
    -- Also notify all members that the group metadata may need a refresh (e.g. invite code/name changes elsewhere).
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'group_changed',
      'groups',
      v_group_id,
      'UPDATE',
      jsonb_build_object('group_id', v_group_id)
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_group_members_user_events ON public.group_members;
CREATE TRIGGER kwenta_group_members_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.group_members
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_group_member_changed();

-- Emit group change events to all members.
CREATE OR REPLACE FUNCTION public.kwenta_on_group_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid;
  v_entity_id uuid;
  v_op text;
BEGIN
  v_op := TG_OP;
  v_group_id := COALESCE(NEW.id, OLD.id);
  v_entity_id := v_group_id;
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'group_changed',
      'groups',
      v_entity_id,
      v_op,
      jsonb_build_object('group_id', v_group_id)
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_groups_user_events ON public.groups;
CREATE TRIGGER kwenta_groups_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.groups
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_group_changed();

-- Emit bill events:
-- - Group bills: fan out to all group members.
-- - Personal bills: fan out to creator + all active split participants.
CREATE OR REPLACE FUNCTION public.kwenta_fanout_personal_bill_participants(
  p_bill_id uuid,
  p_creator_id uuid,
  p_event_type text,
  p_op text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF p_creator_id IS NOT NULL THEN
    PERFORM public.kwenta_emit_user_event(
      p_creator_id,
      p_event_type,
      'bills',
      p_bill_id,
      p_op,
      jsonb_build_object('bill_id', p_bill_id, 'group_id', NULL)
    );
  END IF;

  FOR r IN
    SELECT DISTINCT ish.user_id
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
      AND NOT COALESCE(bi.is_deleted, false)
      AND NOT COALESCE(ish.is_deleted, false)
  LOOP
    IF r.user_id IS NOT NULL AND r.user_id <> p_creator_id THEN
      PERFORM public.kwenta_emit_user_event(
        r.user_id,
        p_event_type,
        'bills',
        p_bill_id,
        p_op,
        jsonb_build_object('bill_id', p_bill_id, 'group_id', NULL)
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fanout_personal_bill_participants(uuid, uuid, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.kwenta_on_bill_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid;
  v_group_id uuid;
  v_creator uuid;
  v_op text;
BEGIN
  v_op := TG_OP;
  v_bill_id := COALESCE(NEW.id, OLD.id);
  v_group_id := COALESCE(NEW.group_id, OLD.group_id);
  v_creator := COALESCE(NEW.created_by, OLD.created_by);

  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'bill_changed',
      'bills',
      v_bill_id,
      v_op,
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', v_op);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_bills_user_events ON public.bills;
CREATE TRIGGER kwenta_bills_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.bills
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_bill_changed();

-- When items or splits change, emit bill_changed for the parent bill (participants may change).
CREATE OR REPLACE FUNCTION public.kwenta_on_bill_item_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid;
  v_group_id uuid;
  v_creator uuid;
  v_op text;
BEGIN
  v_op := TG_OP;
  v_bill_id := COALESCE(NEW.bill_id, OLD.bill_id);
  IF v_bill_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT b.group_id, b.created_by INTO v_group_id, v_creator
  FROM public.bills b
  WHERE b.id = v_bill_id;

  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'bill_changed',
      'bills',
      v_bill_id,
      'UPDATE',
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', 'UPDATE');
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_bill_items_user_events ON public.bill_items;
CREATE TRIGGER kwenta_bill_items_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.bill_items
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_bill_item_changed();

CREATE OR REPLACE FUNCTION public.kwenta_on_item_split_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_id uuid;
  v_bill_id uuid;
  v_group_id uuid;
  v_creator uuid;
BEGIN
  v_item_id := COALESCE(NEW.item_id, OLD.item_id);
  IF v_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT bi.bill_id INTO v_bill_id
  FROM public.bill_items bi
  WHERE bi.id = v_item_id;

  IF v_bill_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT b.group_id, b.created_by INTO v_group_id, v_creator
  FROM public.bills b
  WHERE b.id = v_bill_id;

  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id,
      'bill_changed',
      'bills',
      v_bill_id,
      'UPDATE',
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', 'UPDATE');
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_item_splits_user_events ON public.item_splits;
CREATE TRIGGER kwenta_item_splits_user_events
AFTER INSERT OR UPDATE OR DELETE ON public.item_splits
FOR EACH ROW EXECUTE FUNCTION public.kwenta_on_item_split_changed();

-- Ensure the table is included in Supabase Realtime publication (best-effort).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'kwenta_user_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.kwenta_user_events';
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    -- Publication may not exist in some local setups.
    NULL;
  WHEN duplicate_object THEN
    NULL;
END;
$$;

