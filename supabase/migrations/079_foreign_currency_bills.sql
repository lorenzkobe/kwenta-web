-- 079 — Foreign-currency bills: what was typed, the rate it was locked at, and the balance copy.
--
-- APPLY BEFORE THE CLIENT THAT WRITES THESE COLUMNS SHIPS.
-- A pre-079 server silently drops every new key: its push validators name their INSERT columns
-- (075), so a converted bill would be stored as a plain bill in the balance currency with no
-- trace of the paid-in amount, and its detail endpoints would never return the new keys. The
-- client treats a missing key as "not converted", so the reverse order (migration first, client
-- later) is harmless.
--
-- What this is for
-- A bill can be entered in a currency other than the one balances run in (VND on a trip, balances
-- in PHP). The client converts at save time with a rate the user can see and override, and locks
-- that rate into the bill. Option A: every money column that already exists (`bills.total_amount`,
-- `bill_items.amount`, `item_splits.computed_amount`, `split_value`) keeps holding the BALANCE
-- currency (`bills.currency`: PHP, or the group's currency), so every money function in 052-071
-- stays byte-for-byte untouched and a converted bill moves balances exactly as the same bill typed
-- in PHP would. What was typed is stored beside it:
--
--   bills.original_currency  the paid-in currency (NULL = the bill was not converted)
--   bills.exchange_rate      balance-currency units per ONE paid-in unit (VND -> PHP ~ 0.00246385)
--   bills.rate_source        'online' | 'manual'
--   bills.original_total     the bill total in the paid-in currency
--   bill_items.original_amount, item_splits.original_amount   the same, per row, as typed
--
-- Nothing ever re-reads a live rate into a saved bill: the rate is whatever was saved.
--
-- The invariant, and where it is enforced
-- The four bill columns are all NULL or all set, with exchange_rate > 0 and finite, rate_source in
-- ('online','manual'), original_currency a three-capital-letter code and <> currency (the client
-- feeds it to Intl.NumberFormat, which throws on anything else, so a stored 'zz' would crash
-- every reader's screen). `kwenta_push_bills` filters on it
-- (`kwenta_bill_conversion_ok`), so a violating row drops out of `applied` (and, since 078,
-- `kwenta_write` refuses the whole push) instead of surfacing as a constraint error; the CHECK
-- is the backstop for any other write. The CHECK states the predicate inline rather than calling
-- the helper because a CHECK runs the function with the WRITER's privileges, and the helper is
-- not (and must not become, 073's allowlist) executable by `authenticated`. The two copies must
-- change together. Postgres orders NaN ABOVE every number, so
-- `'NaN'::numeric > 0` is TRUE: the finite check (`< 'Infinity'`) is what keeps NaN and +Infinity
-- out, a bare `> 0` would not. Numeric infinity needs Postgres 14.
-- `original_amount` on items and splits is NULL or finite by the same test (any sign, like the
-- existing amount columns): the push validators drop a NaN row and a CHECK backs them. Infinity
-- already fails numeric(16,2) with 22003 before either is reached.
--
-- Older clients (installed PWAs keep their build until the user taps Refresh)
-- An old build's `updateBill` spreads the stored Dexie bill row, which it pulled as `to_jsonb(b)`
-- and so HOLDS the conversion columns, over a new `total_amount`, and writes NEW children that
-- carry no `original_amount`. Stored as is, that is a bill whose paid-in amount no longer
-- describes its balance amounts. `kwenta_clear_stale_bill_conversion` (AFTER INSERT/UPDATE on
-- bill_items, only for a LIVE item with `original_amount IS NULL`) clears the bill's four columns
-- and `original_amount` on its remaining live items and splits. A new client is unaffected:
-- `kwenta_write` applies bills before items before splits, so a bill it converts is stored first
-- and every live item it writes carries `original_amount`; items it retires are `is_deleted`.
--   * The bill's `updated_at` is bumped to GREATEST(now(), updated_at + 1 microsecond), as 048
--     does: the 021b guard keeps the stored row when it is newer than the incoming one, and every
--     other device only takes the cleared row if its version moves.
--   * The children are cleared WITHOUT touching their `updated_at`, on purpose. The same push
--     soft-deletes the old splits later, carrying the client's clock; bumping them past it would
--     make 021b keep the OLD (live) split and silently void the delete. The old client retires
--     its old children in that same push, so the rows cleared here are the ones about to be
--     deleted; another device gets the cleared bill row, and reads a bill with any live item
--     lacking `original_amount` as unconverted anyway (`isConvertedBill`).
--   * Known edge: an old client editing a converted GROUP bill after the group's currency changed
--     to the bill's paid-in currency sends original_currency = currency; that row violates the
--     invariant and is refused as any inconsistent row is.
--
-- What changes
--   * Columns, the CHECK, `kwenta_bill_conversion_ok` (service_role only), the trigger.
--   * `kwenta_push_bills` / `kwenta_push_bill_items` / `kwenta_push_item_splits`: copied from 075
--     with the new columns in the INSERT list and the ON CONFLICT SET, and `kwenta_push_bills`
--     filtering rows that break the invariant. Authorization (create rule, stored-row WHERE,
--     frozen keys) is unchanged.
--   * `kwenta_bill_detail` (065), `kwenta_personal_bills` (073), `kwenta_group_detail` (061),
--     `kwenta_recent_bills` (058): copied from their latest definitions, adding keys that read
--     columns of rows each already selects (no new query or join). A plain bill returns JSON null
--     for them. `kwenta_search` (056) keeps showing the balance amount.
--   * Pull needs nothing: `kwenta_pull_rows_*` return SETOF the table, so new columns reach Dexie
--     and the realtime reconcile on their own.
--
-- Grants: the validators stay service_role only (rule 5); the four endpoints keep their
-- `authenticated` grant, restated below. No client endpoint is added.

-- 1. The invariant, as the push validator filters on it
CREATE OR REPLACE FUNCTION public.kwenta_bill_conversion_ok(
  p_original_currency text,
  p_currency text,
  p_exchange_rate numeric,
  p_rate_source text,
  p_original_total numeric
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE
      WHEN p_original_currency IS NULL AND p_exchange_rate IS NULL
       AND p_rate_source IS NULL AND p_original_total IS NULL THEN true
      WHEN p_original_currency IS NOT NULL AND p_exchange_rate IS NOT NULL
       AND p_rate_source IS NOT NULL AND p_original_total IS NOT NULL
        THEN p_exchange_rate > 0
         AND p_exchange_rate < 'Infinity'::numeric
         AND p_original_total > '-Infinity'::numeric
         AND p_original_total < 'Infinity'::numeric
         AND p_rate_source IN ('online', 'manual')
         AND p_original_currency ~ '^[A-Z]{3}$'
         AND p_original_currency <> p_currency
      ELSE false
    END,
    false)
$$;

REVOKE ALL ON FUNCTION public.kwenta_bill_conversion_ok(text, text, numeric, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_bill_conversion_ok(text, text, numeric, text, numeric)
  TO service_role;

-- 2. Columns
-- NUMERIC(16,2) for what was typed: cents like every money column here, but wide enough for
-- currencies that count in the millions (VND, IDR) that NUMERIC(12,2) would cap at 10^10.
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS original_currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS original_total numeric(16,2);

ALTER TABLE public.bill_items
  ADD COLUMN IF NOT EXISTS original_amount numeric(16,2);

ALTER TABLE public.item_splits
  ADD COLUMN IF NOT EXISTS original_amount numeric(16,2);

ALTER TABLE public.bill_items DROP CONSTRAINT IF EXISTS bill_items_original_amount_finite;
ALTER TABLE public.bill_items ADD CONSTRAINT bill_items_original_amount_finite CHECK (
  original_amount IS NULL OR (original_amount > '-Infinity'::numeric AND original_amount < 'Infinity'::numeric)
);

ALTER TABLE public.item_splits DROP CONSTRAINT IF EXISTS item_splits_original_amount_finite;
ALTER TABLE public.item_splits ADD CONSTRAINT item_splits_original_amount_finite CHECK (
  original_amount IS NULL OR (original_amount > '-Infinity'::numeric AND original_amount < 'Infinity'::numeric)
);

ALTER TABLE public.bills DROP CONSTRAINT IF EXISTS bills_conversion_consistent;
-- Same predicate as kwenta_bill_conversion_ok (section 1); keep the two in step.
ALTER TABLE public.bills ADD CONSTRAINT bills_conversion_consistent CHECK (
  (original_currency IS NULL AND exchange_rate IS NULL AND rate_source IS NULL AND original_total IS NULL)
  OR (
    original_currency IS NOT NULL AND exchange_rate IS NOT NULL
    AND rate_source IS NOT NULL AND original_total IS NOT NULL
    AND exchange_rate > 0 AND exchange_rate < 'Infinity'::numeric
    AND original_total > '-Infinity'::numeric AND original_total < 'Infinity'::numeric
    AND rate_source IN ('online', 'manual')
    AND original_currency ~ '^[A-Z]{3}$'
    AND original_currency <> currency
  )
);

-- 3. An older client's edit must not leave a stale conversion beside new amounts
CREATE OR REPLACE FUNCTION public.kwenta_clear_stale_bill_conversion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.bills
     SET original_currency = NULL,
         exchange_rate = NULL,
         rate_source = NULL,
         original_total = NULL,
         updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
   WHERE id = NEW.bill_id
     AND original_currency IS NOT NULL;

  IF FOUND THEN
    UPDATE public.bill_items
       SET original_amount = NULL
     WHERE bill_id = NEW.bill_id
       AND is_deleted IS FALSE
       AND original_amount IS NOT NULL;

    UPDATE public.item_splits sp
       SET original_amount = NULL
      FROM public.bill_items bi
     WHERE bi.id = sp.item_id
       AND bi.bill_id = NEW.bill_id
       AND bi.is_deleted IS FALSE
       AND sp.is_deleted IS FALSE
       AND sp.original_amount IS NOT NULL;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_clear_stale_bill_conversion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS kwenta_bill_items_clear_stale_conversion ON public.bill_items;
CREATE TRIGGER kwenta_bill_items_clear_stale_conversion
AFTER INSERT OR UPDATE ON public.bill_items
FOR EACH ROW
WHEN (NEW.is_deleted IS FALSE AND NEW.original_amount IS NULL)
EXECUTE FUNCTION public.kwenta_clear_stale_bill_conversion();

-- 4. Push validators (075) carrying the new columns
CREATE OR REPLACE FUNCTION public.kwenta_push_bills(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.bills AS tgt (
      id, title, group_id, currency, created_by, paid_by, total_amount, note, category,
      created_at, updated_at, synced_at, is_deleted, device_id,
      original_currency, exchange_rate, rate_source, original_total
    )
    SELECT
      src.id, src.title, src.group_id, src.currency, src.created_by,
      public.kwenta_canonical_user_id(src.paid_by),
      src.total_amount, src.note, src.category, src.created_at, src.updated_at,
      src.synced_at, src.is_deleted, src.device_id,
      src.original_currency, src.exchange_rate, src.rate_source, src.original_total
    FROM jsonb_populate_recordset(
      NULL::public.bills,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE (
        (
          src.created_by = uid
          AND (src.group_id IS NULL OR public.kwenta_can_write_group(src.group_id, uid))
        )
        OR EXISTS (SELECT 1 FROM public.bills x WHERE x.id = src.id)
      )
      -- A half-set or non-positive conversion is refused here, not left to the CHECK, so the row
      -- drops out of `applied` instead of raising inside kwenta_sync's whole-bundle replay.
      AND public.kwenta_bill_conversion_ok(
        src.original_currency, src.currency, src.exchange_rate, src.rate_source, src.original_total)
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
      device_id = EXCLUDED.device_id,
      original_currency = EXCLUDED.original_currency,
      exchange_rate = EXCLUDED.exchange_rate,
      rate_source = EXCLUDED.rate_source,
      original_total = EXCLUDED.original_total
    WHERE tgt.created_by = EXCLUDED.created_by
      AND tgt.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
      AND public.kwenta_can_write_bill(tgt.id, uid)
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_bill_items(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.bill_items AS tgt (
      id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id,
      original_amount
    )
    SELECT
      src.id, src.bill_id, src.name, src.amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted,
      src.device_id, src.original_amount
    FROM jsonb_populate_recordset(
      NULL::public.bill_items,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE public.kwenta_can_write_bill(src.bill_id, uid)
      AND (src.original_amount IS NULL
           OR (src.original_amount > '-Infinity'::numeric AND src.original_amount < 'Infinity'::numeric))
    ON CONFLICT (id) DO UPDATE SET
      bill_id = EXCLUDED.bill_id,
      name = EXCLUDED.name,
      amount = EXCLUDED.amount,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      synced_at = EXCLUDED.synced_at,
      is_deleted = EXCLUDED.is_deleted,
      device_id = EXCLUDED.device_id,
      original_amount = EXCLUDED.original_amount
    -- The incoming parent was checked above; frozen, it is also the stored row's parent.
    WHERE tgt.bill_id = EXCLUDED.bill_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kwenta_push_item_splits(arr jsonb, uid uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  WITH upserted AS (
    INSERT INTO public.item_splits AS tgt (
      id, item_id, user_id, split_type, split_value, computed_amount, created_at, updated_at, synced_at,
      is_deleted, device_id, original_amount
    )
    SELECT
      src.id, src.item_id, public.kwenta_canonical_user_id(src.user_id), src.split_type, src.split_value,
      src.computed_amount, src.created_at, src.updated_at, src.synced_at, src.is_deleted, src.device_id,
      src.original_amount
    FROM jsonb_populate_recordset(
      NULL::public.item_splits,
      CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END
    ) AS src
    WHERE EXISTS (
      SELECT 1 FROM public.bill_items bi
      WHERE bi.id = src.item_id AND public.kwenta_can_write_bill(bi.bill_id, uid)
    )
      AND (src.original_amount IS NULL
           OR (src.original_amount > '-Infinity'::numeric AND src.original_amount < 'Infinity'::numeric))
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
      device_id = EXCLUDED.device_id,
      original_amount = EXCLUDED.original_amount
    -- As for items: the incoming parent was checked, and it is frozen. An item's bill_id is
    -- frozen too, so the item cannot have been moved under the split either.
    WHERE tgt.item_id = EXCLUDED.item_id
    RETURNING tgt.id
  )
  SELECT array_agg(id) INTO ids FROM upserted;
  RETURN coalesce(ids, ARRAY[]::uuid[]);
END;
$function$;

-- Restated (CLAUDE.md rule 3 / 5): these take the acting user as an argument, so they are server-only.
REVOKE ALL ON FUNCTION public.kwenta_push_bills(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bills(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_bill_items(jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.kwenta_push_item_splits(jsonb, uuid) TO service_role;

-- 5. Endpoints returning the new keys (each copied from its latest definition)

/** Bill detail: 065's body; adds the conversion keys on the bill, items and splits. */
CREATE OR REPLACE FUNCTION public.kwenta_bill_detail(p_bill_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  EPS constant numeric := 0.005;
  v_uid uuid := auth.uid();
  v_bill public.bills%ROWTYPE;
  v_group_name text;
  v_items jsonb;
  v_pairs jsonb := '[]'::jsonb;
  v_my_split_total numeric := NULL;
  r record;
  v_net numeric;
  v_tab numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_bill
  FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
  WHERE b.id = p_bill_id AND b.is_deleted IS FALSE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT g.name INTO v_group_name
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = v_bill.group_id AND g.is_deleted IS FALSE;

  SELECT COALESCE(jsonb_agg(t.item ORDER BY t.created_at, t.id), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      bi.id,
      bi.created_at,
      jsonb_build_object(
        'id',     bi.id,
        'name',   bi.name,
        'amount', bi.amount,
        'originalAmount', bi.original_amount,
        'splits', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id',             sp.id,
              'userId',         sp.user_id,
              'displayName',    public.kwenta_bill_participant_name(v_bill.group_id, v_uid, sp.user_id),
              'splitType',      sp.split_type,
              'splitValue',     sp.split_value,
              'computedAmount', sp.computed_amount,
              'originalAmount', sp.original_amount
            ) ORDER BY sp.id
          )
          FROM public.item_splits sp
          WHERE sp.item_id = bi.id AND sp.is_deleted IS FALSE
        ), '[]'::jsonb)
      ) AS item
    FROM public.bill_items bi
    WHERE bi.bill_id = p_bill_id AND bi.is_deleted IS FALSE
  ) t;

  -- Personal bills only: what the viewer's own share of this bill comes to. On a group bill the
  -- screen does not show it, and the old client returned null there.
  --
  -- SUM over zero rows is NULL, and that NULL is the answer: it means the viewer holds no split
  -- on this bill. COALESCE-ing it to 0 made a bill someone split entirely between two OTHER
  -- people render "Your share 0.00" on the payer's screen. A genuine zero share still comes back
  -- as 0 and still renders, because that is a different fact.
  IF v_bill.group_id IS NULL THEN
    SELECT SUM(sp.computed_amount) INTO v_my_split_total
    FROM public.item_splits sp
    JOIN public.bill_items bi ON bi.id = sp.item_id AND bi.is_deleted IS FALSE
    WHERE bi.bill_id = p_bill_id
      AND sp.is_deleted IS FALSE
      AND sp.user_id IN (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid));
  END IF;

  FOR r IN
    SELECT
      c.cluster_key,
      COALESCE(
        MIN(c.uid::text) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM public.profiles pr
            WHERE pr.id = c.uid AND pr.is_deleted IS FALSE
              AND pr.is_local IS TRUE AND pr.owner_id = v_uid
          )
        ),
        MIN(c.uid::text)
      )::uuid AS rep
    FROM (
      SELECT
        p.uid,
        (SELECT MIN(e.id::text)::uuid
           FROM public.kwenta_expand_identity(p.uid, v_uid) e) AS cluster_key
      FROM (
        SELECT v_bill.paid_by AS uid
        UNION
        SELECT sp.user_id
        FROM public.item_splits sp
        JOIN public.bill_items bi ON bi.id = sp.item_id AND bi.is_deleted IS FALSE
        WHERE bi.bill_id = p_bill_id AND sp.is_deleted IS FALSE
      ) p
      WHERE p.uid IS NOT NULL
        AND p.uid NOT IN (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid))
    ) c
    GROUP BY c.cluster_key
    ORDER BY c.cluster_key
  LOOP
    v_net := public.kwenta_bill_pairwise(p_bill_id, v_uid, r.rep);
    CONTINUE WHEN v_net IS NULL OR ABS(v_net) < EPS;

    v_tab := COALESCE(
      (public.kwenta_pairwise_breakdown(v_uid, r.rep) -> 'total' ->> v_bill.currency)::numeric,
      0);

    v_pairs := v_pairs || jsonb_build_array(jsonb_build_object(
      'otherId',       r.rep,
      'displayName',   public.kwenta_bill_participant_name(v_bill.group_id, v_uid, r.rep),
      'net',           v_net,
      'squareOverall', ABS(v_tab) <= EPS
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'bill', jsonb_build_object(
      'id',          v_bill.id,
      'title',       v_bill.title,
      'note',        v_bill.note,
      'currency',    v_bill.currency,
      'totalAmount', v_bill.total_amount,
      'createdAt',   v_bill.created_at,
      'createdBy',   v_bill.created_by,
      'paidBy',      v_bill.paid_by,
      'groupId',     v_bill.group_id,
      'category',    v_bill.category,
      'originalCurrency', v_bill.original_currency,
      'exchangeRate',     v_bill.exchange_rate,
      'rateSource',       v_bill.rate_source,
      'originalTotal',    v_bill.original_total,
      'creatorName', public.kwenta_bill_participant_name(v_bill.group_id, v_uid, v_bill.created_by),
      'payorName',   public.kwenta_bill_participant_name(v_bill.group_id, v_uid, v_bill.paid_by)
    ),
    'groupName',    v_group_name,
    'items',        v_items,
    'mySplitTotal', v_my_split_total,
    'pairs',        v_pairs
  );
END;
$$;

/** Bills list: 073's body; adds the conversion keys. */
CREATE OR REPLACE FUNCTION public.kwenta_personal_bills()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_bills public.bills[];
  v_bill_ids uuid[];
  v_settled jsonb;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- The visible personal bills, read once through the privacy boundary and reused below.
  v_bills := ARRAY(
    SELECT b
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  );
  v_bill_ids := ARRAY(SELECT vb.id FROM unnest(v_bills) vb);

  -- One pass for the whole list, so each counterparty's cross-context tab is computed once.
  v_settled := public.kwenta_bills_settled_map(v_bill_ids, v_uid);

  WITH
  me AS MATERIALIZED (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  visible_bills AS MATERIALIZED (SELECT vb.* FROM unnest(v_bills) vb),
  active_items AS MATERIALIZED (
    SELECT bi.id, bi.bill_id
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
    WHERE bi.is_deleted IS FALSE
  ),
  active_splits AS MATERIALIZED (
    SELECT ai.bill_id, sp.user_id
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.is_deleted IS FALSE
  ),
  -- Bills the viewer holds a live split on, once, rather than a scan of every split per bill.
  my_split_bills AS MATERIALIZED (
    SELECT DISTINCT s.bill_id FROM active_splits s WHERE s.user_id IN (SELECT id FROM me)
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = v_uid THEN 'mine'
             WHEN vb.id IN (SELECT bill_id FROM my_split_bills) THEN 'shared'
             ELSE NULL
           END AS bucket
    FROM visible_bills vb
  ),
  kept AS MATERIALIZED (SELECT * FROM bucketed WHERE bucket IS NOT NULL),
  participants AS MATERIALIZED (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  -- Identity is a property of the id, not of the bill: expand each distinct id once.
  -- A soft-deleted contact is outside its account's identity cluster (067), but on a pill it still
  -- names that account: key it by the account so it shares the account's pill (073).
  cluster_keys AS MATERIALIZED (
    SELECT u.uid,
           (SELECT MIN(e.id::text)::uuid
              FROM public.kwenta_expand_identity(
                     COALESCE((SELECT pr.linked_profile_id FROM public.profiles pr
                                WHERE pr.id = u.uid AND pr.is_local IS TRUE AND pr.is_deleted IS TRUE),
                              u.uid),
                     v_uid) e) AS cluster_key
    FROM (SELECT DISTINCT p.uid FROM participants p) u
  ),
  -- Own contact, else the person's live account, else the lowest id: another user's private
  -- contact must not name someone who has an account of their own (073).
  representative AS MATERIALIZED (
    SELECT p.bill_id,
           ck.cluster_key,
           COALESCE(
             MIN(p.uid::text) FILTER (
               WHERE pr.is_deleted IS FALSE AND pr.is_local IS TRUE AND pr.owner_id = v_uid
             ),
             -- The viewer's own pill reads "You" whatever represents it; its id stays as 071 chose.
             CASE WHEN NOT bool_or(p.uid IN (SELECT id FROM me)) THEN MIN(acct.id::text) END,
             MIN(p.uid::text)
           )::uuid AS rep,
           bool_or(p.uid IN (SELECT id FROM me)) AS is_me
    FROM participants p
    JOIN cluster_keys ck ON ck.uid = p.uid
    LEFT JOIN public.profiles pr ON pr.id = p.uid
    LEFT JOIN public.profiles acct
      ON acct.id = CASE WHEN pr.is_local IS TRUE THEN pr.linked_profile_id ELSE p.uid END
     AND acct.is_local IS FALSE
     AND acct.is_deleted IS FALSE
    GROUP BY p.bill_id, ck.cluster_key
  ),
  -- Every name this response prints, resolved once per id (pill labels, their sort key, payers).
  names AS MATERIALIZED (
    SELECT x.id, public.kwenta_peer_display_name(v_uid, x.id) AS name
    FROM (
      SELECT r.rep AS id FROM representative r WHERE NOT r.is_me
      UNION
      SELECT k.paid_by FROM kept k
    ) x
  ),
  pills AS (
    SELECT r.bill_id,
           jsonb_agg(
             jsonb_build_object(
               'id',    r.rep,
               'label', CASE WHEN r.is_me THEN 'You' ELSE n.name END
             )
             ORDER BY r.is_me DESC,
                      CASE WHEN r.is_me THEN '' ELSE n.name END,
                      r.rep
           ) AS pills
    FROM representative r
    LEFT JOIN names n ON n.id = r.rep
    GROUP BY r.bill_id
  ),
  item_counts AS (
    SELECT ai.bill_id, COUNT(*) AS n FROM active_items ai GROUP BY ai.bill_id
  ),
  rows AS (
    SELECT
      k.bucket,
      jsonb_build_object(
        'id',          k.id,
        'title',       k.title,
        'currency',    k.currency,
        'totalAmount', k.total_amount,
        'createdAt',   k.created_at,
        'createdBy',   k.created_by,
        -- Rule 6's roster fallback, via the same resolver as the pills (065). The viewer's own
        -- bills name the viewer here; only the PILL says "You".
        'payorName',   COALESCE(pn.name, 'Someone'),
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     COALESCE((v_settled ->> k.id::text)::boolean, true),
        'category',    k.category,
        'originalCurrency', k.original_currency,
        'originalTotal',    k.original_total,
        'exchangeRate',     k.exchange_rate,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at,
      k.id
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
    LEFT JOIN names pn ON pn.id = k.paid_by
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC, id)
                        FROM rows WHERE bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


/** Group detail: 061's body; the bills list gains the conversion keys. */
CREATE OR REPLACE FUNCTION public.kwenta_group_detail(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group public.groups%ROWTYPE;
  v_members jsonb;
  v_bills jsonb;
  v_pairwise jsonb;
  v_to_receive numeric := 0;
  v_to_pay numeric := 0;
  v_member_balances jsonb;
  v_raw_debts jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_group
  FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
  WHERE g.id = p_group_id AND g.is_deleted IS FALSE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A former member must not read a group they have left. The pull bundle still delivers the
  -- rows (24: deletion events have to reach former members), so absence from the bundle is not
  -- the check — active membership is.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_uid AND gm.is_deleted IS FALSE
  ) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',            m.id,
      'userId',        m.user_id,
      'profileName',   COALESCE(NULLIF(BTRIM(p.display_name), ''), NULLIF(BTRIM(m.display_name), ''), 'Unknown'),
      'isCurrentUser', m.user_id = v_uid
    ) ORDER BY (m.user_id = v_uid) DESC, m.joined_at, m.id
  ), '[]'::jsonb)
  INTO v_members
  FROM public.group_members m
  LEFT JOIN public.kwenta_pull_rows_profiles('epoch'::timestamptz, v_uid) p ON p.id = m.user_id
  WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',          b.id,
      'title',       b.title,
      'note',        b.note,
      'currency',    b.currency,
      'totalAmount', b.total_amount,
      'createdAt',   b.created_at,
      'createdBy',   b.created_by,
      'paidBy',      b.paid_by,
      'groupId',     b.group_id,
      'category',    b.category,
      'originalCurrency', b.original_currency,
      'originalTotal',    b.original_total,
      'exchangeRate',     b.exchange_rate,
      'payorName',   public.kwenta_bill_participant_name(p_group_id, v_uid, b.paid_by)
    ) ORDER BY b.created_at DESC, b.id
  ), '[]'::jsonb)
  INTO v_bills
  FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
  WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'memberUserId', gp.member_user_id,
      'displayName',  gp.display_name,
      'net',          gp.net
    ) ORDER BY gp.display_name, gp.member_user_id), '[]'::jsonb),
    COALESCE(SUM(GREATEST(gp.net, 0)), 0),
    COALESCE(SUM(GREATEST(-gp.net, 0)), 0)
  INTO v_pairwise, v_to_receive, v_to_pay
  FROM public.kwenta_group_pairwise(p_group_id, v_uid) gp;

  -- Net against the group pool: credited for what you fronted, debited for your own shares.
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  sp AS (
    SELECT gb.paid_by, s.user_id, s.computed_amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL
  ),
  gs AS (
    SELECT s.* FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  ),
  deltas AS (
    SELECT sp.paid_by AS uid,  sp.computed_amount AS delta FROM sp
    UNION ALL
    SELECT sp.user_id AS uid, -sp.computed_amount        FROM sp
    UNION ALL
    -- Paying someone reduces what you owe the pool; receiving increases it.
    SELECT gs.from_user_id, gs.amount FROM gs
    UNION ALL
    SELECT gs.to_user_id, -gs.amount FROM gs
    UNION ALL
    -- Active members appear at zero: "settled" is a real answer the roster has to show.
    SELECT m.user_id, 0 FROM public.group_members m
    WHERE m.group_id = p_group_id AND m.is_deleted IS FALSE
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'userId',      t.uid,
    'displayName', public.kwenta_bill_participant_name(p_group_id, v_uid, t.uid),
    'amount',      t.amount
  ) ORDER BY t.amount DESC, t.uid), '[]'::jsonb)
  INTO v_member_balances
  FROM (
    SELECT d.uid, public.kwenta_round_money(SUM(d.delta)) AS amount
    FROM deltas d
    WHERE d.uid IS NOT NULL
    GROUP BY d.uid
  ) t;

  -- The directed debt graph the client decomposes into transfers. A split is a debt from the
  -- splitter to the payer; a settled payment is a debt in the OPPOSITE direction, which cancels
  -- against it rather than being subtracted (the client's buildDebtGraph nets the pair).
  WITH
  gb AS (
    SELECT b.* FROM public.bills b
    WHERE b.group_id = p_group_id AND b.is_deleted IS FALSE
      AND (b.currency IS NULL OR b.currency = '' OR b.currency = v_group.currency)
  ),
  bill_debts AS (
    SELECT s.user_id AS from_id, gb.paid_by AS to_id, s.computed_amount AS amount
    FROM gb
    JOIN public.bill_items bi ON bi.bill_id = gb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits s ON s.item_id = bi.id AND s.is_deleted IS FALSE
    WHERE gb.paid_by IS NOT NULL AND s.user_id <> gb.paid_by
  ),
  settlement_debts AS (
    SELECT s.to_user_id AS from_id, s.from_user_id AS to_id, s.amount
    FROM public.settlements s
    WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND (s.currency IS NULL OR s.currency = '' OR s.currency = v_group.currency)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'from', d.from_id, 'to', d.to_id, 'amount', d.amount
  )), '[]'::jsonb)
  INTO v_raw_debts
  FROM (
    SELECT * FROM bill_debts
    UNION ALL
    SELECT * FROM settlement_debts
  ) d;

  RETURN jsonb_build_object(
    'group', jsonb_build_object(
      'id',         v_group.id,
      'name',       v_group.name,
      'currency',   v_group.currency,
      'createdBy',  v_group.created_by,
      'inviteCode', v_group.invite_code,
      'updatedAt',  v_group.updated_at
    ),
    'members',        v_members,
    'bills',          v_bills,
    'pairwise',       v_pairwise,
    'totalToReceive', public.kwenta_round_money(v_to_receive),
    'totalToPay',     public.kwenta_round_money(v_to_pay),
    'memberBalances', v_member_balances,
    'rawDebts',       v_raw_debts
  );
END;
$$;


/** Home's recent bills: 058's body; adds the conversion keys. */
CREATE OR REPLACE FUNCTION public.kwenta_recent_bills(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(row ORDER BY row ->> 'createdAt' DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'id',        b.id,
             'title',     b.title,
             'amount',    b.total_amount,
             'currency',  b.currency,
             'createdAt', b.created_at,
             'groupName', g.name,
             'originalCurrency', b.original_currency,
             'originalTotal',    b.original_total
           ) AS row
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, auth.uid()) b
    LEFT JOIN public.kwenta_pull_rows_groups('epoch'::timestamptz, auth.uid()) g
           ON g.id = b.group_id AND g.is_deleted IS FALSE
    WHERE b.paid_by = auth.uid()
      AND b.is_deleted IS FALSE
    ORDER BY b.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 5), 0)
  ) t;
$$;


REVOKE ALL ON FUNCTION public.kwenta_bill_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_personal_bills() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_group_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kwenta_recent_bills(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kwenta_bill_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_personal_bills() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_group_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_recent_bills(integer) TO authenticated;

SELECT public.kwenta_revoke_acting_user_helpers();
