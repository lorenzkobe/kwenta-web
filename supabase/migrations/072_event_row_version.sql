-- 072_event_row_version.sql
--
-- WHAT BROKE: nothing returned a wrong answer — every save cost its author a full sync.
--
-- A write fires one `kwenta_user_events` row per changed bill, item, split, settlement or
-- membership row, per recipient (012), and the author is a recipient of its own write. The client
-- could not tell those echoes from someone else's edit: an event said only "bill B changed". So each
-- one was reconciled, and since one save echoes back as a burst (bill + item + every split), the
-- burst was coalesced into a full `kwenta_sync` round trip — the complete ~213 kB bundle — to
-- re-download rows the write had just mirrored from its own response.
--
-- THE SHAPE NOW: every row trigger adds the version of the row that fired it to the payload it
-- already builds:
--
--     row = {"table": TG_TABLE_NAME, "id": <that row's id>, "updated_at": <its stored updated_at>}
--
-- The client skips an event only when its mirror holds that row at EXACTLY that version and synced
-- (src/sync/realtime-events.ts). Another member's edit is a different version, so it is never
-- skipped; neither is anything the client cannot read with certainty. Three details are deliberate:
--   * `row` names the CHANGED row, not the entity the event is filed under: an item or split event
--     is filed under its bill (`entity_type = 'bills'`) but carries the item or split; the `groups`
--     refresh a membership change emits carries the `group_members` row that caused it (no extra
--     SELECT per trigger, and a mirrored group row cannot hide a membership change).
--   * A hard DELETE carries `row = null`, keyed on TG_OP: the item and split triggers report
--     `op = 'UPDATE'` for every change including a delete (012), so the client cannot use `op`.
--     The app soft-deletes; a hard delete comes from maintenance, and must not look mirrored.
--   * `updated_at` is taken in an AFTER trigger, so it is the stored value (after 021b's
--     server-wins BEFORE trigger), rendered by to_jsonb exactly as the read paths render it.
--
-- Unchanged: recipients, event types, entity ids and every existing payload key.
-- `kwenta_reconcile_user_event` (028) reads only `group_id`. An older client ignores `row`.
--
-- `kwenta_fanout_personal_bill_participants` builds its own payload, so it takes the row as a new
-- argument: DROP + CREATE (a new signature), with its REVOKE restated. Its body is 033's otherwise.
-- The two event writers are revoked from `anon`/`authenticated` explicitly (end of file).
--
-- APPLY: before or with the client that reads `row`; either order is safe (an old client ignores
-- the key, a new client without it reconciles as before).

/** The `row` value for an event fired by (p_table, p_id) at p_updated_at; null for a DELETE. */
CREATE OR REPLACE FUNCTION public.kwenta_event_row_version(
  p_tg_op text,
  p_table text,
  p_id uuid,
  p_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_tg_op = 'DELETE' OR p_id IS NULL OR p_updated_at IS NULL THEN NULL
    ELSE jsonb_build_object('table', p_table, 'id', p_id, 'updated_at', p_updated_at)
  END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_event_row_version(text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.kwenta_fanout_personal_bill_participants(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.kwenta_fanout_personal_bill_participants(
  p_bill_id uuid,
  p_creator_id uuid,
  p_event_type text,
  p_op text,
  p_row jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_payload jsonb := jsonb_build_object('bill_id', p_bill_id, 'group_id', NULL, 'row', p_row);
BEGIN
  IF p_creator_id IS NOT NULL THEN
    PERFORM public.kwenta_emit_user_event(p_creator_id, p_event_type, 'bills', p_bill_id, p_op, v_payload);
  END IF;

  -- No is_deleted filter (033): a deletion must reach every historical participant.
  FOR r IN
    SELECT DISTINCT ish.user_id
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
  LOOP
    IF r.user_id IS NOT NULL AND r.user_id <> p_creator_id THEN
      PERFORM public.kwenta_emit_user_event(r.user_id, p_event_type, 'bills', p_bill_id, p_op, v_payload);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fanout_personal_bill_participants(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.kwenta_on_bill_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid := COALESCE(NEW.id, OLD.id);
  v_group_id uuid := COALESCE(NEW.group_id, OLD.group_id);
  v_creator uuid := COALESCE(NEW.created_by, OLD.created_by);
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'bill_changed', 'bills', v_bill_id, TG_OP,
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id, 'row', v_row)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', TG_OP, v_row);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_on_bill_item_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid := COALESCE(NEW.bill_id, OLD.bill_id);
  v_group_id uuid;
  v_creator uuid;
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
  IF v_bill_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT b.group_id, b.created_by INTO v_group_id, v_creator
  FROM public.bills b
  WHERE b.id = v_bill_id;

  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'bill_changed', 'bills', v_bill_id, 'UPDATE',
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id, 'row', v_row)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', 'UPDATE', v_row);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_on_item_split_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_id uuid := COALESCE(NEW.item_id, OLD.item_id);
  v_bill_id uuid;
  v_group_id uuid;
  v_creator uuid;
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
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
      v_group_id, 'bill_changed', 'bills', v_bill_id, 'UPDATE',
      jsonb_build_object('bill_id', v_bill_id, 'group_id', v_group_id, 'row', v_row)
    );
  ELSE
    PERFORM public.kwenta_fanout_personal_bill_participants(v_bill_id, v_creator, 'bill_changed', 'UPDATE', v_row);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_on_settlement_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_id uuid := COALESCE(NEW.id, OLD.id);
  v_group_id uuid := COALESCE(NEW.group_id, OLD.group_id);
  v_from uuid := COALESCE(NEW.from_user_id, OLD.from_user_id);
  v_to uuid := COALESCE(NEW.to_user_id, OLD.to_user_id);
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'settlement_changed', 'settlements', v_entity_id, TG_OP,
      jsonb_build_object('group_id', v_group_id, 'row', v_row)
    );
  ELSE
    IF v_from IS NOT NULL THEN
      PERFORM public.kwenta_emit_user_event(
        v_from, 'settlement_changed', 'settlements', v_entity_id, TG_OP,
        jsonb_build_object('from_user_id', v_from, 'to_user_id', v_to, 'row', v_row)
      );
    END IF;
    IF v_to IS NOT NULL AND v_to <> v_from THEN
      PERFORM public.kwenta_emit_user_event(
        v_to, 'settlement_changed', 'settlements', v_entity_id, TG_OP,
        jsonb_build_object('from_user_id', v_from, 'to_user_id', v_to, 'row', v_row)
      );
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_on_group_member_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid := COALESCE(NEW.group_id, OLD.group_id);
  v_entity_id uuid := COALESCE(NEW.id, OLD.id);
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'group_member_changed', 'group_members', v_entity_id, TG_OP,
      jsonb_build_object('group_id', v_group_id, 'row', v_row)
    );
    -- The group-metadata refresh hint carries the MEMBER row that caused it (see the header).
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'group_changed', 'groups', v_group_id, 'UPDATE',
      jsonb_build_object('group_id', v_group_id, 'row', v_row)
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_on_group_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id uuid := COALESCE(NEW.id, OLD.id);
  v_row jsonb := public.kwenta_event_row_version(TG_OP, TG_TABLE_NAME, NEW.id, NEW.updated_at);
BEGIN
  IF v_group_id IS NOT NULL THEN
    PERFORM public.kwenta_fanout_group_event(
      v_group_id, 'group_changed', 'groups', v_group_id, TG_OP,
      jsonb_build_object('group_id', v_group_id, 'row', v_row)
    );
  END IF;
  RETURN NULL;
END;
$$;

-- The event writers. 012 revoked them from PUBLIC only; Supabase's default privileges can grant
-- `anon`/`authenticated` EXECUTE on public functions regardless (see 068/070), and a signed-in
-- user able to call them could write any event, with any `row`, into anyone's feed. Only these
-- SECURITY DEFINER triggers call them, which run as the owner.
REVOKE ALL ON FUNCTION public.kwenta_emit_user_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_fanout_group_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

