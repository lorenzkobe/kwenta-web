-- 079_foreign_currency_bills.test.sql
--
-- Foreign-currency bills. A converted bill keeps every existing money column in its BALANCE
-- currency (bills.currency: PHP, or the group's), so every money function stays untouched, and
-- additionally records what was typed:
--   bills.original_currency / exchange_rate / rate_source / original_total
--   bill_items.original_amount, item_splits.original_amount
-- with an all-or-none invariant on the four bill columns (exchange_rate > 0, rate_source in
-- ('online','manual'), original_currency <> currency).
--
-- Pinned here, written from the requirements (QA, blind to the migration body):
--   C12  kwenta_write stores a converted bill with every column; kwenta_bill_detail,
--        kwenta_personal_bills, kwenta_group_detail and (C31) kwenta_recent_bills return the new
--        keys, null on an unconverted bill — read through test.as_user so RLS applies.
--   C13  an inconsistent bill row is refused and (078) the whole write rolls back; the CHECK is the
--        backstop for a direct insert.
--   C14  an older client's push that omits the keys leaves a plain bill (superseded in intent by
--        C28, kept because a pre-079 client that never pulled the columns sends exactly this).
--   C28  the REAL old-client shape: the stored bill row spread back (stale conversion columns) with a
--        new total, plus new live children without original_amount -> the conversion is cleared; a
--        new-client push with original_amount on every item keeps it.
--   C15  balances of a converted bill equal those of the same bill entered directly in PHP.
--   C16  the redefined push validators stay service_role only; the client allowlist is unchanged.
--
-- Rows are built in the shape src/db/operations.ts createBill writes (and 078's suite uses):
-- equal splits carry split_value 1, local timestamps, synced_at NULL on push.

SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION test.fx_row_of(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', p_table) INTO r USING p_id;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION test.fx_bill(
  p_id uuid, p_creator uuid, p_group uuid, p_currency text, p_total numeric, p_title text, p_at timestamptz
)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'title', p_title, 'group_id', p_group, 'currency', p_currency,
    'created_by', p_creator, 'paid_by', p_creator, 'total_amount', p_total, 'note', '',
    'category', NULL, 'created_at', now(), 'updated_at', p_at, 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;

CREATE OR REPLACE FUNCTION test.fx_conv(p_cur text, p_rate numeric, p_source text, p_total numeric)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('original_currency', p_cur, 'exchange_rate', p_rate,
    'rate_source', p_source, 'original_total', p_total)
$$;

CREATE OR REPLACE FUNCTION test.fx_item(p_id uuid, p_bill uuid, p_amount numeric, p_original numeric, p_at timestamptz)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'bill_id', p_bill, 'name', 'Pho', 'amount', p_amount,
    'original_amount', p_original, 'created_at', now(), 'updated_at', p_at, 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;

CREATE OR REPLACE FUNCTION test.fx_split(
  p_id uuid, p_item uuid, p_user uuid, p_computed numeric, p_original numeric, p_at timestamptz
)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'item_id', p_item, 'user_id', p_user,
    'split_type', 'equal', 'split_value', 1, 'computed_amount', p_computed,
    'original_amount', p_original, 'created_at', now(), 'updated_at', p_at, 'synced_at', NULL,
    'is_deleted', false, 'device_id', 'test')
$$;

-- The canonical converted personal bill: 500000 VND at 0.00246385 = 1231.93 PHP, split
-- 615.97 / 615.96 (largest remainder, tie to the first listed participant).
CREATE OR REPLACE FUNCTION test.fx_vnd_push(
  p_bill uuid, p_item uuid, p_s1 uuid, p_s2 uuid, p_creator uuid, p_other uuid, p_group uuid, p_at timestamptz
)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'bills', jsonb_build_array(
      test.fx_bill(p_bill, p_creator, p_group, 'PHP', 1231.93, 'Pho night', p_at)
        || test.fx_conv('VND', 0.00246385, 'online', 500000)),
    'bill_items', jsonb_build_array(test.fx_item(p_item, p_bill, 1231.93, 500000, p_at)),
    'item_splits', jsonb_build_array(
      test.fx_split(p_s1, p_item, p_creator, 615.97, 250000, p_at),
      test.fx_split(p_s2, p_item, p_other, 615.96, 250000, p_at)))
$$;

