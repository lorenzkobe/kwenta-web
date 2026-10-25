-- 081_base_version_conflicts.sql
--
-- WHAT BROKE: the device clock decided every conflict. A row pushed through `kwenta_write` is judged
-- by 021b ("newest client updated_at wins"), so a save built from a STALE copy of a row beat newer
-- data whenever its device clock was ahead, un-deleted a row another device had deleted (a stale
-- edit re-sends `is_deleted = false`), and a device whose clock ran behind had a perfectly fresh
-- edit silently dropped while the call reported success. Separately, 045's link rewrite stamps a
-- bare `now()`, which 021b discards on any row whose stored updated_at is in the future (a fast
-- client clock wrote it), so a contact link left those splits, payers and payments on the old id.
--
-- THE SHAPE: a pushed row may carry `_base_updated_at`, the server version (updated_at) the client
-- built the edit from, and `_overwrite: true`, the user's explicit "apply mine" retry of a refused
-- write. Before anything is written, `kwenta_write` judges every such row against the STORED row:
--   * base present, no `_overwrite`, stored row exists, stored.updated_at differs from the base ->
--     CONFLICT. The whole call is refused (P0001, "This was changed on another device. Refresh and
--     try again.", DETAIL `table:id, ...`, HINT "Nothing from this write was stored."), the RAISE
--     rolls back everything, marker included, so a corrected retry under the same submission id
--     applies afresh (078's rule). A base on a row that does not exist yet is ignored.
--   * base matches, or `_overwrite` -> the row's updated_at is rewritten to
--     GREATEST(now(), stored.updated_at + 1 microsecond) (now() when there is no stored row). The
--     server stamps the version, so the client clock decides nothing, and the +1us keeps a stamp
--     inside one transaction (the SQL harness, or two writes in one statement-clock tick) strictly
--     newer than what it replaces. 021b then lets the row in, because it is newer. The echo returns
--     that stamped version, which is what the device bases its next edit on.
--   * both keys are stripped from every row before the validators see it: they never reach a table
--     or the echo. The validators read rows through `jsonb_populate_recordset(NULL::public.<t>, ...)`
--     (075), which ignores keys that are not columns, so a client that sends bases to a pre-081
--     server is harmless: no refusal, the old 021b behaviour, the key dropped on the floor.
--
-- ROWS WITHOUT A BASE keep their client updated_at and 021b exactly as today: new rows, rows from
-- an older install that sends no bases, and kwenta_sync (unchanged; it is the bulk replay of unsent
-- legacy rows, where a refusal would be per-row and sticky - see 078). 044 records why a blanket
-- server stamp for every push was reverted (it regressed to last-arrival-wins and resurrected stale
-- deletes of older offline rows); this migration stamps only rows whose client proved which version
-- it saw, which is the opposite of last-arrival-wins.
--
-- CONCURRENCY: the stored rows of every based or `_overwrite` row are locked (`SELECT ... FOR UPDATE`,
-- ids in order, per pushed table, tables in a fixed order) BEFORE the comparison. Two concurrent
-- writes on one base therefore serialize: the second waits, then reads the version the first stamped,
-- and is refused instead of both passing the check on the same stale version. A caller who sends an
-- id they did not create can lock that row for the length of their own (short) transaction and learn
-- from a refusal that the id exists; ids are unguessable uuids and the write is rolled back, so this
-- adds no read path. The validators still decide who may write a row.
--
-- REPLAYS skip all of this: the check lives in the non-replay branch, so a replay under the same
-- submission id returns the original outcome even though its bases are stale by then (the first
-- apply moved the versions).
--
-- 045 REDEFINED: `kwenta_canonicalize_on_link` is 045's body verbatim except every `updated_at = now()`
-- is now `GREATEST(now(), updated_at + interval '1 microsecond')` (the 048 stamp), so the server-side
-- rewrite of splits, payers, payments and memberships beats 021b on rows whose stored updated_at is
-- ahead of the server clock. The client now sends only the profile link on a contact link and relies
-- on this trigger for the rest, which is why it had to land with the client.
--
-- Everything else in `kwenta_write` is 080's body verbatim (the base step is the only addition);
-- same signature, so CREATE OR REPLACE with the grants restated. No new helper functions.
--
-- APPLY: before the client that sends bases (a client that sends them to a pre-081 server is
-- harmless, see above, but then protects nothing). A contact link from the new client needs this
-- migration: against a pre-081 server it would send the profile alone and the splits, payers and
-- payments would be rewritten by 045's old `now()` stamp, which loses to future-dated rows.

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
  -- Only act when linked_profile_id transitions to a new non-null value.
  IF v_new IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.linked_profile_id IS NOT DISTINCT FROM NEW.linked_profile_id THEN
    RETURN NULL;
  END IF;

  -- item_splits.user_id
  UPDATE public.item_splits
     SET user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE user_id = v_old;

  -- bills.paid_by
  UPDATE public.bills
     SET paid_by = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE paid_by = v_old;

  -- settlements.from_user_id / to_user_id
  UPDATE public.settlements
     SET from_user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE from_user_id = v_old;
  UPDATE public.settlements
     SET to_user_id = v_new, updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE to_user_id = v_old;

  -- group_members.user_id - rewrite, but never create a duplicate active
  -- membership. If the linked account is already an active member of a group
  -- where the old id is also a member, soft-delete the old (now redundant) row
  -- instead of rewriting it onto the same [group_id+user_id].
  UPDATE public.group_members gm
     SET is_deleted = true, updated_at = GREATEST(now(), gm.updated_at + interval '1 microsecond')
   WHERE gm.user_id = v_old
     AND gm.is_deleted IS FALSE
     AND EXISTS (
       SELECT 1 FROM public.group_members gm2
        WHERE gm2.group_id = gm.group_id
          AND gm2.user_id = v_new
          AND gm2.is_deleted IS FALSE
     );

  UPDATE public.group_members gm
     SET user_id = v_new, updated_at = GREATEST(now(), gm.updated_at + interval '1 microsecond')
   WHERE gm.user_id = v_old
     AND NOT EXISTS (
       SELECT 1 FROM public.group_members gm2
        WHERE gm2.group_id = gm.group_id
          AND gm2.user_id = v_new
          AND gm2.is_deleted IS FALSE
     );

  RETURN NULL;
END;
$$;

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
  base_tbl text;
  base_rows jsonb;
  base_conflicts text;
  all_conflicts text;
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
    -- 081: judge and stamp rows that carry a base version (see the header). Runs before the 080
    -- capture and the validators so everything downstream sees the rewritten push.
    FOREACH base_tbl IN ARRAY ARRAY['profiles', 'groups', 'group_members', 'bills', 'bill_items',
                                    'item_splits', 'settlements', 'activity_log', 'profile_peer_links']
    LOOP
      CONTINUE WHEN jsonb_typeof(p_push -> base_tbl) IS DISTINCT FROM 'array';

      EXECUTE format($q$
        WITH incoming AS (
          SELECT e.value AS j, e.ord,
                 (e.value ->> 'id')::uuid AS id,
                 NULLIF(e.value ->> '_base_updated_at', '')::timestamptz AS base,
                 COALESCE((e.value -> '_overwrite') = 'true'::jsonb, false) AS ow
          FROM jsonb_array_elements($1) WITH ORDINALITY AS e(value, ord)
        ),
        stored AS MATERIALIZED (
          SELECT s.id, s.updated_at
          FROM public.%1$I s
          WHERE s.id IN (SELECT i.id FROM incoming i WHERE i.base IS NOT NULL OR i.ow)
          ORDER BY s.id
          FOR UPDATE
        ),
        judged AS (
          SELECT i.j, i.ord, i.id, (i.base IS NOT NULL OR i.ow) AS restamp, s.updated_at AS stored_at,
                 (i.base IS NOT NULL AND NOT i.ow AND s.updated_at IS DISTINCT FROM i.base
                  AND s.id IS NOT NULL) AS conflict
          FROM incoming i
          LEFT JOIN stored s ON s.id = i.id
        )
        SELECT COALESCE(jsonb_agg(
                 CASE WHEN r.restamp
                      THEN (r.j - '_base_updated_at' - '_overwrite')
                           || jsonb_build_object('updated_at', GREATEST(now(), r.stored_at + interval '1 microsecond'))
                      ELSE r.j END
                 ORDER BY r.ord), '[]'::jsonb),
               string_agg(%2$L || ':' || r.id, ', ' ORDER BY r.ord) FILTER (WHERE r.conflict)
        FROM judged r
      $q$, base_tbl, base_tbl)
      INTO base_rows, base_conflicts
      USING p_push -> base_tbl;

      p_push := jsonb_set(p_push, ARRAY[base_tbl], base_rows);
      IF base_conflicts IS NOT NULL THEN
        all_conflicts := concat_ws(', ', all_conflicts, base_conflicts);
      END IF;
    END LOOP;

    IF all_conflicts IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'This was changed on another device. Refresh and try again.',
        DETAIL = all_conflicts,
        HINT = 'Nothing from this write was stored.';
    END IF;

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
