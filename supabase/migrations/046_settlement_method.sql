-- Migration 046: add optional `method` (how a payment moved: cash / transfer / …) to
-- settlements, for the payment audit introduced by the person-debt overhaul.
--
-- Additive + backward-compatible: null for every existing row. The pull bundle serializes
-- settlements with to_jsonb(s.*) (migration 024), so the new column is returned to clients
-- automatically. Only the push upsert enumerates columns explicitly, so it is re-created
-- here to thread `method` through (body from migration 044, unchanged except for `method`).

ALTER TABLE public.settlements ADD COLUMN IF NOT EXISTS method text;

DROP FUNCTION IF EXISTS public.kwenta_push_settlements(jsonb, uuid);
CREATE OR REPLACE FUNCTION public.kwenta_push_settlements(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.settlements AS tgt (
      id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency, is_settled, label, method, created_at, updated_at,
      synced_at, is_deleted, device_id
    )
    SELECT
      src.id, src.group_id, src.bill_id, src.bundle_id,
      public.kwenta_canonical_user_id(src.from_user_id),
      public.kwenta_canonical_user_id(src.to_user_id),
      src.amount, src.currency, src.is_settled,
      src.label, src.method, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id
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
      method = EXCLUDED.method,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_settlements(jsonb, uuid) TO service_role;
