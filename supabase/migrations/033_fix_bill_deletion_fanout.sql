-- Fix: bill deletion events not reaching split participants
--
-- When deleteBill() runs, it soft-deletes bill + items + splits in one local
-- transaction and pushes them all in a single batch. By the time the DB trigger
-- fires on the bill UPDATE, the item_splits rows are ALSO already marked
-- is_deleted = true in the same push. The previous query filtered them out, so
-- no kwenta_user_event was emitted to linked participants.
--
-- Fix: remove the is_deleted filters from the fanout query so deletion events
-- reach all historical participants regardless of their current deletion state.

CREATE OR REPLACE FUNCTION public.kwenta_fanout_personal_bill_participants(
  p_bill_id uuid,
  p_creator_id uuid,
  p_event_type text,
  p_op text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF p_creator_id IS NOT NULL THEN
    PERFORM public.kwenta_emit_user_event(
      p_creator_id,
      p_event_type,
      'bills',
      p_bill_id,
      p_op,
      jsonb_build_object('bill_id', p_bill_id, 'group_id', NULL)
    );
  END IF;

  FOR r IN
    SELECT DISTINCT ish.user_id
    FROM public.bill_items bi
    JOIN public.item_splits ish ON ish.item_id = bi.id
    WHERE bi.bill_id = p_bill_id
  LOOP
    IF r.user_id IS NOT NULL AND r.user_id <> p_creator_id THEN
      PERFORM public.kwenta_emit_user_event(
        r.user_id,
        p_event_type,
        'bills',
        p_bill_id,
        p_op,
        jsonb_build_object('bill_id', p_bill_id, 'group_id', NULL)
      );
    END IF;
  END LOOP;
END;
$$;
