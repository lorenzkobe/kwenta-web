-- Migration 087: the group payment history, paged on the server; the person payment items, looked
-- up by leg id.
--
-- Written from the requirements (case table of the payment-history-paging run), blind to the
-- implementation. What this file pins:
--   C1   kwenta_group_settlement_history(uuid) and kwenta_person_settlement_history(uuid) are
--        untouched: same signatures and grants, byte-identical output against frozen copies of
--        the 064/069 bodies (installed apps call them).
--   C2   kwenta_group_settlement_history_page items are jsonb-identical to the full history's items
--        in the same order; walking by cursor with limits 1..5 visits every item exactly once,
--        newest first; `matching` is the full item count on every page.
--   C2t  (contract addition) `totals`: the dialog's "Total paid" over ALL items of the full
--        history, one {userId, name, currency, amount} per item fromUserId + currency (name = that
--        payer's fromName, amount money-rounded), ordered amount DESC, userId, currency; [] with no
--        payments; identical on every page and cursor; multi-payer and multi-currency.
--   C3   limit NULL -> 20, clamp 1..500; a malformed cursor raises; a deleted (or never-existing)
--        cursor item still continues by its position; a bundle is always one whole item.
--   C4   non-member / removed member / deleted group / unknown group: the same answer as the full
--        history (NULL); unauthenticated raises 'not authenticated'.
--   C5   kwenta_person_payment_items returns exactly the person-history items whose settlementIds
--        intersect the given ids, jsonb-identical and in that function's order; unknown, foreign
--        and excluded ids return nothing; '{}' -> []; 500 ids is accepted, 501 raises.
--   C6   scoped exactly like kwenta_person_settlement_history: given EVERY fixture id it returns
--        exactly that viewer's full person history, for every viewer/person pair, so another
--        account's payments never appear; unauthenticated raises.
--   C7   kwenta_read dispatches page(id, limit, NULL); kwenta_read_is_allowed admits the page but
--        NOT kwenta_person_payment_items; a write primes the page under its key; 085's
--        kwenta_group_detail_paged and 086's kwenta_person_statement_page still dispatch.
--   C13  (SQL half) an authenticated member never gets a NULL page or a NULL items answer, so a
--        NULL can only mean "declined".
--   C17  the cursor compares (createdAt)::timestamptz and (settlementIds[0])::uuid: a cursor
--        written in another UTC offset or with an upper-case id continues at the same place;
--        settlementIds[0] is the primary leg of a bundle whose legs share created_at; a 1 us gap
--        is not collapsed.
--   Grants: both new endpoints authenticated only (the 073/079 allowlists name them).
--
-- Hand-made rows (named, as the role brief asks): every settlement in test.p87_fixture is inserted
-- directly by test.p87_pay rather than test.new_settlement/new_bundle, because the cases need
-- explicit created_at values (a 1 us gap, a bundle whose legs differ by 123 us, a one-recipient
-- bundle whose legs differ by 2 ms) and ids with a chosen leading hex digit (so the id tiebreak
-- has a known answer). Columns and defaults follow test.new_settlement exactly (label NOT NULL,
-- no settled_at, method nullable, created_at = updated_at = synced_at). The bundle legs carry one
-- shared bundle_id and one method, as recordPersonPayment writes them. The removed member and the
-- deleted group are soft-deleted with an UPDATE that moves updated_at forward (021b).

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Frozen references (C1). Do not "tidy" these: their whole value is being an independent second
-- opinion that the old endpoints did not move.
--
-- test.p87_build_069 is 069_settlement_history_method.sql:33-182 verbatim (only the name changed).
-- test.p87_group_history_064 is 064_settlement_history_and_group_math.sql:278-303 verbatim except
-- that it delegates to the frozen builder instead of public.kwenta_settlement_history_build, so a
-- change to the shared builder also shows up as a change to the old group endpoint.
-- test.p87_person_history_069 is 069_settlement_history_method.sql:189-271 verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.p87_build_069(
  p_ids        uuid[],
  p_uid        uuid,
  p_group_id   uuid,
  p_group_name text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH src AS (
    SELECT s.*,
           COALESCE(s.bundle_id, s.id)      AS bundle_key,
           -- Names resolve against the settlement's OWN group when the caller passed none, so a
           -- bill-scoped list still reaches the roster.
           COALESCE(p_group_id, s.group_id) AS name_group_id
    FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, p_uid) s
    WHERE s.id = ANY (p_ids)
      AND s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
  ),
  ranked AS (
    SELECT src.*,
           ROW_NUMBER() OVER (
             PARTITION BY src.bundle_key ORDER BY src.created_at DESC, src.id
           ) AS rn
    FROM src
  ),
  prim AS (
    SELECT * FROM ranked WHERE rn = 1
  ),
  per_recipient AS (
    SELECT r.bundle_key,
           r.to_user_id,
           r.name_group_id,
           public.kwenta_round_money(SUM(r.amount)) AS amount
    FROM ranked r
    GROUP BY r.bundle_key, r.to_user_id, r.name_group_id
  ),
  recipients AS (
    SELECT c.bundle_key,
           COUNT(*)                                 AS recipient_count,
           public.kwenta_round_money(SUM(c.amount)) AS total_amount,
           (array_agg(c.to_user_id ORDER BY c.amount DESC, c.to_user_id))[1] AS top_to_user_id,
           (array_agg(public.kwenta_settlement_party_name(c.name_group_id, p_uid, c.to_user_id)
                      ORDER BY c.amount DESC, c.to_user_id))[1] AS top_to_name,
           jsonb_agg(jsonb_build_object(
             'toUserId', c.to_user_id,
             'toName',   public.kwenta_settlement_party_name(c.name_group_id, p_uid, c.to_user_id),
             'amount',   c.amount
           ) ORDER BY c.amount DESC, c.to_user_id) AS recipients
    FROM per_recipient c
    GROUP BY c.bundle_key
  ),
  legs AS (
    SELECT r.bundle_key,
           jsonb_agg(jsonb_build_object(
             'fromUserId', r.from_user_id,
             'fromName',   public.kwenta_settlement_party_name(r.name_group_id, p_uid, r.from_user_id),
             'toUserId',   r.to_user_id,
             'toName',     public.kwenta_settlement_party_name(r.name_group_id, p_uid, r.to_user_id),
             'amount',     r.amount
           ) ORDER BY r.created_at DESC, r.id) AS legs
    FROM ranked r
    GROUP BY r.bundle_key
  ),
  meta AS (
    SELECT r.bundle_key,
           array_agg(r.id ORDER BY r.created_at DESC, r.id) AS settlement_ids,
           CASE
             WHEN COUNT(r.bill_id) = COUNT(*) AND COUNT(DISTINCT r.bill_id) = 1
             THEN (array_agg(r.bill_id))[1]
           END AS bill_id,
           -- First non-blank label wins; the stored (untrimmed) text is what the UI shows.
           (array_remove(
              array_agg(
                CASE WHEN BTRIM(r.label) <> '' THEN r.label END
                ORDER BY r.created_at DESC, r.id
              ), NULL))[1] AS label,
           -- Same rule for the method (069). recordPersonPayment stamps every leg of a bundle
           -- with the same one, so this only ever has one candidate in practice.
           (array_remove(
              array_agg(
                CASE WHEN BTRIM(COALESCE(r.method, '')) <> '' THEN r.method END
                ORDER BY r.created_at DESC, r.id
              ), NULL))[1] AS method
    FROM ranked r
    GROUP BY r.bundle_key
  ),
  items AS (
    SELECT
      p.created_at AS sort_at,
      p.id         AS sort_id,
      jsonb_build_object(
        'id',            CASE WHEN p.bundle_id IS NOT NULL AND rc.recipient_count > 1
                              THEN p.bundle_id ELSE p.id END,
        'settlementIds', to_jsonb(m.settlement_ids),
        'bundleId',      CASE WHEN p.bundle_id IS NOT NULL AND rc.recipient_count > 1
                              THEN p.bundle_id END,
        'isBundled',     p.bundle_id IS NOT NULL AND rc.recipient_count > 1,
        'groupId',       p_group_id,
        'groupName',     p_group_name,
        'billId',        m.bill_id,
        'billTitle',     (SELECT b.title
                            FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, p_uid) b
                           WHERE b.id = m.bill_id AND b.is_deleted IS FALSE),
        'fromUserId',    p.from_user_id,
        'toUserId',      COALESCE(rc.top_to_user_id, p.to_user_id),
        'fromName',      public.kwenta_settlement_party_name(p.name_group_id, p_uid, p.from_user_id),
        'toName',        COALESCE(rc.top_to_name, 'Someone'),
        'amount',        rc.total_amount,
        'currency',      p.currency,
        'label',         COALESCE(m.label, p.label, ''),
        'method',        m.method,
        'createdAt',     p.created_at,
        'recipients',    rc.recipients,
        'legs',          lg.legs,
        'recordedByUserId', rb.user_id,
        'recordedByName',   CASE WHEN rb.user_id IS NOT NULL
                                 THEN public.kwenta_settlement_party_name(p.name_group_id, p_uid, rb.user_id)
                            END
      ) AS item
    FROM prim p
    JOIN recipients rc ON rc.bundle_key = p.bundle_key
    JOIN legs       lg ON lg.bundle_key = p.bundle_key
    JOIN meta       m  ON m.bundle_key  = p.bundle_key
    LEFT JOIN LATERAL (
      -- Who pressed "Pay" — may differ from the payer when recorded on someone's behalf.
      SELECT a.user_id
        FROM public.kwenta_pull_rows_activity_log('epoch'::timestamptz, p_uid) a
       WHERE a.entity_id = COALESCE(p.bundle_id, p.id)
         AND a.entity_type = 'settlement'
         AND a.action = 'settled'
         AND a.is_deleted IS FALSE
       ORDER BY a.created_at, a.id
       LIMIT 1
    ) rb ON TRUE
  )
  SELECT COALESCE(jsonb_agg(i.item ORDER BY i.sort_at DESC, i.sort_id), '[]'::jsonb)
  FROM items i;
