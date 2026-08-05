-- 068_collapse_legacy_credit_settlements.test.sql
--
-- The sweep turns 72 production rows into 14 payments. The only thing that would make that a
-- disaster is a balance moving, so most of this file is before/after EQUALITY on the surfaces
-- that own a balance: kwenta_person_summary (person page), kwenta_group_detail (group page) and
-- kwenta_bill_settled_for_me (the per-bill flag). Those are read through the CLIENT-facing
-- endpoints under test.as_user, because that is how the app sees them; the sweep itself is
-- service_role and runs as the owner.
--
-- The one number that DOES change is pinned rather than hidden: kwenta_bill_pairwise (060) sums
-- settlements by bill_id, so clearing bill_id changes the per-counterparty nets inside
-- kwenta_bill_detail. That is the documented, accepted cost of the repair.
--
-- BLOCK ORDER MATTERS. The whole file is one transaction and every block calls the sweep, so a
-- row left IN SCOPE by one block is visible to the next. Collapsed and relabelled rows leave
-- scope (their labels are blanked); SKIPPED rows do not — which is why the skip-guard blocks run
-- LAST.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- A personal family: three bill-tagged legs of one payment, plus a plain payment between the
-- same two people that must not be touched at all.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  b1 uuid; b2 uuid; b3 uuid;
  s1 uuid; s2 uuid; s3 uuid; plain uuid;
  plain_before jsonb; plain_after jsonb;
  surv public.settlements%ROWTYPE;
  sum_before jsonb; sum_after jsonb;
  settled_before boolean; settled_after boolean;
  det_before jsonb; det_after jsonb;
  res jsonb;
