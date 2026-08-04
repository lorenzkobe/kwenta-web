-- Migration 049: delivery must not depend on clients having canonicalized ids.
--
-- Personal rows were routed by literal id match: a settlement reached you only if
-- `from_user_id = auth.uid()` or `to_user_id = auth.uid()`, and a personal bill only if a split
-- carried your account id. But before someone links their local contact to your account, those
-- rows carry the LOCAL CONTACT's id. Canonicalization (client rewrite on link, plus the push
-- backstop in 042 and 045) is what eventually rewrites them — and any row that misses it is
-- invisible to the account it belongs to FOREVER, with nothing server-side noticing. Users saw
-- exactly this: some restored payments never appeared on the other device.
--
-- Fix: route READS by identity instead of by literal id, using kwenta_identity_ids (migration
-- 048) — the same relation `kwenta_canonical_user_id` (042) uses to rewrite, applied to reads so
-- delivery no longer waits on a rewrite.
--
-- READS ONLY. The first cut of this migration widened user_is_participant_on_personal_bill
-- itself, which looked like a visibility change but was not: that predicate is the USING clause of
-- bills_access / bill_items_access / item_splits_access (migration 007), and those are FOR ALL —
-- USING gates UPDATE and DELETE as well as SELECT — and it is also the WHERE clause of the push
-- validators kwenta_push_bills / _bill_items / _item_splits / _settlements (044). Widening it
-- therefore handed the account behind a linked contact write and delete authority over the
-- linker's personal bills. Mistype an email when linking a contact and a stranger could delete
-- your bills. So the predicate stays NARROW (its 007 body), and a separate read-only predicate
-- carries the widening:
--
--   user_is_participant_on_personal_bill -- literal id. Write authority + push validation.
--   user_can_read_personal_bill          -- identity set. Delivery only.
--
-- Widening note (reads): this can only expose a row to the account a contact was explicitly
-- linked to. Linking is done by the row's own owner and already means "this contact IS that
-- account", so the only data this surfaces is the linker's own.

-- Restore the narrow body from migration 007. This is the WRITE-authority predicate; every push
-- validator and FOR ALL policy that references it must keep meaning "a split literally carries
-- this account's id".
CREATE OR REPLACE FUNCTION public.user_is_participant_on_personal_bill(p_bill_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
      AND ish.user_id = p_user_id
      AND NOT COALESCE(ish.is_deleted, false)
      AND NOT COALESCE(bi.is_deleted, false)
  );
$$;

-- Read-only counterpart: matches any id representing the user, so a bill whose splits still carry
-- a not-yet-canonicalized local-contact id is still delivered to the account behind it.
CREATE OR REPLACE FUNCTION public.user_can_read_personal_bill(p_bill_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
      AND ish.user_id IN (SELECT id FROM public.kwenta_identity_ids(p_user_id))
      AND NOT COALESCE(ish.is_deleted, false)
      AND NOT COALESCE(bi.is_deleted, false)
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_read_personal_bill(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_can_read_personal_bill(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_read_personal_bill(uuid, uuid) TO service_role;

-- Additive SELECT-only policies. Permissive policies OR together, so these widen reads over the
-- FOR ALL policies from 007 without touching what those allow to be written or deleted.
DROP POLICY IF EXISTS bills_read_linked_identity ON bills;
CREATE POLICY bills_read_linked_identity ON bills
  FOR SELECT
  USING (
    bills.group_id IS NULL
    AND public.user_can_read_personal_bill(bills.id, auth.uid())
  );

DROP POLICY IF EXISTS bill_items_read_linked_identity ON bill_items;
CREATE POLICY bill_items_read_linked_identity ON bill_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.bills b
      WHERE b.id = bill_items.bill_id
        AND b.group_id IS NULL
        AND public.user_can_read_personal_bill(b.id, auth.uid())
    )
  );

DROP POLICY IF EXISTS item_splits_read_linked_identity ON item_splits;
CREATE POLICY item_splits_read_linked_identity ON item_splits
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.bill_items bi
      JOIN public.bills b ON b.id = bi.bill_id
      WHERE bi.id = item_splits.item_id
        AND b.group_id IS NULL
        AND public.user_can_read_personal_bill(b.id, auth.uid())
    )
  );