$$;

CREATE OR REPLACE FUNCTION test.p87_group_history_064(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.kwenta_is_active_group_member(p_group_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(s.id), '{}')
  INTO v_ids
  FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, v_uid) s
  WHERE s.group_id = p_group_id AND s.is_deleted IS FALSE AND s.is_settled IS TRUE;

  RETURN test.p87_build_069(v_ids, v_uid, p_group_id, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION test.p87_person_history_069(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  WITH me AS (
    SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)
  ),
  them AS (
    SELECT id FROM public.kwenta_expand_identity(p_person_id, v_uid)
  ),
  pair_rows AS (
    SELECT s.*
    FROM public.kwenta_pull_rows_settlements('epoch'::timestamptz, v_uid) s
    WHERE s.is_deleted IS FALSE
      AND s.is_settled IS TRUE
      AND (
           (s.from_user_id IN (SELECT id FROM me)   AND s.to_user_id IN (SELECT id FROM them))
        OR (s.from_user_id IN (SELECT id FROM them) AND s.to_user_id IN (SELECT id FROM me))
      )
  ),
  named AS (
    SELECT r.*,
           public.kwenta_settlement_party_name(r.group_id, v_uid, r.from_user_id) AS from_name,
           public.kwenta_settlement_party_name(r.group_id, v_uid, r.to_user_id)   AS to_name,
           COALESCE(
             (SELECT g.name
                FROM public.kwenta_pull_rows_groups('epoch'::timestamptz, v_uid) g
               WHERE g.id = r.group_id),
             CASE WHEN r.group_id IS NULL THEN 'Personal' ELSE 'Group' END
           ) AS group_name
    FROM pair_rows r
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',            n.id,
    'settlementIds', jsonb_build_array(n.id),
    'bundleId',      n.bundle_id,
    'isBundled',     false,
    'groupId',       n.group_id,
    'groupName',     n.group_name,
    'billId',        NULL,
    'billTitle',     NULL,
    'fromUserId',    n.from_user_id,
    'toUserId',      n.to_user_id,
    'fromName',      n.from_name,
    'toName',        n.to_name,
    'amount',        n.amount,
    'currency',      n.currency,
    'label',         COALESCE(n.label, ''),
    'method',        CASE WHEN BTRIM(COALESCE(n.method, '')) <> '' THEN n.method END,
    'createdAt',     n.created_at,
    'recipients',    jsonb_build_array(jsonb_build_object(
                       'toUserId', n.to_user_id, 'toName', n.to_name, 'amount', n.amount)),
    'legs',          jsonb_build_array(jsonb_build_object(
                       'fromUserId', n.from_user_id, 'fromName', n.from_name,
                       'toUserId',   n.to_user_id,   'toName',   n.to_name,
                       'amount',     n.amount)),
    'recordedByUserId', NULL,
    'recordedByName',   NULL
  ) ORDER BY n.created_at DESC, n.id), '[]'::jsonb)
  INTO v_out
  FROM named n;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

/** A fresh uuid whose first hex digit is p_lead, so the id tiebreak has a known answer while the
    rest stays unique across fixtures in this one transaction. */
CREATE OR REPLACE FUNCTION test.p87_id(p_lead text)
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT overlay(gen_random_uuid()::text PLACING p_lead FROM 1 FOR 1)::uuid;
$$;

/** One settlement row, inserted directly (hand-made: see the header). Same columns and values as
    test.new_settlement, plus bundle_id, is_deleted and is_settled. */
CREATE OR REPLACE FUNCTION test.p87_pay(
  p_id uuid, p_from uuid, p_to uuid, p_amount numeric, p_group uuid, p_at timestamptz,
  p_bundle uuid DEFAULT NULL, p_bill uuid DEFAULT NULL, p_label text DEFAULT '',
  p_method text DEFAULT NULL, p_deleted boolean DEFAULT false, p_settled boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.settlements (
    id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
    is_settled, label, method, created_at, updated_at, synced_at, is_deleted, device_id
  )
  VALUES (p_id, p_group, p_bill, p_bundle, p_from, p_to, p_amount, 'PHP',
          p_settled, p_label, p_method, p_at, p_at, p_at, p_deleted, 'test');
  RETURN p_id;
END;
$$;

/** The client's cursor for a held item: its createdAt and its primary leg. */
CREATE OR REPLACE FUNCTION test.p87_cursor(p_item jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object('createdAt', p_item -> 'createdAt', 'id', p_item -> 'settlementIds' -> 0);
$$;

/** settlementIds[0] of every item, in order. */
CREATE OR REPLACE FUNCTION test.p87_primary_ids(p_items jsonb)
RETURNS uuid[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg((e -> 'settlementIds' ->> 0)::uuid ORDER BY n), '{}')
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS t(e, n);
$$;

/** Walk the page endpoint from the start with page size p_limit; returns every item, in order.
    Fails when a page's `matching` disagrees with p_matching, a page is larger than p_limit, or the
    walk does not terminate. */
CREATE OR REPLACE FUNCTION test.p87_walk(p_group uuid, p_limit int, p_matching int, p_totals jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  acc jsonb := '[]'::jsonb;
  p jsonb;
  cur jsonb := NULL;
  n int := 0;
BEGIN
  LOOP
    n := n + 1;
    IF n > 200 THEN
      PERFORM test.fail(format('walk(limit %s) terminates', p_limit), '<= 200 pages', 'more');
    END IF;
    p := public.kwenta_group_settlement_history_page(p_group, p_limit, cur);
    PERFORM test.assert_true(p IS NOT NULL AND jsonb_typeof(p -> 'items') = 'array',
      format('walk(limit %s): page %s is an object with an items array (got %s)', p_limit, n, COALESCE(p::text, 'NULL')));
    PERFORM test.assert_eq((p ->> 'matching')::int, p_matching,
      format('walk(limit %s): page %s reports matching = %s', p_limit, n, p_matching));
    PERFORM test.assert_eq(p -> 'totals', p_totals,
      format('walk(limit %s): page %s carries the whole history''s payer totals', p_limit, n));
    EXIT WHEN jsonb_array_length(p -> 'items') = 0;
    IF jsonb_array_length(p -> 'items') > p_limit THEN
      PERFORM test.fail(format('walk(limit %s): a page holds at most the limit', p_limit),
        p_limit::text, jsonb_array_length(p -> 'items')::text);
    END IF;
    acc := acc || (p -> 'items');
    cur := test.p87_cursor(p -> 'items' -> (jsonb_array_length(p -> 'items') - 1));
  END LOOP;
  RETURN acc;
END;
$$;

/** The dialog's "Total paid", computed independently over a FULL history's items: one entry per
    payer (item fromUserId) and currency, name = that payer's fromName as the items carry it,
    amount = money-rounded sum of item amounts, ordered amount DESC, userId, currency; [] if none.
    (A payer's fromName is the same on every item of one group, so MIN only picks that one name.) */
CREATE OR REPLACE FUNCTION test.p87_totals(p_items jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'userId', t.user_id, 'name', t.name, 'currency', t.currency, 'amount', t.amount)
         ORDER BY t.amount DESC, t.user_id, t.currency), '[]'::jsonb)
  FROM (
    SELECT (e ->> 'fromUserId')::uuid AS user_id,
           MIN(e ->> 'fromName') AS name,
           e ->> 'currency' AS currency,
           public.kwenta_round_money(SUM((e ->> 'amount')::numeric)) AS amount
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) e
    GROUP BY (e ->> 'fromUserId')::uuid, e ->> 'currency'
  ) t;
$$;

