-- 074_caller_scoped_rls_helpers.sql
--
-- WHAT BROKE: anyone could ask whether any user is in a group or on a bill. The RLS helpers
-- `is_group_member(group, user)` (004), `user_is_participant_on_personal_bill(bill, user)` and
-- `user_can_read_personal_bill(bill, user)` (049) are SECURITY DEFINER and take the user as an
-- ARGUMENT, so the ten policies that call them could pass `auth.uid()`. A policy runs as the
-- querying role, so the helpers had to stay executable by `anon` and `authenticated` — and with
-- the user as an argument, `POST /rest/v1/rpc/is_group_member {p_group_id, p_user_id}` answered for
-- anyone, signed in or not, given two uuids. 073 left them open for exactly this reason.
--
-- THE SHAPE NOW:
--   * Three one-argument wrappers — `caller_is_group_member(group)`,
--     `caller_is_participant_on_personal_bill(bill)`, `caller_can_read_personal_bill(bill)` — pass
--     `auth.uid()` themselves, so a caller can only ever ask about itself (anon: always false).
--     Each holds a COPY of its helper's predicate, on purpose, for speed (see section 1); the 074
--     suite checks every copy against its helper. The two-argument helpers are untouched.
--   * The ten policies are rewritten with `ALTER POLICY ... USING`, which replaces only the
--     expression: name, command, roles (`public`) and permissiveness are untouched. Each expression
--     is the pre-074 one with `helper(x, auth.uid())` replaced by `caller_helper(x)`, nothing else.
--   * The two-argument helpers become service_role only (rule 5). Every other caller is SECURITY
--     DEFINER and runs as the owner: the push validators, the bundle fetches, the pull predicate
--     and the repair plan keep calling them with other users' ids as before.
--   * The wrappers are granted to `anon` as well as `authenticated`: the policies are `TO public`,
--     so an anon table read evaluates them, and without EXECUTE it would fail instead of reading
--     nothing. They are safe to hand to anon because they cannot name anyone else.
-- Nothing a user can read or write changes. Pinned by supabase/tests/sql/074_caller_scoped_rls_helpers,
-- which compares, for every account in a fixture, the rows readable under RLS from all seven
-- tables with the PRE-074 predicates evaluated directly.
--
-- COST: one SECURITY DEFINER call per policy evaluation, as before. Bench at 9.9k bills (RLS
-- count, best of 3): bills 316-324 ms before, 310-324 ms after; item_splits 651-716 ms before,
-- 637-674 ms after.
--
-- APPLY: no client change (the client never calls these helpers). Apply any time.

-- ---------------------------------------------------------------------------------------------
-- 1. Caller-scoped wrappers
-- ---------------------------------------------------------------------------------------------
-- Each body is the two-argument helper's body (004 / 049) with `p_user_id` replaced by
-- `auth.uid()`. Deliberately a copy: a SECURITY DEFINER function with a SET clause is never
-- inlined and each call switches security context and search_path, so a wrapper that CALLED the
-- helper (or a shared plain-SQL rule) made RLS reads 4.5-8x slower at 9.9k bills (bills 316 ms ->
-- 1.4-2.6 s). The copies are held together by the 074 suite, which checks every wrapper against
-- its helper for every fixture account and object. Change one, change both.
CREATE OR REPLACE FUNCTION public.caller_is_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id = auth.uid()
      AND NOT is_deleted
  );
$$;

CREATE OR REPLACE FUNCTION public.caller_is_participant_on_personal_bill(p_bill_id uuid)
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
      AND ish.user_id = auth.uid()
      AND NOT COALESCE(ish.is_deleted, false)
      AND NOT COALESCE(bi.is_deleted, false)
  );
$$;

CREATE OR REPLACE FUNCTION public.caller_can_read_personal_bill(p_bill_id uuid)
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
      AND ish.user_id IN (SELECT id FROM public.kwenta_identity_ids(auth.uid()))
      AND NOT COALESCE(ish.is_deleted, false)
      AND NOT COALESCE(bi.is_deleted, false)
  );
$$;