BEGIN
  alice := test.new_account('c68a-alice@example.com', 'Alice');
  bob   := test.new_account('c68a-bob@example.com',   'Bob');

  b1 := test.new_bill(alice, alice, NULL, 'Lunch',  100, ARRAY[alice, bob]);
  b2 := test.new_bill(alice, alice, NULL, 'Coffee',  60, ARRAY[alice, bob]);
  b3 := test.new_bill(alice, alice, NULL, 'Taxi',    40, ARRAY[alice, bob]);

  -- One real payment, written by the removed feature as one row per bill. The production shape,
  -- reproduced exactly: every leg shares `updated_at` (one write transaction — this is the family
  -- key) while `created_at` is STAGGERED, because a re-tagged leg kept the original payment's
  -- date and a freshly written one got the application time. Inserted directly rather than via
  -- the fixture, which ties the two timestamps together.
  s1 := gen_random_uuid();
  s2 := gen_random_uuid();
  s3 := gen_random_uuid();
  INSERT INTO public.settlements
    (id, group_id, bill_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (s1, NULL, b1, bob, alice, 50, 'PHP', true, 'Applied general credit to bills',
     now() - interval '3 days', now(), now(), false, 'test'),
    (s2, NULL, b2, bob, alice, 30, 'PHP', true, 'Applied general credit to bills',
     now() - interval '2 days', now(), now(), false, 'test'),
    (s3, NULL, b3, bob, alice, 20, 'PHP', true, 'Paid from Bob''s available credit',
     now() - interval '1 day',  now(), now(), false, 'test');

  -- NOT 'Cash' — that is an exact method-like label and the sweep's second step would move it.
  plain := test.new_settlement(bob, alice, 15, NULL, NULL, 'PHP', 'Dinner split');
  SELECT to_jsonb(s) INTO plain_before FROM public.settlements s WHERE s.id = plain;

  PERFORM test.as_user(alice);
  sum_before     := public.kwenta_person_summary(bob);
  settled_before := public.kwenta_bill_settled_for_me(b1);
  det_before     := public.kwenta_bill_detail(b1);
  PERFORM test.as_owner();

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'families')::int,        1, 'one family');
  PERFORM test.assert_eq((res ->> 'survivors')::int,       1, 'one survivor');
  PERFORM test.assert_eq((res ->> 'absorbed')::int,        2, 'two rows absorbed');
  PERFORM test.assert_eq((res ->> 'offsets_removed')::int, 0, 'no offset legs here');
  PERFORM test.assert_eq((res ->> 'skipped')::int,         0, 'nothing skipped');

  SELECT * INTO surv FROM public.settlements WHERE id = s1;
  PERFORM test.assert_money(surv.amount, 100, 'the OLDEST row carries 50 + 30 + 20');
  PERFORM test.assert_eq(surv.bill_id, NULL, 'the bill tag is gone');
  PERFORM test.assert_eq(surv.label, '', 'and so is the dead feature''s wording');
  PERFORM test.assert_false(surv.is_deleted, 'survivor stays live');
  PERFORM test.assert_eq(surv.from_user_id, bob,   'payer unchanged');
  PERFORM test.assert_eq(surv.to_user_id,   alice, 'recipient unchanged');
  PERFORM test.assert_eq(surv.currency, 'PHP', 'currency unchanged');
  PERFORM test.assert_true(surv.is_settled, 'settled state unchanged');
  PERFORM test.assert_eq(surv.synced_at, NULL, 'the row is re-advertised to devices');
  -- The date the user actually recorded the payment, not the date the credit was applied.
  PERFORM test.assert_true(surv.created_at < now() - interval '2 days',
    'the survivor keeps the OLDEST created_at — the original payment date');

  PERFORM test.assert_true(
    (SELECT is_deleted FROM public.settlements WHERE id = s2)
    AND (SELECT is_deleted FROM public.settlements WHERE id = s3),
    'the other two legs are soft-deleted, never hard-deleted');

  -- 021b returns OLD when OLD.updated_at > NEW.updated_at. A repair that did not stamp strictly
  -- forward would report success while the row stayed put.
  PERFORM test.assert_true(
    (SELECT updated_at FROM public.settlements WHERE id = s1)
      > (plain_before ->> 'updated_at')::timestamptz,
    'updated_at moves strictly forward past the server-wins guard');

  SELECT to_jsonb(s) INTO plain_after FROM public.settlements s WHERE s.id = plain;
  PERFORM test.assert_eq(plain_after, plain_before,
    'a plain payment is out of scope and is not rewritten at all');

  PERFORM test.as_user(alice);
  sum_after     := public.kwenta_person_summary(bob);
  settled_after := public.kwenta_bill_settled_for_me(b1);
  det_after     := public.kwenta_bill_detail(b1);

  PERFORM test.assert_eq(sum_after, sum_before,
    'THE INVARIANT: the person page is bit-identical before and after');
  PERFORM test.assert_eq(settled_after, settled_before,
    'the per-bill settled flag is person-level and does not move');

  -- The documented cost, asserted so it can never change again unnoticed: kwenta_bill_pairwise
  -- sums settlements by bill_id (060:132), so clearing bill_id un-pays the bill's own net.
  PERFORM test.assert_eq(det_before -> 'bill', det_after -> 'bill',
    'the bill record itself is untouched');
  PERFORM test.assert_true(
    (det_before -> 'pairs') IS DISTINCT FROM (det_after -> 'pairs'),
    'DOCUMENTED: bill-detail per-counterparty nets change when bill_id is cleared');

  PERFORM test.as_owner();
  PERFORM test.note('068: personal family collapses; person page and settled flag unmoved');
END;
$$;

-- ---------------------------------------------------------------------------
-- An offset bundle: one credit leg plus a mutual pair that cancels exactly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bundle uuid;
  credit uuid; off_a uuid; off_b uuid;
  sum_before jsonb; res jsonb;