/** The error text when the page endpoint refuses the call, NULL when it answers. */
CREATE OR REPLACE FUNCTION test.p87_page_error(p_group uuid, p_limit int, p_before jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.kwenta_group_settlement_history_page(p_group, p_limit, p_before);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

/** The error text when the items endpoint refuses the call, NULL when it answers. */
CREATE OR REPLACE FUNCTION test.p87_items_error(p_person uuid, p_ids uuid[])
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.kwenta_person_payment_items(p_person, p_ids);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- The fixture. B is ten days ago; TT = B + 2 min is the tie instant.
--
-- Trip (g1: Alice, Bob, Cara, Dan; Rem was a member and was removed), newest first by primary leg:
--   nw   B+7m        Bob -> Alice 1, label and method whitespace only
--   bt   B+5m        Bob -> Alice 100, tagged to the Hotel bill, label 'Hotel share'
--   obnd B+4m        one-recipient bundle Alice -> Bob 10 (ol1) + 5 (ol2, 2 ms older): one item, not
--                    "bundled", settlementIds [ol1, ol2]
--   ibnd B+3m+123us  bundle through an intermediary: Dan -> Cara 40 (il1, at B+3m), Cara -> Bob 40
--                    (il2, at B+3m+123us); primary = il2
--   tA   TT  id 2... Bob -> Alice 15
--   bnd  TT  ids 4..., 9...: Alice -> Bob 30 (bl1), Alice -> Cara 20 (bl2, label 'Settle up'),
--                    legs SHARE created_at, method BDO, logged by Alice; primary = bl1 (4... < 9...)
--   tB   TT  id 6... Alice -> Bob 12
--   tC   TT  id f... Cara -> Alice 8
--   tD   TT - 1us    Bob -> Alice 5
--   i1   B+1m        Bob -> Alice 100 'Dinner' GCash, recorded by Cara (activity log)
--   excluded: del1 (deleted, B+6m), uns (is_settled false, B+6m+1s)
-- Flat (g2: Alice, Bob): g2a Bob -> Alice 70 (B+8m), g2b Alice -> Bob 20 Cash (B+9m).
-- Personal: pa Alice -> Bob 25 (B+10m); pc Alice's linked contact for Bob -> Alice 9 (B+11m);
--   pdel Bob -> Alice 3 deleted (B+12m); ef Eve -> Frank 50 (B+13m), strangers to everyone else.
-- Gone (gdel: Alice, Bob): gd Bob -> Alice 11 (B+30s), then the group is deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test.p87_fixture(p_tag text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  b timestamptz := date_trunc('second', now()) - interval '10 days';
  tt timestamptz;
  alice uuid; bob uuid; cara uuid; dan uuid; eve uuid; frank uuid; rem uuid; c_bob uuid;
  g1 uuid; g2 uuid; gdel uuid; rem_m uuid; hotel uuid;
  nw uuid; bt uuid; obnd uuid := gen_random_uuid(); ol1 uuid; ol2 uuid;
  ibnd uuid := gen_random_uuid(); il1 uuid; il2 uuid;
  ta uuid; bnd uuid := test.p87_id('e'); bl1 uuid; bl2 uuid; tb uuid; tc uuid; td uuid; i1 uuid;
  del1 uuid; uns uuid; g2a uuid; g2b uuid; pa uuid; pc uuid; pdel uuid; ef uuid; gd uuid;
BEGIN
  tt := b + interval '2 minutes';
  alice := test.new_account('p87-' || p_tag || '-alice@example.com', 'Alice');
  bob   := test.new_account('p87-' || p_tag || '-bob@example.com', 'Bob');
  cara  := test.new_account('p87-' || p_tag || '-cara@example.com', 'Cara');
  dan   := test.new_account('p87-' || p_tag || '-dan@example.com', 'Dan');
  eve   := test.new_account('p87-' || p_tag || '-eve@example.com', 'Eve');
  frank := test.new_account('p87-' || p_tag || '-frank@example.com', 'Frank');
  rem   := test.new_account('p87-' || p_tag || '-rem@example.com', 'Rem');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  g1 := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g1, alice, 'Alice');
  PERFORM test.add_member(g1, bob, 'Bob');
  PERFORM test.add_member(g1, cara, 'Cara');
  PERFORM test.add_member(g1, dan, 'Dan');
  rem_m := test.add_member(g1, rem, 'Rem');
  g2 := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, bob, 'Bob');
  gdel := test.new_group(alice, 'Gone');
  PERFORM test.add_member(gdel, alice, 'Alice');
  PERFORM test.add_member(gdel, bob, 'Bob');

  hotel := test.new_bill(alice, alice, g1, 'Hotel', 300, ARRAY[alice, bob, cara]);

  i1 := test.p87_pay(gen_random_uuid(), bob, alice, 100, g1, b + interval '1 minute', NULL, NULL, 'Dinner', 'GCash');
  PERFORM test.log_settled(i1, cara, g1);
  ta  := test.p87_pay(test.p87_id('2'), bob, alice, 15, g1, tt);
  bl1 := test.p87_pay(test.p87_id('4'), alice, bob, 30, g1, tt, bnd, NULL, '', 'BDO');
  bl2 := test.p87_pay(test.p87_id('9'), alice, cara, 20, g1, tt, bnd, NULL, 'Settle up', 'BDO');
  PERFORM test.log_settled(bnd, alice, g1);
  tb  := test.p87_pay(test.p87_id('6'), alice, bob, 12, g1, tt);
  tc  := test.p87_pay(test.p87_id('f'), cara, alice, 8, g1, tt);
  td  := test.p87_pay(gen_random_uuid(), bob, alice, 5, g1, tt - interval '1 microsecond');
  il1 := test.p87_pay(gen_random_uuid(), dan, cara, 40, g1, b + interval '3 minutes', ibnd);
  il2 := test.p87_pay(gen_random_uuid(), cara, bob, 40, g1, b + interval '3 minutes 123 microseconds', ibnd);
  ol1 := test.p87_pay(gen_random_uuid(), alice, bob, 10, g1, b + interval '4 minutes', obnd);
  ol2 := test.p87_pay(gen_random_uuid(), alice, bob, 5, g1, b + interval '4 minutes' - interval '2 milliseconds', obnd);
  bt  := test.p87_pay(gen_random_uuid(), bob, alice, 100, g1, b + interval '5 minutes', NULL, hotel, 'Hotel share');
  del1 := test.p87_pay(gen_random_uuid(), cara, alice, 10, g1, b + interval '6 minutes', NULL, NULL, '', NULL, true);
  uns := test.p87_pay(gen_random_uuid(), bob, alice, 7, g1, b + interval '6 minutes 1 second', NULL, NULL, '', NULL, false, false);
  nw  := test.p87_pay(gen_random_uuid(), bob, alice, 1, g1, b + interval '7 minutes', NULL, NULL, '  ', '  ');

  g2a := test.p87_pay(gen_random_uuid(), bob, alice, 70, g2, b + interval '8 minutes');
  g2b := test.p87_pay(gen_random_uuid(), alice, bob, 20, g2, b + interval '9 minutes', NULL, NULL, '', 'Cash');
  pa  := test.p87_pay(gen_random_uuid(), alice, bob, 25, NULL, b + interval '10 minutes');
  pc  := test.p87_pay(gen_random_uuid(), c_bob, alice, 9, NULL, b + interval '11 minutes');
  pdel := test.p87_pay(gen_random_uuid(), bob, alice, 3, NULL, b + interval '12 minutes', NULL, NULL, '', NULL, true);
  ef  := test.p87_pay(gen_random_uuid(), eve, frank, 50, NULL, b + interval '13 minutes');
  gd  := test.p87_pay(gen_random_uuid(), bob, alice, 11, gdel, b + interval '30 seconds');

  -- Rem leaves Trip; Gone is deleted (082's sweep runs on that UPDATE).
  UPDATE public.group_members SET is_deleted = true, updated_at = updated_at + interval '1 second' WHERE id = rem_m;
  UPDATE public.groups SET is_deleted = true, updated_at = updated_at + interval '1 second' WHERE id = gdel;

  RETURN jsonb_build_object(
    'alice', alice, 'bob', bob, 'cara', cara, 'dan', dan, 'eve', eve, 'frank', frank, 'rem', rem,
    'c_bob', c_bob, 'g1', g1, 'g2', g2, 'gdel', gdel, 'hotel', hotel, 'tt', tt,
    'nw', nw, 'bt', bt, 'obnd', obnd, 'ol1', ol1, 'ol2', ol2, 'ibnd', ibnd, 'il1', il1, 'il2', il2,
    'ta', ta, 'bnd', bnd, 'bl1', bl1, 'bl2', bl2, 'tb', tb, 'tc', tc, 'td', td, 'i1', i1,
    'del1', del1, 'uns', uns, 'g2a', g2a, 'g2b', g2b, 'pa', pa, 'pc', pc, 'pdel', pdel,
    'ef', ef, 'gd', gd);
END;
$$;

/** Every settlement id the fixture wrote (read as the owner, so RLS hides nothing). */
CREATE OR REPLACE FUNCTION test.p87_all_ids(f jsonb)
RETURNS uuid[]
LANGUAGE sql
AS $$
  SELECT array_agg(s.id ORDER BY s.id)
  FROM public.settlements s
  WHERE s.from_user_id IN ((f->>'alice')::uuid, (f->>'bob')::uuid, (f->>'cara')::uuid, (f->>'dan')::uuid,
                           (f->>'eve')::uuid, (f->>'frank')::uuid, (f->>'rem')::uuid, (f->>'c_bob')::uuid)
     OR s.to_user_id   IN ((f->>'alice')::uuid, (f->>'bob')::uuid, (f->>'cara')::uuid, (f->>'dan')::uuid,
                           (f->>'eve')::uuid, (f->>'frank')::uuid, (f->>'rem')::uuid, (f->>'c_bob')::uuid);
$$;

-- ---------------------------------------------------------------------------
-- C1: the old endpoints are untouched — signatures, grants, byte-identical output.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; cara uuid; dan uuid; eve uuid; frank uuid; rem uuid; c_bob uuid;
  g1 uuid; g2 uuid; gdel uuid; got jsonb; ref jsonb; fn text; sig text;
BEGIN
  f := test.p87_fixture('c1');
  alice := (f->>'alice')::uuid; bob := (f->>'bob')::uuid; cara := (f->>'cara')::uuid;
  dan := (f->>'dan')::uuid; eve := (f->>'eve')::uuid; frank := (f->>'frank')::uuid;
  rem := (f->>'rem')::uuid; c_bob := (f->>'c_bob')::uuid;
  g1 := (f->>'g1')::uuid; g2 := (f->>'g2')::uuid; gdel := (f->>'gdel')::uuid;

  FOREACH fn IN ARRAY ARRAY['kwenta_group_settlement_history', 'kwenta_person_settlement_history'] LOOP
    sig := 'public.' || fn || '(uuid)';
    PERFORM test.assert_eq(
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = fn), 1,
      'C1: ' || fn || ' keeps exactly one signature');
    PERFORM test.assert_true(to_regprocedure(sig) IS NOT NULL, 'C1: ' || sig || ' exists');
    PERFORM test.assert_eq(
      (SELECT format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.oid = to_regprocedure(sig)),
      'jsonb', 'C1: ' || fn || ' still returns jsonb');
    PERFORM test.assert_true(has_function_privilege('authenticated', sig, 'EXECUTE'),
      'C1: installed apps (authenticated) still execute ' || fn);
    PERFORM test.assert_false(has_function_privilege('anon', sig, 'EXECUTE'), 'C1: anon still does not execute ' || fn);
  END LOOP;

  PERFORM test.as_user(alice);
  ref := test.p87_group_history_064(g1);
  -- Fixture sanity, and the old order the page must keep: newest first by primary leg, ties by id.
  PERFORM test.assert_eq(test.p87_primary_ids(ref), ARRAY[
      (f->>'nw')::uuid, (f->>'bt')::uuid, (f->>'ol1')::uuid, (f->>'il2')::uuid, (f->>'ta')::uuid,
      (f->>'bl1')::uuid, (f->>'tb')::uuid, (f->>'tc')::uuid, (f->>'td')::uuid, (f->>'i1')::uuid],
    'C1: the reference Trip history is the 10 fixture items in (createdAt DESC, primary id) order');
  got := public.kwenta_group_settlement_history(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice / Trip is byte-identical to 064+069');
  got := public.kwenta_group_settlement_history(g2); ref := test.p87_group_history_064(g2);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice / Flat is byte-identical');
  got := public.kwenta_group_settlement_history(gdel); ref := test.p87_group_history_064(gdel);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice / a deleted group is byte-identical');
  got := public.kwenta_person_settlement_history(bob); ref := test.p87_person_history_069(bob);
  PERFORM test.assert_eq(jsonb_array_length(ref), 13, 'C1: the reference Alice -> Bob history holds 13 rows');
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> Bob person history is byte-identical to 069');
  got := public.kwenta_person_settlement_history(c_bob); ref := test.p87_person_history_069(c_bob);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> her linked contact is byte-identical');
  got := public.kwenta_person_settlement_history(cara); ref := test.p87_person_history_069(cara);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> Cara is byte-identical');
  got := public.kwenta_person_settlement_history(frank); ref := test.p87_person_history_069(frank);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Alice -> a stranger is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.as_user(bob);
  got := public.kwenta_group_settlement_history(g1); ref := test.p87_group_history_064(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Bob / Trip is byte-identical');
  got := public.kwenta_person_settlement_history(alice); ref := test.p87_person_history_069(alice);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Bob -> Alice is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.as_user(cara);
  got := public.kwenta_group_settlement_history(g1); ref := test.p87_group_history_064(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Cara / Trip is byte-identical');
  got := public.kwenta_group_settlement_history(g2); ref := test.p87_group_history_064(g2);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Cara / Flat (not a member) is byte-identical');
  got := public.kwenta_person_settlement_history(bob); ref := test.p87_person_history_069(bob);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Cara -> Bob (intermediary leg) is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.as_user(dan);
  got := public.kwenta_group_settlement_history(g1); ref := test.p87_group_history_064(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Dan / Trip is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.as_user(rem);
  got := public.kwenta_group_settlement_history(g1); ref := test.p87_group_history_064(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: a removed member / Trip is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.as_user(eve);
  got := public.kwenta_group_settlement_history(g1); ref := test.p87_group_history_064(g1);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: a stranger / Trip is byte-identical');
  got := public.kwenta_person_settlement_history(frank); ref := test.p87_person_history_069(frank);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Eve -> Frank is byte-identical');
  got := public.kwenta_person_settlement_history(alice); ref := test.p87_person_history_069(alice);
  PERFORM test.assert_eq(got::text, ref::text, 'C1: Eve -> Alice is byte-identical');
  PERFORM test.as_owner();

  PERFORM test.note('087 C1: the old group and person histories are untouched');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2 + C13: the page is the full history, cut by keyset.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; cara uuid; g1 uuid; g2 uuid; ge uuid;
  full_items jsonb; p jsonb; walked jsonb; lim int; viewer uuid;
BEGIN
  f := test.p87_fixture('c2');
  alice := (f->>'alice')::uuid; bob := (f->>'bob')::uuid; cara := (f->>'cara')::uuid;
  g1 := (f->>'g1')::uuid; g2 := (f->>'g2')::uuid;
  ge := test.new_group(alice, 'Empty');
  PERFORM test.add_member(ge, alice, 'Alice');

  PERFORM test.as_user(alice);
  full_items := public.kwenta_group_settlement_history(g1);
  PERFORM test.assert_eq(jsonb_array_length(full_items), 10, 'C2: Trip has 10 history items');

  p := public.kwenta_group_settlement_history_page(g1, 20, NULL);
  PERFORM test.assert_true(p IS NOT NULL AND jsonb_typeof(p) = 'object', 'C2/C13: a member gets an object, never NULL');
  PERFORM test.assert_true(p ? 'items' AND p ? 'matching', 'C2: the page carries items and matching');
  PERFORM test.assert_eq(p -> 'items', full_items, 'C2: one page of 20 is the full history, jsonb-identical, same order');
  PERFORM test.assert_eq((p ->> 'matching')::int, 10, 'C2: matching = the item count');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g1, 20), p,
    'C2: p_before defaults to NULL (the first page)');

  -- Payer totals over the WHOLE history (the dialog's "Total paid"), literal first: Bob paid
  -- 1 + 100 + 15 + 5 + 100; Cara is the payer of record of the intermediary bundle (its primary
  -- leg Cara -> Bob, total 80) plus 8; Alice paid 15 + 50 + 12. Dan's leg is not a primary leg.
  PERFORM test.assert_eq(p -> 'totals', test.p87_totals(full_items), 'C2t: totals = the payer grouping over the full history');
  PERFORM test.assert_eq(
    ARRAY(SELECT (e ->> 'userId')::uuid FROM jsonb_array_elements(p -> 'totals') WITH ORDINALITY t(e, n) ORDER BY n),
    ARRAY[bob, cara, alice], 'C2t: payers ordered by amount DESC');
  PERFORM test.assert_eq(
    ARRAY(SELECT (e ->> 'amount')::numeric FROM jsonb_array_elements(p -> 'totals') WITH ORDINALITY t(e, n) ORDER BY n),
    ARRAY[221.00, 88.00, 77.00]::numeric[], 'C2t: Bob 221, Cara 88, Alice 77');
  PERFORM test.assert_eq(
    ARRAY(SELECT e ->> 'name' FROM jsonb_array_elements(p -> 'totals') WITH ORDINALITY t(e, n) ORDER BY n),
    ARRAY['Bob', 'Cara', 'Alice'], 'C2t: named as the items name the payer');
  PERFORM test.assert_eq(
    ARRAY(SELECT e ->> 'currency' FROM jsonb_array_elements(p -> 'totals') WITH ORDINALITY t(e, n) ORDER BY n),
    ARRAY['PHP', 'PHP', 'PHP'], 'C2t: per currency');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g1, 1, NULL) -> 'totals', p -> 'totals',
    'C2t: a one-item first page still carries the whole history''s totals');

  FOR lim IN 1 .. 5 LOOP
    walked := test.p87_walk(g1, lim, 10, test.p87_totals(full_items));
    PERFORM test.assert_eq(walked, full_items,
      format('C2: walking Trip with limit %s visits every item exactly once, newest first, jsonb-identical', lim));
  END LOOP;

  p := public.kwenta_group_settlement_history_page(g1, 4, NULL);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'items'), 4, 'C2: limit 4 returns 4');
  PERFORM test.assert_eq(p -> 'items', jsonb_build_array(full_items -> 0, full_items -> 1, full_items -> 2, full_items -> 3),
    'C2: and they are the 4 newest');
  p := public.kwenta_group_settlement_history_page(g1, 5, test.p87_cursor(full_items -> 9));
  PERFORM test.assert_eq(p -> 'items', '[]'::jsonb, 'C2: past the oldest item the page is empty');
  PERFORM test.assert_eq((p ->> 'matching')::int, 10, 'C2: and matching still counts the whole history');
  PERFORM test.assert_eq(p -> 'totals', test.p87_totals(full_items), 'C2t: and the totals are still the whole history''s');

  PERFORM test.assert_eq(test.p87_walk(g2, 1, 2, test.p87_totals(public.kwenta_group_settlement_history(g2))),
    public.kwenta_group_settlement_history(g2), 'C2: Flat walks to its own full history');
  p := public.kwenta_group_settlement_history_page(ge, 20, NULL);
  PERFORM test.assert_true(p IS NOT NULL, 'C2/C13: a group with no payments is a page, not NULL');
  PERFORM test.assert_eq(p -> 'items', '[]'::jsonb, 'C2: with no items');
  PERFORM test.assert_eq((p ->> 'matching')::int, 0, 'C2: matching 0');
  PERFORM test.assert_eq(p -> 'totals', '[]'::jsonb, 'C2t: and totals []');
  PERFORM test.as_owner();

  FOREACH viewer IN ARRAY ARRAY[bob, cara] LOOP
    PERFORM test.as_user(viewer);
    full_items := public.kwenta_group_settlement_history(g1);
    PERFORM test.assert_eq(test.p87_walk(g1, 2, 10, test.p87_totals(full_items)), full_items,
      'C2: another member walks to their own full history (names resolved for them)');
    PERFORM test.as_owner();
  END LOOP;

  PERFORM test.note('087 C2/C13: page = full history by keyset; every item once; matching = count');