CREATE OR REPLACE FUNCTION test.fx_find(p_arr jsonb, p_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT e FROM jsonb_array_elements(COALESCE(p_arr, '[]'::jsonb)) e WHERE e ->> 'id' = p_id::text LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION test.fx_row_of(text, uuid),
  test.fx_bill(uuid, uuid, uuid, text, numeric, text, timestamptz),
  test.fx_conv(text, numeric, text, numeric),
  test.fx_item(uuid, uuid, numeric, numeric, timestamptz),
  test.fx_split(uuid, uuid, uuid, numeric, numeric, timestamptz),
  test.fx_vnd_push(uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz),
  test.fx_find(jsonb, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- C12 + C31: stored columns and the endpoint keys for a converted PERSONAL bill, and nulls for a
-- plain one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; plain uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  res jsonb; d jsonb; row0 jsonb; k text; n int;
  r record;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx12-alice@example.com', 'Alice');
  bob   := test.new_account('fx12-bob@example.com', 'Bob');

  PERFORM test.as_user(alice);
  res := public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute'),
                             gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C12: the converted bill is applied');
  PERFORM test.assert_true(res -> 'applied' -> 'bill_items' ? ni::text, 'C12: its item is applied');
  PERFORM test.assert_true(res -> 'applied' -> 'item_splits' ? s1::text AND res -> 'applied' -> 'item_splits' ? s2::text,
    'C12: both splits are applied');

  SELECT * INTO r FROM public.bills WHERE id = nb;
  PERFORM test.assert_eq(r.currency::text, 'PHP', 'C12: bills.currency stays the balance currency');
  PERFORM test.assert_money(r.total_amount, 1231.93, 'C12: total_amount is the PHP total');
  PERFORM test.assert_eq(r.original_currency::text, 'VND', 'C12: original_currency stored');
  PERFORM test.assert_true(r.exchange_rate::numeric = 0.00246385,
    'C12: exchange_rate stored exactly (got ' || COALESCE(r.exchange_rate::text, 'null') || ')');
  PERFORM test.assert_eq(r.rate_source::text, 'online', 'C12: rate_source stored');
  PERFORM test.assert_true(r.original_total::numeric = 500000, 'C12: original_total stored');
  PERFORM test.assert_true((SELECT original_amount::numeric FROM public.bill_items WHERE id = ni) = 500000,
    'C12: bill_items.original_amount stored');
  PERFORM test.assert_eq((SELECT count(*) FROM public.item_splits WHERE id IN (s1, s2) AND original_amount::numeric = 250000),
    2::bigint, 'C12: item_splits.original_amount stored on both shares');
  PERFORM test.assert_money((SELECT computed_amount FROM public.item_splits WHERE id = s1), 615.97,
    'C12: computed_amount is the PHP share');

  -- kwenta_bill_detail, as the creator and as the other participant.
  FOREACH k IN ARRAY ARRAY['alice', 'bob'] LOOP
    PERFORM test.as_user(CASE WHEN k = 'alice' THEN alice ELSE bob END);
    d := public.kwenta_bill_detail(nb);
    PERFORM test.as_owner();
    PERFORM test.assert_eq(d -> 'bill' ->> 'originalCurrency', 'VND', 'C12: bill_detail originalCurrency (' || k || ')');
    PERFORM test.assert_true((d -> 'bill' ->> 'exchangeRate')::numeric = 0.00246385,
      'C12: bill_detail exchangeRate (' || k || ', got ' || COALESCE(d -> 'bill' ->> 'exchangeRate', 'null') || ')');
    PERFORM test.assert_eq(d -> 'bill' ->> 'rateSource', 'online', 'C12: bill_detail rateSource (' || k || ')');
    PERFORM test.assert_true((d -> 'bill' ->> 'originalTotal')::numeric = 500000, 'C12: bill_detail originalTotal (' || k || ')');
    PERFORM test.assert_money((d -> 'bill' ->> 'totalAmount')::numeric, 1231.93, 'C12: bill_detail totalAmount stays PHP (' || k || ')');
    PERFORM test.assert_true((d -> 'items' -> 0 ->> 'originalAmount')::numeric = 500000,
      'C12: bill_detail items[].originalAmount (' || k || ')');
    SELECT count(*) INTO n FROM jsonb_array_elements(d -> 'items' -> 0 -> 'splits') s
     WHERE (s ->> 'originalAmount')::numeric = 250000;
    PERFORM test.assert_eq(n, 2, 'C12: bill_detail splits[].originalAmount on both shares (' || k || ')');
  END LOOP;

  -- kwenta_personal_bills (Bills list) and kwenta_recent_bills (Home), as the creator.
  PERFORM test.as_user(alice);
  row0 := test.fx_find(public.kwenta_personal_bills() -> 'mine', nb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(row0 IS NOT NULL, 'C12: the converted bill is in personal_bills.mine');
  PERFORM test.assert_eq(row0 ->> 'originalCurrency', 'VND', 'C12: personal_bills originalCurrency');
  PERFORM test.assert_true((row0 ->> 'originalTotal')::numeric = 500000, 'C12: personal_bills originalTotal');
  PERFORM test.assert_true((row0 ->> 'exchangeRate')::numeric = 0.00246385, 'C12: personal_bills exchangeRate');
  PERFORM test.assert_money((row0 ->> 'totalAmount')::numeric, 1231.93, 'C12: personal_bills totalAmount stays PHP');

  PERFORM test.as_user(alice);
  row0 := test.fx_find(public.kwenta_recent_bills(10), nb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(row0 IS NOT NULL, 'C31: the converted bill is in recent_bills');
  PERFORM test.assert_eq(row0 ->> 'originalCurrency', 'VND', 'C31: recent_bills originalCurrency');
  PERFORM test.assert_true((row0 ->> 'originalTotal')::numeric = 500000, 'C31: recent_bills originalTotal');
  PERFORM test.assert_money((row0 ->> 'amount')::numeric, 1231.93, 'C31: recent_bills amount stays PHP');

  -- A plain bill: the keys are present and JSON null (an older server omits them; this one must not).
  plain := test.new_bill(alice, alice, NULL, 'Plain', 100.00, ARRAY[alice, bob]);
  SELECT * INTO r FROM public.bills WHERE id = plain;
  PERFORM test.assert_true(r.original_currency IS NULL AND r.exchange_rate IS NULL AND r.rate_source IS NULL
    AND r.original_total IS NULL, 'C12: a bill written without the columns stores NULLs');

  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(plain);
  PERFORM test.as_owner();
  FOREACH k IN ARRAY ARRAY['originalCurrency', 'exchangeRate', 'rateSource', 'originalTotal'] LOOP
    PERFORM test.assert_true((d -> 'bill') ? k, 'C12: bill_detail carries bill.' || k || ' on a plain bill');
    PERFORM test.assert_eq(d -> 'bill' -> k, 'null'::jsonb, 'C12: bill_detail bill.' || k || ' is null on a plain bill');
  END LOOP;
  PERFORM test.assert_true((d -> 'items' -> 0) ? 'originalAmount', 'C12: items[].originalAmount present on a plain bill');
  PERFORM test.assert_eq(d -> 'items' -> 0 -> 'originalAmount', 'null'::jsonb, 'C12: items[].originalAmount null');
  SELECT count(*) INTO n FROM jsonb_array_elements(d -> 'items' -> 0 -> 'splits') s
   WHERE s ? 'originalAmount' AND s -> 'originalAmount' = 'null'::jsonb;
  PERFORM test.assert_eq(n, 2, 'C12: splits[].originalAmount present and null on a plain bill');

  PERFORM test.as_user(alice);
  row0 := test.fx_find(public.kwenta_personal_bills() -> 'mine', plain);
  PERFORM test.as_owner();
  FOREACH k IN ARRAY ARRAY['originalCurrency', 'originalTotal', 'exchangeRate'] LOOP
    PERFORM test.assert_true(row0 ? k, 'C12: personal_bills carries ' || k || ' on a plain bill');
    PERFORM test.assert_eq(row0 -> k, 'null'::jsonb, 'C12: personal_bills ' || k || ' null on a plain bill');
  END LOOP;

  PERFORM test.as_user(alice);
  row0 := test.fx_find(public.kwenta_recent_bills(10), plain);
  PERFORM test.as_owner();
  FOREACH k IN ARRAY ARRAY['originalCurrency', 'originalTotal'] LOOP
    PERFORM test.assert_true(row0 ? k, 'C31: recent_bills carries ' || k || ' on a plain bill');
    PERFORM test.assert_eq(row0 -> k, 'null'::jsonb, 'C31: recent_bills ' || k || ' null on a plain bill');
  END LOOP;

  PERFORM test.note('079 C12/C31: converted personal bill stored and surfaced; plain bill reads null');
END;
$$;

-- ---------------------------------------------------------------------------
-- C12: a converted GROUP bill, in the group's currency, on kwenta_group_detail.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; plain uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  res jsonb; d jsonb; row0 jsonb; k text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx12g-alice@example.com', 'Alice');
  bob   := test.new_account('fx12g-bob@example.com', 'Bob');
  g     := test.new_group(alice, 'Hanoi', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  PERFORM test.as_user(alice);
  res := public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, g, now() + interval '1 minute'),
                             gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C12: the converted group bill is applied');
  PERFORM test.assert_eq((SELECT original_currency::text FROM public.bills WHERE id = nb), 'VND',
    'C12: group bill original_currency stored');

  plain := test.new_bill(alice, alice, g, 'Plain', 100.00, ARRAY[alice, bob]);

  -- Read as the OTHER member: a co-member sees the paid-in amount too.
  PERFORM test.as_user(bob);
  d := public.kwenta_group_detail(g);
  PERFORM test.as_owner();
  row0 := test.fx_find(d -> 'bills', nb);
  PERFORM test.assert_true(row0 IS NOT NULL, 'C12: the converted bill is in group_detail.bills');
  PERFORM test.assert_eq(row0 ->> 'currency', 'PHP', 'C12: group_detail currency stays the group currency');
  PERFORM test.assert_eq(row0 ->> 'originalCurrency', 'VND', 'C12: group_detail originalCurrency');
  PERFORM test.assert_true((row0 ->> 'originalTotal')::numeric = 500000, 'C12: group_detail originalTotal');
  PERFORM test.assert_true((row0 ->> 'exchangeRate')::numeric = 0.00246385, 'C12: group_detail exchangeRate');

  row0 := test.fx_find(d -> 'bills', plain);
  FOREACH k IN ARRAY ARRAY['originalCurrency', 'originalTotal', 'exchangeRate'] LOOP
    PERFORM test.assert_true(row0 ? k, 'C12: group_detail carries ' || k || ' on a plain bill');
    PERFORM test.assert_eq(row0 -> k, 'null'::jsonb, 'C12: group_detail ' || k || ' null on a plain bill');
  END LOOP;

  PERFORM test.note('079 C12: converted group bill on kwenta_group_detail');
END;
$$;

-- ---------------------------------------------------------------------------
-- C13: an inconsistent bill row is refused, and the whole write rolls back (078).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  variants jsonb[] := ARRAY[
    test.fx_conv('VND', NULL, 'online', 500000),          -- no rate
    test.fx_conv('VND', 0, 'online', 500000),             -- rate 0
    test.fx_conv('VND', -0.00246385, 'online', 500000),   -- negative rate
    test.fx_conv('VND', 0.00246385, 'guess', 500000),     -- unknown rate_source
    test.fx_conv('VND', 0.00246385, NULL, 500000),        -- no rate_source
    test.fx_conv('PHP', 1, 'manual', 1231.93),            -- original_currency = currency
    test.fx_conv(NULL, 0.00246385, 'online', 500000),     -- rate without a currency
    test.fx_conv('VND', 0.00246385, 'online', NULL),      -- no original_total
    -- NaN is not a rate: in Postgres NaN > 0 is TRUE, so a bare "> 0" check would let it through.
    jsonb_build_object('original_currency', 'VND', 'exchange_rate', 'NaN', 'rate_source', 'online', 'original_total', 500000),
    jsonb_build_object('original_currency', 'VND', 'exchange_rate', 'Infinity', 'rate_source', 'online', 'original_total', 500000),
    -- The client feeds original_currency to Intl.NumberFormat, which throws on anything but a code.
    test.fx_conv('', 0.00246385, 'online', 500000),
    test.fx_conv('zz', 0.00246385, 'online', 500000),
    test.fx_conv('vnd', 0.00246385, 'online', 500000),
    test.fx_conv('VNDX', 0.00246385, 'online', 500000),
    test.fx_conv(repeat('V', 10000), 0.00246385, 'online', 500000)
  ];
  labels text[] := ARRAY['no rate', 'rate 0', 'negative rate', 'unknown rate_source', 'no rate_source',
    'original_currency = currency', 'rate without currency', 'no original_total', 'NaN rate',
    'Infinity rate', 'empty code', 'two-letter lowercase code', 'lowercase code', 'four-letter code', '10 kB code'];
  i int;
  nb uuid; ni uuid; s1 uuid; s2 uuid; push jsonb; res jsonb; st text; msg text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx13-alice@example.com', 'Alice');
  bob   := test.new_account('fx13-bob@example.com', 'Bob');

  FOR i IN 1 .. array_length(variants, 1) LOOP
    nb := gen_random_uuid(); ni := gen_random_uuid(); s1 := gen_random_uuid(); s2 := gen_random_uuid();
    push := test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute');
    push := jsonb_set(push, '{bills,0}', (push -> 'bills' -> 0) || variants[i]);

    PERFORM test.as_user(alice);
    res := NULL; st := NULL; msg := NULL;
    BEGIN
      res := public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    END;
    PERFORM test.as_owner();
    PERFORM test.assert_true(st IS NOT NULL,
      'C13 (' || labels[i] || '): kwenta_write refuses the write (got applied: '
      || COALESCE((res -> 'applied' -> 'bills')::text, 'null') || ')');
    PERFORM test.assert_eq(test.fx_row_of('bills', nb), NULL::jsonb, 'C13 (' || labels[i] || '): no bill stored');
    PERFORM test.assert_eq(test.fx_row_of('bill_items', ni), NULL::jsonb, 'C13 (' || labels[i] || '): no item stored');
    PERFORM test.assert_eq(test.fx_row_of('item_splits', s1), NULL::jsonb, 'C13 (' || labels[i] || '): no split stored');
  END LOOP;

  PERFORM test.note('079 C13: every inconsistent conversion is refused and rolls the write back');
END;
$$;

-- C13: a non-finite original_amount on an item or a split is refused and nothing is stored; a
-- finite one (any sign) saves.
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid; ni uuid; s1 uuid; s2 uuid; push jsonb; st text;
  which text;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx13n-alice@example.com', 'Alice');
  bob   := test.new_account('fx13n-bob@example.com', 'Bob');

  FOREACH which IN ARRAY ARRAY['item', 'split'] LOOP
    nb := gen_random_uuid(); ni := gen_random_uuid(); s1 := gen_random_uuid(); s2 := gen_random_uuid();
    push := test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute');
    IF which = 'item' THEN
      push := jsonb_set(push, '{bill_items,0,original_amount}', '"NaN"'::jsonb);
    ELSE
      push := jsonb_set(push, '{item_splits,0,original_amount}', '"NaN"'::jsonb);
    END IF;
    PERFORM test.as_user(alice);
    st := NULL;
    BEGIN
      PERFORM public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    END;
    PERFORM test.as_owner();
    PERFORM test.assert_eq(st, 'P0001', 'C13: a NaN ' || which || ' original_amount is filtered by the validator and 078 refuses the write');
    PERFORM test.assert_eq(test.fx_row_of('bills', nb), NULL::jsonb, 'C13 (NaN ' || which || '): no bill stored');
    PERFORM test.assert_eq(test.fx_row_of('bill_items', ni), NULL::jsonb, 'C13 (NaN ' || which || '): no item stored');
    PERFORM test.assert_eq(test.fx_row_of('item_splits', s1), NULL::jsonb, 'C13 (NaN ' || which || '): no split stored');
  END LOOP;

  -- The CHECKs behind the validators, on a direct insert.
  nb := gen_random_uuid(); ni := gen_random_uuid(); s1 := gen_random_uuid();
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency, created_at, updated_at,
    synced_at, is_deleted, device_id)
  VALUES (nb, NULL, alice, alice, 'Plain', 10, 'PHP', now(), now(), now(), false, 'test');
  st := NULL;
  BEGIN
    INSERT INTO public.bill_items (id, bill_id, name, amount, original_amount, created_at, updated_at, synced_at, is_deleted, device_id)
    VALUES (ni, nb, 'Pho', 10, 'NaN', now(), now(), now(), false, 'test');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.assert_eq(st, '23514', 'C13 CHECK: a direct insert of a NaN item original_amount fails');

  INSERT INTO public.bill_items (id, bill_id, name, amount, original_amount, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (ni, nb, 'Pho', 10, -250, now(), now(), now(), false, 'test');
  st := NULL;
  BEGIN
    INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount, original_amount,
      created_at, updated_at, synced_at, is_deleted, device_id)
    VALUES (s1, ni, alice, 'equal', 1, 10, 'NaN', now(), now(), now(), false, 'test');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.assert_eq(st, '23514', 'C13 CHECK: a direct insert of a NaN split original_amount fails');

  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount, original_amount,
    created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (s1, ni, alice, 'equal', 1, 10, 250000.5, now(), now(), now(), false, 'test');
  PERFORM test.assert_true((SELECT original_amount FROM public.item_splits WHERE id = s1) = 250000.5,
    'C13: a finite split original_amount still saves');
  PERFORM test.assert_true((SELECT original_amount FROM public.bill_items WHERE id = ni) = -250,
    'C13: a finite item original_amount of either sign still saves');
END;
$$;

-- C13: an UPDATE that breaks the invariant leaves the stored converted bill as it was.
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  push jsonb; st text; r record;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx13u-alice@example.com', 'Alice');
  bob   := test.new_account('fx13u-bob@example.com', 'Bob');
  PERFORM test.as_user(alice);
  PERFORM public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute'),
                              gen_random_uuid(), '[]'::jsonb);

  push := jsonb_build_object('bills', jsonb_build_array(
    test.fx_bill(nb, alice, NULL, 'PHP', 9999, 'Tampered', now() + interval '2 minutes')
      || test.fx_conv('VND', 0, 'online', 500000)));
  st := NULL;
  BEGIN
    PERFORM public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  PERFORM test.as_owner();
  PERFORM test.assert_true(st IS NOT NULL, 'C13: an update with rate 0 is refused');
  SELECT * INTO r FROM public.bills WHERE id = nb;
  PERFORM test.assert_eq(r.title::text, 'Pho night', 'C13: the refused update did not apply');
  PERFORM test.assert_true(r.exchange_rate::numeric = 0.00246385, 'C13: the stored rate is unchanged');
  PERFORM test.assert_money(r.total_amount, 1231.93, 'C13: the stored total is unchanged');
END;
$$;

-- C13: the CHECK is the backstop for any write that is not a validated push. Every clause is pinned
-- on its own, because the CHECK states the rule inline and the helper's copy does not protect it.
DO $$
DECLARE
  alice uuid;
  variants jsonb[] := ARRAY[
    '{"original_currency": "VND", "exchange_rate": null, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": null, "exchange_rate": 0.0025, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0.0025, "rate_source": null, "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0.0025, "rate_source": "online", "original_total": null}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": "NaN", "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": "Infinity", "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": -1, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0.0025, "rate_source": "guess", "original_total": 4000}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0.0025, "rate_source": "online", "original_total": "NaN"}'::jsonb,
    '{"original_currency": "VND", "exchange_rate": 0.0025, "rate_source": "online", "original_total": "Infinity"}'::jsonb,
    '{"original_currency": "PHP", "exchange_rate": 1, "rate_source": "manual", "original_total": 10}'::jsonb,
    '{"original_currency": "", "exchange_rate": 0.0025, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "zz", "exchange_rate": 0.0025, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "vnd", "exchange_rate": 0.0025, "rate_source": "online", "original_total": 4000}'::jsonb,
    '{"original_currency": "VNDX", "exchange_rate": 0.0025, "rate_source": "online", "original_total": 4000}'::jsonb
  ];
  labels text[] := ARRAY['no rate', 'rate without currency', 'no rate_source', 'no original_total', 'NaN rate',
    'Infinity rate', 'rate 0', 'negative rate', 'unknown rate_source', 'NaN total', 'Infinity total',
    'original_currency = currency', 'empty code', 'two-letter lowercase code', 'lowercase code', 'four-letter code'];
  i int; st text; v jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx13c-alice@example.com', 'Alice');

  FOR i IN 1 .. array_length(variants, 1) LOOP
    v := variants[i];
    st := NULL;
    BEGIN
      INSERT INTO public.bills (
        id, group_id, created_by, paid_by, title, total_amount, currency,
        original_currency, exchange_rate, rate_source, original_total,
        created_at, updated_at, synced_at, is_deleted, device_id
      ) VALUES (gen_random_uuid(), NULL, alice, alice, 'Direct', 10, 'PHP',
        v ->> 'original_currency', (v ->> 'exchange_rate')::numeric, v ->> 'rate_source',
        (v ->> 'original_total')::numeric, now(), now(), now(), false, 'test');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    END;
    -- numeric(16,2) refuses an Infinity total (22003) before the CHECK is reached; either way it is refused.
    PERFORM test.assert_true(st = '23514' OR (labels[i] = 'Infinity total' AND st = '22003'),
      'C13 CHECK (' || labels[i] || '): a direct insert is refused (got ' || COALESCE(st, 'accepted') || ')');
  END LOOP;

  -- The valid shapes still go in directly: converted, and plain.
  INSERT INTO public.bills (
    id, group_id, created_by, paid_by, title, total_amount, currency,
    original_currency, exchange_rate, rate_source, original_total,
    created_at, updated_at, synced_at, is_deleted, device_id
  ) VALUES (gen_random_uuid(), NULL, alice, alice, 'Direct ok', 10, 'PHP',
    'VND', 0.0025, 'manual', 4000, now(), now(), now(), false, 'test');
END;
$$;

-- ---------------------------------------------------------------------------
-- C14: a push that omits the keys (a client that never held the columns) leaves a plain bill.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  ni2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid(); s4 uuid := gen_random_uuid();
  t2 timestamptz := now() + interval '2 minutes';
  push jsonb; res jsonb; r record;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx14-alice@example.com', 'Alice');
  bob   := test.new_account('fx14-bob@example.com', 'Bob');
  PERFORM test.as_user(alice);
  PERFORM public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute'),
                              gen_random_uuid(), '[]'::jsonb);

  push := jsonb_build_object(
    'bills', jsonb_build_array(test.fx_bill(nb, alice, NULL, 'PHP', 1300, 'Pho night', t2)),
    'bill_items', jsonb_build_array(
      (test.fx_item(ni, nb, 1231.93, NULL, t2) - 'original_amount') || '{"is_deleted": true}'::jsonb,
      test.fx_item(ni2, nb, 1300, NULL, t2) - 'original_amount'),
    'item_splits', jsonb_build_array(
      (test.fx_split(s1, ni, alice, 615.97, NULL, t2) - 'original_amount') || '{"is_deleted": true}'::jsonb,
      (test.fx_split(s2, ni, bob, 615.96, NULL, t2) - 'original_amount') || '{"is_deleted": true}'::jsonb,
      test.fx_split(s3, ni2, alice, 650, NULL, t2) - 'original_amount',
      test.fx_split(s4, ni2, bob, 650, NULL, t2) - 'original_amount'));
  res := public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();

  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C14: the keyless update is applied');
  SELECT * INTO r FROM public.bills WHERE id = nb;
  PERFORM test.assert_money(r.total_amount, 1300, 'C14: amounts stay as pushed');
  PERFORM test.assert_true(r.original_currency IS NULL AND r.exchange_rate IS NULL AND r.rate_source IS NULL
    AND r.original_total IS NULL, 'C14: the bill becomes a plain PHP bill');
  PERFORM test.assert_true((SELECT original_amount FROM public.bill_items WHERE id = ni2) IS NULL,
    'C14: the new item has no original_amount');
