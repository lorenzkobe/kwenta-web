-- Endpoint efficiency: single targeted realtime reconcile RPC + supporting indexes.

CREATE OR REPLACE FUNCTION public.kwenta_empty_reconcile_bundle()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profiles', '[]'::jsonb,
    'groups', '[]'::jsonb,
    'group_members', '[]'::jsonb,
    'bills', '[]'::jsonb,
    'bill_items', '[]'::jsonb,
    'item_splits', '[]'::jsonb,
    'settlements', '[]'::jsonb,
    'activity_log', '[]'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION public.kwenta_empty_reconcile_bundle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_empty_reconcile_bundle() TO authenticated;

CREATE OR REPLACE FUNCTION public.kwenta_reconcile_user_event(
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_bill jsonb;
  v_group jsonb;
  v_settlement jsonb;
  v_profile public.profiles;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_entity_type = 'bills' THEN
    v_bill := public.kwenta_fetch_bill_bundle(p_entity_id);
    IF v_bill IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    RETURN public.kwenta_empty_reconcile_bundle()
      || jsonb_build_object(
        'bills', COALESCE(jsonb_build_array(v_bill->'bill'), '[]'::jsonb),
        'bill_items', COALESCE(v_bill->'bill_items', '[]'::jsonb),
        'item_splits', COALESCE(v_bill->'item_splits', '[]'::jsonb)
      );
  ELSIF p_entity_type IN ('groups', 'group_members') THEN
    v_group_id := COALESCE((p_payload->>'group_id')::uuid, p_entity_id);
    IF v_group_id IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    v_group := public.kwenta_fetch_group_bundle(v_group_id);
    IF v_group IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    RETURN public.kwenta_empty_reconcile_bundle()
      || jsonb_build_object(
        'groups', COALESCE(jsonb_build_array(v_group->'group'), '[]'::jsonb),
        'group_members', COALESCE(v_group->'group_members', '[]'::jsonb)
      );
  ELSIF p_entity_type = 'settlements' THEN
    v_settlement := public.kwenta_fetch_settlement(p_entity_id);
    IF v_settlement IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    RETURN public.kwenta_empty_reconcile_bundle()
      || jsonb_build_object(
        'settlements', COALESCE(jsonb_build_array(v_settlement->'settlement'), '[]'::jsonb)
      );
  ELSIF p_entity_type = 'profiles' THEN
    SELECT * INTO v_profile
    FROM public.profiles p
    WHERE p.id = p_entity_id
      AND (
        p.id = v_uid
        OR (p.is_local IS TRUE AND p.owner_id = v_uid)
      );
    IF v_profile.id IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    RETURN public.kwenta_empty_reconcile_bundle()
      || jsonb_build_object(
        'profiles', jsonb_build_array(to_jsonb(v_profile))
      );
  END IF;

  RETURN public.kwenta_empty_reconcile_bundle();
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_reconcile_user_event(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_reconcile_user_event(text, uuid, jsonb) TO authenticated;

CREATE INDEX IF NOT EXISTS kwenta_notifications_recipient_created_idx
  ON public.kwenta_notifications (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS kwenta_notifications_unread_idx
  ON public.kwenta_notifications (recipient_id)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS bills_updated_at_idx
  ON public.bills (updated_at DESC);

CREATE INDEX IF NOT EXISTS group_members_group_updated_idx
  ON public.group_members (group_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS settlements_updated_at_idx
  ON public.settlements (updated_at DESC);

