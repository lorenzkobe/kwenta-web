-- Ensure notification rows are emitted to clients via Supabase Realtime.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'kwenta_notifications'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.kwenta_notifications';
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    -- Publication might not exist in some local setups.
    NULL;
  WHEN duplicate_object THEN
    NULL;
END;
$$;