END;
$$;

-- ---------------------------------------------------------------------------
-- C2t: payer totals, multi-payer and multi-currency, identical on every page and cursor.
-- Hand-made rows: test.new_settlement / test.new_bundle rows with explicit created_at (new_bundle
-- rows re-dated with an UPDATE) so the order is known.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '5 days';
  alice uuid; bob uuid; cara uuid; g uuid; bnd uuid; full_items jsonb; p jsonb; expected jsonb; lim int;
BEGIN
  alice := test.new_account('p87tot-alice@example.com', 'Alice');
  bob   := test.new_account('p87tot-bob@example.com', 'Bob');
  cara  := test.new_account('p87tot-cara@example.com', 'Cara');
  g := test.new_group(alice, 'Abroad');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, cara, 'Cara');
  -- Bob: PHP 10.10 + 4.95 = 15.05, USD 5.50 + 2.25 = 7.75. Alice: PHP 15.05 (ties Bob), JPY 1000.
  -- Cara: one bundle to Alice 3.33 + Bob 3.34 in USD = 6.67.
  PERFORM test.new_settlement(bob, alice, 10.10, g, NULL, 'PHP', '', base + interval '1 minute');
  PERFORM test.new_settlement(bob, alice, 5.50, g, NULL, 'USD', '', base + interval '2 minutes');
  PERFORM test.new_settlement(alice, bob, 15.05, g, NULL, 'PHP', '', base + interval '3 minutes');
  PERFORM test.new_settlement(bob, cara, 4.95, g, NULL, 'PHP', '', base + interval '4 minutes');
  PERFORM test.new_settlement(alice, cara, 1000, g, NULL, 'JPY', '', base + interval '5 minutes');
  PERFORM test.new_settlement(bob, alice, 2.25, g, NULL, 'USD', '', base + interval '6 minutes');
  bnd := test.new_bundle(cara, ARRAY[alice, bob], ARRAY[3.33, 3.34], g, '', 'USD');
  UPDATE public.settlements SET created_at = base + interval '7 minutes', updated_at = base + interval '7 minutes'
   WHERE bundle_id = bnd;

  PERFORM test.as_user(alice);
  full_items := public.kwenta_group_settlement_history(g);
  PERFORM test.assert_eq(jsonb_array_length(full_items), 7, 'C2t fixture: 7 items (the bundle is one)');
  expected := test.p87_totals(full_items);
  PERFORM test.assert_eq(jsonb_array_length(expected), 5, 'C2t: five payer/currency pairs');
  PERFORM test.assert_eq(
    ARRAY(SELECT (e ->> 'amount')::numeric FROM jsonb_array_elements(expected) WITH ORDINALITY t(e, n) ORDER BY n),
    ARRAY[1000.00, 15.05, 15.05, 7.75, 6.67]::numeric[], 'C2t: the reference itself: amounts ordered DESC');
  PERFORM test.assert_eq(expected -> 0 ->> 'currency', 'JPY', 'C2t: Alice''s JPY first');
  PERFORM test.assert_eq(
    ARRAY[(expected -> 1 ->> 'userId')::uuid, (expected -> 2 ->> 'userId')::uuid],
    ARRAY[LEAST(alice, bob), GREATEST(alice, bob)], 'C2t: the 15.05 tie breaks by userId');

  p := public.kwenta_group_settlement_history_page(g, 20, NULL);
  PERFORM test.assert_eq(p -> 'totals', expected, 'C2t: multi-payer multi-currency totals match the full history''s grouping');
  FOR lim IN 1 .. 3 LOOP
    PERFORM test.assert_eq(test.p87_walk(g, lim, 7, expected), full_items,
      format('C2t: walking limit %s, every page carries the same totals', lim));
  END LOOP;
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_settlement_history_page', g, 2) -> 'totals', expected,
    'C2t: the kwenta_read (primed) page carries them too');
  PERFORM test.as_owner();

  PERFORM test.as_user(cara);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g, 2, NULL) -> 'totals',
    test.p87_totals(public.kwenta_group_settlement_history(g)), 'C2t: and for another member');
  PERFORM test.as_owner();
  PERFORM test.note('087 C2t: payer totals over the whole history, on every page');