BEGIN
  alice  := test.new_account('c68b-alice@example.com', 'Alice');
  bob    := test.new_account('c68b-bob@example.com',   'Bob');
  bundle := gen_random_uuid();
  credit := gen_random_uuid();
  off_a  := gen_random_uuid();
  off_b  := gen_random_uuid();

  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 200, ARRAY[alice, bob]);

  INSERT INTO public.settlements
    (id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (credit, NULL, NULL, bundle, bob, alice, 100, 'PHP', true,
     'Applied general credit to bills', now(), now(), now(), false, 'test'),
    (off_a,  NULL, NULL, bundle, bob, alice,  40, 'PHP', true,
     'Settled by offset against bills Alice paid', now(), now(), now(), false, 'test'),
    (off_b,  NULL, NULL, bundle, alice, bob,  40, 'PHP', true,
     'Settled by offset — covers what Bob owed you', now(), now(), now(), false, 'test');

  PERFORM test.as_user(alice);
  sum_before := public.kwenta_person_summary(bob);
  PERFORM test.as_owner();

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'offsets_removed')::int, 2, 'both offset legs removed');
  PERFORM test.assert_eq((res ->> 'survivors')::int, 1, 'the credit leg survives');
  PERFORM test.assert_eq((res ->> 'skipped')::int, 0, 'a cancelling pair passes the guard');

  PERFORM test.assert_true((SELECT is_deleted FROM public.settlements WHERE id = off_a)
                       AND (SELECT is_deleted FROM public.settlements WHERE id = off_b),
    'offset legs are gone');
  PERFORM test.assert_money((SELECT amount FROM public.settlements WHERE id = credit), 100,
    'the survivor sums the NON-offset rows only — the cancelling pair is not folded in');
  PERFORM test.assert_eq((SELECT bundle_id FROM public.settlements WHERE id = credit), bundle,
    'bundle_id survives: 064 finds recordedBy via COALESCE(bundle_id, id)');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_person_summary(bob), sum_before,
    'removing a cancelling pair moves no money');
  -- A one-leg bundle must not render as a bundle ("You paid 1 people").
  PERFORM test.assert_eq(jsonb_array_length(public.kwenta_person_settlement_history(bob)), 1,
    'one payment left in the person history');
  PERFORM test.as_owner();
  PERFORM test.note('068: offset bundle collapses to its single real leg');
END;
$$;

-- ---------------------------------------------------------------------------
-- A group-tagged legacy row: label only. A shared ledger is not rewritten by a sweep no other
-- member asked for.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b uuid; s uuid;
  before_row jsonb; after_row jsonb;
  gd_before jsonb; gd_after jsonb;
  res jsonb;
BEGIN
  alice := test.new_account('c68c-alice@example.com', 'Alice');
  bob   := test.new_account('c68c-bob@example.com',   'Bob');
  g     := test.new_group(alice, 'Trip', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');
  b := test.new_bill(alice, alice, g, 'Hotel', 300, ARRAY[alice, bob]);
  s := test.new_settlement(bob, alice, 80, g, b, 'PHP',
                           'Applied general credit to group balance');

  SELECT to_jsonb(r) INTO before_row FROM public.settlements r WHERE r.id = s;

  PERFORM test.as_user(alice);
  gd_before := public.kwenta_group_detail(g);
  PERFORM test.as_owner();

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'relabeled')::int, 1, 'the group row is relabelled');
  PERFORM test.assert_eq((res ->> 'survivors')::int, 0, 'and never collapsed');
  PERFORM test.assert_eq((res ->> 'absorbed')::int,  0, 'nothing absorbed');

  SELECT to_jsonb(r) INTO after_row FROM public.settlements r WHERE r.id = s;
  PERFORM test.assert_eq(after_row ->> 'label', '', 'label blanked');
  PERFORM test.assert_money((after_row ->> 'amount')::numeric,
                            (before_row ->> 'amount')::numeric, 'amount untouched');
  PERFORM test.assert_eq(after_row ->> 'bill_id', before_row ->> 'bill_id',
    'the bill tag is KEPT on a group row');
  PERFORM test.assert_eq(after_row ->> 'group_id', before_row ->> 'group_id', 'group untouched');
  PERFORM test.assert_eq(after_row ->> 'from_user_id', before_row ->> 'from_user_id',
    'parties untouched');
  PERFORM test.assert_false((after_row ->> 'is_deleted')::boolean, 'still live');

  PERFORM test.as_user(alice);
  gd_after := public.kwenta_group_detail(g);
  -- rawDebts is aggregated without a stable order; compare it as a set and the rest exactly.
  PERFORM test.assert_eq(gd_after - 'rawDebts', gd_before - 'rawDebts',
    'THE INVARIANT: the group page is bit-identical apart from unordered rawDebts');
  PERFORM test.assert_eq(
    (SELECT jsonb_agg(e ORDER BY e::text) FROM jsonb_array_elements(gd_after  -> 'rawDebts') e),
    (SELECT jsonb_agg(e ORDER BY e::text) FROM jsonb_array_elements(gd_before -> 'rawDebts') e),
    'and rawDebts is the same set of edges, so settle-up suggests the same transfers');

  PERFORM test.assert_eq(public.kwenta_group_settlement_history(g) -> 0 ->> 'label', '',
    'the history line loses the dead feature''s wording');
  PERFORM test.as_owner();
  PERFORM test.note('068: group rows are label-only, so no shared ledger moves');
