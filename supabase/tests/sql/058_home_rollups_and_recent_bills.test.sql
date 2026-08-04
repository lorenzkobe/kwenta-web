-- Migration 058: the Home page's group bucket and its recent-bills list.
--
-- The load-bearing claim is the one in the migration header: the group bucket is NOT
-- `combined - personal`. The third block below is the case that separates them, and it is the
-- reason this bucket had to be ported rather than derived on the client.

SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- The group bucket sums per-member nets, in the group's own currency
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; carol uuid; g uuid; o jsonb;
BEGIN
  alice := test.new_account('hr-alice@example.com', 'Alice');
  bob   := test.new_account('hr-bob@example.com', 'Bob');
  carol := test.new_account('hr-carol@example.com', 'Carol');

  g := test.new_group(alice, 'Trip');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, carol, 'Carol');

  -- Alice fronts 300 split three ways: Bob and Carol owe her 100 each.
  PERFORM test.new_bill(alice, alice, g, 'Hotel', 300, ARRAY[alice, bob, carol]);

  PERFORM test.as_user(alice);
  o := public.kwenta_balances_overview();

  PERFORM test.assert_money((o -> 'groupReceive' ->> 'PHP')::numeric, 200,
    'both members'' debts land in one group receive bucket');
  PERFORM test.assert_eq(o -> 'groupPay', '{}'::jsonb,
    'nothing owed outward, so the pay bucket stays empty');

  PERFORM test.as_owner();
  PERFORM test.note('group bucket: per-member nets sum into the group currency');
END;
$$;

-- ---------------------------------------------------------------------------
-- A settled group contributes nothing; a second currency buckets separately
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g1 uuid; g2 uuid; o jsonb;
BEGIN
  alice := test.new_account('hr2-alice@example.com', 'Alice');
  bob   := test.new_account('hr2-bob@example.com', 'Bob');

  -- Group 1 (PHP): Alice fronts 100, Bob pays her back in full -> net 0.
  g1 := test.new_group(alice, 'Settled', 'PHP');
  PERFORM test.add_member(g1, alice, 'Alice');
  PERFORM test.add_member(g1, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g1, 'Lunch', 100, ARRAY[alice, bob]);
  PERFORM test.new_settlement(bob, alice, 50, g1, NULL, 'PHP');

  -- Group 2 (USD): Bob fronts 80, so Alice owes 40.
  g2 := test.new_group(alice, 'Abroad', 'USD');
  PERFORM test.add_member(g2, alice, 'Alice');
  PERFORM test.add_member(g2, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g2, 'Taxi', 80, ARRAY[alice, bob], 'USD');

  PERFORM test.as_user(alice);
  o := public.kwenta_balances_overview();

  PERFORM test.assert_eq(o -> 'groupReceive' ? 'PHP', false,
    'a fully settled group is not a receive line');
  PERFORM test.assert_money((o -> 'groupPay' ->> 'USD')::numeric, 40,
    'the USD group buckets in its own currency');
  PERFORM test.assert_eq(o -> 'groupPay' ? 'PHP', false,
    'currencies are never merged — Kwenta has no FX');

  PERFORM test.as_owner();
  PERFORM test.note('group bucket: settled groups drop out, currencies stay separate');
END;
$$;