END;
$$;

-- ---------------------------------------------------------------------------
-- C3: limit default and clamp (503 payments), malformed cursors, deleted cursor items, bundles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  base timestamptz := date_trunc('second', now()) - interval '30 days';
  alice uuid; bob uuid; g uuid; p jsonb; msg text; bad jsonb; lim int;
BEGIN
  alice := test.new_account('p87c3big-alice@example.com', 'Alice');
  bob   := test.new_account('p87c3big-bob@example.com', 'Bob');
  g := test.new_group(alice, 'Big');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  -- Hand-made rows: 503 single payments, one second apart, same columns as test.new_settlement.
  INSERT INTO public.settlements (
    id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
    is_settled, label, method, created_at, updated_at, synced_at, is_deleted, device_id
  )
  SELECT gen_random_uuid(), g, NULL, NULL, bob, alice, 1, 'PHP', true, '', NULL,
         base + make_interval(secs => i), base + make_interval(secs => i), base + make_interval(secs => i),
         false, 'test'
  FROM generate_series(1, 503) AS i;

  PERFORM test.as_user(alice);
  p := public.kwenta_group_settlement_history_page(g, NULL, NULL);
  PERFORM test.assert_eq(jsonb_array_length(p -> 'items'), 20, 'C3: limit NULL -> 20');
  PERFORM test.assert_eq((p ->> 'matching')::int, 503, 'C3: matching = 503');
  PERFORM test.assert_eq(p -> 'items' -> 0 ->> 'createdAt', to_jsonb(base + interval '503 seconds') #>> '{}',
    'C3: the newest first');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_settlement_history_page(g, 0, NULL) -> 'items'), 1,
    'C3: limit 0 clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_settlement_history_page(g, -3, NULL) -> 'items'), 1,
    'C3: a negative limit clamps to 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_settlement_history_page(g, 1, NULL) -> 'items'), 1,
    'C3: limit 1 is 1');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_settlement_history_page(g, 500, NULL) -> 'items'), 500,
    'C3: limit 500 is 500');
  FOREACH lim IN ARRAY ARRAY[501, 1000, 2147483647] LOOP
    PERFORM test.assert_eq(jsonb_array_length(public.kwenta_group_settlement_history_page(g, lim, NULL) -> 'items'), 500,
      'C3: limit ' || lim || ' clamps to 500');
  END LOOP;
  p := public.kwenta_group_settlement_history_page(g, 500, NULL);
  p := public.kwenta_group_settlement_history_page(g, 500, test.p87_cursor(p -> 'items' -> 499));
  PERFORM test.assert_eq(jsonb_array_length(p -> 'items'), 3, 'C3: past the first 500, the remaining 3');
  PERFORM test.assert_eq(p -> 'items' -> 2 ->> 'createdAt', to_jsonb(base + interval '1 second') #>> '{}',
    'C3: ending at the oldest');

  FOREACH bad IN ARRAY ARRAY[
    jsonb_build_object('createdAt', 'not a time', 'id', gen_random_uuid()),
    jsonb_build_object('createdAt', base, 'id', 'not-a-uuid'),
    jsonb_build_object('createdAt', base),
    jsonb_build_object('id', gen_random_uuid()),
    '[1, 2]'::jsonb,
    '"2026-01-01"'::jsonb
  ] LOOP
    msg := test.p87_page_error(g, 20, bad);
    PERFORM test.assert_true(msg IS NOT NULL, 'C3: cursor ' || bad::text || ' raises');
  END LOOP;
  PERFORM test.as_owner();
  PERFORM test.note('087 C3: limit default and clamp; malformed cursors raise');