END;
$$;

-- ---------------------------------------------------------------------------
-- The label -> method step. Exact case-insensitive matches only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid;
  exact uuid; spaced uuid; noisy uuid; taken uuid;
  res jsonb;
BEGIN
  alice := test.new_account('c68e-alice@example.com', 'Alice');
  bob   := test.new_account('c68e-bob@example.com',   'Bob');

  exact  := test.new_settlement(bob, alice, 10, NULL, NULL, 'PHP', 'GCash');
  spaced := test.new_settlement(bob, alice, 11, NULL, NULL, 'PHP', '  gotyme ');
  noisy  := test.new_settlement(bob, alice, 12, NULL, NULL, 'PHP', 'Gcash 6/4');
  -- Already has a method: the label must NOT overwrite it.
  taken  := test.new_settlement(bob, alice, 13, NULL, NULL, 'PHP', 'BDO', NULL, 'Cash');

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'method_moved')::int, 2, 'two unambiguous labels moved');

  PERFORM test.assert_eq((SELECT method FROM public.settlements WHERE id = exact), 'GCash',
    'an exact match moves to the method column');
  PERFORM test.assert_eq((SELECT label FROM public.settlements WHERE id = exact), '',
    'and the label is cleared');
  PERFORM test.assert_eq((SELECT method FROM public.settlements WHERE id = spaced), 'gotyme',
    'matching is case-insensitive and trims, but the stored text keeps its own case');

  PERFORM test.assert_eq((SELECT method FROM public.settlements WHERE id = noisy), NULL,
    'a note that merely CONTAINS a method is left alone');
  PERFORM test.assert_eq((SELECT label FROM public.settlements WHERE id = noisy), 'Gcash 6/4',
    'so its label survives intact');
  PERFORM test.assert_eq((SELECT method FROM public.settlements WHERE id = taken), 'Cash',
    'an existing method is never overwritten');
  PERFORM test.assert_eq((SELECT label FROM public.settlements WHERE id = taken), 'BDO',
    'and that row keeps its label too');
  PERFORM test.note('068: method-like labels move, ambiguous ones do not');
END;
$$;

-- ---------------------------------------------------------------------------
-- Idempotence. Blanking the label removes the row from scope; that is the ONLY thing making a
-- second run safe, so it is asserted rather than assumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; s1 uuid; s2 uuid;
  after_first jsonb; res jsonb;
