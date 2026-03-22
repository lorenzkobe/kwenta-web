-- In-app notifications: recipients see rows where recipient_id = self; actors may insert for others.

CREATE TABLE IF NOT EXISTS public.kwenta_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('profile_linked', 'bill_participant')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_id UUID,
  group_id UUID REFERENCES public.groups (id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX kwenta_notifications_recipient_created_idx
  ON public.kwenta_notifications (recipient_id, created_at DESC);

CREATE INDEX kwenta_notifications_unread_idx
  ON public.kwenta_notifications (recipient_id)
  WHERE read_at IS NULL;

ALTER TABLE public.kwenta_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY kwenta_notifications_select_own
  ON public.kwenta_notifications
  FOR SELECT
  USING (recipient_id = (SELECT auth.uid()));

CREATE POLICY kwenta_notifications_insert_as_actor
  ON public.kwenta_notifications
  FOR INSERT
  WITH CHECK (
    actor_id = (SELECT auth.uid())
    AND recipient_id <> (SELECT auth.uid())
  );

CREATE POLICY kwenta_notifications_update_own
  ON public.kwenta_notifications
  FOR UPDATE
  USING (recipient_id = (SELECT auth.uid()))
  WITH CHECK (recipient_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.kwenta_notifications TO authenticated;