END;
$$;

DO $$
DECLARE
  f jsonb; alice uuid; g1 uuid; full_items jsonb; p jsonb; cur jsonb; tt timestamptz;
BEGIN
  f := test.p87_fixture('c3');
  alice := (f->>'alice')::uuid; g1 := (f->>'g1')::uuid; tt := (f->>'tt')::timestamptz;

  PERFORM test.as_user(alice);
  full_items := public.kwenta_group_settlement_history(g1);

  -- A bundle is one whole item on any page size.
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 4));
  PERFORM test.assert_eq(jsonb_array_length(p -> 'items'), 1, 'C3: limit 1 at the bundle is one item');
  PERFORM test.assert_eq(p -> 'items' -> 0 -> 'settlementIds',
    jsonb_build_array(f->'bl1', f->'bl2'), 'C3: carrying both of its legs, primary first');
  PERFORM test.assert_eq((p -> 'items' -> 0 ->> 'isBundled')::boolean, true, 'C3: as one bundled payment');
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 2));
  PERFORM test.assert_eq(p -> 'items' -> 0 -> 'settlementIds', jsonb_build_array(f->'il2', f->'il1'),
    'C3: the intermediary bundle is one item, its newer leg first');
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 1));
  PERFORM test.assert_eq(p -> 'items' -> 0 -> 'settlementIds', jsonb_build_array(f->'ol1', f->'ol2'),
    'C3: the one-recipient bundle is one item');

  -- A cursor whose item no longer exists continues by position.
  cur := test.p87_cursor(full_items -> 3);
  PERFORM test.as_owner();
  UPDATE public.settlements SET is_deleted = true, updated_at = updated_at + interval '1 second'
   WHERE bundle_id = (f->>'ibnd')::uuid;
  PERFORM test.assert_eq((SELECT count(*)::int FROM public.settlements
                           WHERE bundle_id = (f->>'ibnd')::uuid AND is_deleted IS TRUE), 2,
    'C3 fixture: both intermediary legs are now deleted');
  PERFORM test.as_user(alice);
  p := public.kwenta_group_settlement_history_page(g1, 20, cur);
  PERFORM test.assert_eq(p -> 'items',
    (SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(full_items) WITH ORDINALITY t(e, n) WHERE n > 4),
    'C3: a cursor at a deleted item continues with the items older than it');
  PERFORM test.assert_eq((p ->> 'matching')::int, 9, 'C3: matching drops to 9');
  PERFORM test.assert_eq(p -> 'totals', test.p87_totals(public.kwenta_group_settlement_history(g1)),
    'C2t/C3: totals follow the full history after the delete (Cara''s 80 is gone)');
  PERFORM test.assert_money(
    (SELECT (e ->> 'amount')::numeric FROM jsonb_array_elements(p -> 'totals') e WHERE e ->> 'userId' = f ->> 'cara'),
    8.00, 'C2t/C3: Cara now totals 8');

  -- A cursor that never named an item continues by its position too: (TT, 3000...) sits between
  -- tA (2...) and the bundle (4...).
  p := public.kwenta_group_settlement_history_page(g1, 20,
         jsonb_build_object('createdAt', to_jsonb(tt), 'id', '30000000-0000-0000-0000-000000000000'));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'),
    ARRAY[(f->>'bl1')::uuid, (f->>'tb')::uuid, (f->>'tc')::uuid, (f->>'td')::uuid, (f->>'i1')::uuid],
    'C3/C17: a never-existing cursor (TT, 3000...) continues with the bundle');
  p := public.kwenta_group_settlement_history_page(g1, 20,
         jsonb_build_object('createdAt', to_jsonb(tt), 'id', '00000000-0000-0000-0000-000000000000'));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'),
    ARRAY[(f->>'ta')::uuid, (f->>'bl1')::uuid, (f->>'tb')::uuid, (f->>'tc')::uuid, (f->>'td')::uuid, (f->>'i1')::uuid],
    'C3/C17: (TT, nil uuid) is strictly before every TT item, so all of them follow');
  PERFORM test.as_owner();
  PERFORM test.note('087 C3: bundles stay whole; deleted and never-existing cursors continue');
END;
$$;

-- ---------------------------------------------------------------------------
-- C17: the cursor is compared as a timestamptz and a uuid; the primary leg is settlementIds[0].
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; g1 uuid; full_items jsonb; p jsonb; tt timestamptz; bundle_item jsonb;
BEGIN
  f := test.p87_fixture('c17');
  alice := (f->>'alice')::uuid; g1 := (f->>'g1')::uuid; tt := (f->>'tt')::timestamptz;

  PERFORM test.as_user(alice);
  full_items := public.kwenta_group_settlement_history(g1);
  bundle_item := full_items -> 5;
  PERFORM test.assert_eq(bundle_item ->> 'id', f ->> 'bnd', 'C17: item 5 is the bundle (its id is the bundle id)');
  PERFORM test.assert_eq(bundle_item -> 'settlementIds', jsonb_build_array(f->'bl1', f->'bl2'),
    'C17: legs sharing created_at -> settlementIds[0] is the lower id, the primary leg');
  PERFORM test.assert_eq((bundle_item ->> 'createdAt')::timestamptz, tt, 'C17: the bundle item carries the shared instant');

  -- The page from a cursor at tA starts at the bundle; a cursor at the bundle (its primary leg,
  -- NOT its bundle id e...) continues with tB and never repeats the bundle.
  p := public.kwenta_group_settlement_history_page(g1, 2, test.p87_cursor(full_items -> 4));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'bl1')::uuid, (f->>'tb')::uuid],
    'C17: after tA come the bundle and tB');
  p := public.kwenta_group_settlement_history_page(g1, 2, test.p87_cursor(bundle_item));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'tb')::uuid, (f->>'tc')::uuid],
    'C17: after the bundle (keyed by settlementIds[0]) come tB and tC');

  -- Upper-case id: compared as a uuid, the same place.
  p := public.kwenta_group_settlement_history_page(g1, 20,
         jsonb_build_object('createdAt', full_items -> 7 -> 'createdAt', 'id', upper(f ->> 'tc')));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'td')::uuid, (f->>'i1')::uuid],
    'C17: an upper-case cursor id continues after tC (uuid comparison, not text)');

  -- Another UTC offset: compared as a timestamptz, the same instant.
  p := public.kwenta_group_settlement_history_page(g1, 20,
         jsonb_build_object(
           'createdAt', to_char(tt AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '-05:00',
           'id', f -> 'tb'));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'),
    ARRAY[(f->>'tc')::uuid, (f->>'td')::uuid, (f->>'i1')::uuid],
    'C17: a cursor createdAt written at -05:00 continues after tB (timestamptz comparison, not text)');
  p := public.kwenta_group_settlement_history_page(g1, 20,
         jsonb_build_object(
           'createdAt', to_char(tt AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+09:00',
           'id', f -> 'tb'));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'),
    ARRAY[(f->>'tc')::uuid, (f->>'td')::uuid, (f->>'i1')::uuid],
    'C17: and at +09:00');

  -- A 1 us gap is kept: after tC (TT) comes tD (TT - 1us), and after tD comes i1.
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 7));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'td')::uuid],
    'C17: the item 1 microsecond older is next, not skipped');
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 8));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'i1')::uuid],
    'C17: and is not repeated after it');

  -- The intermediary bundle's primary leg is its NEWER leg (123 us later), and its createdAt.
  PERFORM test.assert_eq((full_items -> 3 ->> 'createdAt')::timestamptz,
    tt + interval '1 minute 123 microseconds', 'C17: the intermediary item is dated by its newest leg');
  p := public.kwenta_group_settlement_history_page(g1, 1, test.p87_cursor(full_items -> 3));
  PERFORM test.assert_eq(test.p87_primary_ids(p -> 'items'), ARRAY[(f->>'ta')::uuid],
    'C17: after the intermediary bundle comes tA');
  PERFORM test.as_owner();
  PERFORM test.note('087 C17: timestamptz + uuid cursor, primary leg = settlementIds[0]');
END;
$$;

-- ---------------------------------------------------------------------------
-- C4: the same gate as the full history; unauthenticated raises.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; cara uuid; eve uuid; rem uuid; g1 uuid; g2 uuid; gdel uuid; ghost uuid := gen_random_uuid();
  full_items jsonb; msg text;
