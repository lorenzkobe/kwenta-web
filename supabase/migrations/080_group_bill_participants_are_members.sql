-- 080_group_bill_participants_are_members.sql
--
-- WHAT BROKE: members were told "Cannot create a group bill with non-member participant(s)" for
-- people who ARE in the group. The Add bill dialog lists the roster from the server
-- (`kwenta_group_detail`), but the only membership check on a group bill's people ran on the
-- client, against this device's Dexie mirror of `group_members`. A mirror that had not caught up
-- (a member added from another device, a roster that never reached this one) refused real members,
-- the caller included. The client now refreshes its roster on a miss (`src/sync/group-mirror.ts`);
-- this migration makes the SERVER the judge, so a device that cannot refresh (offline, then queued)
-- still cannot store a bill naming someone the group has never had.
--
-- WHY IT MATTERS: a payer or split id with no membership row is invisible to every other member
-- (the pull bundle's privacy boundary) and renders as "Unknown" in balances and settle-up. Nothing
-- on the server refused one: the push validators check only that the CALLER may write the bill.
--
-- THE RULE: a live `item_splits.user_id` or `bills.paid_by` on a live GROUP bill that a `kwenta_write`
-- call stores must belong to someone who has a membership row in that group, active or not, UNLESS
-- the bill already named that person before this call. Former members pass on purpose: editing an
-- old bill re-submits its splits as new rows, and refusing a removed member's historical share would
-- make that bill uneditable. Ids compare through `kwenta_canonical_user_id` on BOTH sides: splits and
-- payers are stored canonical (042, 079), membership rows are not, so a linked contact's local id on
-- the roster still matches the account id on the split. Deleted rows are not checked (cascades delete
-- whatever they find).
--
-- LEGACY NEVER-MEMBERS: the client had no membership guard on `createBill` until e6ed5e0 (2026-06-25;
-- the app's first commit is 2026-06-07), and 043's repair is operator-run and rewrites only ids it can
-- resolve to a roster member, so live group bills can still name someone the group never had. Judging
-- every participant of every touched bill would refuse flows that work today: `linkProfileToRemote`
-- re-sends every split and payer of a contact in ONE write, and `updateBill` re-sends every
-- participant as new split rows, so one such bill would block linking that contact, or even a title
-- edit. So the check judges only people a write ADDS: `kwenta_group_bill_participants` records, before
-- the validators run, who each touched bill names in its stored rows (raw ids, no canonicalizing yet:
-- a link rewrite changes what a raw id means mid-call), and a participant that matches no membership
-- row is still accepted when its (bill, canonical person) pair was already there. Canonicalizing both
-- sides AFTER the push is what lets a local -> account link rewrite pass.
--
-- WHERE: inside `kwenta_write` only, checked after the push and the 078 all-or-nothing check, judged on the
-- STORED rows (so a membership row and a bill written in the same call see each other, whatever
-- order the validators ran in). The RAISE rolls the whole call back, marker included, so the
-- server never holds a bill missing a refused split. `kwenta_sync` is deliberately not changed, for
-- 078's reason: it is the bulk replay of whatever unsynced rows a device holds, and a refusal there
-- is per-row — a bill would be stored without the refused split, the exact half-written money
-- record 078 exists to prevent — and one bad legacy row would be refused on every sync forever.
-- Every current write goes through `kwenta_write` (066); `kwenta_sync` carries only rows no queue
-- entry owns.
--
-- The error is P0001, which the client classifies as a refusal (never a transport failure, so it is
-- not retried) and shows as "Could not save to cloud: <message>".
--
-- Everything else in `kwenta_write` is 078's body verbatim (the prior-participants capture and the
-- check are the only additions); same signature, so CREATE OR REPLACE with the grants restated.
--
-- APPLY: before or after the client that refreshes its roster; either order breaks no flow that
-- works today. Until 080 is applied, a save whose roster refresh could not reach the server (the
-- client then submits and lets the server decide) can still store a never-member id, exactly as it
-- could before; apply 080 first to close that window.

-- Who each GROUP bill the push touches names in its STORED rows right now: the bill's paid_by and
-- every live split on its live items, as [{"b": bill, "u": raw user id}]. Called before the
-- validators run. A bill is touched when the push names it, one of its items, or a split of one of
-- its items (the item resolved through the push's own bill_items, else the stored ones).
CREATE OR REPLACE FUNCTION public.kwenta_group_bill_participants(p_push jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pushed_items AS (
    SELECT (e.value ->> 'id')::uuid AS id, (e.value ->> 'bill_id')::uuid AS bill_id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> 'bill_items') = 'array' THEN p_push -> 'bill_items' ELSE '[]'::jsonb END
    ) AS e(value)
  ),
  touched AS (
    SELECT (e.value ->> 'id')::uuid AS bill_id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> 'bills') = 'array' THEN p_push -> 'bills' ELSE '[]'::jsonb END
    ) AS e(value)
    UNION
    SELECT pi.bill_id FROM pushed_items pi
    UNION
    SELECT COALESCE(pi.bill_id, i.bill_id)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> 'item_splits') = 'array' THEN p_push -> 'item_splits' ELSE '[]'::jsonb END
    ) AS e(value)
    LEFT JOIN pushed_items pi ON pi.id = (e.value ->> 'item_id')::uuid
    LEFT JOIN public.bill_items i ON i.id = (e.value ->> 'item_id')::uuid
  ),
  group_bills AS (
    SELECT b.id, b.paid_by
    FROM touched t
    JOIN public.bills b ON b.id = t.bill_id AND b.is_deleted IS FALSE AND b.group_id IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('b', x.bill_id, 'u', x.user_id)), '[]'::jsonb)
  FROM (
    SELECT gb.id AS bill_id, gb.paid_by AS user_id FROM group_bills gb WHERE gb.paid_by IS NOT NULL
    UNION
    SELECT gb.id, s.user_id
    FROM group_bills gb
    JOIN public.bill_items i ON i.bill_id = gb.id AND i.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = i.id AND s.is_deleted IS FALSE
  ) AS x;
