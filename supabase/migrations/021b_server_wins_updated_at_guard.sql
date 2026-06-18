-- Guard against stale client pushes overriding newer server rows.
-- If an incoming update has older updated_at than the current row, keep the current row.

CREATE OR REPLACE FUNCTION public.kwenta_server_wins_updated_at_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.updated_at > NEW.updated_at THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kwenta_server_wins_profiles ON public.profiles;
CREATE TRIGGER kwenta_server_wins_profiles
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_groups ON public.groups;
CREATE TRIGGER kwenta_server_wins_groups
BEFORE UPDATE ON public.groups
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_group_members ON public.group_members;
CREATE TRIGGER kwenta_server_wins_group_members
BEFORE UPDATE ON public.group_members
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_bills ON public.bills;
CREATE TRIGGER kwenta_server_wins_bills
BEFORE UPDATE ON public.bills
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_bill_items ON public.bill_items;
CREATE TRIGGER kwenta_server_wins_bill_items
BEFORE UPDATE ON public.bill_items
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_item_splits ON public.item_splits;
CREATE TRIGGER kwenta_server_wins_item_splits
BEFORE UPDATE ON public.item_splits
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_settlements ON public.settlements;
CREATE TRIGGER kwenta_server_wins_settlements
BEFORE UPDATE ON public.settlements
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();

DROP TRIGGER IF EXISTS kwenta_server_wins_activity_log ON public.activity_log;
CREATE TRIGGER kwenta_server_wins_activity_log
BEFORE UPDATE ON public.activity_log
FOR EACH ROW
EXECUTE FUNCTION public.kwenta_server_wins_updated_at_guard();