-- Bill delivery. Body from 007, with two changes: the personal branch uses the read predicate, and
-- the per-row function call is replaced by a set the planner can drive from an index.
--
-- With the pull cursor gone every bundle passes p_since = epoch, so `updated_at > p_since` selects
-- the whole table and the old shape evaluated user_is_participant_on_personal_bill once per row of
-- a GLOBAL bills scan — on every mutation, focus, reconnect and route change, for every user.
-- Driving the personal branch from item_splits.user_id (indexed) instead turns that into a lookup
-- of the caller's own splits.
CREATE OR REPLACE FUNCTION public.relevant_bill_ids_for_user()
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.bills b
  WHERE b.created_by = (SELECT auth.uid())
     OR (
       b.group_id IS NOT NULL
       AND public.is_group_member(b.group_id, (SELECT auth.uid()))
     )
  UNION
  SELECT bi.bill_id
  FROM public.bill_items bi
  JOIN public.item_splits ish ON ish.item_id = bi.id
  JOIN public.bills b2 ON b2.id = bi.bill_id
  WHERE b2.group_id IS NULL
    AND ish.user_id IN (SELECT i.id FROM public.kwenta_identity_ids((SELECT auth.uid())) AS i)
    AND NOT COALESCE(ish.is_deleted, false)
    AND NOT COALESCE(bi.is_deleted, false);
$$;

CREATE OR REPLACE FUNCTION public.bills_for_sync(p_since timestamptz)
RETURNS SETOF public.bills
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.*
  FROM public.bills b
  WHERE b.updated_at > p_since
    AND b.id IN (SELECT r.id FROM public.relevant_bill_ids_for_user() AS r);
$$;

-- Targeted realtime fetch. Body from 013, with the personal branch switched to the read predicate
-- so a bill whose splits are not yet canonicalized resolves instead of returning NULL and forcing
-- the caller down the fallback-pull path.
CREATE OR REPLACE FUNCTION public.kwenta_fetch_bill_bundle(p_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  b public.bills;
  items jsonb;
  splits jsonb;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO b
  FROM public.bills
  WHERE id = p_bill_id
    AND (
      created_by = v_uid
      OR (group_id IS NOT NULL AND public.is_group_member(group_id, v_uid))
      OR (group_id IS NULL AND public.user_can_read_personal_bill(p_bill_id, v_uid))
    );

  IF b.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(bi) ORDER BY bi.created_at), '[]'::jsonb) INTO items
  FROM public.bill_items bi
  WHERE bi.bill_id = p_bill_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(ish) ORDER BY ish.created_at), '[]'::jsonb) INTO splits
  FROM public.item_splits ish
  JOIN public.bill_items bi ON bi.id = ish.item_id
  WHERE bi.bill_id = p_bill_id;

  RETURN jsonb_build_object(
    'bill', to_jsonb(b),
    'bill_items', items,
    'item_splits', splits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_fetch_bill_bundle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_fetch_bill_bundle(uuid) TO authenticated;

-- Pull bundle: body from 028, with TWO changes.
--
-- 1. The personal-settlement predicate matches the identity set instead of the bare uid.
-- 2. The profiles clause also delivers local contacts LINKED TO the caller. Without this, change 1
--    hands a device settlement rows whose party id is a profile it will never receive, so
--    expandProfileIdsForSplitMatching cannot contain that id, computePairwiseNetBreakdown skips
--    the row, and the payment stays invisible on the very device the widening exists to reach.
--    This is a deliberate, narrow exception to "a user never receives another user's local
--    contacts": the only rows it adds are contacts explicitly linked to YOU, i.e. rows that
--    already assert "this contact IS your account".
--
-- Everything else is reproduced verbatim.
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
       AND (
         p.id = uid
         OR (p.is_local IS TRUE AND p.owner_id = uid)
         OR (p.is_local IS TRUE AND p.linked_profile_id = uid AND p.is_deleted IS FALSE)
       )),
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
         AND (
           s2.from_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
           OR s2.to_user_id IN (SELECT id FROM public.kwenta_identity_ids(uid))
         )
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