BEGIN
  alice := test.new_account('c68d-alice@example.com', 'Alice');
  bob   := test.new_account('c68d-bob@example.com',   'Bob');
  -- Staggered created_at so "oldest survives" is deterministic; a shared created_at would leave
  -- the tiebreak to a random uuid and make this assertion pass only half the time.
  s1 := gen_random_uuid();
  s2 := gen_random_uuid();
  INSERT INTO public.settlements
    (id, group_id, bill_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (s1, NULL, NULL, bob, alice, 25, 'PHP', true, 'Applied general credit to bills',
     now() - interval '2 days', now(), now(), false, 'test'),
    (s2, NULL, NULL, bob, alice, 35, 'PHP', true, 'Applied general credit to bills',
     now() - interval '1 day',  now(), now(), false, 'test');

  PERFORM public.kwenta_collapse_legacy_credit_settlements(false);
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO after_first
  FROM public.settlements t WHERE t.id IN (s1, s2);

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'rows_touched')::int, 0, 'the second run finds nothing');
  PERFORM test.assert_eq((res ->> 'families')::int, 0, 'no families left in scope');
  PERFORM test.assert_eq((res ->> 'method_moved')::int, 0, 'and no labels left to move');
  PERFORM test.assert_eq(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.settlements t WHERE t.id IN (s1, s2)),
    after_first,
    'and changes nothing — a survivor at 60 is NOT summed to 120');
  PERFORM test.assert_money((SELECT amount FROM public.settlements WHERE id = s1), 60,
    'survivor still holds exactly one payment');

  -- The dry run agrees with the apply, because both read the same classifier.
  PERFORM test.assert_eq(
    (public.kwenta_collapse_legacy_credit_settlements(true) ->> 'rows_touched')::int, 0,
    'dry run reports the same nothing');
  PERFORM test.note('068: idempotent — the label IS the scope selector');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants and the backup table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
BEGIN
  PERFORM test.as_owner();

  -- 065's generic sweep only catches functions taking a VIEWER argument, so it cannot see these.
  PERFORM test.assert_false(
    has_function_privilege('authenticated',
      'public.kwenta_collapse_legacy_credit_settlements(boolean)', 'EXECUTE'),
    'a global unscoped sweep is not client-callable (rule 5)');
  PERFORM test.assert_false(
    has_function_privilege('authenticated',
      'public.kwenta_collapse_legacy_credit_plan()', 'EXECUTE'),
    'nor is its classifier');
  PERFORM test.assert_true(
    has_function_privilege('service_role',
      'public.kwenta_collapse_legacy_credit_settlements(boolean)', 'EXECUTE'),
    'service_role can run it');

  SELECT count(*) INTO n FROM public.kwenta_legacy_credit_repair_backup;
  PERFORM test.assert_true(n > 0, 'every modified row was snapshotted first');
  PERFORM test.assert_true(
    EXISTS (SELECT 1 FROM public.kwenta_legacy_credit_repair_backup b
            WHERE b.row_data ->> 'label' LIKE 'Applied general credit%'
              AND (b.row_data ->> 'is_deleted')::boolean IS FALSE),
    'the snapshot is the PRE-modification row: original label, still live');
  PERFORM test.assert_true(
    (SELECT bool_and(b.swept_at IS NOT NULL AND b.run_id IS NOT NULL)
       FROM public.kwenta_legacy_credit_repair_backup b),
    'every snapshot is stamped and attributed to a run');

  -- The shim does NOT emulate Supabase's default GRANTs on new public tables, so this assertion
  -- is weaker here than in production — the REVOKE it guards still needs a branch-database check
  -- (rule 11). RLS with no policies is the second lock.
  PERFORM test.assert_true(
    (SELECT c.relrowsecurity FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname = 'kwenta_legacy_credit_repair_backup'),
    'the backup table has RLS enabled and no policies');
  PERFORM test.assert_false(
    has_table_privilege('authenticated', 'public.kwenta_legacy_credit_repair_backup', 'SELECT'),
    'and is not readable by a signed-in user');

  PERFORM test.note('068: service_role only; backup snapshotted and not client-readable');
END;
$$;

