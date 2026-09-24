-- 074_caller_scoped_rls_helpers.test.sql
--
-- 074 stops the RLS helpers from answering questions about other people. Pinned here:
--   1. the two-argument helpers are server-only; the one-argument wrappers are callable by anon and
--      authenticated (policies are TO public) and answer ONLY for auth.uid();
--   2. no policy calls a two-argument helper, and the ten rewritten policies kept their shape;
--   3. RLS is unchanged: for every account in a fixture, the rows it can read from each of the
--      seven tables equal what the PRE-074 policies admit — those predicates are restated below
--      verbatim, evaluated as the owner with the two-argument helpers and the account's id;
--   4. writes through the ALL policies: a member may update a group bill, a stranger may not.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 1. Grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.is_group_member(uuid, uuid)',
    'public.user_can_read_personal_bill(uuid, uuid)',
    'public.user_is_participant_on_personal_bill(uuid, uuid)'
  ] LOOP
    PERFORM test.assert_false(has_function_privilege('anon', fn, 'EXECUTE'), fn || ' is not executable by anon');
    PERFORM test.assert_false(has_function_privilege('authenticated', fn, 'EXECUTE'), fn || ' is not executable by authenticated');
    PERFORM test.assert_true(has_function_privilege('service_role', fn, 'EXECUTE'), fn || ' stays executable by service_role');
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'public.caller_is_group_member(uuid)',
    'public.caller_can_read_personal_bill(uuid)',
    'public.caller_is_participant_on_personal_bill(uuid)'
  ] LOOP
    PERFORM test.assert_true(has_function_privilege('anon', fn, 'EXECUTE'), fn || ' is executable by anon (policies are TO public)');
    PERFORM test.assert_true(has_function_privilege('authenticated', fn, 'EXECUTE'), fn || ' is executable by authenticated');
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Policy shape
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM test.assert_eq(
    (SELECT count(*) FROM pg_policies
      WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '')
            ~ '\m(is_group_member|user_can_read_personal_bill|user_is_participant_on_personal_bill)\('),
    0::bigint,
    'no policy passes a user id to a helper any more');

  PERFORM test.assert_eq(
    (SELECT array_agg(tablename || '.' || policyname || ':' || cmd || ':' || permissive || ':' || roles::text
                      ORDER BY tablename, policyname)
       FROM pg_policies
      WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '\mcaller_'),
    ARRAY[
      'activity_log.activity_log_access:ALL:PERMISSIVE:{public}',
      'bill_items.bill_items_access:ALL:PERMISSIVE:{public}',
      'bill_items.bill_items_read_linked_identity:SELECT:PERMISSIVE:{public}',
      'bills.bills_access:ALL:PERMISSIVE:{public}',
      'bills.bills_read_linked_identity:SELECT:PERMISSIVE:{public}',
      'group_members.group_members_read:SELECT:PERMISSIVE:{public}',
      'groups.groups_member_read:SELECT:PERMISSIVE:{public}',
      'item_splits.item_splits_access:ALL:PERMISSIVE:{public}',
      'item_splits.item_splits_read_linked_identity:SELECT:PERMISSIVE:{public}',
      'settlements.settlements_access:ALL:PERMISSIVE:{public}'
    ],
    'the ten policies use the caller wrappers and keep name, command, permissiveness and roles');
END;
$$;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
CREATE TABLE test.fx074 (k text PRIMARY KEY, id uuid NOT NULL);
GRANT SELECT ON test.fx074 TO authenticated;

DO $$
DECLARE
  a uuid := test.new_account('a074@example.com', 'A');   -- creates G and personal bills
  b uuid := test.new_account('b074@example.com', 'B');   -- member of G
  c uuid := test.new_account('c074@example.com', 'C');   -- owns H; not in G
  d uuid := test.new_account('d074@example.com', 'D');   -- removed from G
  l uuid := test.new_account('l074@example.com', 'L');   -- behind A's contact "Ellie"
  e uuid := test.new_account('e074@example.com', 'E');   -- stranger
  f uuid := test.new_account('f074@example.com', 'F');   -- only a SOFT-DELETED split on pb4
  k uuid := test.new_account('k074@example.com', 'K');   -- split on a SOFT-DELETED item of pb5
  ellie uuid; fcon uuid; kcon uuid;
  pb4 uuid; pb5 uuid;
  g uuid; h uuid; dm uuid;
  gb1 uuid; gb2 uuid; hb uuid; pb1 uuid; pb2 uuid; pb3 uuid;