-- ---------------------------------------------------------------------------
-- THE CASE THE MIGRATION EXISTS FOR: group /= combined - personal
--
-- Bob owes Alice 50 personally and Alice owes Bob 30 in a group. The combined bucket nets them
-- to a single +20 receive. Subtracting personal from combined would report a group PAY of 30
-- only by accident of these numbers — flip the sizes and it reports a negative receive. The
-- group bucket is its own quantity, computed per group.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; o jsonb;
BEGIN
  alice := test.new_account('hr3-alice@example.com', 'Alice');
  bob   := test.new_account('hr3-bob@example.com', 'Bob');

  -- Personal: Alice fronts 100 for the two of them -> Bob owes her 50.
  PERFORM test.new_bill(alice, alice, NULL, 'Dinner', 100, ARRAY[alice, bob]);

  -- Group: Bob fronts 60 for the two of them -> Alice owes him 30.
  g := test.new_group(alice, 'Flat');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(bob, bob, g, 'Wifi', 60, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  o := public.kwenta_balances_overview();

  PERFORM test.assert_money((o -> 'personalReceive' ->> 'PHP')::numeric, 50,
    'personal bucket is unnetted against the group');
  PERFORM test.assert_money((o -> 'combinedReceive' ->> 'PHP')::numeric, 20,
    'combined nets the person to a single side before bucketing');
  PERFORM test.assert_eq(o -> 'combinedPay' ? 'PHP', false,
    'one person cannot appear on both combined sides');
  PERFORM test.assert_money((o -> 'groupPay' ->> 'PHP')::numeric, 30,
    'the group bucket reports the group debt in full');
  PERFORM test.assert_eq(o -> 'groupReceive' ? 'PHP', false,
    'the personal credit does not leak into the group bucket');

  PERFORM test.as_owner();
  PERFORM test.note('group bucket is independent of the combined bucket');
END;
$$;

-- ---------------------------------------------------------------------------
-- Membership scoping: exact viewer id, active memberships only
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; o jsonb;
BEGIN
  alice := test.new_account('hr4-alice@example.com', 'Alice');
  bob   := test.new_account('hr4-bob@example.com', 'Bob');

  g := test.new_group(bob, 'Old flat');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.new_bill(bob, bob, g, 'Rent', 200, ARRAY[alice, bob]);

  PERFORM test.as_user(alice);
  PERFORM test.assert_money((public.kwenta_balances_overview() -> 'groupPay' ->> 'PHP')::numeric, 100,
    'while a member, the debt is bucketed');
  PERFORM test.as_owner();

  -- Alice leaves. Her membership row is soft-deleted; the group ledger still holds the history,
  -- but it is no longer one of HER groups.
  UPDATE public.group_members SET is_deleted = true
  WHERE group_id = g AND user_id = alice;

  PERFORM test.as_user(alice);
  o := public.kwenta_balances_overview();
  PERFORM test.assert_eq(o -> 'groupPay', '{}'::jsonb,
    'a group the viewer has left is not rolled up');

  PERFORM test.as_owner();
  PERFORM test.note('group bucket: only the viewer''s active memberships');
END;
$$;

-- ---------------------------------------------------------------------------
-- A deleted group drops out entirely
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid;
BEGIN
  alice := test.new_account('hr5-alice@example.com', 'Alice');
  bob   := test.new_account('hr5-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Gone');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');
  PERFORM test.new_bill(alice, alice, g, 'Thing', 100, ARRAY[alice, bob]);

  UPDATE public.groups SET is_deleted = true WHERE id = g;

  PERFORM test.as_user(alice);
  PERFORM test.assert_eq(public.kwenta_balances_overview() -> 'groupReceive', '{}'::jsonb,
    'a soft-deleted group contributes nothing');

  PERFORM test.as_owner();
  PERFORM test.note('group bucket: deleted groups drop out');
END;
$$;

-- ---------------------------------------------------------------------------
-- An unauthenticated caller is refused rather than answered with an empty rollup
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.kwenta_balances_overview();
  EXCEPTION WHEN OTHERS THEN
    ok := true;
  END;
  PERFORM test.assert_true(ok, 'no auth.uid() raises instead of returning zeros');
  PERFORM test.note('overview refuses an unauthenticated caller');
END;
$$;

-- ---------------------------------------------------------------------------
-- kwenta_recent_bills
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  alice uuid; bob uuid; g uuid; b1 uuid; b2 uuid; b3 uuid; b4 uuid; rows jsonb;
BEGIN
  alice := test.new_account('rb-alice@example.com', 'Alice');
  bob   := test.new_account('rb-bob@example.com', 'Bob');

  g := test.new_group(alice, 'Squad');
  PERFORM test.add_member(g, alice, 'Alice');
  PERFORM test.add_member(g, bob, 'Bob');

  b1 := test.new_bill(alice, alice, NULL, 'Oldest', 10, ARRAY[alice, bob]);
  b2 := test.new_bill(alice, alice, g,    'Middle', 20, ARRAY[alice, bob]);
  b3 := test.new_bill(alice, alice, NULL, 'Newest', 30, ARRAY[alice, bob]);
  -- Bob paid this one. It is Alice's bill to see, but not one SHE paid.
  b4 := test.new_bill(bob, bob, g, 'Bob paid', 40, ARRAY[alice, bob]);

  -- now() is frozen inside a transaction, so ordering needs explicit timestamps.
  UPDATE public.bills SET created_at = now() - interval '3 days' WHERE id = b1;
  UPDATE public.bills SET created_at = now() - interval '2 days' WHERE id = b2;
  UPDATE public.bills SET created_at = now() - interval '1 day'  WHERE id = b3;
  UPDATE public.bills SET created_at = now()                     WHERE id = b4;

  PERFORM test.as_user(alice);
  rows := public.kwenta_recent_bills(10);

  PERFORM test.assert_eq(jsonb_array_length(rows), 3,
    'only bills the viewer paid — Bob''s is excluded even though she can read it');
  PERFORM test.assert_eq(rows -> 0 ->> 'title', 'Newest', 'newest first');
  PERFORM test.assert_eq(rows -> 2 ->> 'title', 'Oldest', 'oldest last');
  PERFORM test.assert_eq(rows -> 1 ->> 'groupName', 'Squad',
    'a group bill carries its group name');
  PERFORM test.assert_eq(rows -> 0 -> 'groupName', 'null'::jsonb,
    'a personal bill has no group name');
  PERFORM test.assert_money((rows -> 0 ->> 'amount')::numeric, 30, 'amount round-trips');

  -- The limit is a limit, and it keeps the NEWEST rows.
  rows := public.kwenta_recent_bills(2);
  PERFORM test.assert_eq(jsonb_array_length(rows), 2, 'p_limit caps the list');
  PERFORM test.assert_eq(rows -> 0 ->> 'title', 'Newest', 'the cap keeps the newest, not the first found');

  PERFORM test.as_owner();
  UPDATE public.bills SET is_deleted = true WHERE id = b3;

  PERFORM test.as_user(alice);
  rows := public.kwenta_recent_bills(10);
  PERFORM test.assert_eq(jsonb_array_length(rows), 2, 'a deleted bill leaves the list');
  PERFORM test.assert_eq(rows -> 0 ->> 'title', 'Middle', 'the next newest takes its place');

  PERFORM test.as_owner();
  PERFORM test.note('recent_bills: viewer-paid, newest first, capped, deletions honoured');
END;
$$;

-- Another account's bills never appear, even with a generous limit.
DO $$
DECLARE
  alice uuid; carol uuid; rows jsonb;
BEGIN
  alice := test.new_account('rb2-alice@example.com', 'Alice');
  carol := test.new_account('rb2-carol@example.com', 'Carol');

  PERFORM test.new_bill(carol, carol, NULL, 'Carol only', 99, ARRAY[carol]);

  PERFORM test.as_user(alice);
  rows := public.kwenta_recent_bills(100);
  PERFORM test.assert_eq(rows, '[]'::jsonb,
    'a stranger''s bills are not in the caller''s list');

  PERFORM test.as_owner();
  PERFORM test.note('recent_bills is caller-scoped');
END;
$$;
