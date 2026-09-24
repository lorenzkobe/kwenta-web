-- 071_bills_list_set_based.test.sql
--
-- Migration 071 is a PERFORMANCE change and must not move a single row, key or bucket. It
-- rewrites three functions, each pinned here against a verbatim copy of the body it replaced:
--
--   * relevant_bill_ids_for_user() — the bill half of the pull privacy boundary. A wrong set is a
--     cross-account leak (too wide) or a bill vanishing from a device (too narrow), so it is
--     compared as a SET for every account, and the pull_rows_* functions that ride it are
--     compared too.
--   * kwenta_personal_bills() — the Bills list. Compared exactly, order included, on a fixture
--     whose bills all have distinct created_at; then a tie block, where the old order was
--     undefined, compares order-insensitively and asserts the new tiebreak (id).
--   * kwenta_related_profile_ids(uuid) — contact discovery. Its output order was never defined
--     (DISTINCT, no ORDER BY) and nothing depends on it, so it is compared as a set.
--
-- Do not "tidy" the test.old_* copies: their value is being an independent second opinion.

SET client_min_messages = notice;

-- verbatim from 049_pull_follows_linked_profiles.sql (relevant_bill_ids_for_user); only the name is rewritten.
CREATE OR REPLACE FUNCTION test.old_relevant_bill_ids_for_user()
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.bills b
  WHERE b.created_by = (SELECT auth.uid())
     OR (
       b.group_id IS NOT NULL
       AND public.is_group_member(b.group_id, (SELECT auth.uid()))
     )
  UNION
  SELECT bi.bill_id
  FROM public.bill_items bi
  JOIN public.item_splits ish ON ish.item_id = bi.id
  JOIN public.bills b2 ON b2.id = bi.bill_id
  WHERE b2.group_id IS NULL
    AND ish.user_id IN (SELECT i.id FROM public.kwenta_identity_ids((SELECT auth.uid())) AS i)
    AND NOT COALESCE(ish.is_deleted, false)
    AND NOT COALESCE(bi.is_deleted, false);
$$;

