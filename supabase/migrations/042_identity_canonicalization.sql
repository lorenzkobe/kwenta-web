-- 042: Server-side identity canonicalization backstop.
-- Rewrites a local-contact id that is linked to a remote account to the remote id,
-- for every identity column, at push time. Mirrors the client push rewrites and the
-- group-roster resolution; independent of the pushing device's linked_profile_id state.

CREATE OR REPLACE FUNCTION public.kwenta_canonical_user_id(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.linked_profile_id
       FROM public.profiles p
      WHERE p.id = p_id
        AND p.is_local IS TRUE
        AND p.linked_profile_id IS NOT NULL),
    p_id
  );
$$;

-- Re-create kwenta_push_item_splits with canonicalized user_id.
CREATE OR REPLACE FUNCTION public.kwenta_push_item_splits(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.item_splits AS tgt (
    id, item_id, user_id, split_type, split_value, computed_amount, created_at, updated_at, synced_at,
    is_deleted, device_id
  )
  SELECT
    src.id, src.item_id, public.kwenta_canonical_user_id(src.user_id), src.split_type, src.split_value,
    src.computed_amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.item_splits,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE EXISTS (
    SELECT 1
    FROM public.bill_items bi
    JOIN public.bills b ON b.id = bi.bill_id
    WHERE bi.id = src.item_id
      AND (
        b.created_by = uid
        OR (b.group_id IS NOT NULL AND public.is_group_member(b.group_id, uid))
        OR (b.group_id IS NULL AND public.user_is_participant_on_personal_bill(b.id, uid))
      )
  )
  ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    user_id = EXCLUDED.user_id,
    split_type = EXCLUDED.split_type,
    split_value = EXCLUDED.split_value,
    computed_amount = EXCLUDED.computed_amount,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;

-- Re-create kwenta_push_bills with canonicalized paid_by.
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
    src.id, src.title, src.group_id, src.currency, src.created_by,
    public.kwenta_canonical_user_id(src.paid_by),
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

-- Re-create kwenta_push_settlements with canonicalized from/to_user_id.
CREATE OR REPLACE FUNCTION public.kwenta_push_settlements(arr jsonb, uid uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.settlements AS tgt (
    id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency, is_settled, label, created_at, updated_at,
    synced_at, is_deleted, device_id
  )
  SELECT
    src.id, src.group_id, src.bill_id, src.bundle_id,
    public.kwenta_canonical_user_id(src.from_user_id),
    public.kwenta_canonical_user_id(src.to_user_id),
    src.amount, src.currency, src.is_settled,
    src.label, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
  FROM jsonb_populate_recordset(
    NULL::public.settlements,
    CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
  ) AS src
  WHERE (
      (
        src.group_id IS NOT NULL
        AND public.is_group_member(src.group_id, uid)
      )
      OR (
        src.group_id IS NULL
        AND (src.from_user_id = uid OR src.to_user_id = uid)
      )
    )
    AND (
      src.bill_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.bills b
        WHERE b.id = src.bill_id
          AND b.is_deleted IS FALSE
          AND (
            b.created_by = uid
            OR (b.group_id IS NOT NULL AND public.is_group_member(b.group_id, uid))
            OR (b.group_id IS NULL AND public.user_is_participant_on_personal_bill(b.id, uid))
          )
      )
    )
  ON CONFLICT (id) DO UPDATE SET
    group_id = EXCLUDED.group_id,
    bill_id = EXCLUDED.bill_id,
    bundle_id = EXCLUDED.bundle_id,
    from_user_id = EXCLUDED.from_user_id,
    to_user_id = EXCLUDED.to_user_id,
    amount = EXCLUDED.amount,
    currency = EXCLUDED.currency,
    is_settled = EXCLUDED.is_settled,
    label = EXCLUDED.label,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    synced_at = EXCLUDED.synced_at,
    is_deleted = EXCLUDED.is_deleted,
    device_id = EXCLUDED.device_id;
$$;