END;
$$;

-- ---------------------------------------------------------------------------
-- C28: the REAL old-client edit. An old build's updateBill spreads its stored Dexie bill row (which
-- it pulled as to_jsonb(b), so it HOLDS the conversion columns) with a new title/total, retires the
-- old children by spreading them with is_deleted, and writes NEW children without original_amount.
-- The stale conversion must not survive beside amounts it no longer describes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  ni2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid(); s4 uuid := gen_random_uuid();
  t2 timestamptz := now() + interval '2 minutes';
  stored_bill jsonb; push jsonb; res jsonb; r record; d jsonb;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx28-alice@example.com', 'Alice');
  bob   := test.new_account('fx28-bob@example.com', 'Bob');
  PERFORM test.as_user(alice);
  PERFORM public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute'),
                              gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();

  stored_bill := test.fx_row_of('bills', nb);
  PERFORM test.assert_eq(stored_bill ->> 'original_currency', 'VND', 'C28 setup: the stored row carries the conversion');

  push := jsonb_build_object(
    'bills', jsonb_build_array(stored_bill || jsonb_build_object(
      'title', 'Pho night (edited)', 'total_amount', 1300, 'updated_at', t2, 'synced_at', NULL)),
    'bill_items', jsonb_build_array(
      test.fx_row_of('bill_items', ni) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_item(ni2, nb, 1300, NULL, t2) - 'original_amount'),
    'item_splits', jsonb_build_array(
      test.fx_row_of('item_splits', s1) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_row_of('item_splits', s2) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_split(s3, ni2, alice, 650, NULL, t2) - 'original_amount',
      test.fx_split(s4, ni2, bob, 650, NULL, t2) - 'original_amount'));
  PERFORM test.assert_eq(push -> 'bills' -> 0 ->> 'original_currency', 'VND',
    'C28 setup: the old client really sends the stale conversion back');

  PERFORM test.as_user(alice);
  res := public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();
  PERFORM test.assert_true(res -> 'applied' -> 'bills' ? nb::text, 'C28: the old client''s edit is applied');
  PERFORM test.assert_true(res -> 'applied' -> 'bill_items' ? ni2::text, 'C28: its new item is applied');

  SELECT * INTO r FROM public.bills WHERE id = nb;
  PERFORM test.assert_eq(r.title::text, 'Pho night (edited)', 'C28: the edit landed');
  PERFORM test.assert_money(r.total_amount, 1300, 'C28: the new PHP total stands');
  PERFORM test.assert_true(r.original_currency IS NULL, 'C28: original_currency cleared (got ' || COALESCE(r.original_currency::text, 'null') || ')');
  PERFORM test.assert_true(r.exchange_rate IS NULL, 'C28: exchange_rate cleared');
  PERFORM test.assert_true(r.rate_source IS NULL, 'C28: rate_source cleared');
  PERFORM test.assert_true(r.original_total IS NULL, 'C28: original_total cleared');
  -- Bumped past the pushed version, so every other device's mirror takes the cleared row (the 021b
  -- guard and shouldApplyPulledRow both compare updated_at).
  PERFORM test.assert_true(r.updated_at > t2, 'C28: the clearing bumps bills.updated_at past the pushed version');
  PERFORM test.assert_eq(
    (SELECT count(*) FROM public.bill_items WHERE bill_id = nb AND is_deleted IS FALSE AND original_amount IS NOT NULL),
    0::bigint, 'C28: no live item keeps an original_amount');
  PERFORM test.assert_eq(
    (SELECT count(*) FROM public.item_splits sp JOIN public.bill_items bi ON bi.id = sp.item_id
      WHERE bi.bill_id = nb AND bi.is_deleted IS FALSE AND sp.is_deleted IS FALSE AND sp.original_amount IS NOT NULL),
    0::bigint, 'C28: no live split keeps an original_amount');
  PERFORM test.assert_money((SELECT computed_amount FROM public.item_splits WHERE id = s3), 650,
    'C28: the new balance shares are untouched');

  -- The endpoints now read it as a plain bill.
  PERFORM test.as_user(alice);
  d := public.kwenta_bill_detail(nb);
  PERFORM test.as_owner();
  PERFORM test.assert_eq(d -> 'bill' -> 'originalCurrency', 'null'::jsonb, 'C28: bill_detail reads it as unconverted');

  PERFORM test.note('079 C28: an old client''s edit of a converted bill clears the stale conversion');
