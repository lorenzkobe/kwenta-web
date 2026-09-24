-- =============================================================================================
-- 075 — The push validators authorize the row they OVERWRITE, not only the row they receive.
-- =============================================================================================
--
-- What broke
-- ----------
-- Every `kwenta_push_<table>(arr, uid)` (the validators behind `kwenta_write` / `kwenta_sync`)
-- filtered the INCOMING rows and then ran `INSERT ... ON CONFLICT (id) DO UPDATE` with no
-- condition on the row already stored under that id. The incoming checks key on columns the
-- caller supplies — `created_by = uid`, `user_id = uid`, `is_local AND owner_id = uid` — so any
-- signed-in account could send a row that passed them under an id it had no right to, and the
-- update landed. Reproduced locally through `kwenta_write` by an account with no relationship to
-- the victim: another user's personal bill rewritten and soft-deleted; a membership row inserted
-- into another user's group (after which RLS let that account read the whole group); a bill
-- planted in a group the caller was not in (`created_by = uid` passed for ANY group_id); another
-- user's account profile rewritten and marked as the caller's local contact. Production had no
-- trace of any of these (read-only probe, 2026-09-24).
--
-- The rule now, for every validator
-- ---------------------------------
--   * A NEW row must pass the table's create rule (below).
--   * An EXISTING row is updated only when the STORED row passes the table's write rule
--     (`ON CONFLICT ... DO UPDATE ... WHERE`, which sees the stored row as `tgt` and the incoming
--     one as `EXCLUDED`). When that WHERE is false the row is neither written nor RETURNed, so it
--     drops out of `applied` and the client's NOT_STORED check reports it — the same outcome as a
--     row refused on the way in.
--   * Key columns never move on update: a bill's group and creator, an item's bill, a split's
--     item, a payment's group and bill, a membership's group, a group's creator, a profile's
--     owner and is_local, a log line's author and group, a peer link's owner/anchor/peer.
--     Otherwise a row could be dragged somewhere the caller may write and then edited there.
--
-- Per table (create rule / write rule on the stored row):
--   profiles            id = uid OR own local contact; /  the same, on the stored row
--                       an account row carries no link
--   groups              created_by = uid               /  stored created_by = uid
--   group_members       the group's creator            /  the group's creator; or your OWN row,
--                       (no self-join)                     kept as yours and not un-deleted
--   bills               created_by = uid, and for a    /  group bill: can_write_group;
--                       group bill can_write_group        personal: the creator only
--   bill_items, splits  the parent bill is writable    /  parent frozen, so the same check
--   settlements         group: can_write_group;        /  the same on the stored row
--                       personal: a party. A bill tag
--                       needs the bill visible to you
--                       (participants may tag) and live
--   activity_log        user_id = uid (+ group rule)   /  your own entries only
--   profile_peer_links  anchor is your live contact    /  stored owner = uid
--
-- `kwenta_can_write_group(group, uid)` = an ACTIVE member, or the group's creator. The creator arm
-- is not a convenience: `deleteGroup` (src/db/operations.ts) soft-deletes every membership,
-- the creator's own included, in the SAME submission and before the bills, items, splits and
-- payments it also deletes — an active-member-only rule would refuse the rest of the cascade.
--
-- What is deliberately narrower than before
-- -----------------------------------------
--   * A REMOVED member can no longer write to the group, including a bill they created (the old
--     `created_by = uid` arm let them edit group bills after removal).
--   * A non-creator can no longer insert membership rows. No flow does: only group creators add
--     members (`addExistingGroupMembers`), and there is no self-join/invite flow.
--   * A member can no longer write log lines attributed to someone else.
--   * A PARTICIPANT on someone else's personal bill can no longer edit it, its items or its
--     splits. The client's edit and delete were already creator-only; the old rule let the
--     debtor on a bill delete it or zero their own share. `deletePerson` now redistributes only
--     on bills the actor created (client change in the same release).
--   * An account profile can no longer carry `linked_profile_id`. Linking is for contacts; a
--     linked ACCOUNT row makes 045's canonicalize trigger rewrite every split and payment filed
--     under it to the other account — a self-link moved the caller's debts onto someone else.
--
-- Two cascades that used to half-apply now apply whole: a "must be live" parent check (a
-- payment's bill, a peer link's anchor) now applies to NEW rows only, because deleteGroup and
-- deletePerson delete the parent earlier in the same submission than its dependents. `kwenta_write`
-- runs each validator independently, so a refusal inside a cascade is a partial server write.
-- Every other write shape the client produces is covered, as accepted, by the 075 suite
-- (createBill personal/group, a member editing another member's group bill, roster changes,
-- createGroup, the deleteGroup cascade, linkProfileToRemote's id rewrites, group and personal
-- payments, renaming yourself in someone else's group).
--
-- Direct table writes
-- -------------------
-- The client writes these eight tables only through the validators (the one PostgREST write
-- left is `profiles`, from AuthProvider, and `kwenta_notifications`). Their `FOR ALL` RLS policies
-- are USING-only, so `created_by = auth.uid()` also admitted a direct INSERT into ANY group — the
-- same hole by another door. INSERT/UPDATE/DELETE/TRUNCATE are revoked from anon and authenticated
-- on those eight; `profiles` and `kwenta_notifications` keep their RLS-guarded writes but lose
-- TRUNCATE, which RLS does not govern at all. The only client code that upserts these tables
-- directly is `pushChanges` (sync-service.ts), the fallback for a database WITHOUT `kwenta_sync`
-- (pre-008) — it cannot meet this migration.
--
-- Known limit: an existing row is admitted on the way in by its id and judged by the ON CONFLICT
-- WHERE. If the row were HARD-deleted between those two steps it would be inserted unjudged by the
-- create rule; nothing but `admin_delete_user` hard-deletes, so this is accepted.
--
-- Cost: every push path, per row. The create rule and the write rule each cost the index lookups
-- the old incoming rule already did (primary keys, group_members(group_id, user_id)); a stored-row
-- check adds one per conflicting row. No new scans.
--
-- Deployment: apply any time. The client change in the same release (deletePerson touching only
-- your own personal bills; the offline push filter matching these rules) is what keeps a new
-- client from sending a refused row. An OLDER client still sends one when it deletes a contact who
-- is on someone else's personal bill, and that deletePerson then fails with "not stored"; its
-- offline filter may also replay a removed member's group bill or someone else's log line, which
-- is now refused. Installed PWAs keep the old build until their user taps Refresh, so expect
-- these for a while after deploy — each is a refused write, never a wrong one.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Helpers (server-only: they take the acting user as an argument — rule 5)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_can_write_group(p_group_id uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_group_member(p_group_id, uid)
      OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = p_group_id AND g.created_by = uid);
$$;

-- The bill rule shared by bills (stored row), bill_items and item_splits, so the three cannot
-- drift apart. A personal bill is its creator's alone: `updateBill`/`deleteBill` are creator-only
-- in the client, and the old participant arm let the debtor on a bill delete it or zero their
-- own share.
CREATE OR REPLACE FUNCTION public.kwenta_can_write_bill(p_bill_id uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bills b
    WHERE b.id = p_bill_id
      AND CASE
            WHEN b.group_id IS NOT NULL THEN public.kwenta_can_write_group(b.group_id, uid)
            ELSE b.created_by = uid
          END
  );
$$;

REVOKE ALL ON FUNCTION public.kwenta_can_write_group(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_can_write_bill(uuid, uuid)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_can_write_group(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_can_write_bill(uuid, uuid)  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Validators. Bodies are the live definitions (025/032/038/042/044/046) with the incoming
--    filter tightened and a WHERE on the conflict update; column lists are unchanged.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_push_profiles(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.profiles AS tgt (
      id, email, display_name, avatar_url, created_at, updated_at, synced_at, is_deleted, device_id,
      is_local, linked_profile_id, owner_id
    )
    SELECT
      src.id, src.email, src.display_name, src.avatar_url, src.created_at, src.updated_at, src.synced_at,
      src.is_deleted, src.device_id, src.is_local, src.linked_profile_id, src.owner_id
    FROM jsonb_populate_recordset(
      NULL::public.profiles,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (src.id = uid OR (src.is_local IS TRUE AND src.owner_id = uid))
      -- Linking is for contacts. An ACCOUNT row linked to another account routes every split and
      -- payment filed under it to that account (045's canonicalize trigger rewrites them), so a
      -- self-link would move the caller's debts onto someone else. is_local is frozen below, so
      -- checking the incoming row covers the stored one.
      AND (src.is_local IS TRUE OR src.linked_profile_id IS NULL)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id,
      is_local = EXCLUDED.is_local,
      linked_profile_id = EXCLUDED.linked_profile_id,
      owner_id = EXCLUDED.owner_id
    WHERE (tgt.id = uid OR (tgt.is_local IS TRUE AND tgt.owner_id = uid))
      AND tgt.is_local IS NOT DISTINCT FROM EXCLUDED.is_local
      AND tgt.owner_id IS NOT DISTINCT FROM EXCLUDED.owner_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_groups(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.groups AS tgt (
      id, name, currency, created_by, invite_code, created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.name, src.currency, src.created_by, src.invite_code, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.groups,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE src.created_by = uid
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      currency = EXCLUDED.currency,
      created_by = EXCLUDED.created_by,
      invite_code = EXCLUDED.invite_code,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    WHERE tgt.created_by = uid
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_group_members(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.group_members AS tgt (
      id, group_id, user_id, display_name, joined_at, created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.group_id, src.user_id, src.display_name, src.joined_at, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.group_members,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE EXISTS (SELECT 1 FROM public.groups g WHERE g.id = src.group_id AND g.created_by = uid)
       OR EXISTS (SELECT 1 FROM public.group_members m WHERE m.id = src.id)
    ON CONFLICT (id) DO UPDATE SET
      group_id = EXCLUDED.group_id,
      user_id = EXCLUDED.user_id,
      display_name = EXCLUDED.display_name,
      joined_at = EXCLUDED.joined_at,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    WHERE tgt.group_id = EXCLUDED.group_id
      AND (
        EXISTS (SELECT 1 FROM public.groups g WHERE g.id = tgt.group_id AND g.created_by = uid)
        OR (
          tgt.user_id = uid
          AND EXCLUDED.user_id = uid
          AND (tgt.is_deleted IS FALSE OR EXCLUDED.is_deleted IS TRUE)
        )
      )
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_bills(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.bills AS tgt (
      id, title, group_id, currency, created_by, paid_by, total_amount, note, category,
      created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.title, src.group_id, src.currency, src.created_by,
      public.kwenta_canonical_user_id(src.paid_by),
      src.total_amount, src.note, src.category, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.bills,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (
        src.created_by = uid
        AND (src.group_id IS NULL OR public.kwenta_can_write_group(src.group_id, uid))
      )
       OR EXISTS (SELECT 1 FROM public.bills x WHERE x.id = src.id)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      group_id = EXCLUDED.group_id,
      currency = EXCLUDED.currency,
      created_by = EXCLUDED.created_by,
      paid_by = EXCLUDED.paid_by,
      total_amount = EXCLUDED.total_amount,
      note = EXCLUDED.note,
      category = EXCLUDED.category,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    WHERE tgt.created_by = EXCLUDED.created_by
      AND tgt.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
      AND public.kwenta_can_write_bill(tgt.id, uid)
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_bill_items(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.bill_items AS tgt (
      id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.bill_id, src.name, src.amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted,
      src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.bill_items,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE public.kwenta_can_write_bill(src.bill_id, uid)
    ON CONFLICT (id) DO UPDATE SET
      bill_id = EXCLUDED.bill_id,
      name = EXCLUDED.name,
      amount = EXCLUDED.amount,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    -- The incoming parent was checked above; frozen, it is also the stored row's parent.
    WHERE tgt.bill_id = EXCLUDED.bill_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_item_splits(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.item_splits AS tgt (
      id, item_id, user_id, split_type, split_value, computed_amount, created_at, updated_at, synced_at,
      is_deleted, device_id
    )
    SELECT
      src.id, src.item_id, public.kwenta_canonical_user_id(src.user_id), src.split_type, src.split_value,
      src.computed_amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.item_splits,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE EXISTS (
      SELECT 1 FROM public.bill_items bi
      WHERE bi.id = src.item_id AND public.kwenta_can_write_bill(bi.bill_id, uid)
    )
    ON CONFLICT (id) DO UPDATE SET
      item_id = EXCLUDED.item_id,
      user_id = EXCLUDED.user_id,
      split_type = EXCLUDED.split_type,
      split_value = EXCLUDED.split_value,
      computed_amount = EXCLUDED.computed_amount,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    -- As for items: the incoming parent was checked, and it is frozen. An item's bill_id is
    -- frozen too, so the item cannot have been moved under the split either.
    WHERE tgt.item_id = EXCLUDED.item_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_settlements(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.settlements AS tgt (
      id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency, is_settled, label, method, created_at, updated_at,
      synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.group_id, src.bill_id, src.bundle_id,
      public.kwenta_canonical_user_id(src.from_user_id),
      public.kwenta_canonical_user_id(src.to_user_id),
      src.amount, src.currency, src.is_settled,
      src.label, src.method, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.settlements,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (
        (src.group_id IS NOT NULL AND public.kwenta_can_write_group(src.group_id, uid))
        OR (src.group_id IS NULL AND (src.from_user_id = uid OR src.to_user_id = uid))
      )
      -- Tagging a payment to a bill needs the bill to be yours to see, not to edit: the debtor on
      -- a personal bill records their payment against it. The bill must be live only for a NEW
      -- payment — bill_id is frozen on update, and a cascade (deleteGroup, deletePerson) deletes
      -- the bill earlier in the same submission than the payment tagged to it.
      AND (
        src.bill_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.bills b
          WHERE b.id = src.bill_id
            AND (b.is_deleted IS FALSE OR EXISTS (SELECT 1 FROM public.settlements x WHERE x.id = src.id))
            AND CASE
                  WHEN b.group_id IS NOT NULL THEN public.kwenta_can_write_group(b.group_id, uid)
                  ELSE b.created_by = uid OR public.user_is_participant_on_personal_bill(b.id, uid)
                END
        )
      )
    ON CONFLICT (id) DO UPDATE SET
      group_id = EXCLUDED.group_id,
      bill_id = EXCLUDED.bill_id,
      bundle_id = EXCLUDED.bundle_id,
      from_user_id = EXCLUDED.from_user_id,
      to_user_id = EXCLUDED.to_user_id,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      is_settled = EXCLUDED.is_settled,
      label = EXCLUDED.label,
      method = EXCLUDED.method,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    -- Group frozen, so the incoming group check covers the stored row. A personal payment must
    -- ALREADY name the caller: naming yourself in the incoming row is exactly the forgery.
    WHERE tgt.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
      AND tgt.bill_id IS NOT DISTINCT FROM EXCLUDED.bill_id
      AND (tgt.group_id IS NOT NULL OR tgt.from_user_id = uid OR tgt.to_user_id = uid)
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_activity_log(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.activity_log AS tgt (
      id, group_id, user_id, action, entity_type, entity_id, description, created_at, updated_at, synced_at,
      is_deleted, device_id
    )
    SELECT
      src.id, src.group_id, src.user_id, src.action, src.entity_type, src.entity_id, src.description,
      src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
    FROM jsonb_populate_recordset(
      NULL::public.activity_log,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE src.user_id = uid
      AND (src.group_id IS NULL OR public.kwenta_can_write_group(src.group_id, uid))
    ON CONFLICT (id) DO UPDATE SET
      group_id = EXCLUDED.group_id,
      user_id = EXCLUDED.user_id,
      action = EXCLUDED.action,
      entity_type = EXCLUDED.entity_type,
      entity_id = EXCLUDED.entity_id,
      description = EXCLUDED.description,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    WHERE tgt.user_id = uid
      AND tgt.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_profile_peer_links(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
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
    -- The anchor must be live only for a NEW link: deletePerson deletes the contact earlier in the
    -- same submission than the links anchored on it.
    WHERE EXISTS (
        SELECT 1
        FROM public.profiles a
        WHERE a.id = src.anchor_profile_id
          AND a.is_local IS TRUE
          AND a.owner_id = uid
          AND (a.is_deleted IS FALSE
               OR EXISTS (SELECT 1 FROM public.profile_peer_links x WHERE x.id = src.id))
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
      device_id = EXCLUDED.device_id
    WHERE tgt.owner_user_id = uid
      AND tgt.anchor_profile_id = EXCLUDED.anchor_profile_id
      AND tgt.peer_profile_id = EXCLUDED.peer_profile_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

-- CREATE OR REPLACE keeps existing ACLs; restated so this file alone states the contract.
REVOKE ALL ON FUNCTION public.kwenta_push_profiles(jsonb, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_groups(jsonb, uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_group_members(jsonb, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bills(jsonb, uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_settlements(jsonb, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profiles(jsonb, uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_groups(jsonb, uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_group_members(jsonb, uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid)        TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid)        TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_activity_log(jsonb, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_profile_peer_links(jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The direct `profiles` door. AuthProvider still upserts the caller's own row through
--    PostgREST, and the `profiles_update` policy (`auth.uid() = id OR own contact`) lets any
--    column of your own row change — so a direct UPDATE could link your account to another
--    (moving your debts, see above) or make it `is_local` with `owner_id` = someone else, which
--    lands it in their phonebook under any name. RLS cannot compare OLD with NEW; a trigger can.
--    SECURITY INVOKER on purpose: `current_user` is then the role doing the write, so the guard
--    applies to a client role writing the table directly and not to the validator (a DEFINER
--    function running as the owner, which filters the same rows itself) or to server jobs.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_profiles_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.is_local IS DISTINCT FROM OLD.is_local OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    RAISE EXCEPTION 'cannot change is_local or owner_id of a profile' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_local IS NOT TRUE AND NEW.linked_profile_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.linked_profile_id IS DISTINCT FROM OLD.linked_profile_id) THEN
    RAISE EXCEPTION 'an account profile cannot be linked to another profile' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.is_local IS TRUE AND NEW.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'a local contact must be owned by its creator' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS kwenta_profiles_guard_identity_trg ON public.profiles;
CREATE TRIGGER kwenta_profiles_guard_identity_trg
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.kwenta_profiles_guard_identity();

-- ---------------------------------------------------------------------------------------------
-- 4. No direct writes on the synced tables
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.bills, public.bill_items, public.item_splits, public.settlements, public.activity_log,
  public.groups, public.group_members, public.profile_peer_links
FROM anon, authenticated;
REVOKE TRUNCATE ON public.profiles, public.kwenta_notifications FROM anon, authenticated;

SELECT public.kwenta_revoke_acting_user_helpers();

-- Post-condition. A REVOKE by a role that did not grant the privilege only WARNS; abort instead
-- of reporting success with a door still open.
DO $$
DECLARE
  t text; r text; p text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bills', 'bill_items', 'item_splits', 'settlements', 'activity_log',
                           'groups', 'group_members', 'profile_peer_links'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION '075: % still has % on public.%', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.kwenta_can_write_group(uuid, uuid)',
                           'public.kwenta_can_write_bill(uuid, uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '075: % is executable by a client role', f;
    END IF;
  END LOOP;
END;
$$;
