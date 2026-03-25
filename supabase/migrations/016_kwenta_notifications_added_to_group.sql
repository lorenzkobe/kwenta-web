-- Extend notification kind enum/check for group invite alerts.

ALTER TABLE public.kwenta_notifications
  DROP CONSTRAINT IF EXISTS kwenta_notifications_kind_check;

ALTER TABLE public.kwenta_notifications
  ADD CONSTRAINT kwenta_notifications_kind_check
  CHECK (kind IN ('profile_linked', 'bill_participant', 'payment_recorded', 'added_to_group'));