BEGIN
  ellie := test.new_contact(a, 'Ellie', l);
  g := test.new_group(a, 'G');
  h := test.new_group(c, 'H');
  PERFORM test.add_member(g, a, 'A');
  PERFORM test.add_member(g, b, 'B');
  dm := test.add_member(g, d, 'D');
  UPDATE public.group_members SET is_deleted = true WHERE id = dm;
  PERFORM test.add_member(h, c, 'C');

  gb1 := test.new_bill(a, a, g, 'G dinner', 90, ARRAY[a, b, d]);
  gb2 := test.new_bill(b, b, g, 'G taxi', 40, ARRAY[a, b]);
  hb  := test.new_bill(c, c, h, 'H lunch', 30, ARRAY[c]);
  pb1 := test.new_bill(a, a, NULL, 'A and B', 20, ARRAY[a, b]);
  pb2 := test.new_bill(a, a, NULL, 'A and Ellie', 20, ARRAY[a, ellie]);
  pb3 := test.new_bill(c, c, NULL, 'C and A', 20, ARRAY[c, a]);

  -- Soft-delete coverage for the copied predicates: F's split and K's item were removed, each both
  -- under the account id itself (participant rule) and under a contact linked to it (reader rule).
  fcon := test.new_contact(a, 'Fay', f);
  kcon := test.new_contact(a, 'Kai', k);
  pb4 := test.new_bill(a, a, NULL, 'F removed', 30, ARRAY[a, f, fcon]);
  UPDATE public.item_splits SET is_deleted = true
   WHERE user_id IN (f, fcon)
     AND item_id IN (SELECT id FROM public.bill_items WHERE bill_id = pb4);
  pb5 := test.new_bill(a, a, NULL, 'K item removed', 30, ARRAY[a, k, kcon]);
  UPDATE public.bill_items SET is_deleted = true WHERE bill_id = pb5;

  PERFORM test.new_settlement(b, a, 30, g);
  PERFORM test.new_settlement(c, c, 5, h);
  PERFORM test.new_settlement(b, a, 10);
  PERFORM test.new_settlement(c, e, 7);
  PERFORM test.new_settlement(ellie, a, 3);

  INSERT INTO public.activity_log (id, group_id, user_id, action, entity_type, entity_id)
  VALUES (gen_random_uuid(), g, a, 'created', 'bill', gb1),
         (gen_random_uuid(), NULL, b, 'created', 'bill', pb1),
         (gen_random_uuid(), h, c, 'created', 'bill', hb);

  INSERT INTO test.fx074 VALUES ('a', a), ('b', b), ('c', c), ('d', d), ('l', l), ('e', e), ('f', f), ('k', k),
                        ('pb4', pb4), ('pb5', pb5),
                        ('g', g), ('h', h), ('gb1', gb1), ('pb1', pb1), ('pb2', pb2);
END;
$$;

