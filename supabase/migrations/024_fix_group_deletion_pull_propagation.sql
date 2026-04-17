-- After a group is deleted, the creator soft-deletes groups, bills, settlements, and
-- group_members.  The pull bundle previously filtered groups and settlements with
-- `gm.is_deleted IS FALSE`, so once a member's row was soft-deleted the group_id
-- dropped out of the pull filter — the is_deleted=TRUE group and settlement records
-- never reached other members, leaving them with stale balances on a deleted group.
--
-- Fix: use every membership row the user has ever had (any is_deleted state) as the
-- source of group IDs for the groups and settlements pull.  The updated_at > p_since
-- guard still ensures we only send records that actually changed since the last sync.

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
         -- All groups this user has ever been a member of (active or soft-deleted),
         -- so that is_deleted=TRUE propagates after group deletion.
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
           -- Same as groups: include every group the user was ever a member of so
           -- is_deleted=TRUE settlement records reach them after group deletion.
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
       ))
  );
$$;
