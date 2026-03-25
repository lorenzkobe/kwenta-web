-- Optional retention helper for kwenta_user_events (keep the stream small).
-- Intended for server-side scheduling (Supabase cron / external job) using service_role.

CREATE OR REPLACE FUNCTION public.kwenta_prune_user_events(p_before timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.kwenta_user_events
  WHERE created_at < p_before;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_prune_user_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_prune_user_events(timestamptz) TO service_role;