CREATE FUNCTION test.fx(p_k text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM test.fx074 WHERE k = p_k $$;

-- The pre-074 predicates, verbatim except auth.uid() -> u. Each table's SELECT is the OR of every
-- permissive policy that applies to SELECT (so groups_creator_write counts for groups).
CREATE OR REPLACE FUNCTION pg_temp.old_visible(p_table text, u uuid)
RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE
  r uuid[];
BEGIN
  CASE p_table
  WHEN 'bills' THEN
    SELECT array_agg(id) INTO r FROM public.bills
    WHERE ((created_by = u) OR ((group_id IS NOT NULL) AND public.is_group_member(group_id, u))
           OR ((group_id IS NULL) AND public.user_is_participant_on_personal_bill(id, u)))
       OR ((group_id IS NULL) AND public.user_can_read_personal_bill(id, u));
  WHEN 'bill_items' THEN
    SELECT array_agg(bi.id) INTO r FROM public.bill_items bi
    WHERE EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bi.bill_id AND ((b.created_by = u)
                    OR ((b.group_id IS NOT NULL) AND public.is_group_member(b.group_id, u))
                    OR ((b.group_id IS NULL) AND public.user_is_participant_on_personal_bill(b.id, u))))
       OR EXISTS (SELECT 1 FROM public.bills b WHERE b.id = bi.bill_id AND b.group_id IS NULL
                    AND public.user_can_read_personal_bill(b.id, u));
  WHEN 'item_splits' THEN
    SELECT array_agg(s.id) INTO r FROM public.item_splits s
    WHERE EXISTS (SELECT 1 FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id
                   WHERE bi.id = s.item_id AND ((b.created_by = u)
                    OR ((b.group_id IS NOT NULL) AND public.is_group_member(b.group_id, u))
                    OR ((b.group_id IS NULL) AND public.user_is_participant_on_personal_bill(b.id, u))))
       OR EXISTS (SELECT 1 FROM public.bill_items bi JOIN public.bills b ON b.id = bi.bill_id
                   WHERE bi.id = s.item_id AND b.group_id IS NULL
                     AND public.user_can_read_personal_bill(b.id, u));
  WHEN 'groups' THEN
    SELECT array_agg(id) INTO r FROM public.groups
    WHERE public.is_group_member(id, u) OR created_by = u;
  WHEN 'group_members' THEN
    SELECT array_agg(gm.id) INTO r FROM public.group_members gm
    WHERE public.is_group_member(gm.group_id, u)
       OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = gm.group_id AND g.created_by = u);
  WHEN 'settlements' THEN
    SELECT array_agg(id) INTO r FROM public.settlements
    WHERE ((group_id IS NOT NULL) AND public.is_group_member(group_id, u))
       OR ((group_id IS NULL) AND ((from_user_id = u) OR (to_user_id = u)));
  WHEN 'activity_log' THEN
    SELECT array_agg(id) INTO r FROM public.activity_log
    WHERE (user_id = u) OR ((group_id IS NOT NULL) AND public.is_group_member(group_id, u));
  END CASE;
  RETURN COALESCE(r, '{}');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS equivalence
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  acct text;
  t text;
  u uuid;
  expected uuid[];
  actual uuid[];
  nonempty int := 0;
BEGIN
  FOREACH acct IN ARRAY ARRAY['a', 'b', 'c', 'd', 'l', 'e', 'f', 'k'] LOOP
    u := test.fx(acct);
    FOREACH t IN ARRAY ARRAY['bills', 'bill_items', 'item_splits', 'groups', 'group_members',
                             'settlements', 'activity_log'] LOOP
      expected := pg_temp.old_visible(t, u);
      PERFORM test.as_user(u);
      EXECUTE format('SELECT COALESCE(array_agg(id), ''{}'') FROM public.%I', t) INTO actual;
      PERFORM test.as_owner();
      PERFORM test.assert_ids(actual, expected, format('%s reads the same %s as before 074', acct, t));
      IF cardinality(expected) > 0 THEN nonempty := nonempty + 1; END IF;
    END LOOP;
  END LOOP;
  -- Guard against a vacuous pass: an equivalence over empty sets proves nothing.
  PERFORM test.assert_true(nonempty >= 25, format('the fixture exercises most (account, table) pairs: %s non-empty', nonempty));
END;
$$;

-- The cases the fixture exists for, stated directly.
DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM test.as_user(test.fx('d'));
  SELECT count(*) INTO n FROM public.bills WHERE id = test.fx('gb1');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 0::bigint, 'a removed member no longer reads a group bill they did not create');

  PERFORM test.as_user(test.fx('l'));
  SELECT count(*) INTO n FROM public.bills WHERE id = test.fx('pb2');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 1::bigint, 'the account behind a linked contact still reads that personal bill (049)');

  PERFORM test.as_user(test.fx('e'));
  SELECT count(*) INTO n FROM public.bills;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 0::bigint, 'a stranger reads no bills');

  PERFORM test.as_user(test.fx('f'));
  SELECT count(*) INTO n FROM public.bills WHERE id = test.fx('pb4');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 0::bigint, 'a removed split grants nothing on the bill');

  PERFORM test.as_user(test.fx('k'));
  SELECT count(*) INTO n FROM public.bills WHERE id = test.fx('pb5');
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 0::bigint, 'a split on a removed item grants nothing on the bill');
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. The wrappers answer only for the caller
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  own_group boolean; other_group boolean; on_bill boolean; linked_read boolean; stranger boolean;
  anon_answer boolean;
  g uuid;
