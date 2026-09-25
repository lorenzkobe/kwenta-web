-- 078_kwenta_write_all_or_nothing.sql
--
-- WHAT BROKE: `kwenta_write` (066) stored whatever part of a push its validators accepted and
-- reported the rest as missing from `applied`. The client refuses a save with a row missing
-- (NOT_STORED), but by then the server had already COMMITTED the accepted part: a bill without the
-- split that was refused, i.e. a half-written money record that other members' screens and every
-- balance endpoint then read. Worse, the submission marker (050) was recorded with that partial
-- outcome, so the corrected retry the client sends under the SAME submission id — which is how the
-- write queue replays — was answered as a replay of the partial outcome and never applied.
--
-- THE SHAPE NOW: after the push, if any pushed row other than an `activity_log` line is absent
-- from `applied`, `kwenta_write` raises (SQLSTATE P0001, message
-- `kwenta_write refused rows: <table>:<id>, ...`). The raise rolls back the whole call — the rows
-- that were accepted and the submission marker included — so the server holds either all of a
-- mutation or none of it, and a retry under the same submission id applies afresh. The client
-- classifies P0001 as a refusal (not a transport failure), exactly as it did NOT_STORED.
--
-- `activity_log` stays exempt (CLAUDE.md rule 9): it is an audit trail, not money, and failing a
-- bill because its log line was refused would turn a cosmetic gap into a lost write.
--
-- A replay (the marker already exists) is not re-checked: its outcome was stored by a call that
-- passed this check, or by a pre-078 call, and replay semantics are "report the original outcome".
--
-- `kwenta_sync` is deliberately NOT changed. It is the bulk safety-net replay of whatever unsynced
-- rows a device holds (legacy offline edits, rows from older builds); all-or-nothing there would
-- let one bad legacy row block every later sync for that device, forever. Its partial `applied`
-- keeps working as before.
--
-- The caller must be active (076), checked FIRST: 076's write trigger refuses an inactive caller at
-- the first validator, but a REPLAY of an existing submission touches no gated table and would
-- otherwise return its echo and `reads` to a deactivated account. `kwenta_sync` has the same
-- replay/empty-push path and is left alone here; the PostgREST pre-request hook (076) refuses an
-- inactive caller before either RPC runs.
--
-- Everything else is 066's body verbatim: same validators, same submission bookkeeping, same echo
-- and `reads`. The signature is unchanged, so this is a CREATE OR REPLACE; the grants are restated.
--
-- APPLY: any time (after 076, which the migration order guarantees). An older client already
-- throws on a partial drop, so the only visible change is that nothing is left behind on the server.

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
