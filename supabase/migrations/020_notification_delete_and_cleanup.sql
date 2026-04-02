-- Allow recipients to delete notifications and auto-clean stale bill/payment notifications.

DROP POLICY IF EXISTS kwenta_notifications_delete_own ON public.kwenta_notifications;
CREATE POLICY kwenta_notifications_delete_own
  ON public.kwenta_notifications
  FOR DELETE
  USING (recipient_id = (SELECT auth.uid()));

GRANT DELETE ON public.kwenta_notifications TO authenticated;

CREATE OR REPLACE FUNCTION public.kwenta_cleanup_bill_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill_id uuid := COALESCE(NEW.id, OLD.id);
  v_is_deleted boolean := COALESCE(NEW.is_deleted, false);
BEGIN
  IF TG_OP = 'DELETE' OR v_is_deleted THEN
    DELETE FROM public.kwenta_notifications qn
    WHERE qn.kind = 'bill_participant'
      AND qn.entity_id = v_bill_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_cleanup_bill_notifications_trg ON public.bills;
CREATE TRIGGER kwenta_cleanup_bill_notifications_trg
AFTER UPDATE OR DELETE ON public.bills
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_cleanup_bill_notifications();

CREATE OR REPLACE FUNCTION public.kwenta_cleanup_settlement_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement_id uuid := COALESCE(NEW.id, OLD.id);
  v_is_deleted boolean := COALESCE(NEW.is_deleted, false);
BEGIN
  IF TG_OP = 'DELETE' OR v_is_deleted THEN
    DELETE FROM public.kwenta_notifications qn
    WHERE qn.kind = 'payment_recorded'
      AND qn.entity_id = v_settlement_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_cleanup_settlement_notifications_trg ON public.settlements;
CREATE TRIGGER kwenta_cleanup_settlement_notifications_trg
AFTER UPDATE OR DELETE ON public.settlements
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_cleanup_settlement_notifications();