$$;

REVOKE ALL ON FUNCTION public.kwenta_group_bill_participants(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_bill_participants(jsonb) TO service_role;

-- After the push: 'table:id, ...' for each pushed live split / payer on a live group bill whose
-- person has no membership row in the group and was not already on that bill (p_prior, from
-- `kwenta_group_bill_participants`), or NULL when every one passes.
CREATE OR REPLACE FUNCTION public.kwenta_group_bill_non_members(p_push jsonb, p_prior jsonb)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pushed_splits AS (
    SELECT (e.value ->> 'id')::uuid AS id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> 'item_splits') = 'array' THEN p_push -> 'item_splits' ELSE '[]'::jsonb END
    ) AS e(value)
  ),
  pushed_bills AS (
    SELECT (e.value ->> 'id')::uuid AS id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> 'bills') = 'array' THEN p_push -> 'bills' ELSE '[]'::jsonb END
    ) AS e(value)
  ),
  participants AS (
    SELECT 'item_splits' AS tbl, s.id, b.id AS bill_id, b.group_id,
           public.kwenta_canonical_user_id(s.user_id) AS person
    FROM pushed_splits ps
    JOIN public.item_splits s ON s.id = ps.id AND s.is_deleted IS FALSE
    JOIN public.bill_items i ON i.id = s.item_id AND i.is_deleted IS FALSE
    JOIN public.bills b ON b.id = i.bill_id AND b.is_deleted IS FALSE AND b.group_id IS NOT NULL
    UNION ALL
    SELECT 'bills', b.id, b.id, b.group_id, public.kwenta_canonical_user_id(b.paid_by)
    FROM pushed_bills pb
    JOIN public.bills b ON b.id = pb.id AND b.is_deleted IS FALSE AND b.group_id IS NOT NULL
    WHERE b.paid_by IS NOT NULL
  ),
  roster AS (
    SELECT DISTINCT gm.group_id, public.kwenta_canonical_user_id(gm.user_id) AS person
    FROM public.group_members gm
    WHERE gm.group_id IN (SELECT group_id FROM participants)
  ),
  prior AS (
    SELECT DISTINCT (e.value ->> 'b')::uuid AS bill_id, public.kwenta_canonical_user_id((e.value ->> 'u')::uuid) AS person
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_prior) = 'array' THEN p_prior ELSE '[]'::jsonb END
    ) AS e(value)
  )
  SELECT string_agg(p.tbl || ':' || p.id, ', ' ORDER BY p.tbl, p.id)
  FROM participants p
  WHERE NOT EXISTS (SELECT 1 FROM roster r WHERE r.group_id = p.group_id AND r.person = p.person)
    AND NOT EXISTS (SELECT 1 FROM prior pr WHERE pr.bill_id = p.bill_id AND pr.person = p.person);
$$;