-- ---------------------------------------------------------------------------
-- The skip guards. LAST on purpose: these rows STAY in scope, so any sweep after them would see
-- them again and pollute the counts.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; bundle uuid;
  credit uuid; off_a uuid; off_b uuid;
  before_rows jsonb; sum_before jsonb; res jsonb;
BEGIN
  alice  := test.new_account('c68z-alice@example.com', 'Alice');
  bob    := test.new_account('c68z-bob@example.com',   'Bob');
  bundle := gen_random_uuid();
  credit := gen_random_uuid();
  off_a  := gen_random_uuid();
  off_b  := gen_random_uuid();

  -- 40 out, 25 back: NOT a cancelling pair. Deleting these would erase 15 of real money.
  INSERT INTO public.settlements
    (id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (credit, NULL, NULL, bundle, bob, alice, 100, 'PHP', true,
     'Applied general credit to bills', now(), now(), now(), false, 'test'),
    (off_a,  NULL, NULL, bundle, bob, alice,  40, 'PHP', true,
     'Settled by offset against bills Alice paid', now(), now(), now(), false, 'test'),
    (off_b,  NULL, NULL, bundle, alice, bob,  25, 'PHP', true,
     'Settled by offset — covers what Bob owed you', now(), now(), now(), false, 'test');

  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO before_rows
  FROM public.settlements t WHERE t.id IN (credit, off_a, off_b);

  PERFORM test.as_user(alice);
  sum_before := public.kwenta_person_summary(bob);
  PERFORM test.as_owner();

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res ->> 'skipped')::int, 3,
    'the guard refuses the WHOLE family, not just the offending leg');
  PERFORM test.assert_eq((res ->> 'survivors')::int, 0, 'nothing collapsed');
  PERFORM test.assert_eq((res ->> 'offsets_removed')::int, 0, 'nothing deleted');
  PERFORM test.assert_eq((res -> 'skipped_families' ->> 'offsets_do_not_net_to_zero')::int, 1,
    'and says why');

  PERFORM test.assert_eq(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.settlements t
      WHERE t.id IN (credit, off_a, off_b)),
    before_rows,
    'a skipped family is byte-identical afterwards — updated_at included');

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_person_summary(bob), sum_before,
    'and the balance is untouched');
  PERFORM test.as_owner();

  -- Deterministic, not stateful: re-running keeps skipping it.
  PERFORM test.assert_eq(
    (public.kwenta_collapse_legacy_credit_settlements(true) ->> 'skipped')::int, 3,
    'a skip is stable across runs');
  PERFORM test.note('068: offsets that do not cancel skip the whole family');
END;
$$;

-- ---------------------------------------------------------------------------
-- The remaining guards. A multi-recipient bundle is the one that would silently move money
-- between two DIFFERENT people, which no amount of balance-checking per pair would catch if the
-- classifier let it through.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; cha uuid; bundle uuid; res jsonb;
  b_before numeric; c_before numeric;
BEGIN
  alice  := test.new_account('c68y-alice@example.com', 'Alice');
  bob    := test.new_account('c68y-bob@example.com',   'Bob');
  cha    := test.new_account('c68y-cha@example.com',   'Cha');
  bundle := gen_random_uuid();

  INSERT INTO public.settlements
    (id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), NULL, NULL, bundle, alice, bob, 30, 'PHP', true,
     'Applied general credit to bills', now(), now(), now(), false, 'test'),
    (gen_random_uuid(), NULL, NULL, bundle, alice, cha, 70, 'PHP', true,
     'Applied general credit to bills', now(), now(), now(), false, 'test');

  SELECT SUM(amount) INTO b_before FROM public.settlements
   WHERE bundle_id = bundle AND to_user_id = bob AND is_deleted IS FALSE;
  SELECT SUM(amount) INTO c_before FROM public.settlements
   WHERE bundle_id = bundle AND to_user_id = cha AND is_deleted IS FALSE;

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res -> 'skipped_families' ->> 'mixed_parties_currency_or_settled_state')::int,
    1, 'a bundle paying two different people is refused');
  PERFORM test.assert_eq((res ->> 'survivors')::int, 0, 'so nothing is collapsed');

  PERFORM test.assert_money(
    (SELECT SUM(amount) FROM public.settlements
      WHERE bundle_id = bundle AND to_user_id = bob AND is_deleted IS FALSE), b_before,
    'Bob still has exactly his 30 — not the whole 100');
  PERFORM test.assert_money(
    (SELECT SUM(amount) FROM public.settlements
      WHERE bundle_id = bundle AND to_user_id = cha AND is_deleted IS FALSE), c_before,
    'and Cha''s 70 was not transferred to Bob');
  PERFORM test.note('068: a multi-recipient bundle is refused, not summed onto one recipient');