-- verbatim from 065_list_settled_map_and_payor_names.sql (kwenta_personal_bills); only the name is rewritten.
CREATE OR REPLACE FUNCTION test.old_personal_bills()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_settled jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- One pass for the whole list, so each counterparty's cross-context tab is
  -- computed once rather than once per bill they appear on.
  SELECT public.kwenta_bills_settled_map(
           COALESCE(ARRAY(
             SELECT b.id
             FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
             WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
           ), ARRAY[]::uuid[]),
           v_uid)
  INTO v_settled;

  WITH
  me AS (SELECT id FROM public.kwenta_expand_identity(v_uid, v_uid)),
  visible_bills AS (
    SELECT b.*
    FROM public.kwenta_pull_rows_bills('epoch'::timestamptz, v_uid) b
    WHERE b.group_id IS NULL AND b.is_deleted IS FALSE
  ),
  active_items AS (
    SELECT bi.id, bi.bill_id
    FROM public.kwenta_pull_rows_bill_items('epoch'::timestamptz, v_uid) bi
    JOIN visible_bills vb ON vb.id = bi.bill_id
    WHERE bi.is_deleted IS FALSE
  ),
  active_splits AS (
    SELECT ai.bill_id, sp.user_id
    FROM public.kwenta_pull_rows_item_splits('epoch'::timestamptz, v_uid) sp
    JOIN active_items ai ON ai.id = sp.item_id
    WHERE sp.is_deleted IS FALSE
  ),
  bucketed AS (
    SELECT vb.*,
           CASE
             WHEN vb.created_by = v_uid THEN 'mine'
             WHEN EXISTS (
               SELECT 1 FROM active_splits s
               WHERE s.bill_id = vb.id AND s.user_id IN (SELECT id FROM me)
             ) THEN 'shared'
             ELSE NULL
           END AS bucket
    FROM visible_bills vb
  ),
  kept AS (SELECT * FROM bucketed WHERE bucket IS NOT NULL),
  participants AS (
    SELECT k.id AS bill_id, k.paid_by AS uid FROM kept k WHERE k.paid_by IS NOT NULL
    UNION
    SELECT s.bill_id, s.user_id FROM active_splits s
    WHERE s.bill_id IN (SELECT id FROM kept)
  ),
  clustered AS (
    SELECT p.bill_id,
           p.uid,
           (SELECT MIN(e.id::text)::uuid FROM public.kwenta_expand_identity(p.uid, v_uid) e) AS cluster_key
    FROM participants p
  ),
  representative AS (
    SELECT c.bill_id,
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
           )::uuid AS rep,
           bool_or(c.uid IN (SELECT id FROM me)) AS is_me
    FROM clustered c
    GROUP BY c.bill_id, c.cluster_key
  ),
  pills AS (
    SELECT r.bill_id,
           jsonb_agg(
             jsonb_build_object(
               'id',    r.rep,
               'label', CASE WHEN r.is_me THEN 'You'
                             ELSE public.kwenta_peer_display_name(v_uid, r.rep) END
             )
             ORDER BY r.is_me DESC,
                      CASE WHEN r.is_me THEN '' ELSE public.kwenta_peer_display_name(v_uid, r.rep) END,
                      r.rep
           ) AS pills
    FROM representative r
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
        -- Same resolver as the participant pill on this row, with rule 6's roster
        -- fallback. The old pull-rows join could not see another account's profile,
        -- so every shared-bucket row read "Paid by Someone" while the pill beside it
        -- said "Bob". The viewer's own bills keep naming the viewer, exactly as
        -- before — the participant PILL says "You", the payer line does not, and
        -- 059's suite pins that.
        'payorName',   CASE
                         WHEN k.paid_by IS NULL THEN 'Someone'
                         ELSE public.kwenta_peer_display_name(v_uid, k.paid_by)
                       END,
        'itemCount',   COALESCE(ic.n, 0),
        'settled',     COALESCE((v_settled ->> k.id::text)::boolean, true),
        'category',    k.category,
        'participants', COALESCE(pl.pills, '[]'::jsonb)
      ) AS row,
      k.created_at
    FROM kept k
    LEFT JOIN item_counts ic ON ic.bill_id = k.id
    LEFT JOIN pills pl ON pl.bill_id = k.id
  )
  SELECT jsonb_build_object(
    'mine',   COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC)
                        FROM rows WHERE bucket = 'mine'), '[]'::jsonb),
    'shared', COALESCE((SELECT jsonb_agg(row ORDER BY created_at DESC)
                        FROM rows WHERE bucket = 'shared'), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

-- verbatim from 054_money_contacts_and_rollups.sql (kwenta_related_profile_ids); only the name is rewritten.
CREATE OR REPLACE FUNCTION test.old_related_profile_ids(p_viewer uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  my_groups AS (
    SELECT DISTINCT gm.group_id
    FROM public.group_members gm
    WHERE gm.user_id = p_viewer AND gm.is_deleted IS FALSE
  ),
  owned_locals AS (
    SELECT p.id FROM public.profiles p
    WHERE p.owner_id = p_viewer AND p.is_deleted IS FALSE
  ),
  co_members AS (
    SELECT gm.user_id AS id
    FROM public.group_members gm
    JOIN my_groups g ON g.group_id = gm.group_id
    WHERE gm.is_deleted IS FALSE
      AND gm.user_id NOT IN (SELECT id FROM me_ids)
  ),
  candidate_bills AS (
    SELECT b.* FROM public.bills b
    WHERE b.is_deleted IS FALSE
      AND (
        (b.group_id IS NOT NULL AND b.group_id IN (SELECT group_id FROM my_groups))
        OR (b.group_id IS NULL AND b.created_by IN (SELECT id FROM me_ids))
      )
  ),
  bill_participants AS (
    SELECT cb.id AS bill_id, cb.paid_by AS user_id FROM candidate_bills cb
    UNION
    SELECT bi.bill_id, sp.user_id
    FROM candidate_bills cb
    JOIN public.bill_items bi ON bi.bill_id = cb.id AND bi.is_deleted IS FALSE
    JOIN public.item_splits sp ON sp.item_id = bi.id AND sp.is_deleted IS FALSE
  ),
  -- Only bills the viewer actually takes part in contribute their other participants.
  my_bills AS (
    SELECT DISTINCT bp.bill_id
    FROM bill_participants bp
    WHERE bp.user_id IN (SELECT id FROM me_ids)
  ),
  bill_people AS (
    SELECT bp.user_id AS id
    FROM bill_participants bp
    JOIN my_bills mb ON mb.bill_id = bp.bill_id
    WHERE bp.user_id NOT IN (SELECT id FROM me_ids)
  ),
  settlement_people AS (
    SELECT s.from_user_id AS id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.to_user_id IN (SELECT id FROM me_ids)
      AND s.from_user_id NOT IN (SELECT id FROM me_ids)
    UNION
    SELECT s.to_user_id FROM public.settlements s
    WHERE s.is_deleted IS FALSE AND s.is_settled IS TRUE
      AND s.from_user_id IN (SELECT id FROM me_ids)
      AND s.to_user_id NOT IN (SELECT id FROM me_ids)
  )
  SELECT DISTINCT x.id FROM (
    SELECT id FROM owned_locals
    UNION SELECT id FROM co_members
    UNION SELECT id FROM bill_people
    UNION SELECT id FROM settlement_people
  ) x
  WHERE x.id IS NOT NULL;
$$;

/** jsonb with every array sorted by element text, recursively: order-insensitive equality. */
CREATE OR REPLACE FUNCTION test.canon(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  out jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p)
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(c ORDER BY c::text), '[]'::jsonb) INTO out
      FROM (SELECT test.canon(e) AS c FROM jsonb_array_elements(p) e) s;
      RETURN out;
    WHEN 'object' THEN
      SELECT COALESCE(jsonb_object_agg(k, test.canon(v)), '{}'::jsonb) INTO out
      FROM jsonb_each(p) AS t(k, v);
      RETURN out;
    ELSE
      RETURN p;
  END CASE;
END;
$$;

/** Run a query returning one jsonb; an error becomes {"error": message} so "both refuse" compares. */
CREATE OR REPLACE FUNCTION test.try_json(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  out jsonb;
BEGIN
  EXECUTE p_sql INTO out;
  RETURN out;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION test.assert_json_eq(p_actual jsonb, p_expected jsonb, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    PERFORM test.fail(p_what, COALESCE(p_expected::text, 'null'), COALESCE(p_actual::text, 'null'));
  END IF;
END;
$$;

/** A bucket's rows are in created_at DESC, then id order. */
CREATE OR REPLACE FUNCTION test.bills_in_list_order(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p, '[]'::jsonb) = COALESCE((
    SELECT jsonb_agg(e ORDER BY (e ->> 'createdAt')::timestamptz DESC, (e ->> 'id')::uuid)
    FROM jsonb_array_elements(p) e
  ), '[]'::jsonb);
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO authenticated;

-- ---------------------------------------------------------------------------
-- Fixture + old-vs-new comparison for every account
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a uuid; b uuid; c uuid; d uuid; e uuid; f uuid;
  ca_b uuid; ca_l uuid; ca_l2 uuid; cb_a uuid; cd_b uuid; cf_e uuid;
  g1 uuid; g2 uuid; g3 uuid; g4 uuid; g5 uuid;
  bill uuid;
  accounts uuid[];
  v uuid;
  pb jsonb;
  n_mine int := 0; n_shared int := 0; n_multi_pill int := 0;
BEGIN
  a := test.new_account('p71-a@example.com', 'Alice');
  b := test.new_account('p71-b@example.com', 'Bob');
  c := test.new_account('p71-c@example.com', 'Cha');
  d := test.new_account('p71-d@example.com', 'Dan');
  e := test.new_account('p71-e@example.com', 'Eve');
  f := test.new_account('p71-f@example.com', '  ');             -- blank name: roster fallback

  ca_b  := test.new_contact(a, 'Bee', b);        -- Alice's contact linked to Bob
  ca_l  := test.new_contact(a, 'Loco');          -- Alice's local-only contact
  ca_l2 := test.new_contact(a, 'Cee');           -- merged to Cha by hand below
  cb_a  := test.new_contact(b, 'Ay', a);         -- Bob's contact linked to Alice
  cd_b  := test.new_contact(d, 'Bobby', b);      -- a THIRD party's contact linked to Bob
  cf_e  := test.new_contact(f, 'Evie', e);       -- Fay's contact linked to Eve

  INSERT INTO public.profile_peer_links
    (id, owner_user_id, anchor_profile_id, peer_profile_id, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES (gen_random_uuid(), a, ca_l2, c, now(), now(), now(), false, 'test');

  -- Personal bills
  PERFORM test.new_bill(a, a, NULL, 'dinner', 300, ARRAY[a, ca_b, ca_l]);
  PERFORM test.new_bill(b, b, NULL, 'taxi', 100, ARRAY[b, cb_a]);      -- Alice via Bob's contact
  PERFORM test.new_bill(a, a, NULL, 'usd lunch', 50, ARRAY[a, b], 'USD');
  PERFORM test.new_bill(a, a, NULL, 'merged', 90, ARRAY[ca_l2, a, c]); -- one person, two ids
  PERFORM test.new_bill(c, c, NULL, 'coffee', 40, ARRAY[c, a]);
  PERFORM test.new_bill(a, a, NULL, 'both ids on one item', 60, ARRAY[a, ca_b, b]);
  PERFORM test.new_bill(a, ca_b, NULL, 'bob paid via contact', 80, ARRAY[a, ca_b]);
  bill := test.new_bill(a, a, NULL, 'deleted item', 999, ARRAY[a, ca_b]);
  UPDATE public.bill_items SET is_deleted = true WHERE bill_id = bill;
  bill := test.new_bill(a, a, NULL, 'deleted bill', 777, ARRAY[a, b]);
  UPDATE public.bills SET is_deleted = true WHERE id = bill;
  PERFORM test.new_bill(a, a, NULL, 'treat for bob', 64, ARRAY[b]);    -- payer holds no split
  PERFORM test.new_bill(b, b, NULL, 'bob treats alice', 26, ARRAY[a]);
  PERFORM test.new_bill(d, d, NULL, 'strangers', 70, ARRAY[d, e]);
  PERFORM test.new_bill(d, d, NULL, 'via third party contact', 30, ARRAY[d, cd_b]);  -- Bob by 049
  PERFORM test.new_bill(f, f, NULL, 'fay and evie', 20, ARRAY[f, cf_e]);             -- Eve by 049
  bill := test.new_bill(c, c, NULL, 'deleted split', 44, ARRAY[c, e]);
  UPDATE public.item_splits SET is_deleted = true
   WHERE user_id = e AND item_id IN (SELECT id FROM public.bill_items WHERE bill_id = bill);
  bill := test.new_bill(c, c, NULL, 'settled with dan', 10, ARRAY[c, d]);
  PERFORM test.new_settlement(d, c, 5);                                -- settles Dan's share
  PERFORM test.new_bill(e, e, NULL, 'no items', 0, ARRAY[]::uuid[]);
  DELETE FROM public.item_splits WHERE item_id IN
    (SELECT bi.id FROM public.bill_items bi JOIN public.bills bb ON bb.id = bi.bill_id WHERE bb.title = 'no items');
  DELETE FROM public.bill_items WHERE bill_id IN (SELECT id FROM public.bills WHERE title = 'no items');
  UPDATE public.bills SET category = 'food' WHERE title = 'dinner';

  -- Groups: active member, removed member, deleted group, group the viewer is not in
  g1 := test.new_group(a, 'Manila');
  PERFORM test.add_member(g1, a, 'Alice');
  PERFORM test.add_member(g1, b, 'Bob');
  PERFORM test.add_member(g1, c, 'Cha');
  PERFORM test.add_member(g1, d, 'Dan');
  PERFORM test.add_member(g1, f, 'Fay on roster');
  PERFORM test.new_bill(b, b, g1, 'hotel', 120, ARRAY[a, b, c]);
  PERFORM test.new_bill(d, d, g1, 'dan paid before leaving', 45, ARRAY[a, b, d]);
  UPDATE public.group_members SET is_deleted = true WHERE group_id = g1 AND user_id = d;
  g2 := test.new_group(b, 'Office');
  PERFORM test.add_member(g2, b, 'Bob');
  PERFORM test.add_member(g2, c, 'Cha');
  PERFORM test.new_bill(b, b, g2, 'lunch', 50, ARRAY[b, c]);
  g3 := test.new_group(a, 'Gone');
  PERFORM test.add_member(g3, a, 'Alice');
  PERFORM test.add_member(g3, e, 'Eve');
  PERFORM test.new_bill(a, a, g3, 'ghost', 500, ARRAY[a, e]);
  UPDATE public.groups SET is_deleted = true WHERE id = g3;
  g4 := test.new_group(e, 'Cha via contact');
  PERFORM test.add_member(g4, e, 'Eve');
  PERFORM test.add_member(g4, ca_l, 'Loco');                         -- a local contact on a roster
  PERFORM test.new_bill(e, e, g4, 'contact group', 12, ARRAY[e, ca_l]);
  -- States that tell the group arm from the personal arm (reviewer-2): each of these bills must
  -- stay INVISIBLE to the named account, whatever else changes.
  --   * a group bill someone else created, still carrying a live split for Dan after his removal;
  --   * a group bill with a split under Dan's contact linked to Bob, in a group Bob is not on;
  --   * a roster row under Bob's contact linked to Alice, in a group Alice is not on.
  PERFORM test.new_bill(b, b, g1, 'split for removed dan', 33, ARRAY[b, d]);
  g5 := test.new_group(c, 'Not Bob, not Alice');
  PERFORM test.add_member(g5, c, 'Cha');
  PERFORM test.add_member(g5, d, 'Dan');
  PERFORM test.add_member(g5, cd_b, 'Bobby');
  PERFORM test.add_member(g5, cb_a, 'Ay');
  PERFORM test.new_bill(c, c, g5, 'split under a contact of bob', 21, ARRAY[c, cd_b]);
  PERFORM test.new_bill(c, c, g5, 'roster row under a contact of alice', 15, ARRAY[c, cb_a]);

  -- Fay is on the Manila roster with a blank profile name: pills must use the roster name.
  PERFORM test.new_bill(a, a, NULL, 'fay blank name', 18, ARRAY[a, f]);
  -- The pill representative prefers the VIEWER's own contact, not any local contact: Eve keeps a
  -- private contact for Bob under a FIXED low id, so "lowest local id" and "viewer's own contact"
  -- pick different rows and Alice must see her own 'Bee', never Eve's nickname.
  INSERT INTO public.profiles (id, email, display_name, created_at, updated_at, synced_at,
                               is_deleted, device_id, is_local, linked_profile_id, owner_id)
  VALUES ('00000000-0000-4000-8000-000000000799', '', 'Eve''s nickname for Bob', now(), now(), now(),
          false, 'test', true, b, e);
  PERFORM test.new_bill(a, a, NULL, 'owner filter', 27, ARRAY[a, ca_b, '00000000-0000-4000-8000-000000000799'::uuid]);

  -- Every bill gets a distinct created_at so the list order is fully defined in both bodies.
  UPDATE public.bills bb SET created_at = now() - make_interval(mins => x.n::int)
  FROM (SELECT id, row_number() OVER (ORDER BY title, id) AS n FROM public.bills) x
  WHERE x.id = bb.id;

  accounts := ARRAY[a, b, c, d, e, f];

  FOREACH v IN ARRAY accounts LOOP
    PERFORM test.as_user(v);

    PERFORM test.assert_ids(
      ARRAY(SELECT id FROM public.relevant_bill_ids_for_user()),
      ARRAY(SELECT id FROM test.old_relevant_bill_ids_for_user()),
      format('relevant_bill_ids_for_user for %s', v));
    PERFORM test.assert_true(
      (SELECT count(*) = count(DISTINCT id) FROM public.relevant_bill_ids_for_user()),
      format('relevant_bill_ids_for_user has no duplicate ids for %s', v));

    pb := test.try_json('SELECT public.kwenta_personal_bills()');
    PERFORM test.assert_json_eq(pb, test.try_json('SELECT test.old_personal_bills()'),
      format('personal_bills for %s', v));
    PERFORM test.assert_true(test.bills_in_list_order(pb -> 'mine') AND test.bills_in_list_order(pb -> 'shared'),
      format('personal_bills lists newest first, then id, for %s', v));
    n_mine := n_mine + jsonb_array_length(pb -> 'mine');
    n_shared := n_shared + jsonb_array_length(pb -> 'shared');
    n_multi_pill := n_multi_pill + (SELECT count(*) FROM jsonb_array_elements((pb -> 'mine') || (pb -> 'shared')) r
                                     WHERE jsonb_array_length(r -> 'participants') > 2);
    PERFORM test.as_owner();

    -- Contact discovery and the rows that ride the bill predicate, compared as the owner
    -- (the pull_rows_* functions and kwenta_related_profile_ids are server-internal).
    PERFORM test.assert_ids(
      ARRAY(SELECT id FROM public.kwenta_related_profile_ids(v)),
      ARRAY(SELECT id FROM test.old_related_profile_ids(v)),
      format('related_profile_ids for %s', v));
    PERFORM set_config('request.jwt.claim.sub', v::text, true);
    PERFORM test.assert_ids(
      ARRAY(SELECT id FROM public.kwenta_pull_rows_bills('epoch', v)),
      ARRAY(SELECT bb.id FROM public.bills bb WHERE bb.id IN (SELECT id FROM test.old_relevant_bill_ids_for_user())),
      format('pull_rows_bills for %s', v));
    PERFORM test.assert_ids(
      ARRAY(SELECT id FROM public.kwenta_pull_rows_bill_items('epoch', v)),
      ARRAY(SELECT bi.id FROM public.bill_items bi WHERE bi.bill_id IN (SELECT id FROM test.old_relevant_bill_ids_for_user())),
      format('pull_rows_bill_items for %s', v));
    PERFORM test.assert_ids(
      ARRAY(SELECT id FROM public.kwenta_pull_rows_item_splits('epoch', v)),
      ARRAY(SELECT sp.id FROM public.item_splits sp JOIN public.bill_items bi ON bi.id = sp.item_id
             WHERE bi.bill_id IN (SELECT id FROM test.old_relevant_bill_ids_for_user())),
      format('pull_rows_item_splits for %s', v));
    PERFORM test.as_owner();
  END LOOP;

  -- The fixture must reach every rule, or equality proves nothing.
  PERFORM test.assert_true(n_mine > 0 AND n_shared > 0, 'fixture sanity: both buckets are non-empty');
  PERFORM test.assert_true(n_multi_pill > 0, 'fixture sanity: some bill has three or more pills');
  PERFORM set_config('request.jwt.claim.sub', b::text, true);  -- owner: bills is not granted to authenticated
  PERFORM test.assert_true(
    (SELECT bool_or(r ->> 'title' = 'via third party contact') FROM jsonb_array_elements(public.kwenta_personal_bills() -> 'shared') r),
    'fixture sanity: Bob sees a bill filed under a third party''s contact linked to him');
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
             WHERE bb.title = 'hotel'),
    'fixture sanity: an active member sees a group bill they did not create');
  PERFORM set_config('request.jwt.claim.sub', d::text, true);  -- owner: bills is not granted to authenticated
  PERFORM test.assert_true(
    NOT EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'hotel')
    AND EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'dan paid before leaving'),
    'fixture sanity: a removed member keeps only the group bills they created');
  PERFORM test.assert_true(
    NOT EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'split for removed dan'),
    'a removed member holding a live split on a group bill does NOT see it');
  PERFORM set_config('request.jwt.claim.sub', b::text, true);
  PERFORM test.assert_true(
    NOT EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'split under a contact of bob'),
    'a group bill split to a contact linked to Bob does NOT reach Bob when he is not on the group');
  PERFORM set_config('request.jwt.claim.sub', a::text, true);
  PERFORM test.assert_true(
    NOT EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'roster row under a contact of alice'),
    'a roster row under a contact linked to Alice does NOT make the group''s bills Alice''s');
  PERFORM set_config('request.jwt.claim.sub', e::text, true);  -- owner: bills is not granted to authenticated
  PERFORM test.assert_true(
    NOT EXISTS (SELECT 1 FROM public.relevant_bill_ids_for_user() r JOIN public.bills bb ON bb.id = r.id
                 WHERE bb.title = 'deleted split'),
    'fixture sanity: a deleted split does not make a bill visible');
  PERFORM set_config('request.jwt.claim.sub', a::text, true);  -- owner: bills is not granted to authenticated
  PERFORM test.assert_true(
    (SELECT jsonb_array_length(r -> 'participants') FROM jsonb_array_elements(public.kwenta_personal_bills() -> 'mine') r
      WHERE r ->> 'title' = 'merged') = 2,
    'fixture sanity: a contact merged to an account renders as ONE pill');
  PERFORM test.assert_eq(
    (SELECT string_agg(pl ->> 'label', ',' ORDER BY pl ->> 'label')
       FROM jsonb_array_elements(public.kwenta_personal_bills() -> 'mine') r,
            jsonb_array_elements(r -> 'participants') pl
      WHERE r ->> 'title' = 'owner filter'),
    'Bee,You', 'the pill is the viewer''s own contact, never another user''s private contact');
  PERFORM test.as_owner();

  -- Ties: the old order was undefined, so compare as multisets and assert the new tiebreak. The
  -- tied bills carry FIXED ids inserted out of id order: with random ids they would already come
  -- out in id order one run in six and a missing tiebreak would pass (the 067/068 trap).
  INSERT INTO public.bills (id, group_id, created_by, paid_by, title, total_amount, currency,
                            created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES ('00000000-0000-4000-8000-000000000713', NULL, a, a, 'tie 3', 30, 'PHP', now() - interval '1 day', now(), now(), false, 'test'),
         ('00000000-0000-4000-8000-000000000711', NULL, a, a, 'tie 1', 10, 'PHP', now() - interval '1 day', now(), now(), false, 'test'),
         ('00000000-0000-4000-8000-000000000712', NULL, a, a, 'tie 2', 20, 'PHP', now() - interval '1 day', now(), now(), false, 'test');
  INSERT INTO public.bill_items (id, bill_id, name, amount, created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), x.id, 'item', 10, now(), now(), now(), false, 'test'
  FROM (VALUES ('00000000-0000-4000-8000-000000000713'::uuid), ('00000000-0000-4000-8000-000000000711'::uuid),
               ('00000000-0000-4000-8000-000000000712'::uuid)) AS x(id);
  INSERT INTO public.item_splits (id, item_id, user_id, split_type, split_value, computed_amount,
                                  created_at, updated_at, synced_at, is_deleted, device_id)
  SELECT gen_random_uuid(), bi.id, u.uid, 'equal', 1, 5, now(), now(), now(), false, 'test'
  FROM public.bill_items bi CROSS JOIN (VALUES (a), (b)) AS u(uid)
  WHERE bi.bill_id IN ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000712',
                       '00000000-0000-4000-8000-000000000713');
  PERFORM test.as_user(a);
  PERFORM test.assert_eq(
    (SELECT string_agg(r ->> 'title', ',') FROM jsonb_array_elements(public.kwenta_personal_bills() -> 'mine') r
      WHERE r ->> 'title' LIKE 'tie %'),
    'tie 1,tie 2,tie 3', 'tied bills are listed by id');
  PERFORM test.as_owner();
  FOREACH v IN ARRAY accounts LOOP
    PERFORM test.as_user(v);
    pb := test.try_json('SELECT public.kwenta_personal_bills()');
    PERFORM test.assert_json_eq(test.canon(pb), test.canon(test.try_json('SELECT test.old_personal_bills()')),
      format('personal_bills with created_at ties, as multisets, for %s', v));
    PERFORM test.assert_true(test.bills_in_list_order(pb -> 'mine') AND test.bills_in_list_order(pb -> 'shared'),
      format('personal_bills breaks created_at ties by id for %s', v));
    PERFORM test.as_owner();
  END LOOP;

  PERFORM test.note(format('old == new for %s accounts (%s mine rows, %s shared rows)',
                           array_length(accounts, 1), n_mine, n_shared));