REVOKE ALL ON FUNCTION public.caller_is_group_member(uuid)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.caller_is_participant_on_personal_bill(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.caller_can_read_personal_bill(uuid)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_is_group_member(uuid)                 TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.caller_is_participant_on_personal_bill(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.caller_can_read_personal_bill(uuid)          TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The ten policies
-- ---------------------------------------------------------------------------------------------
ALTER POLICY activity_log_access ON public.activity_log
  USING ((user_id = auth.uid()) OR ((group_id IS NOT NULL) AND public.caller_is_group_member(group_id)));

ALTER POLICY bill_items_access ON public.bill_items
  USING (EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = bill_items.bill_id
      AND ((b.created_by = auth.uid())
        OR ((b.group_id IS NOT NULL) AND public.caller_is_group_member(b.group_id))
        OR ((b.group_id IS NULL) AND public.caller_is_participant_on_personal_bill(b.id)))));

ALTER POLICY bill_items_read_linked_identity ON public.bill_items
  USING (EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = bill_items.bill_id
      AND b.group_id IS NULL
      AND public.caller_can_read_personal_bill(b.id)));

ALTER POLICY bills_access ON public.bills
  USING ((created_by = auth.uid())
    OR ((group_id IS NOT NULL) AND public.caller_is_group_member(group_id))
    OR ((group_id IS NULL) AND public.caller_is_participant_on_personal_bill(id)));

ALTER POLICY bills_read_linked_identity ON public.bills
  USING ((group_id IS NULL) AND public.caller_can_read_personal_bill(id));

ALTER POLICY group_members_read ON public.group_members
  USING (public.caller_is_group_member(group_id)
    OR (EXISTS (SELECT 1 FROM public.groups g
                WHERE g.id = group_members.group_id AND g.created_by = auth.uid())));

ALTER POLICY groups_member_read ON public.groups
  USING (public.caller_is_group_member(id));

ALTER POLICY item_splits_access ON public.item_splits
  USING (EXISTS (
    SELECT 1 FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE bi.id = item_splits.item_id
      AND ((b.created_by = auth.uid())
        OR ((b.group_id IS NOT NULL) AND public.caller_is_group_member(b.group_id))
        OR ((b.group_id IS NULL) AND public.caller_is_participant_on_personal_bill(b.id)))));

ALTER POLICY item_splits_read_linked_identity ON public.item_splits
  USING (EXISTS (
    SELECT 1 FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE bi.id = item_splits.item_id
      AND b.group_id IS NULL
      AND public.caller_can_read_personal_bill(b.id)));

ALTER POLICY settlements_access ON public.settlements
  USING (((group_id IS NOT NULL) AND public.caller_is_group_member(group_id))
    OR ((group_id IS NULL) AND ((from_user_id = auth.uid()) OR (to_user_id = auth.uid()))));

-- ---------------------------------------------------------------------------------------------
-- 3. The two-argument helpers become server-only
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_group_member(uuid, uuid)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_is_participant_on_personal_bill(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_can_read_personal_bill(uuid, uuid)          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.user_is_participant_on_personal_bill(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_can_read_personal_bill(uuid, uuid)          TO service_role;

SELECT public.kwenta_revoke_acting_user_helpers();

-- Post-condition. A REVOKE by a role that did not grant the privilege only WARNS, so if
-- production's grants came from another grantor the probe would stay open while this migration
-- reported success. Checked on 2026-09-24 that postgres granted them all; this aborts regardless.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.is_group_member(uuid, uuid)',
                           'public.user_can_read_personal_bill(uuid, uuid)',
                           'public.user_is_participant_on_personal_bill(uuid, uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '074: % is still executable by a client role', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.caller_is_group_member(uuid)',
                           'public.caller_can_read_personal_bill(uuid)',
                           'public.caller_is_participant_on_personal_bill(uuid)'] LOOP
    IF NOT (has_function_privilege('anon', f, 'EXECUTE') AND has_function_privilege('authenticated', f, 'EXECUTE')) THEN
      RAISE EXCEPTION '074: % is not executable by anon and authenticated; RLS reads would fail', f;
    END IF;
  END LOOP;
END;
$$;