BEGIN
  PERFORM test.as_user(test.fx('b'));
  own_group := public.caller_is_group_member(test.fx('g'));
  other_group := public.caller_is_group_member(test.fx('h'));
  on_bill := public.caller_is_participant_on_personal_bill(test.fx('pb1'));
  PERFORM test.as_owner();
  PERFORM test.assert_true(own_group, 'B is told B is in G');
  PERFORM test.assert_false(other_group, 'B is told B is not in H');
  PERFORM test.assert_true(on_bill, 'B is told B is on pb1');

  PERFORM test.as_user(test.fx('l'));
  linked_read := public.caller_can_read_personal_bill(test.fx('pb2'));
  PERFORM test.as_owner();
  PERFORM test.assert_true(linked_read, 'L may read pb2 through the linked contact');

  PERFORM test.as_user(test.fx('e'));
  stranger := public.caller_is_group_member(test.fx('g'));
  PERFORM test.as_owner();
  PERFORM test.assert_false(stranger, 'E is told E is not in G — and cannot ask about anyone else');

  g := test.fx('g');   -- anon cannot see the test schema
  EXECUTE 'SET LOCAL ROLE anon';
  anon_answer := public.caller_is_group_member(g);
  EXECUTE 'RESET ROLE';
  PERFORM test.assert_false(anon_answer, 'anon is never a member');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Writes through the ALL policies
-- 075 revoked direct writes on these tables from client roles, so the policy's USING clause is
-- only reachable with the privilege restored. Granted here, inside this always-rolled-back run,
-- so the block still tests the POLICY rather than the missing grant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
BEGIN
  GRANT UPDATE ON public.bills TO authenticated;
  PERFORM test.as_user(test.fx('b'));
  UPDATE public.bills SET title = 'renamed by B', updated_at = now() + interval '1 second'
   WHERE id = test.fx('gb1');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 1, 'a member may update a group bill');

  PERFORM test.as_user(test.fx('e'));
  UPDATE public.bills SET title = 'renamed by E' WHERE id = test.fx('gb1');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.as_owner();
  PERFORM test.assert_eq(n, 0, 'a stranger may not');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The wrappers are COPIES of the helpers' predicates (for speed; see the 074 header). Hold them
-- together: for every fixture account and every group / personal bill, each wrapper answers
-- exactly what its helper answers for that account.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  acct text;
  u uuid;
  ids uuid[];
  x uuid;
  helper boolean;
  wrapper boolean;
  checked int := 0;
  trues int := 0;
BEGIN
  FOREACH acct IN ARRAY ARRAY['a', 'b', 'c', 'd', 'l', 'e', 'f', 'k'] LOOP
    u := test.fx(acct);

    ids := ARRAY(SELECT id FROM public.groups);
    FOREACH x IN ARRAY ids LOOP
      helper := public.is_group_member(x, u);
      PERFORM test.as_user(u);
      wrapper := public.caller_is_group_member(x);
      PERFORM test.as_owner();
      PERFORM test.assert_eq(wrapper, helper, format('caller_is_group_member agrees with is_group_member for %s', acct));
      checked := checked + 1; IF helper THEN trues := trues + 1; END IF;
    END LOOP;

    ids := ARRAY(SELECT id FROM public.bills WHERE group_id IS NULL);
    FOREACH x IN ARRAY ids LOOP
      helper := public.user_is_participant_on_personal_bill(x, u);
      PERFORM test.as_user(u);
      wrapper := public.caller_is_participant_on_personal_bill(x);
      PERFORM test.as_owner();
      PERFORM test.assert_eq(wrapper, helper, format('caller_is_participant_on_personal_bill agrees for %s', acct));
      checked := checked + 1; IF helper THEN trues := trues + 1; END IF;

      helper := public.user_can_read_personal_bill(x, u);
      PERFORM test.as_user(u);
      wrapper := public.caller_can_read_personal_bill(x);
      PERFORM test.as_owner();
      PERFORM test.assert_eq(wrapper, helper, format('caller_can_read_personal_bill agrees for %s', acct));
      checked := checked + 1; IF helper THEN trues := trues + 1; END IF;
    END LOOP;
  END LOOP;
  PERFORM test.assert_true(trues >= 10 AND checked - trues >= 10,
    format('the agreement check sees both answers (%s true of %s)', trues, checked));
END;
$$;