END;
$$;

-- C28: a NEW client's edit (original_amount on every live item) keeps the conversion, rate exactly.
DO $$
DECLARE
  alice uuid; bob uuid;
  nb uuid := gen_random_uuid(); ni uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  ni2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid(); s4 uuid := gen_random_uuid();
  t2 timestamptz := now() + interval '2 minutes';
  push jsonb; r record;
BEGIN
  PERFORM test.as_owner();
  alice := test.new_account('fx28n-alice@example.com', 'Alice');
  bob   := test.new_account('fx28n-bob@example.com', 'Bob');
  PERFORM test.as_user(alice);
  PERFORM public.kwenta_write(test.fx_vnd_push(nb, ni, s1, s2, alice, bob, NULL, now() + interval '1 minute'),
                              gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();

  push := jsonb_build_object(
    'bills', jsonb_build_array(
      test.fx_bill(nb, alice, NULL, 'PHP', 1231.93, 'Pho night', t2) || test.fx_conv('VND', 0.00246385, 'online', 500000)),
    'bill_items', jsonb_build_array(
      test.fx_row_of('bill_items', ni) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_item(ni2, nb, 1231.93, 500000, t2)),
    'item_splits', jsonb_build_array(
      test.fx_row_of('item_splits', s1) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_row_of('item_splits', s2) || jsonb_build_object('is_deleted', true, 'updated_at', t2),
      test.fx_split(s3, ni2, alice, 615.97, 250000, t2),
      test.fx_split(s4, ni2, bob, 615.96, 250000, t2)));
  PERFORM test.as_user(alice);
  PERFORM public.kwenta_write(push, gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();

  SELECT * INTO r FROM public.bills WHERE id = nb;
  PERFORM test.assert_eq(r.original_currency::text, 'VND', 'C28: a new client''s edit keeps original_currency');
  PERFORM test.assert_true(r.exchange_rate::numeric = 0.00246385, 'C28/C7: the locked rate is kept exactly');
  PERFORM test.assert_true(r.original_total::numeric = 500000, 'C28: original_total kept');
  PERFORM test.assert_true((SELECT original_amount::numeric FROM public.bill_items WHERE id = ni2) = 500000,
    'C28: the new item keeps its original_amount');
  PERFORM test.assert_eq((SELECT count(*) FROM public.item_splits WHERE id IN (s3, s4) AND original_amount::numeric = 250000),
    2::bigint, 'C28: the new splits keep their original_amount');

  PERFORM test.note('079 C28: a new client''s edit keeps the conversion');
END;
$$;

-- ---------------------------------------------------------------------------
-- C15: balances of a converted bill equal those of the same bill entered directly in PHP.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a1 uuid; b1 uuid; a2 uuid; b2 uuid; g1 uuid; g2 uuid;
  conv_net numeric; plain_net numeric; s jsonb;
  t1 timestamptz := now() + interval '1 minute';
BEGIN
  PERFORM test.as_owner();
  -- Personal: world 1 converted, world 2 plain PHP with the same amounts.
  a1 := test.new_account('fx15-a1@example.com', 'A1');
  b1 := test.new_account('fx15-b1@example.com', 'B1');
  a2 := test.new_account('fx15-a2@example.com', 'A2');
  b2 := test.new_account('fx15-b2@example.com', 'B2');

  PERFORM test.as_user(a1);
  PERFORM public.kwenta_write(
    test.fx_vnd_push(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1501', gen_random_uuid(), gen_random_uuid(),
                     a1, b1, NULL, t1),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_user(a2);
  PERFORM public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.fx_bill('00000000-0000-0000-0000-0000000f1502', a2, NULL, 'PHP', 1231.93, 'Pho night', t1)),
    'bill_items', jsonb_build_array(test.fx_item('00000000-0000-0000-0000-0000000f1503', '00000000-0000-0000-0000-0000000f1502', 1231.93, NULL, t1) - 'original_amount'),
    'item_splits', jsonb_build_array(
      test.fx_split(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1503', a2, 615.97, NULL, t1) - 'original_amount',
      test.fx_split(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1503', b2, 615.96, NULL, t1) - 'original_amount')),
    gen_random_uuid(), '[]'::jsonb);

  PERFORM test.as_user(a1);
  s := public.kwenta_person_summary(b1);
  conv_net := (s -> 'total' ->> 'PHP')::numeric;
  PERFORM test.assert_false(COALESCE((s -> 'total') ? 'VND', false),
    'C15: the paid-in currency never becomes a balance currency');
  PERFORM test.as_user(a2);
  plain_net := (public.kwenta_person_summary(b2) -> 'total' ->> 'PHP')::numeric;
  PERFORM test.as_owner();
  PERFORM test.assert_money(conv_net, 615.96, 'C15: the converted bill''s pairwise net is the PHP share');
  PERFORM test.assert_money(conv_net, plain_net, 'C15: person summary equals the same bill entered in PHP');

  -- Group: same comparison through the group ledger.
  g1 := test.new_group(a1, 'Hanoi', 'PHP');
  PERFORM test.add_member(g1, a1, 'A1');
  PERFORM test.add_member(g1, b1, 'B1');
  g2 := test.new_group(a2, 'Manila', 'PHP');
  PERFORM test.add_member(g2, a2, 'A2');
  PERFORM test.add_member(g2, b2, 'B2');

  PERFORM test.as_user(a1);
  PERFORM public.kwenta_write(
    test.fx_vnd_push(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1504', gen_random_uuid(), gen_random_uuid(),
                     a1, b1, g1, t1),
    gen_random_uuid(), '[]'::jsonb);
  -- The PHP twin goes through the same write path with the same shares (test.new_bill would round
  -- 1231.93 / 2 as 615.96 + 615.97, putting the extra cent on the other member).
  PERFORM test.as_user(a2);
  PERFORM public.kwenta_write(jsonb_build_object(
    'bills', jsonb_build_array(test.fx_bill('00000000-0000-0000-0000-0000000f1505', a2, g2, 'PHP', 1231.93, 'Pho night', t1)),
    'bill_items', jsonb_build_array(test.fx_item('00000000-0000-0000-0000-0000000f1506', '00000000-0000-0000-0000-0000000f1505', 1231.93, NULL, t1) - 'original_amount'),
    'item_splits', jsonb_build_array(
      test.fx_split(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1506', a2, 615.97, NULL, t1) - 'original_amount',
      test.fx_split(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1506', b2, 615.96, NULL, t1) - 'original_amount')),
    gen_random_uuid(), '[]'::jsonb);
  PERFORM test.as_owner();

  SELECT gp.net INTO conv_net FROM public.kwenta_group_pairwise(g1, a1) gp WHERE gp.member_user_id = b1;
  SELECT gp.net INTO plain_net FROM public.kwenta_group_pairwise(g2, a2) gp WHERE gp.member_user_id = b2;
  PERFORM test.assert_money(conv_net, 615.96, 'C15: group pairwise net of the converted bill is the PHP share');
  PERFORM test.assert_money(conv_net, plain_net, 'C15: group pairwise equals the same bill entered in PHP');

  PERFORM test.as_user(b1);
  conv_net := (public.kwenta_group_detail(g1) ->> 'totalToPay')::numeric;
  PERFORM test.as_user(b2);
  plain_net := (public.kwenta_group_detail(g2) ->> 'totalToPay')::numeric;
  PERFORM test.as_owner();
  PERFORM test.assert_money(conv_net, plain_net, 'C15: group detail totals equal the same bill entered in PHP');

  PERFORM test.note('079 C15: a converted bill moves balances exactly as its PHP twin');
END;
$$;

-- ---------------------------------------------------------------------------
-- C16: the redefined validators stay server-only; the client allowlist is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.fx_executable_by(p_role text)
RETURNS text[]
LANGUAGE sql
AS $$
  SELECT COALESCE(array_agg(DISTINCT p.proname::text ORDER BY p.proname::text), '{}')
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege(p_role, p.oid, 'EXECUTE');
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.kwenta_push_bills(jsonb, uuid)',
    'public.kwenta_push_bill_items(jsonb, uuid)',
    'public.kwenta_push_item_splits(jsonb, uuid)'
  ] LOOP
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'), 'C16: ' || fn || ' not executable by anon');
    PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'),
      'C16: ' || fn || ' not executable by authenticated');
    PERFORM test.assert_true(has_function_privilege('service_role', fn, 'EXECUTE'),
      'C16: ' || fn || ' executable by service_role');
  END LOOP;

  -- The endpoints 079 redefines keep exactly their client grant.
  FOREACH fn IN ARRAY ARRAY[
    'public.kwenta_bill_detail(uuid)',
    'public.kwenta_personal_bills()',
    'public.kwenta_group_detail(uuid)',
    'public.kwenta_recent_bills(integer)'
  ] LOOP
    PERFORM test.assert_true(has_function_privilege('authenticated', fn, 'EXECUTE'),
      'C16: ' || fn || ' stays executable by authenticated');
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'), 'C16: ' || fn || ' not executable by anon');
  END LOOP;

  -- Copied from 073's suite as it stands before 079: 079 adds no client endpoint.
  PERFORM test.assert_eq(test.fx_executable_by('authenticated'), ARRAY[
    'admin_delete_user', 'admin_list_profiles', 'admin_set_account_status', 'admin_set_user_type',
    'bills_for_sync', 'caller_can_read_personal_bill', 'caller_is_group_member',
    'caller_is_participant_on_personal_bill', 'is_admin',
    'kwenta_balances_overview', 'kwenta_bill_detail', 'kwenta_bill_settled_for_me',
    'kwenta_bill_settlement_history', 'kwenta_caller_is_active', 'kwenta_contacts_with_balances',
    'kwenta_delete_group', 'kwenta_fetch_bill_bundle', 'kwenta_fetch_group_bundle', 'kwenta_fetch_profile_for_linking',
    'kwenta_fetch_settlement', 'kwenta_group_detail', 'kwenta_group_member_breakdown',
    'kwenta_group_settlement_history', 'kwenta_group_spending', 'kwenta_groups_with_balances',
    'kwenta_lookup_profile_id_by_email', 'kwenta_my_account_status', 'kwenta_owed_in_group',
    'kwenta_person_settlement_history', 'kwenta_person_statement', 'kwenta_person_summary',
    'kwenta_personal_bills', 'kwenta_pre_request', 'kwenta_read',
    'kwenta_read_is_allowed', 'kwenta_recent_bills', 'kwenta_reconcile_user_event',
    'kwenta_repair_settlements', 'kwenta_round_money',
    'kwenta_search', 'kwenta_sync', 'kwenta_write', 'relevant_bill_ids_for_user'
  ]::text[], 'C16: authenticated executes exactly the client allowlist');
  PERFORM test.assert_eq(test.fx_executable_by('anon'), ARRAY[
    'caller_can_read_personal_bill', 'caller_is_group_member', 'caller_is_participant_on_personal_bill',
    'is_admin', 'kwenta_pre_request'
  ]::text[], 'C16: anon executes only the RLS helpers and the pre-request hook');

  PERFORM test.note('079 C16: validators server-only, endpoints keep their grant, allowlist unchanged');
END;
$$;
