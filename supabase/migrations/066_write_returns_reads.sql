-- ===========================================================================
-- 066 — Separate WRITING from REFRESHING, and let a write answer the screen.
--
-- WHAT WAS WRONG.
--   `kwenta_sync` is one RPC doing two unrelated jobs: apply a push, and return
--   the caller's complete row set. That was correct when Dexie WAS the read
--   model. Since 051–064 it is not: every displayed number comes from a scoped
--   endpoint, and Dexie is a mirror kept for offline display and descriptive
--   rows. But the write path still went through `kwenta_sync`, so **saving a
--   bill downloaded the user's entire dataset — ~213 kB — to confirm one row**.
--   Then the screen fetched AGAIN, because the balance a write moves is
--   computed in SQL (rule 8) and cannot be derived on the client from the rows
--   the write echoes back.
--
--   So one save cost: a full bundle down, plus a second round trip up-and-back
--   for a number the server had already recomputed while applying the write.
--
-- WHAT THIS ADDS.
--   `kwenta_write` — apply the push, return ONLY the rows it stored, plus the
--   recomputed payloads for whichever read endpoints the caller names. One
--   round trip, ~1 kB, and the screen has its new numbers without asking again.
--
--   `kwenta_read` — the dispatch that makes "whichever endpoints the caller
--   names" expressible. A **whitelist**, not a generic invoker: a client that
--   could name any function here would be a remote procedure call primitive.
--
-- WHY THE RETURN SHAPE IS THE SAME AS `kwenta_sync`'s.
--   Nine table keys plus `applied`, so the client's existing confirm-then-mirror
--   loop is unchanged — the only difference is that each array holds just this
--   submission's rows instead of everything the user can see. Fewer moving parts
--   than a new shape, and the "was it really stored?" check that closed the
--   silently-dropped-write bug keeps working verbatim.
--
-- AUTHORIZATION.
--   `kwenta_write` takes NO viewer argument: it derives `uid` from `auth.uid()`
--   like `kwenta_sync`, so granting it to `authenticated` is correct (rule 5).
--   `kwenta_read` is SECURITY **INVOKER** on purpose — it adds no authority of
--   its own; each endpoint it forwards to is already SECURITY DEFINER and reads
--   `auth.uid()` itself. (SECURITY DEFINER changes the ROLE, never the JWT GUC,
--   so `auth.uid()` inside a dispatched endpoint is still the caller either way.)
--   `kwenta_write_echo` DOES take the acting user as an argument and is
--   therefore service_role only — the same rule that 065 had to retrofit after
--   `kwenta_build_pull_bundle` and the `kwenta_push_*` validators were found
--   callable by any signed-in user.
--
-- ORDERING.
--   Apply this BEFORE shipping the client that calls it. The client falls back
--   to `kwenta_sync` when the RPC is missing (PGRST202), which covers a new
--   server with an old client, not the reverse.
--
-- Additive: nothing is dropped, `kwenta_sync` is untouched and remains the
-- offline-replay and mirror-refresh path.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- kwenta_read — whitelisted dispatch over the client read endpoints.
--
-- Every entry takes no viewer argument and resolves the caller from auth.uid().
-- Adding a row here is a security decision: it makes that endpoint reachable by
-- name from a write payload. Never add a function that takes a viewer/uid
-- argument — those are service_role only (rule 5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_read(
  p_fn text,
  p_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
-- Deliberately VOLATILE (the default): several dispatched endpoints are plpgsql and volatile
-- themselves, and marking the wrapper stronger than what it calls is how a planner ends up
-- caching a balance.
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN CASE p_fn
    WHEN 'kwenta_balances_overview'        THEN public.kwenta_balances_overview()
    WHEN 'kwenta_groups_with_balances'     THEN public.kwenta_groups_with_balances()
    WHEN 'kwenta_contacts_with_balances'   THEN public.kwenta_contacts_with_balances()
    WHEN 'kwenta_personal_bills'           THEN public.kwenta_personal_bills()
    WHEN 'kwenta_recent_bills'             THEN public.kwenta_recent_bills(COALESCE(p_limit, 5))
    WHEN 'kwenta_bill_detail'              THEN public.kwenta_bill_detail(p_id)
    WHEN 'kwenta_group_detail'             THEN public.kwenta_group_detail(p_id)
    WHEN 'kwenta_person_summary'           THEN public.kwenta_person_summary(p_id)
    WHEN 'kwenta_person_statement'         THEN public.kwenta_person_statement(p_id)
    WHEN 'kwenta_bill_settlement_history'  THEN public.kwenta_bill_settlement_history(p_id)
    WHEN 'kwenta_group_settlement_history' THEN public.kwenta_group_settlement_history(p_id)
    WHEN 'kwenta_person_settlement_history' THEN public.kwenta_person_settlement_history(p_id)
    WHEN 'kwenta_group_spending'           THEN public.kwenta_group_spending(p_id)
    ELSE NULL
  END;
END;
$$;

-- A name outside the whitelist is a programming error on the client, never a
-- reason to serve something. Raised separately from the CASE so a legitimate
-- endpoint returning SQL NULL (e.g. a bill the caller cannot read) stays
-- distinguishable from an unknown name.
CREATE OR REPLACE FUNCTION public.kwenta_read_is_allowed(p_fn text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_fn IN (
    'kwenta_balances_overview',
    'kwenta_groups_with_balances',
    'kwenta_contacts_with_balances',
    'kwenta_personal_bills',
    'kwenta_recent_bills',
    'kwenta_bill_detail',
    'kwenta_group_detail',
    'kwenta_person_summary',
    'kwenta_person_statement',
    'kwenta_bill_settlement_history',
    'kwenta_group_settlement_history',
    'kwenta_person_settlement_history',
    'kwenta_group_spending'
  );
$$;

-- ---------------------------------------------------------------------------
-- kwenta_write_echo — the stored rows for one submission.
--
-- Reads through `kwenta_pull_rows_*` rather than the base tables: those
-- predicates ARE the privacy boundary (051), and an echo is a read like any
-- other. Filtering afterwards by id is deliberate — narrowing inside the
-- functions would mean nine new signatures and nine chances to get the
-- predicate wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_write_echo(p_applied jsonb, uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH since AS (SELECT 'epoch'::timestamptz AS t)
  SELECT jsonb_build_object(
    'profiles',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_profiles((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'profiles', '[]'::jsonb)))),
    'groups',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_groups((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'groups', '[]'::jsonb)))),
    'group_members',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_group_members((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'group_members', '[]'::jsonb)))),
    'bills',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_bills((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'bills', '[]'::jsonb)))),
    'bill_items',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_bill_items((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'bill_items', '[]'::jsonb)))),
    'item_splits',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_item_splits((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'item_splits', '[]'::jsonb)))),
    'settlements',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_settlements((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'settlements', '[]'::jsonb)))),
    'activity_log',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_activity_log((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'activity_log', '[]'::jsonb)))),
    'profile_peer_links',
    (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
     FROM public.kwenta_pull_rows_profile_peer_links((SELECT t FROM since), uid) x
     WHERE x.id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_applied->'profile_peer_links', '[]'::jsonb))))
  );
$$;

-- ---------------------------------------------------------------------------
-- kwenta_write — the mutation path.
--
-- Push handling is `050`'s `kwenta_sync` verbatim: same validators, same
-- submission bookkeeping, same replay semantics. What differs is everything
-- AFTER the push — the echo instead of the bundle, plus `reads`.
-- ---------------------------------------------------------------------------
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
BEGIN
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

-- ---------------------------------------------------------------------------
-- Grants. See the AUTHORIZATION note in the header.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.kwenta_read(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_read(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_read(text, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_read_is_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_read_is_allowed(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_read_is_allowed(text) TO service_role;

REVOKE ALL ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_write(jsonb, uuid, jsonb) TO service_role;

-- Takes the acting user as an ARGUMENT, so a client-callable version would echo any user's rows.
REVOKE ALL ON FUNCTION public.kwenta_write_echo(jsonb, uuid) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_write_echo(jsonb, uuid) TO service_role;