END;
$$;

-- ---------------------------------------------------------------------------
-- Unauthenticated callers: the endpoint refuses and the predicate is empty
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.as_owner();
  PERFORM test.assert_true(test.try_json('SELECT public.kwenta_personal_bills()') ? 'error',
    'personal_bills refuses a caller with no auth.uid()');
  PERFORM test.assert_eq((SELECT count(*) FROM public.relevant_bill_ids_for_user()), 0::bigint,
    'relevant_bill_ids_for_user is empty without auth.uid()');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants are unchanged: the endpoint and the predicate stay client-callable, the acting-user
-- helpers stay server-only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.kwenta_related_profile_ids(uuid)',
    'public.kwenta_bills_settled_map(uuid[], uuid)',
    'public.kwenta_pull_rows_bills(timestamptz, uuid)',
    'public.kwenta_pull_rows_bill_items(timestamptz, uuid)',
    'public.kwenta_pull_rows_item_splits(timestamptz, uuid)'
  ] LOOP
    PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'),
      fn || ' is not executable by authenticated');
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'),
      fn || ' is not executable by anon');
  END LOOP;
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.kwenta_personal_bills()', 'EXECUTE'),
    'kwenta_personal_bills stays executable by authenticated');
  PERFORM test.assert_false(has_function_privilege('anon', 'public.kwenta_personal_bills()', 'EXECUTE'),
    'kwenta_personal_bills is not executable by anon');
  PERFORM test.assert_true(has_function_privilege('authenticated', 'public.relevant_bill_ids_for_user()', 'EXECUTE'),
    'relevant_bill_ids_for_user keeps its 005 grant to authenticated');
  PERFORM test.assert_eq(
    (SELECT p.prorows FROM pg_proc p WHERE p.oid = 'public.kwenta_expand_identity(uuid, uuid)'::regprocedure),
    5::real, 'kwenta_expand_identity keeps ROWS 5');
END;
$$;
