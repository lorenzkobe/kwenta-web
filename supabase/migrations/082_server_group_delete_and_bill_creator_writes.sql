-- 082_server_group_delete_and_bill_creator_writes.sql
--
-- WHAT BROKE
-- 1. Deleting a group was a CLIENT-built cascade. `deleteGroup` read the group's bills, items, splits,
--    payments and memberships from the device's mirror and pushed a soft-delete for each. A device
--    never holds every row (it is sent only what it was a party to), so a bill another member added
--    that this device had not pulled, or a payment recorded since the last refresh, stayed live
--    under a deleted group, rows that belong to a group nobody can open any more. Deletion is server-authoritative (CLAUDE.md rule 2); this was the one cascade
--    still decided from a cache.
-- 2. Any member could rewrite any other member's group bill. 075's write rule for a group bill is
--    `kwenta_can_write_group` (active member OR the group's creator), so a member could retitle,
--    re-amount, re-assign or delete a bill someone else entered.
-- 3. Linking a contact whose account already had a membership row in the same group raised 23505.
--    081's `kwenta_canonicalize_on_link` rewrote the contact's `group_members.user_id` onto the
--    account id unless a LIVE account row existed; a SOFT-DELETED account row (the person was
--    removed earlier) is still a row under UNIQUE(group_id, user_id), so the rewrite collided and
--    the whole link transaction died.
--
-- THE SHAPE
-- (a) A group is deleted by ONE sweep, whichever way it is deleted. An AFTER UPDATE OF is_deleted
--     trigger on `groups` (WHEN the row goes from live to deleted) calls
--     `kwenta_sweep_group_children`, which soft-deletes, stamping
--     GREATEST(now(), updated_at + 1 microsecond) (the 048 stamp: 021b would otherwise keep a stored
--     row whose updated_at is ahead of the server clock, and the delete would silently not happen):
--       every live payment of the group, every live split and item under ANY bill of the group
--       (leftovers under an already-deleted bill included: an older client deleted bill rows
--       alone), every live bill of the group, and last every live membership.
--     So a group deleted through `kwenta_write`, through `kwenta_sync`'s per-row replay of a legacy
--     unsent row, or by `kwenta_delete_group` leaves no live child, and a stale device's cascade
--     cannot strand a bill it did not know about. An old client's own cascade still applies: its
--     child soft-deletes arrive after the trigger has deleted them, and an unchanged row passes
--     the content-equality check below (a stale child copy refuses the whole `kwenta_write`, 078).
--     The trigger is named to sort after 012's event trigger: the fan-out of an event reaches only
--     LIVE members, so the group-changed event must be emitted before the memberships go. Children
--     go before the memberships for the same reason, each in its own statement (AFTER ROW triggers
--     run at the end of a statement). The deletion reaches former members as before (024): their
--     pull bundle carries every row of a group they were ever in.
--     `kwenta_delete_group(p_group_id)` is the client endpoint. The caller is `auth.uid()` (active,
--     076) and must be the group's creator. It locks the group row, marks it deleted (the trigger
--     sweeps), writes one activity_log line (the shape the client's deleteGroup wrote: action
--     'deleted', entity_type 'group', description `Deleted group "<name>"`) and returns
--     `kwenta_write_echo`'s shape: per-table arrays of the group's CURRENT rows (the group, every
--     membership, bill, item, split and payment of it, as stored, every key present), so the device
--     mirrors the server's own stamps and learns of bills it never held. The rows are read from the
--     base tables, not through `kwenta_pull_rows_*`: that scope needs a LIVE membership, which the
--     creator no longer has. They are all rows of the caller's own group, so nothing else leaks.
--     Errors (P0001): a missing group -> 'This group no longer exists, or you no longer have access
--     to it.'; a caller who is not the creator -> 'Only the group creator can delete this group.'.
--     On a group that is already deleted it changes no group row and writes no log line; it runs
--     the same sweep and returns only the group row and its memberships (so a repeat call stays
--     cheap however much history the group has), which is enough for a stale device to mirror the
--     deletion. The group row is locked first so two concurrent deletes serialize.
--     What is swept, and what is not: from this migration on, a group that goes deleted by any
--     path leaves no live child, and a repeat `kwenta_delete_group` call sweeps again. Rows
--     ALREADY stranded under groups the old client cascade deleted before 082 are not touched by
--     this migration; sweeping them once is an optional data fix and the user's call.
--     RACE WITH A WRITER: `kwenta_group_open` reads the group row FOR SHARE, so a live write into
--     the group serialises with the delete's FOR UPDATE: it either commits first (the sweep then
--     deletes its rows) or waits for the delete and is refused. The reviewer reproduced the old
--     window with two sessions; the harness runs one, so the suite pins only the sequential case.
--     Deadlock: a BASED write locks its bill rows FOR UPDATE (081) and then wants the group FOR
--     SHARE, while the delete holds the group and wants those bill rows. Postgres aborts one of
--     them with 40P01 after deadlock_timeout; the RAISE rolls back that call whole, so nothing is
--     half-applied. The client classifies SQLSTATE class 40 as transport
--     (src/sync/write-errors.ts TRANSIENT_SQLSTATE_CLASSES), so an aborted write is replayed under
--     the same submission id, where the base check or `kwenta_group_open` then refuses it; an
--     aborted delete is retried by the user.
-- (b) A group bill is writable only by its creator. `kwenta_push_bills` / `kwenta_push_bill_items` /
--     `kwenta_push_item_splits` (079 bodies, the conversion checks kept) pass a write to a group
--     bill (row, items, splits; new or stored) only when the caller created the bill and is an
--     active member (`kwenta_can_write_group`), judged on the STORED row in the conflict WHERE
--     (CLAUDE.md: a validator must judge the stored row). Personal bills are unchanged (creator only).
--     User decisions 2026-10-25, two exceptions, each narrow:
--       * the group's CREATOR may write a soft-delete (incoming is_deleted true) of another
--         member's bill, items and splits, but only once the STORED group is deleted and only
--         changing is_deleted (plus updated_at/synced_at/device_id) of the stored row. Older
--         clients delete a group by pushing the cascade, group row first (`kwenta_write` and
--         `kwenta_sync` push groups before bills, items and splits), and a delete queued offline
--         replays it; refusing it would half-apply. While the group is live the group creator
--         can neither edit nor delete another member's bill, item or split.
--       * an active MEMBER may write `bills.paid_by` / `item_splits.user_id` when the new value is
--         `kwenta_canonical_user_id(stored value)` and nothing else of the row changed. A pre-081
--         client linking a contact pushed exactly that rewrite for bills it did not create (by the
--         time it arrives, 045's trigger has usually made it a no-op); 081 moved the rewrite into
--         the trigger, which bypasses the validators, so a current client no longer sends it. The
--         exception never lets the caller choose updated_at: an unchanged id keeps the stored
--         version, a changed one is stamped GREATEST(now(), stored + 1 microsecond), because a
--         future version would make 021b drop the creator's next unbased edit.
--       * No LIVE bill, item, split or payment can be written into a deleted group, by anyone
--         (`kwenta_group_open`, which also takes the group row FOR SHARE: see (a);
--         `kwenta_push_settlements` is 075's body plus that one predicate).
--         Soft-deletes stay allowed. It is a validator predicate, not part of
--         `kwenta_can_write_group`, which the old cascade relies on after the group row is deleted.
--     `kwenta_can_write_bill` (075) keeps its meaning (settlement bill tags use it); the new rule
--     is `kwenta_can_edit_bill`, shared by the three validators so they cannot drift apart.
--     Re-adding a removed member: `kwenta_push_group_members` already lets the group's creator
--     revive a stored row by its id (the client sends the existing id instead of minting one, which
--     is what collided with UNIQUE(group_id, user_id)). 082 adds only the deleted-group rule to it:
--     a LIVE membership (new, or a deleted one revived) into a deleted group is refused, an edit of a
--     row that is already live there (a rename) and soft-deletes pass (the old cascade), and the
--     link rewrite below never revives or rewrites a live row there.
-- (c) `kwenta_canonicalize_on_link` (081's body) never writes onto an existing (group, account)
--     row. For each membership of the contact: if the account already has a row in that group
--     (live or soft-deleted) and the contact's row is live, the account's row is revived
--     (is_deleted false, stamped) and the contact's row is soft-deleted; if the contact's row is
--     already deleted both are left alone; only when the account has no row at all is the contact's
--     row rewritten onto the account id. Never a 23505. In a DELETED group it neither revives the
--     account's row nor rewrites a live contact row onto the account.
--
-- BEHAVIOUR CHANGE (intended): 075's suite pinned "a member can edit a group bill someone else
-- created" as accepted; it is now refused, and that case was rewritten in the same change.
--
-- COST: a group delete is one lock, six set-based statements by group_id / join through the
-- group's bills (indexed), one insert and one echo read; nothing per row in a loop. Every LIVE group
-- write takes one shared tuple lock on its group row (kwenta_group_open). The
-- validators add the same primary-key lookups the old rule did (one more for a stored split's bill).
--
-- GRANTS: kwenta_delete_group derives the caller from auth.uid() and takes no acting-user
-- argument, so it is a client endpoint: REVOKE FROM PUBLIC, anon; GRANT authenticated, service_role
-- (073's allowlist names it). kwenta_can_edit_bill takes `uid`, so it is service_role only like
-- its siblings; the closing sweep restates that. kwenta_group_open takes no acting user but would
-- tell any caller whether a group id is deleted, so it is service_role only as well.
--
-- APPLY: before the client that calls kwenta_delete_group, or with it. The reverse order is safe
-- for old clients: their group delete (the group creator soft-deleting others' bills) and their
-- link push (the canonical-id rewrite) are the two exceptions above; what an old client can no
-- longer do is edit another member's bill, and its own writes to bills it created are unchanged.
-- A new client against a pre-082 server fails at the missing function and refuses the delete.

-- 1. The bill rule shared by the three validators (server-only: it takes the acting user)
CREATE OR REPLACE FUNCTION public.kwenta_can_edit_bill(p_bill_id uuid, uid uuid, p_deleting boolean)
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
            WHEN b.group_id IS NULL THEN b.created_by = uid
            ELSE (b.created_by = uid AND public.kwenta_can_write_group(b.group_id, uid))
              OR (COALESCE(p_deleting, false)
                  AND EXISTS (SELECT 1 FROM public.groups g
                              WHERE g.id = b.group_id AND g.created_by = uid AND g.is_deleted IS TRUE))
          END
  );
$$;

REVOKE ALL ON FUNCTION public.kwenta_can_edit_bill(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_can_edit_bill(uuid, uuid, boolean) TO service_role;

-- No live row may be written into a deleted group. Not folded into kwenta_can_write_group: the
-- old deleteGroup cascade relies on that helper after the group row has been deleted.
-- VOLATILE because FOR SHARE is not allowed in a STABLE function. The lock makes a live write
-- wait for a concurrent kwenta_delete_group (whose FOR UPDATE it conflicts with) and then re-read
-- the group as deleted, instead of judging a snapshot that predates the delete.
CREATE OR REPLACE FUNCTION public.kwenta_group_open(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  IF p_group_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT g.is_deleted INTO v_deleted FROM public.groups g WHERE g.id = p_group_id FOR SHARE;
  RETURN v_deleted IS NOT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_group_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_open(uuid) TO service_role;

-- 2. Push validators (079 bodies) with the group-bill rule
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
      created_at, updated_at, synced_at, is_deleted, device_id,
      original_currency, exchange_rate, rate_source, original_total
    )
    SELECT
      src.id, src.title, src.group_id, src.currency, src.created_by,
      public.kwenta_canonical_user_id(src.paid_by),
      src.total_amount, src.note, src.category, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id,
      src.original_currency, src.exchange_rate, src.rate_source, src.original_total
    FROM jsonb_populate_recordset(
      NULL::public.bills,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (
        (
          src.created_by = uid
          AND (src.group_id IS NULL OR public.kwenta_can_write_group(src.group_id, uid))
        )
        OR EXISTS (SELECT 1 FROM public.bills x WHERE x.id = src.id)
      )
      -- A half-set or non-positive conversion is refused here, not left to the CHECK, so the row
      -- drops out of `applied` instead of raising inside kwenta_sync's whole-bundle replay.
      AND public.kwenta_bill_conversion_ok(
        src.original_currency, src.currency, src.exchange_rate, src.rate_source, src.original_total)
      AND (COALESCE(src.is_deleted, false) OR public.kwenta_group_open(src.group_id))
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
      -- In the link exception below the server picks the version, never the caller.
      updated_at = CASE
        WHEN public.kwenta_can_edit_bill(tgt.id, uid, EXCLUDED.is_deleted) THEN EXCLUDED.updated_at
        WHEN EXCLUDED.paid_by = tgt.paid_by THEN tgt.updated_at
        ELSE GREATEST(now(), tgt.updated_at + interval '1 microsecond')
      END,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id,
      original_currency = EXCLUDED.original_currency,
      exchange_rate = EXCLUDED.exchange_rate,
      rate_source = EXCLUDED.rate_source,
      original_total = EXCLUDED.original_total
    WHERE tgt.created_by = EXCLUDED.created_by
      AND tgt.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
      AND (
        public.kwenta_can_edit_bill(tgt.id, uid, false)
        -- Old clients' group delete: the group row is already deleted by the time its bills are
        -- judged (groups are pushed first), and only is_deleted may differ from the stored row.
        OR (
          EXCLUDED.is_deleted IS TRUE
          AND public.kwenta_can_edit_bill(tgt.id, uid, true)
          AND to_jsonb(tgt) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
            = to_jsonb(EXCLUDED) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
        )
        -- A pre-081 contact link: an active member re-points the payer at the canonical account
        -- and changes nothing else of someone else's group bill. An unchanged payer passes too:
        -- the link's own profile row, pushed first in the same call, has already made 045's
        -- trigger rewrite it.
        OR (
          tgt.group_id IS NOT NULL
          AND public.kwenta_can_write_group(tgt.group_id, uid)
          AND EXCLUDED.paid_by = public.kwenta_canonical_user_id(tgt.paid_by)
          AND to_jsonb(tgt) - ARRAY['paid_by', 'updated_at', 'synced_at', 'device_id']
            = to_jsonb(EXCLUDED) - ARRAY['paid_by', 'updated_at', 'synced_at', 'device_id']
        )
      )
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
      id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id,
      original_amount
    )
    SELECT
      src.id, src.bill_id, src.name, src.amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted,
      src.device_id, src.original_amount
    FROM jsonb_populate_recordset(
      NULL::public.bill_items,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE public.kwenta_can_edit_bill(src.bill_id, uid, COALESCE(src.is_deleted, false))
      AND (COALESCE(src.is_deleted, false)
           OR public.kwenta_group_open((SELECT b.group_id FROM public.bills b WHERE b.id = src.bill_id)))
      AND (src.original_amount IS NULL
           OR (src.original_amount > '-Infinity'::numeric AND src.original_amount < 'Infinity'::numeric))
    ON CONFLICT (id) DO UPDATE SET
      bill_id = EXCLUDED.bill_id,
      name = EXCLUDED.name,
      amount = EXCLUDED.amount,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id,
      original_amount = EXCLUDED.original_amount
    -- The incoming parent was checked above; frozen, it is also the stored row's parent. The
    -- first arm is the bill's creator; the second is old clients' group delete (see kwenta_push_bills).
    WHERE tgt.bill_id = EXCLUDED.bill_id
      AND (
        public.kwenta_can_edit_bill(tgt.bill_id, uid, false)
        OR (
          EXCLUDED.is_deleted IS TRUE
          AND public.kwenta_can_edit_bill(tgt.bill_id, uid, true)
          AND to_jsonb(tgt) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
            = to_jsonb(EXCLUDED) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
        )
      )
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
      is_deleted, device_id, original_amount
    )
    SELECT
      src.id, src.item_id, public.kwenta_canonical_user_id(src.user_id), src.split_type, src.split_value,
      src.computed_amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id,
      src.original_amount
    FROM jsonb_populate_recordset(
      NULL::public.item_splits,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    -- A new split must pass the bill rule; an existing one is judged on its STORED parent below.
    WHERE (
        EXISTS (
          SELECT 1 FROM public.bill_items bi
          WHERE bi.id = src.item_id
            AND public.kwenta_can_edit_bill(bi.bill_id, uid, COALESCE(src.is_deleted, false))
        )
        OR EXISTS (SELECT 1 FROM public.item_splits x WHERE x.id = src.id)
      )
      AND (COALESCE(src.is_deleted, false)
           OR public.kwenta_group_open((
             SELECT b.group_id FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id
             WHERE bi.id = src.item_id)))
      AND (src.original_amount IS NULL
           OR (src.original_amount > '-Infinity'::numeric AND src.original_amount < 'Infinity'::numeric))
    ON CONFLICT (id) DO UPDATE SET
      item_id = EXCLUDED.item_id,
      user_id = EXCLUDED.user_id,
      split_type = EXCLUDED.split_type,
      split_value = EXCLUDED.split_value,
      computed_amount = EXCLUDED.computed_amount,
      created_at = EXCLUDED.created_at,
      updated_at = CASE
        WHEN EXISTS (SELECT 1 FROM public.bill_items bi
                     WHERE bi.id = tgt.item_id
                       AND public.kwenta_can_edit_bill(bi.bill_id, uid, EXCLUDED.is_deleted))
          THEN EXCLUDED.updated_at
        WHEN EXCLUDED.user_id = tgt.user_id THEN tgt.updated_at
        ELSE GREATEST(now(), tgt.updated_at + interval '1 microsecond')
      END,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id,
      original_amount = EXCLUDED.original_amount
    -- An item's bill_id is frozen, so the stored split's bill is the one judged here.
    WHERE tgt.item_id = EXCLUDED.item_id
      AND EXISTS (
        SELECT 1
        FROM public.bill_items bi
        JOIN public.bills b ON b.id = bi.bill_id
        WHERE bi.id = tgt.item_id
          AND (
            public.kwenta_can_edit_bill(b.id, uid, false)
            OR (
              EXCLUDED.is_deleted IS TRUE
              AND public.kwenta_can_edit_bill(b.id, uid, true)
              AND to_jsonb(tgt) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
                = to_jsonb(EXCLUDED) - ARRAY['is_deleted', 'updated_at', 'synced_at', 'device_id']
            )
            -- A pre-081 contact link: see kwenta_push_bills.
            OR (
              b.group_id IS NOT NULL
              AND public.kwenta_can_write_group(b.group_id, uid)
              AND EXCLUDED.user_id = public.kwenta_canonical_user_id(tgt.user_id)
              AND to_jsonb(tgt) - ARRAY['user_id', 'updated_at', 'synced_at', 'device_id']
                = to_jsonb(EXCLUDED) - ARRAY['user_id', 'updated_at', 'synced_at', 'device_id']
            )
          )
      )
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

-- 075's body; the only change is the deleted-group line.
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
      AND (COALESCE(src.is_deleted, false) OR public.kwenta_group_open(src.group_id))
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

-- 075's body; the only change is the deleted-group line.
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
    WHERE (
        EXISTS (SELECT 1 FROM public.groups g WHERE g.id = src.group_id AND g.created_by = uid)
        OR EXISTS (SELECT 1 FROM public.group_members m WHERE m.id = src.id)
      )
      -- Only a transition to live is refused: an edit of a row that is already live (a rename of a
      -- row stranded under a deleted group) passes, so renameSelf is not sunk by such a row.
      AND (COALESCE(src.is_deleted, false)
           OR EXISTS (SELECT 1 FROM public.group_members m WHERE m.id = src.id AND m.is_deleted IS FALSE)
           OR public.kwenta_group_open(src.group_id))
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
      -- The stored row decides (a concurrent sweep may have deleted it since the filter above):
      -- reviving it needs an open group.
      AND (EXCLUDED.is_deleted IS TRUE OR tgt.is_deleted IS FALSE OR public.kwenta_group_open(tgt.group_id))
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

REVOKE ALL ON FUNCTION public.kwenta_push_bills(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_group_members(jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO service_role;

-- Server-only (no acting user, but it deletes a group's contents): reached through the trigger and
-- kwenta_delete_group, never directly.
CREATE OR REPLACE FUNCTION public.kwenta_sweep_group_children(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.settlements s
     SET is_deleted = true, updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond')
   WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE;

  UPDATE public.item_splits sp
     SET is_deleted = true, updated_at = GREATEST(now(), sp.updated_at + interval '1 microsecond')
    FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
   WHERE sp.item_id = bi.id AND b.group_id = p_group_id AND sp.is_deleted IS FALSE;

  UPDATE public.bill_items bi
     SET is_deleted = true, updated_at = GREATEST(now(), bi.updated_at + interval '1 microsecond')
    FROM public.bills b
   WHERE bi.bill_id = b.id AND b.group_id = p_group_id AND bi.is_deleted IS FALSE;

  UPDATE public.bills b
     SET is_deleted = true, updated_at = GREATEST(now(), b.updated_at + interval '1 microsecond')
   WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE;

  UPDATE public.group_members gm
     SET is_deleted = true, updated_at = GREATEST(now(), gm.updated_at + interval '1 microsecond')
   WHERE gm.group_id = p_group_id AND gm.is_deleted IS FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_sweep_group_children(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_sweep_group_children(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.kwenta_on_group_deleted_sweep()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.kwenta_sweep_group_children(NEW.id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_on_group_deleted_sweep() FROM PUBLIC, anon, authenticated;

-- Fires after 012's `kwenta_groups_user_events` (same timing, name order): see the header.
DROP TRIGGER IF EXISTS kwenta_groups_z_sweep_children ON public.groups;
CREATE TRIGGER kwenta_groups_z_sweep_children
AFTER UPDATE OF is_deleted ON public.groups
FOR EACH ROW
WHEN (OLD.is_deleted IS FALSE AND NEW.is_deleted IS TRUE)
EXECUTE FUNCTION public.kwenta_on_group_deleted_sweep();

CREATE OR REPLACE FUNCTION public.kwenta_delete_group(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group public.groups%ROWTYPE;
  v_log uuid;
  v_repeat boolean := false;
BEGIN
  PERFORM public.kwenta_assert_caller_active();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_group FROM public.groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'This group no longer exists, or you no longer have access to it.';
  END IF;
  IF v_group.created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Only the group creator can delete this group.';
  END IF;

  IF v_group.is_deleted THEN
    -- A retry, or a stale device: the group is already marked. Sweep again, but echo only the group
    -- and its roster: the first call's echo carried the rest, and a repeat must not grow with history.
    PERFORM public.kwenta_sweep_group_children(p_group_id);
    v_repeat := true;
  ELSE
    -- The trigger sweeps the children and the memberships.
    UPDATE public.groups g
       SET is_deleted = true, updated_at = GREATEST(now(), g.updated_at + interval '1 microsecond')
     WHERE g.id = p_group_id;

    v_log := gen_random_uuid();
    INSERT INTO public.activity_log (
      id, group_id, user_id, action, entity_type, entity_id, description,
      created_at, updated_at, synced_at, is_deleted, device_id
    ) VALUES (
      v_log, p_group_id, v_uid, 'deleted', 'group', p_group_id,
      'Deleted group "' || v_group.name || '"',
      now(), now(), now(), false, 'server'
    );
  END IF;

  -- Read straight from the base tables: kwenta_write_echo filters through the caller's PULL scope,
  -- which no longer includes the roster once the creator's own membership is deleted.
  RETURN jsonb_build_object(
    'profiles', '[]'::jsonb,
    'groups', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
               FROM public.groups x WHERE x.id = p_group_id),
    'group_members', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                      FROM public.group_members x WHERE x.group_id = p_group_id),
    'bills', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
              FROM public.bills x WHERE NOT v_repeat AND x.group_id = p_group_id),
    'bill_items', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                   FROM public.bill_items x
                   WHERE NOT v_repeat
                     AND x.bill_id IN (SELECT b.id FROM public.bills b WHERE b.group_id = p_group_id)),
    'item_splits', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                    FROM public.item_splits x
                    WHERE NOT v_repeat
                      AND x.item_id IN (SELECT i.id FROM public.bill_items i
                                        JOIN public.bills b ON b.id = i.bill_id
                                        WHERE b.group_id = p_group_id)),
    'settlements', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                    FROM public.settlements x WHERE NOT v_repeat AND x.group_id = p_group_id),
    'activity_log', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                     FROM public.activity_log x WHERE x.id = v_log),
    'profile_peer_links', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_delete_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_delete_group(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_delete_group(uuid) TO service_role;

-- 3. 081's link rewrite, minus the 23505 on a membership row that already exists for the account
CREATE OR REPLACE FUNCTION public.kwenta_canonicalize_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old uuid := NEW.id;
  v_new uuid := NEW.linked_profile_id;
BEGIN
  IF v_new IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.linked_profile_id IS NOT DISTINCT FROM NEW.linked_profile_id THEN
    RETURN NULL;
  END IF;

  UPDATE public.item_splits
     SET user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE user_id = v_old;

  UPDATE public.bills
     SET paid_by = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE paid_by = v_old;

  UPDATE public.settlements
     SET from_user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE from_user_id = v_old;
  UPDATE public.settlements
     SET to_user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE to_user_id = v_old;

  -- group_members.user_id. UNIQUE(group_id, user_id) holds soft-deleted rows too, so a row is
  -- rewritten onto the account only when the account has NO row in that group at all. Where it
  -- has one, the contact's live membership is folded into it: the account's row is revived if it
  -- was removed, then the contact's row is soft-deleted. A contact row that is already deleted
  -- is left as it is. In a deleted group nothing is revived and no live row is rewritten.
  UPDATE public.group_members ga
     SET is_deleted = false, updated_at = GREATEST(now(), ga.updated_at + interval '1 microsecond')
   WHERE ga.user_id = v_new
     AND ga.is_deleted IS TRUE
     AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = ga.group_id AND g.is_deleted IS TRUE)
     AND EXISTS (
       SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = ga.group_id
          AND gm.user_id = v_old
          AND gm.is_deleted IS FALSE
     );

  UPDATE public.group_members gm
     SET is_deleted = true, updated_at = GREATEST(now(), gm.updated_at + interval '1 microsecond')
   WHERE gm.user_id = v_old
     AND gm.is_deleted IS FALSE
     AND EXISTS (
       SELECT 1 FROM public.group_members ga
        WHERE ga.group_id = gm.group_id
          AND ga.user_id = v_new
     );

  UPDATE public.group_members gm
     SET user_id = v_new, updated_at = GREATEST(now(), gm.updated_at + interval '1 microsecond')
   WHERE gm.user_id = v_old
     AND (gm.is_deleted IS TRUE
          OR NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = gm.group_id AND g.is_deleted IS TRUE))
     AND NOT EXISTS (
       SELECT 1 FROM public.group_members ga
        WHERE ga.group_id = gm.group_id
          AND ga.user_id = v_new
     );

  RETURN NULL;
END;
$$;

SELECT public.kwenta_revoke_acting_user_helpers();