BEGIN
  f := test.p87_fixture('c4');
  alice := (f->>'alice')::uuid; cara := (f->>'cara')::uuid; eve := (f->>'eve')::uuid; rem := (f->>'rem')::uuid;
  g1 := (f->>'g1')::uuid; g2 := (f->>'g2')::uuid; gdel := (f->>'gdel')::uuid;

  PERFORM test.as_user(alice);
  full_items := public.kwenta_group_settlement_history(g1);
  PERFORM test.as_owner();

  PERFORM test.as_user(eve);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g1), NULL::jsonb, 'C4 fixture: a stranger gets NULL from the full history');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g1, 20, NULL), NULL::jsonb,
    'C4: a stranger gets NULL from the page too');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g1, 20, test.p87_cursor(full_items -> 2)), NULL::jsonb,
    'C4: with a valid cursor as well');
  PERFORM test.as_owner();

  PERFORM test.as_user(rem);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g1), NULL::jsonb, 'C4 fixture: a removed member gets NULL from the full history');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g1, 20, NULL), NULL::jsonb,
    'C4: a removed member gets NULL from the page');
  PERFORM test.as_owner();

  PERFORM test.as_user(cara);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g2, 20, NULL),
    public.kwenta_group_settlement_history(g2), 'C4: a member of another group only: same answer as the full history');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(g2, 20, NULL), NULL::jsonb, 'C4: which is NULL');
  PERFORM test.as_owner();

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(gdel), NULL::jsonb,
    'C4 fixture: a deleted group (memberships swept) is NULL from the full history');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(gdel, 20, NULL), NULL::jsonb,
    'C4: a deleted group is NULL from the page');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history_page(ghost, 20, NULL), NULL::jsonb,
    'C4: an unknown group id is NULL');
  PERFORM test.assert_eq(public.kwenta_group_settlement_history(ghost), NULL::jsonb, 'C4: as from the full history');
  PERFORM test.as_owner();

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  msg := test.p87_page_error(g1, 20, NULL);
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C4: the page without auth.uid() raises ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  PERFORM test.note('087 C4: the page keeps the full history''s membership gate');
END;
$$;

-- ---------------------------------------------------------------------------
-- C5 + C13: kwenta_person_payment_items is the person history, filtered by leg id.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; c_bob uuid; h jsonb; got jsonb; ids uuid[]; msg text;
BEGIN
  f := test.p87_fixture('c5');
  alice := (f->>'alice')::uuid; bob := (f->>'bob')::uuid; c_bob := (f->>'c_bob')::uuid;

  PERFORM test.as_user(alice);
  h := public.kwenta_person_settlement_history(bob);
  PERFORM test.assert_eq(jsonb_array_length(h), 13, 'C5 fixture: Alice -> Bob history has 13 items');

  -- Every id of the history -> the history.
  ids := ARRAY(SELECT (e -> 'settlementIds' ->> 0)::uuid FROM jsonb_array_elements(h) e);
  PERFORM test.assert_eq(public.kwenta_person_payment_items(bob, ids), h,
    'C5: all of the history''s leg ids return the whole history, identical and in order');

  -- A subset, passed out of order and with a duplicate, comes back in the history's order, once.
  got := public.kwenta_person_payment_items(bob, ARRAY[
    (h -> 9 -> 'settlementIds' ->> 0)::uuid, (h -> 1 -> 'settlementIds' ->> 0)::uuid,
    (h -> 9 -> 'settlementIds' ->> 0)::uuid, (h -> 4 -> 'settlementIds' ->> 0)::uuid]);
  PERFORM test.assert_eq(got, jsonb_build_array(h -> 1, h -> 4, h -> 9),
    'C5: a subset returns those items once each, in the history''s order');

  -- One named leg each.
  got := public.kwenta_person_payment_items(bob, ARRAY[(f->>'bl1')::uuid]);
  PERFORM test.assert_eq(jsonb_array_length(got), 1, 'C5: the Alice -> Bob leg of the Trip bundle is one item');
  PERFORM test.assert_eq(got -> 0 ->> 'id', f ->> 'bl1', 'C5: that leg''s own item');
  PERFORM test.assert_eq(got -> 0 ->> 'method', 'BDO', 'C5: with its method');
  PERFORM test.assert_eq(got -> 0,
    (SELECT e FROM jsonb_array_elements(h) e WHERE e ->> 'id' = f ->> 'bl1'), 'C5: identical to the history item');
  got := public.kwenta_person_payment_items(bob, ARRAY[(f->>'i1')::uuid]);
  PERFORM test.assert_eq(got -> 0 ->> 'label', 'Dinner', 'C5: the Dinner payment keeps its label');
  PERFORM test.assert_eq(got -> 0 ->> 'method', 'GCash', 'C5: and its method');
  got := public.kwenta_person_payment_items(bob, ARRAY[(f->>'nw')::uuid]);
  PERFORM test.assert_true((got -> 0 -> 'method') = 'null'::jsonb, 'C5: a whitespace method reads as null');

  -- Ids outside this pair, excluded rows, unknown ids: nothing.
  PERFORM test.assert_eq(public.kwenta_person_payment_items(bob, ARRAY[
      (f->>'bl2')::uuid,   -- the Alice -> Cara leg of the same bundle
      (f->>'tc')::uuid,    -- Cara -> Alice
      (f->>'il1')::uuid,   -- Dan -> Cara
      (f->>'il2')::uuid,   -- Cara -> Bob
      (f->>'ef')::uuid,    -- Eve -> Frank, another account's payment
      (f->>'del1')::uuid, (f->>'pdel')::uuid,  -- deleted
      (f->>'uns')::uuid,   -- not settled
      (f->>'gd')::uuid,    -- in a deleted group
      gen_random_uuid()]),
    (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(h) e
      WHERE e ->> 'id' IN (f->>'bl2', f->>'tc', f->>'il1', f->>'il2', f->>'ef', f->>'del1', f->>'pdel', f->>'uns', f->>'gd')),
    'C5: ids outside the Alice -> Bob history return exactly what the history holds of them');
  PERFORM test.assert_eq(public.kwenta_person_payment_items(bob, ARRAY[
      (f->>'bl2')::uuid, (f->>'tc')::uuid, (f->>'il1')::uuid, (f->>'il2')::uuid, (f->>'ef')::uuid,
      (f->>'del1')::uuid, (f->>'pdel')::uuid, (f->>'uns')::uuid, gen_random_uuid()]),
    '[]'::jsonb, 'C5: foreign, other-pair, deleted, unsettled and unknown ids return []');
  PERFORM test.assert_eq(public.kwenta_person_payment_items(bob, ARRAY[gen_random_uuid(), (f->>'pa')::uuid]),
    public.kwenta_person_payment_items(bob, ARRAY[(f->>'pa')::uuid]), 'C5: an unknown id beside a known one adds nothing');
  PERFORM test.assert_eq(public.kwenta_person_payment_items(bob, '{}'::uuid[]), '[]'::jsonb,
    'C5/C13: an empty id list is [], not NULL');

  -- The linked contact's id behaves as the person's own (same expansion as the history).
  PERFORM test.assert_eq(public.kwenta_person_payment_items(c_bob, ARRAY[(f->>'pc')::uuid]),
    (SELECT jsonb_agg(e) FROM jsonb_array_elements(public.kwenta_person_settlement_history(c_bob)) e
      WHERE e ->> 'id' = f ->> 'pc'),
    'C5: through the linked contact, the contact''s payment item');

  -- At most 500 ids: 500 is answered, 501 raises.
  ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 499)) || (f->>'ta')::uuid;
  PERFORM test.assert_eq(cardinality(ids), 500, 'C5 setup: 500 ids');
  got := public.kwenta_person_payment_items(bob, ids);
  PERFORM test.assert_eq(test.p87_primary_ids(got), ARRAY[(f->>'ta')::uuid], 'C5: 500 ids are answered');
  ids := ids || gen_random_uuid();
  msg := test.p87_items_error(bob, ids);
  PERFORM test.assert_true(msg IS NOT NULL, 'C5: 501 ids raise (the client chunks by 500)');
  PERFORM test.as_owner();
  PERFORM test.note('087 C5: payment items = the person history filtered by leg id');
END;
$$;