END;
$$;

DO $$
DECLARE
  alice uuid; bob uuid; g uuid; bundle uuid; res jsonb;
BEGIN
  alice  := test.new_account('c68x-alice@example.com', 'Alice');
  bob    := test.new_account('c68x-bob@example.com',   'Bob');
  g      := test.new_group(alice, 'Split bundle', 'PHP');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob,   'Bob');
  bundle := gen_random_uuid();

  -- One bundle straddling the personal and group ledgers. The group leg is excluded from
  -- collapsing by design, so collapsing the personal half alone would leave it incoherent.
  INSERT INTO public.settlements
    (id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (gen_random_uuid(), NULL, NULL, bundle, bob, alice, 40, 'PHP', true,
     'Applied general credit to bills', now(), now(), now(), false, 'test'),
    (gen_random_uuid(), g,    NULL, bundle, bob, alice, 60, 'PHP', true,
     'Applied general credit to group balance', now(), now(), now(), false, 'test');

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res -> 'skipped_families' ->> 'bundle_spans_group_rows')::int, 1,
    'a bundle straddling the personal and group ledgers is refused');
  PERFORM test.assert_eq((res ->> 'survivors')::int, 0, 'nothing collapsed');
  -- The group leg is still relabelled: that half is never collapsed, only reworded.
  PERFORM test.assert_eq((res ->> 'relabeled')::int, 1, 'but the group leg still loses its label');
  PERFORM test.note('068: a bundle spanning both ledgers is refused');
END;
$$;

DO $$
DECLARE
  alice uuid; bob uuid; bundle uuid; a uuid; b uuid; res jsonb;
BEGIN
  alice  := test.new_account('c68w-alice@example.com', 'Alice');
  bob    := test.new_account('c68w-bob@example.com',   'Bob');
  bundle := gen_random_uuid();
  a := gen_random_uuid();
  b := gen_random_uuid();

  -- Offsets that DO cancel, but with no real leg behind them: collapsing would delete the whole
  -- payment from history. Balance-neutral, but not a repair.
  INSERT INTO public.settlements
    (id, group_id, bill_id, bundle_id, from_user_id, to_user_id, amount, currency,
     is_settled, label, created_at, updated_at, synced_at, is_deleted, device_id)
  VALUES
    (a, NULL, NULL, bundle, bob, alice, 50, 'PHP', true,
     'Settled by offset against bills Alice paid', now(), now(), now(), false, 'test'),
    (b, NULL, NULL, bundle, alice, bob, 50, 'PHP', true,
     'Settled by offset — covers what Bob owed you', now(), now(), now(), false, 'test');

  res := public.kwenta_collapse_legacy_credit_settlements(false);
  PERFORM test.assert_eq((res -> 'skipped_families' ->> 'offset_only_family')::int, 1,
    'a family of nothing but offsets is refused');
  PERFORM test.assert_eq((res ->> 'offsets_removed')::int, 0, 'so the payment does not vanish');
  PERFORM test.assert_false((SELECT is_deleted FROM public.settlements WHERE id = a),
    'both legs stay live');
  PERFORM test.note('068: an offset-only family is refused rather than erased');
END;
$$;
