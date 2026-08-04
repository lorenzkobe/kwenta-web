-- 050_write_submissions.sql
--
-- Idempotent writes: a retry of the SAME submission can never apply twice.
--
-- Context. The client now submits a mutation's rows straight to `kwenta_sync` and only mirrors
-- them locally once the server confirms (see src/sync/cloud-write.ts). That closes the common
-- duplicate: a rejected write no longer survives locally for the user to retry into a second
-- copy. It does not close the ambiguous one — the request reaches Postgres, the row is stored,
-- and the response is lost to a dropped connection. The client cannot tell that from a failure,
-- so it retries, and without a server-side record the retry is indistinguishable from a new
-- write.
--
-- Every push is an upsert keyed by the client-generated row id, so replaying an identical
-- payload is already harmless. What this adds is the ability to REPORT the original outcome:
-- the retry returns the ids the first attempt stored instead of re-running the validators and
-- returning a fresh `applied` map that may differ (a row deleted in between, a membership
-- revoked). The client then treats the retry as the success it actually was.
--
-- `p_submission_id` is OPTIONAL and the two-argument form is kept, so a client that predates
-- this migration keeps working unchanged.

CREATE TABLE IF NOT EXISTS public.kwenta_write_submissions (
  submission_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  applied_ids   jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kwenta_write_submissions_actor_created_idx
  ON public.kwenta_write_submissions (actor_user_id, created_at DESC);

ALTER TABLE public.kwenta_write_submissions ENABLE ROW LEVEL SECURITY;

-- Readable only by its author. Writes happen inside the SECURITY DEFINER function below, never
-- directly from a client, so there is deliberately no INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS kwenta_write_submissions_select_own ON public.kwenta_write_submissions;
CREATE POLICY kwenta_write_submissions_select_own
  ON public.kwenta_write_submissions
  FOR SELECT
  USING (actor_user_id = auth.uid());

-- Three-argument kwenta_sync. Body mirrors the two-argument form from migration 044, with the
-- submission bookkeeping wrapped around the push.
CREATE OR REPLACE FUNCTION public.kwenta_sync(
  p_since timestamptz,
  p_push jsonb,
  p_submission_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  applied jsonb := '{}'::jsonb;
  bundle jsonb;
  prior jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Replay of a submission this user already completed: return what it stored the first time
  -- and do NOT re-apply. Scoped to the caller so one user's id cannot suppress another's write.
  IF p_submission_id IS NOT NULL THEN
    SELECT s.applied_ids INTO prior
    FROM public.kwenta_write_submissions s
    WHERE s.submission_id = p_submission_id
      AND s.actor_user_id = uid;

    IF prior IS NOT NULL THEN
      bundle := public.kwenta_build_pull_bundle(p_since, uid);
      RETURN bundle || jsonb_build_object('applied', prior, 'replayed', true);
    END IF;
  END IF;

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
  --
  -- ON CONFLICT DO NOTHING covers two concurrent retries of one submission racing here: the
  -- loser's push was an upsert of identical rows, so the stored outcome stays accurate.
  IF p_submission_id IS NOT NULL THEN
    INSERT INTO public.kwenta_write_submissions (submission_id, actor_user_id, applied_ids)
    VALUES (p_submission_id, uid, applied)
    ON CONFLICT (submission_id) DO NOTHING;
  END IF;

  bundle := public.kwenta_build_pull_bundle(p_since, uid);
  RETURN bundle || jsonb_build_object('applied', applied);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_sync(timestamptz, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_sync(timestamptz, jsonb, uuid) TO authenticated;

-- Housekeeping: submission markers are only useful for as long as a client might retry.
-- Keeping them forever would grow without bound.
CREATE OR REPLACE FUNCTION public.kwenta_prune_write_submissions(p_older_than interval DEFAULT interval '30 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.kwenta_write_submissions
  WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_prune_write_submissions(interval) FROM PUBLIC;
