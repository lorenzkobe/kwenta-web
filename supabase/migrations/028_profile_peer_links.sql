-- Manual peer links: anchor = user's local contact, peer = another profile id (group member, etc.).
-- Synced like other Kwenta tables; RLS restricts rows to owner_user_id = auth.uid().

CREATE TABLE public.profile_peer_links (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  anchor_profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  peer_profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  device_id text NOT NULL DEFAULT '',
  CONSTRAINT profile_peer_links_distinct_endpoints CHECK (anchor_profile_id <> peer_profile_id)
);

CREATE UNIQUE INDEX profile_peer_links_anchor_peer_active_idx
  ON public.profile_peer_links (anchor_profile_id, peer_profile_id)
  WHERE is_deleted IS FALSE;

CREATE INDEX profile_peer_links_owner_updated_idx
  ON public.profile_peer_links (owner_user_id, updated_at DESC);

ALTER TABLE public.profile_peer_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_peer_links_select_own
  ON public.profile_peer_links
  FOR SELECT
  USING (owner_user_id = (SELECT auth.uid()));

CREATE POLICY profile_peer_links_insert_own
  ON public.profile_peer_links
  FOR INSERT
  WITH CHECK (owner_user_id = (SELECT auth.uid()));

CREATE POLICY profile_peer_links_update_own
  ON public.profile_peer_links
  FOR UPDATE
  USING (owner_user_id = (SELECT auth.uid()))
  WITH CHECK (owner_user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.kwenta_push_profile_peer_links(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.profile_peer_links AS tgt (
    id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT
    src.id,
    uid,
    src.anchor_profile_id,
    src.peer_profile_id,
    src.created_at,
    src.updated_at,
    src.synced_at,
    src.is_deleted,
    src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.profile_peer_links,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE EXISTS (
      SELECT 1
      FROM public.profiles a
      WHERE a.id = src.anchor_profile_id
        AND a.is_local IS TRUE
        AND a.owner_id = uid
        AND a.is_deleted IS FALSE
    )
    AND src.anchor_profile_id <> src.peer_profile_id
  ON CONFLICT (id) DO UPDATE SET
    owner_user_id = EXCLUDED.owner_user_id,
    anchor_profile_id = EXCLUDED.anchor_profile_id,
    peer_profile_id = EXCLUDED.peer_profile_id,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

REVOKE ALL ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.kwenta_build_pull_bundle(p_since timestamptz, uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profiles',
    (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
     FROM public.profiles p
     WHERE p.updated_at > p_since
       AND (p.id = uid OR (p.is_local IS TRUE AND p.owner_id = uid))),
    'groups',
    (SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
     FROM public.groups g
     WHERE g.id IN (
         SELECT gm.group_id FROM public.group_members gm
         WHERE gm.user_id = uid
       )
       AND (
         g.updated_at > p_since
         OR EXISTS (
           SELECT 1 FROM public.group_members gm2
           WHERE gm2.group_id = g.id
             AND gm2.user_id = uid
             AND gm2.updated_at > p_since
         )
       )),
    'group_members',
    (SELECT COALESCE(jsonb_agg(to_jsonb(gm)), '[]'::jsonb)
     FROM public.group_members gm
     WHERE gm.updated_at > p_since
       AND (
         gm.user_id = uid
         OR gm.group_id IN (
           SELECT m.group_id FROM public.group_members m
           WHERE m.user_id = uid AND m.is_deleted IS FALSE
         )
       )),
    'bills',
    (SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
     FROM public.bills_for_sync(p_since) AS b),
    'bill_items',
    (SELECT COALESCE(jsonb_agg(to_jsonb(bi)), '[]'::jsonb)
     FROM public.bill_items bi
     WHERE bi.updated_at > p_since
       AND bi.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())),
    'item_splits',
    (SELECT COALESCE(jsonb_agg(to_jsonb(ish)), '[]'::jsonb)
     FROM public.item_splits ish
     WHERE ish.updated_at > p_since
       AND ish.item_id IN (
         SELECT bi2.id FROM public.bill_items bi2
         WHERE bi2.bill_id IN (SELECT id FROM public.relevant_bill_ids_for_user())
       )),
    'settlements',
    (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
     FROM (
       SELECT s.*
       FROM public.settlements s
       WHERE s.updated_at > p_since
         AND s.group_id IS NOT NULL
         AND s.group_id IN (
           SELECT gm.group_id FROM public.group_members gm
           WHERE gm.user_id = uid
         )
       UNION ALL
       SELECT s2.*
       FROM public.settlements s2
       WHERE s2.updated_at > p_since
         AND s2.group_id IS NULL
         AND (s2.from_user_id = uid OR s2.to_user_id = uid)
     ) AS s),
    'activity_log',
    (SELECT COALESCE(jsonb_agg(to_jsonb(al)), '[]'::jsonb)
     FROM public.activity_log al
     WHERE al.updated_at > p_since
       AND (
         al.user_id = uid
         OR (
           al.group_id IS NOT NULL
           AND al.group_id IN (
             SELECT gm.group_id FROM public.group_members gm
             WHERE gm.user_id = uid AND gm.is_deleted IS FALSE
           )
         )
       )),
    'profile_peer_links',
    (SELECT COALESCE(jsonb_agg(to_jsonb(ppl)), '[]'::jsonb)
     FROM public.profile_peer_links ppl
     WHERE ppl.updated_at > p_since
       AND ppl.owner_user_id = uid)
  );
$$;

CREATE OR REPLACE FUNCTION public.kwenta_sync(p_since timestamptz, p_push jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  PERFORM public.kwenta_push_profiles(coalesce(p_push->'profiles', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_groups(coalesce(p_push->'groups', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_group_members(coalesce(p_push->'group_members', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_bills(coalesce(p_push->'bills', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_bill_items(coalesce(p_push->'bill_items', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_item_splits(coalesce(p_push->'item_splits', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_settlements(coalesce(p_push->'settlements', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_activity_log(coalesce(p_push->'activity_log', '[]'::jsonb), uid);
  PERFORM public.kwenta_push_profile_peer_links(coalesce(p_push->'profile_peer_links', '[]'::jsonb), uid);

  RETURN public.kwenta_build_pull_bundle(p_since, uid);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_sync(timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb) TO service_role;

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
    'activity_log', '[]'::jsonb,
    'profile_peer_links', '[]'::jsonb
  );
$$;

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
  v_link public.profile_peer_links;
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
  ELSIF p_entity_type = 'profile_peer_links' THEN
    SELECT * INTO v_link
    FROM public.profile_peer_links ppl
    WHERE ppl.id = p_entity_id
      AND ppl.owner_user_id = v_uid;
    IF v_link.id IS NULL THEN
      RETURN public.kwenta_empty_reconcile_bundle();
    END IF;
    RETURN public.kwenta_empty_reconcile_bundle()
      || jsonb_build_object(
        'profile_peer_links', jsonb_build_array(to_jsonb(v_link))
      );
  END IF;

  RETURN public.kwenta_empty_reconcile_bundle();
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_empty_reconcile_bundle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_empty_reconcile_bundle() TO authenticated;

REVOKE ALL ON FUNCTION public.kwenta_reconcile_user_event(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_reconcile_user_event(text, uuid, jsonb) TO authenticated;