-- ---------------------------------------------------------------------------
-- C6: scoped exactly like the person history, for every viewer/person pair; unauthenticated raises.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; all_ids uuid[]; pair text[]; viewer uuid; person uuid; got jsonb; ref jsonb; msg text;
BEGIN
  f := test.p87_fixture('c6');
  all_ids := test.p87_all_ids(f);
  PERFORM test.assert_eq(cardinality(all_ids), 22, 'C6 fixture: the fixture wrote 22 settlement rows');

  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['alice', 'bob'], ARRAY['alice', 'c_bob'], ARRAY['alice', 'cara'], ARRAY['alice', 'dan'],
    ARRAY['alice', 'frank'], ARRAY['alice', 'eve'], ARRAY['bob', 'alice'], ARRAY['bob', 'c_bob'],
    ARRAY['bob', 'cara'], ARRAY['cara', 'bob'], ARRAY['cara', 'alice'], ARRAY['cara', 'dan'],
    ARRAY['dan', 'cara'], ARRAY['eve', 'frank'], ARRAY['eve', 'alice'], ARRAY['frank', 'bob'],
    ARRAY['rem', 'alice']
  ] LOOP
    viewer := (f ->> pair[1])::uuid; person := (f ->> pair[2])::uuid;
    PERFORM test.as_user(viewer);
    ref := public.kwenta_person_settlement_history(person);
    got := public.kwenta_person_payment_items(person, all_ids);
    PERFORM test.assert_eq(got, ref,
      format('C6: %s -> %s given every fixture id returns exactly that person history', pair[1], pair[2]));
    PERFORM test.as_owner();
  END LOOP;

  PERFORM test.as_user((f->>'alice')::uuid);
  PERFORM test.assert_eq(public.kwenta_person_payment_items((f->>'frank')::uuid, ARRAY[(f->>'ef')::uuid]), '[]'::jsonb,
    'C6: Alice cannot read Eve -> Frank by naming its id');
  PERFORM test.assert_eq(public.kwenta_person_payment_items((f->>'eve')::uuid, all_ids), '[]'::jsonb,
    'C6: nor anything of Eve''s');
  PERFORM test.as_owner();
  PERFORM test.as_user((f->>'eve')::uuid);
  got := public.kwenta_person_payment_items((f->>'frank')::uuid, ARRAY[(f->>'ef')::uuid]);
  PERFORM test.assert_eq(test.p87_primary_ids(got), ARRAY[(f->>'ef')::uuid], 'C6: Eve reads her own payment to Frank');
  PERFORM test.assert_eq(public.kwenta_person_payment_items((f->>'alice')::uuid, all_ids), '[]'::jsonb,
    'C6: and nothing between Eve and Alice, given every id');
  PERFORM test.as_owner();

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  msg := test.p87_items_error((f->>'bob')::uuid, all_ids);
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C6: payment items without auth.uid() raise ''not authenticated'' (got: ' || COALESCE(msg, 'no error') || ')');
  msg := test.p87_items_error((f->>'bob')::uuid, '{}'::uuid[]);
  PERFORM test.assert_true(msg IS NOT NULL AND msg ILIKE '%not authenticated%',
    'C6: even with no ids (got: ' || COALESCE(msg, 'no error') || ')');
  PERFORM test.note('087 C6: payment items scoped exactly like the person history');
END;
$$;

-- ---------------------------------------------------------------------------
-- C7: kwenta_read dispatch, write priming, 085/086 branches kept.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f jsonb; alice uuid; bob uuid; eve uuid; g1 uuid; gk uuid; i int;
  np uuid := gen_random_uuid(); res jsonb; primed jsonb; key text; bad_key text;
BEGIN
  f := test.p87_fixture('c7');
  alice := (f->>'alice')::uuid; bob := (f->>'bob')::uuid; eve := (f->>'eve')::uuid; g1 := (f->>'g1')::uuid;
  gk := test.new_group(alice, 'Many');
  PERFORM test.add_member(gk, alice, 'Alice');
  PERFORM test.add_member(gk, bob, 'Bob');
  FOR i IN 1 .. 22 LOOP
    PERFORM test.new_settlement(bob, alice, 1, gk, NULL, 'PHP', '', now() - interval '20 days' + make_interval(mins => i));
  END LOOP;

  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_settlement_history_page'),
    'C7: kwenta_read_is_allowed admits kwenta_group_settlement_history_page');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_person_payment_items'),
    'C7: but NOT kwenta_person_payment_items (never primed)');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_settlement_history'),
    'C7: the old group history stays admitted (installed apps prime it)');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_person_settlement_history'),
    'C7: and the old person history');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_group_detail_paged'), 'C7: 085''s kwenta_group_detail_paged stays');
  PERFORM test.assert_true(public.kwenta_read_is_allowed('kwenta_person_statement_page'), 'C7: 086''s kwenta_person_statement_page stays');
  PERFORM test.assert_false(public.kwenta_read_is_allowed('kwenta_group_bills_page'), 'C7: kwenta_group_bills_page stays unnameable');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_settlement_history_page', g1, 3),
    public.kwenta_group_settlement_history_page(g1, 3, NULL), 'C7: kwenta_read dispatches page(id, limit, NULL)');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_settlement_history_page', g1, 20),
    public.kwenta_group_settlement_history_page(g1, 20, NULL), 'C7: with the limit it was given');
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_read('kwenta_group_settlement_history_page', gk, NULL) -> 'items'), 20,
    'C7: a spec without a limit gets the default 20');
  PERFORM test.assert_eq((public.kwenta_read('kwenta_group_settlement_history_page', gk, NULL) ->> 'matching')::int, 22,
    'C7: of 22');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_payment_items', bob, NULL), NULL::jsonb,
    'C7: kwenta_read does not dispatch kwenta_person_payment_items');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail_paged', g1, 20),
    public.kwenta_group_detail_paged(g1, 20), 'C7: kwenta_read still dispatches 085''s kwenta_group_detail_paged');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_statement_page', bob, 20),
    public.kwenta_person_statement_page(bob, 20, 'all', NULL), 'C7: and 086''s kwenta_person_statement_page');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_settlement_history', g1, NULL),
    public.kwenta_group_settlement_history(g1), 'C7: and the old group history');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_person_settlement_history', bob, NULL),
    public.kwenta_person_settlement_history(bob), 'C7: and the old person history');
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_detail', g1, NULL),
    public.kwenta_group_detail(g1), 'C7: and kwenta_group_detail');

  -- A payment recorded now primes the group payments page under the client's key.
  key := 'group-payments-page:' || g1;
  bad_key := 'person-payment-items:' || bob;
  res := public.kwenta_write(
    jsonb_build_object('settlements', jsonb_build_array(jsonb_build_object(
      'id', np, 'group_id', g1, 'bill_id', NULL, 'bundle_id', NULL,
      'from_user_id', alice, 'to_user_id', bob, 'amount', 42, 'currency', 'PHP',
      'is_settled', true, 'label', 'Fresh', 'method', 'GCash',
      'created_at', now(), 'updated_at', now(), 'synced_at', NULL,
      'is_deleted', false, 'device_id', 'test'))),
    gen_random_uuid(),
    jsonb_build_array(
      jsonb_build_object('key', key, 'fn', 'kwenta_group_settlement_history_page', 'id', g1, 'limit', 20),
      jsonb_build_object('key', bad_key, 'fn', 'kwenta_person_payment_items', 'id', bob)));
  PERFORM test.assert_true(res -> 'applied' -> 'settlements' ? np::text, 'C7: the payment is applied');
  primed := res -> 'reads' -> key;
  PERFORM test.assert_true(primed IS NOT NULL AND jsonb_typeof(primed) = 'object',
    'C7: the write returns the payments page under group-payments-page:<id>');
  PERFORM test.assert_eq((primed -> 'items' -> 0 -> 'settlementIds' ->> 0)::uuid, np,
    'C7: the payment just written is already first');
  PERFORM test.assert_eq(primed -> 'items' -> 0 ->> 'label', 'Fresh', 'C7: with its label');
  PERFORM test.assert_eq((primed ->> 'matching')::int, 11, 'C7: matching already includes it (10 + 1)');
  PERFORM test.assert_eq(primed, public.kwenta_group_settlement_history_page(g1, 20, NULL),
    'C7: the primed payload equals a direct call after the write');
  PERFORM test.assert_false(COALESCE(res -> 'reads' ? bad_key, false),
    'C7: a payment-items spec is not answered by the write');
  PERFORM test.as_owner();

  PERFORM test.as_user(eve);
  PERFORM test.assert_eq(public.kwenta_read('kwenta_group_settlement_history_page', g1, 20), NULL::jsonb,
    'C7: through kwenta_read a stranger still gets NULL');
  PERFORM test.as_owner();
  PERFORM test.note('087 C7: kwenta_read dispatch and write priming; 085/086 branches kept');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: both new endpoints are authenticated only, one signature each, returning jsonb.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('kwenta_group_settlement_history_page', 'public.kwenta_group_settlement_history_page(uuid, integer, jsonb)'),
    ('kwenta_person_payment_items', 'public.kwenta_person_payment_items(uuid, uuid[])')
  ) AS v(fn, sig) LOOP
    PERFORM test.assert_eq(
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = r.fn), 1,
      'grants: ' || r.fn || ' has one signature');
    PERFORM test.assert_true(to_regprocedure(r.sig) IS NOT NULL, 'grants: ' || r.sig || ' exists');
    PERFORM test.assert_true(has_function_privilege('authenticated', r.sig, 'EXECUTE'), 'grants: authenticated executes ' || r.fn);
    PERFORM test.assert_false(has_function_privilege('anon', r.sig, 'EXECUTE'), 'grants: anon may not execute ' || r.fn);
    PERFORM test.assert_false(
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = to_regprocedure(r.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
      'grants: PUBLIC holds no EXECUTE on ' || r.fn);
    PERFORM test.assert_eq(
      (SELECT format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)),
      'jsonb', 'grants: ' || r.fn || ' returns jsonb');
  END LOOP;
  PERFORM test.note('087 grants: both endpoints authenticated only');
END;
$$;
