ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS paid_by uuid REFERENCES profiles(id);

UPDATE bills SET paid_by = created_by WHERE paid_by IS NULL;

ALTER TABLE bills ALTER COLUMN paid_by SET NOT NULL;

CREATE OR REPLACE FUNCTION public.kwenta_push_bills(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.bills AS tgt (
    id, title, group_id, currency, created_by, paid_by, total_amount, note, category,
    created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.title, src.group_id, src.currency, src.created_by, src.paid_by,
    src.total_amount, src.note, src.category, src.created_at, src.updated_at,
    src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.bills,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE src.created_by = uid
     OR (src.group_id IS NOT NULL AND public.is_group_member(src.group_id, uid))
     OR (
       src.group_id IS NULL
       AND public.user_is_participant_on_personal_bill(src.id, uid)
     )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    group_id = EXCLUDED.group_id,
    currency = EXCLUDED.currency,
    created_by = EXCLUDED.created_by,
    paid_by = EXCLUDED.paid_by,
    total_amount = EXCLUDED.total_amount,
    note = EXCLUDED.note,
    category = EXCLUDED.category,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;