REVOKE ALL ON FUNCTION public.kwenta_group_bill_non_members(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_bill_non_members(jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.kwenta_write(
  p_push jsonb,
  p_submission_id uuid DEFAULT NULL,
  p_reads jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  applied jsonb;
  prior jsonb;
  spec jsonb;
  reads jsonb := '{}'::jsonb;
  one_read jsonb;
  refused text;
  non_members text;
  prior_participants jsonb;
BEGIN
  -- First, before the replay lookup: a replay touches no gated table, so 076's write trigger
  -- would never fire for it.
  PERFORM public.kwenta_assert_caller_active();

  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Replay of a submission this user already completed: return what it stored the first time and
  -- do NOT re-apply. Scoped to the caller so one user's id cannot suppress another's write.
  SELECT s.applied_ids INTO prior
  FROM public.kwenta_write_submissions s
  WHERE p_submission_id IS NOT NULL
    AND s.submission_id = p_submission_id
    AND s.actor_user_id = uid;

  IF prior IS NOT NULL THEN
    applied := prior;
  ELSE
    -- 080: before the validators change anything.
    prior_participants := public.kwenta_group_bill_participants(p_push);

    applied := jsonb_build_object(
      'profiles',           to_jsonb(public.kwenta_push_profiles(coalesce(p_push->'profiles', '[]'::jsonb), uid)),
      'groups',             to_jsonb(public.kwenta_push_groups(coalesce(p_push->'groups', '[]'::jsonb), uid)),
      'group_members',      to_jsonb(public.kwenta_push_group_members(coalesce(p_push->'group_members', '[]'::jsonb), uid)),
      'bills',              to_jsonb(public.kwenta_push_bills(coalesce(p_push->'bills', '[]'::jsonb), uid)),
      'bill_items',         to_jsonb(public.kwenta_push_bill_items(coalesce(p_push->'bill_items', '[]'::jsonb), uid)),
      'item_splits',        to_jsonb(public.kwenta_push_item_splits(coalesce(p_push->'item_splits', '[]'::jsonb), uid)),
      'settlements',        to_jsonb(public.kwenta_push_settlements(coalesce(p_push->'settlements', '[]'::jsonb), uid)),
      'activity_log',       to_jsonb(public.kwenta_push_activity_log(coalesce(p_push->'activity_log', '[]'::jsonb), uid)),
      'profile_peer_links', to_jsonb(public.kwenta_push_profile_peer_links(coalesce(p_push->'profile_peer_links', '[]'::jsonb), uid))
    );

    -- All or nothing (078): a refused money/identity row sinks the call, and the RAISE rolls back
    -- the accepted rows with it. activity_log is exempt (rule 9).
    SELECT string_agg(t.tbl || ':' || COALESCE(e.value ->> 'id', 'null'), ', ' ORDER BY t.ord, e.ord)
    INTO refused
    FROM unnest(ARRAY['profiles', 'groups', 'group_members', 'bills', 'bill_items', 'item_splits',
                      'settlements', 'profile_peer_links']) WITH ORDINALITY AS t(tbl, ord)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_push -> t.tbl) = 'array' THEN p_push -> t.tbl ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(value, ord)
    WHERE NOT COALESCE(applied -> t.tbl ? (e.value ->> 'id'), false);

    IF refused IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'kwenta_write refused rows: ' || refused,
        HINT = 'Nothing from this write was stored.';
    END IF;

    -- 080: people this write adds to a group bill must be on the group's roster (see the header).
    non_members := public.kwenta_group_bill_non_members(p_push, prior_participants);
    IF non_members IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Someone on this bill is not a member of this group. Add them to the group first.',
        DETAIL = non_members,
        HINT = 'Nothing from this write was stored.';
    END IF;

    -- Recorded in the SAME transaction as the push, so a submission is never marked complete
    -- unless its rows are committed — and the rows are never committed without the marker.
    IF p_submission_id IS NOT NULL THEN
      INSERT INTO public.kwenta_write_submissions (submission_id, actor_user_id, applied_ids)
      VALUES (p_submission_id, uid, applied)
      ON CONFLICT (submission_id) DO NOTHING;
    END IF;
  END IF;

  -- Computed AFTER the push and inside the same transaction, which is the whole point: the
  -- payload the caller gets back already contains the effect of the write it just made.
  --
  -- A read is recomputed even on a replay. `applied` is a stored OUTCOME; a read is a view of
  -- current state, and serving a stale one would be worse than not answering at all.
  FOR spec IN SELECT * FROM jsonb_array_elements(COALESCE(p_reads, '[]'::jsonb))
  LOOP
    CONTINUE WHEN NOT public.kwenta_read_is_allowed(spec->>'fn');
    BEGIN
      one_read := public.kwenta_read(
        spec->>'fn',
        NULLIF(spec->>'id', '')::uuid,
        NULLIF(spec->>'limit', '')::integer
      );
      reads := reads || jsonb_build_object(spec->>'key', one_read);
    EXCEPTION WHEN OTHERS THEN
      -- A read must never fail the write. The user may have lost access to the screen they were
      -- on, or an id may be stale; the mutation is still valid and is already applied. The key is
      -- simply omitted and the client fetches it the ordinary way.
      NULL;
    END;
  END LOOP;

  RETURN public.kwenta_write_echo(applied, uid)
    || jsonb_build_object('applied', applied, 'reads', reads)
    || CASE WHEN prior IS NOT NULL THEN jsonb_build_object('replayed', true) ELSE '{}'::jsonb END;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) TO service_role;

SELECT public.kwenta_revoke_acting_user_helpers();
