-- Migration 068: collapse the settlement rows two REMOVED features left behind.
--
-- WHAT BROKE. "Apply general credit" and "pay from available credit" (removed 2026-07-11 with the
-- person-debt overhaul; see the 052 header for why there is no "credit" concept any more) did not
-- write one settlement per payment. They wrote one row PER BILL the credit was applied to, and in
-- the bundled case a pair of mutual "offset" legs that cancel each other out. Production holds 72
-- live rows that are really 14 payments -- one 2,136.07 payment is stored as 25 rows.
--
-- The BALANCES were never wrong: every money endpoint sums the rows, and the split was
-- conservative (each family's rows sum to the original amount). What is wrong is the HISTORY. 064
-- renders 72 entries, most tagged to bills the payer never chose, half of them bookkeeping
-- artefacts that mean nothing to a human.
--
-- The exact label inventory at the time of writing -- LIKE over free text is brittle, and this
-- header is the canonical record (rule 3):
--     Applied general credit to bills                              15
--     Applied general credit to bills (from PHP1,154 credit)        1
--     Applied general credit to bills (from PHP3,911.25 credit)     5
--     Applied general credit to bills (from PHP500 credit)          3
--     Applied general credit to group balance                       1
--     Applied general credit to group balance (from ... credit)     4   -- four distinct amounts
--     Paid from <name>'s available credit                          17   -- four counterparties
--     Settled by offset against bills <name> paid                  19
--     Settled by offset -- covers what <name> owed you              7
--                                                                  --
--                                                                  72
--
-- WHAT THIS DOES, per family (one real payment):
--   1. soft-delete the mutual "Settled by offset" legs -- they net to zero by construction, so
--      removing them cannot move a balance;
--   2. keep the OLDEST remaining row and give it the family's TOTAL, with bill_id and label
--      cleared; parties, currency, created_at, group_id, bundle_id and is_settled untouched;
--   3. soft-delete the rest.
-- Rows carrying a group_id are NOT collapsed -- only their label is blanked. A group ledger is
-- shared, and rewriting shared rows from a sweep no other member asked for is not a repair.
--
-- THE ONE NUMBER THAT CHANGES. kwenta_bill_pairwise (060) sums settlements by bill_id into its
-- settlement_delta, so clearing bill_id changes the per-counterparty amounts inside
-- kwenta_bill_detail for the 52 personal bills that carry a legacy leg: a counterparty currently
-- shown as square shows their real unpaid share again. This is intended. Those slices were a
-- fiction -- ONE payment chopped across bills arbitrarily -- and the person-level tab is the
-- documented source of truth (see 060's own header on squareOverall). Nothing else moves:
-- kwenta_person_summary, kwenta_group_detail, kwenta_group_pool_net, kwenta_person_statement,
-- kwenta_balances_overview and kwenta_bill_settled / kwenta_bills_settled_map are all
-- person-level and never read bill_id. Pinned both ways in 068's test.
--
-- WHY bundle_id SURVIVES ON THE SURVIVOR. 064 keys isBundled on recipient_count > 1, so a
-- one-leg bundle already renders as a plain payment. Nulling it would instead break
-- recordedByUserId, which finds the activity_log row by COALESCE(bundle_id, id) -- "Added by
-- Alice" would silently become nothing.
--
-- WHY THE CLASSIFIER IS A SEPARATE FUNCTION. Same reason as 048: the dry run and the apply must
-- not be able to disagree about what would change.
--
-- WHY updated_at IS STAMPED FORWARD. kwenta_server_wins_updated_at_guard (021b) is a BEFORE
-- UPDATE trigger returning OLD whenever OLD.updated_at > NEW.updated_at. A bare now() against a
-- row written by a fast-clocked device would be silently discarded while this function still
-- counted it as repaired -- success reported on every run, bad row still there.
--
-- IDEMPOTENCE, and the coincidence it rests on. The label IS the scope selector, and every row a
-- processed family touches either loses its label or is soft-deleted, so a second run finds
-- nothing. Leaving a survivor's label as anything non-blank would silently make a re-run DOUBLE
-- its amount. Pinned by the idempotency block in the test.
--
-- APPLY AFTER 067. Safe to apply before the client ships -- it changes data, not shape.

-- ---------------------------------------------------------------------------------------------
-- Snapshot of every row the sweep modifies, taken before it is modified.
--
-- row_data is the whole row as jsonb rather than a mirrored column list: a mirrored list silently
-- stops capturing the next column someone adds to settlements, and a backup missing a column is
-- not a backup. jsonb_populate_record turns it back into a row.
--
-- Supabase runs ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated in
-- public, and PostgREST exposes anything there. Without the REVOKEs below this table -- which
-- holds other people's settlements verbatim -- would be world-readable to every signed-in user.
-- RLS with no policies is the second lock; the SECURITY DEFINER writer runs as the owner and is
-- unaffected (the table is not FORCE ROW LEVEL SECURITY). The harness shim does NOT emulate
-- Supabase's default privileges, so a green `npm run test:sql` does not prove this -- check it on
-- a branch database (rule 11).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kwenta_legacy_credit_repair_backup (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         uuid        NOT NULL,
  swept_at       timestamptz NOT NULL DEFAULT now(),
  settlement_id  uuid        NOT NULL,
  family_key     text        NOT NULL,
  planned_action text        NOT NULL,
  new_amount     numeric,
  row_data       jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS kwenta_legacy_credit_repair_backup_run_idx
  ON public.kwenta_legacy_credit_repair_backup (run_id, settlement_id);

ALTER TABLE public.kwenta_legacy_credit_repair_backup ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kwenta_legacy_credit_repair_backup FROM PUBLIC;
REVOKE ALL ON TABLE public.kwenta_legacy_credit_repair_backup FROM anon;
REVOKE ALL ON TABLE public.kwenta_legacy_credit_repair_backup FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.kwenta_legacy_credit_repair_backup TO service_role;


-- ---------------------------------------------------------------------------------------------
-- The classifier. One row per in-scope settlement with the action to take.
--
-- FAMILY KEY. A bundle IS a family. Without one, the family is
-- (second-truncated updated_at, from, to, currency): the legs of one legacy payment were written
-- in a single transaction and therefore share updated_at exactly, and the truncation absorbs a
-- row a later push re-stamped by a few hundred microseconds. A leg that drifted past the second
-- boundary becomes its own family, which is harmless -- a lone credit leg collapses into itself,
-- and a lone offset leg fails the net-to-zero guard and is skipped.
--
-- THE GUARDS. Each refuses a WHOLE family rather than guessing, because each describes a shape
-- where collapsing would MOVE MONEY between people. None can fire on the data this was written
-- for; they exist because this is a service_role function against a live database.
--   offsets_do_not_net_to_zero  the legs are not a cancelling pair, so deleting them is a real
--                               deletion. Netting is per UNORDERED pair: from/to are already in
--                               the non-bundled family key, so netting per direction could never
--                               pass. For a non-bundled family this correctly degrades to "any
--                               non-zero offset leg skips".
--   mixed_parties_currency_or_settled_state
--                               the survivor keeps ITS OWN parties, so a bundle paying B 30 and
--                               C 70 would become "paid B 100" and move 70 from C to B. Folding
--                               an unsettled row into a settled survivor mints money, because
--                               every money function filters is_settled.
--   offset_only_family          nothing would survive; the payment would vanish from history.
--                               Balance-neutral, but not a repair.
--   bundle_spans_group_rows     half the bundle is excluded from collapsing (group rows), so
--                               collapsing the other half leaves it incoherent.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_collapse_legacy_credit_plan()
RETURNS TABLE (
  family_key    text,
  settlement_id uuid,
  action        text,
  new_amount    numeric,
  skip_reason   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scope AS (
    SELECT s.id, s.group_id, s.bundle_id, s.from_user_id, s.to_user_id,
           s.amount, s.currency, s.is_settled, s.created_at, s.updated_at, s.label
    FROM public.settlements s
    WHERE s.is_deleted IS FALSE
      AND (   s.label LIKE 'Applied general credit%'
           OR s.label LIKE 'Paid from%available credit'
           OR s.label LIKE 'Settled by offset%')
  ),
  tagged AS (
    SELECT sc.*,
           (sc.label LIKE 'Settled by offset%') AS is_offset,
           CASE
             WHEN sc.bundle_id IS NOT NULL THEN 'bundle:' || sc.bundle_id::text
             ELSE 'pair:'
                  || EXTRACT(EPOCH FROM date_trunc('second', sc.updated_at))::bigint::text
                  || '|' || sc.from_user_id::text
                  || '|' || sc.to_user_id::text
                  || '|' || sc.currency
           END AS fkey
    FROM scope sc
  ),
  relabel_rows AS (SELECT * FROM tagged WHERE group_id IS NOT NULL),
  fam          AS (SELECT * FROM tagged WHERE group_id IS NULL),

  offset_nets AS (
    SELECT f.fkey,
           SUM(CASE WHEN f.from_user_id < f.to_user_id THEN f.amount ELSE -f.amount END) AS net
    FROM fam f
    WHERE f.is_offset
    GROUP BY f.fkey,
             LEAST(f.from_user_id, f.to_user_id),
             GREATEST(f.from_user_id, f.to_user_id),
             f.currency
  ),
  bad_offsets AS (
    SELECT DISTINCT n.fkey FROM offset_nets n WHERE ROUND(n.net, 2) <> 0
  ),
  bad_keepers AS (
    SELECT f.fkey
    FROM fam f
    WHERE NOT f.is_offset
    GROUP BY f.fkey
    HAVING COUNT(DISTINCT f.from_user_id::text || '|' || f.to_user_id::text || '|'
                          || f.currency || '|' || f.is_settled::text) > 1
  ),
  offset_only AS (
    SELECT f.fkey FROM fam f GROUP BY f.fkey
    HAVING COUNT(*) FILTER (WHERE NOT f.is_offset) = 0
  ),
  split_bundle AS (
    SELECT DISTINCT f.fkey
    FROM fam f
    JOIN relabel_rows r ON r.bundle_id = f.bundle_id
    WHERE f.bundle_id IS NOT NULL
  ),
  skip_keys AS (
    SELECT b.fkey, MIN(b.reason) AS reason
    FROM (
      SELECT fkey, 'offsets_do_not_net_to_zero'::text                AS reason FROM bad_offsets
      UNION ALL SELECT fkey, 'mixed_parties_currency_or_settled_state' FROM bad_keepers
      UNION ALL SELECT fkey, 'offset_only_family'                     FROM offset_only
      UNION ALL SELECT fkey, 'bundle_spans_group_rows'                FROM split_bundle
    ) b
    GROUP BY b.fkey
  ),
  eligible AS (
    SELECT f.* FROM fam f WHERE f.fkey NOT IN (SELECT sk.fkey FROM skip_keys sk)
  ),
  totals AS (
    SELECT e.fkey, public.kwenta_round_money(SUM(e.amount)) AS total
    FROM eligible e WHERE NOT e.is_offset GROUP BY e.fkey
  ),
  ranked AS (
    SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.fkey ORDER BY e.created_at, e.id) AS rn
    FROM eligible e WHERE NOT e.is_offset
  )
  SELECT r.fkey, r.id, 'survivor'::text, t.total, NULL::text
  FROM ranked r JOIN totals t ON t.fkey = r.fkey WHERE r.rn = 1
  UNION ALL
  SELECT r.fkey, r.id, 'absorb'::text, NULL::numeric, NULL::text
  FROM ranked r WHERE r.rn > 1
  UNION ALL
  SELECT e.fkey, e.id, 'offset'::text, NULL::numeric, NULL::text
  FROM eligible e WHERE e.is_offset
  UNION ALL
  SELECT f.fkey, f.id, 'skip'::text, NULL::numeric, sk.reason
  FROM fam f JOIN skip_keys sk ON sk.fkey = f.fkey
  UNION ALL
  SELECT rl.fkey, rl.id, 'relabel'::text, NULL::numeric, NULL::text
  FROM relabel_rows rl;
$$;

-- A global sweep with no viewer scoping: rule 5 puts it out of authenticated's reach. 065's
-- generic grant sweep only catches functions taking a viewer ARGUMENT, so it cannot see this one
-- -- 068's test asserts these grants explicitly instead.
REVOKE ALL ON FUNCTION public.kwenta_collapse_legacy_credit_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_collapse_legacy_credit_plan() TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Apply (or, with p_dry_run, report). Returns counts.
--
-- The POST-CONDITION is the point of this function. Before and after the UPDATEs it computes the
-- signed money between each unordered pair of parties, over exactly the rows it touched, counting
-- only live settled ones. If the two disagree by a cent the whole transaction aborts. Every guard
-- above is an attempt to PREDICT a shape that would move money; this is the check that does not
-- have to predict.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kwenta_collapse_legacy_credit_settlements(
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id        uuid := gen_random_uuid();
  v_plan          jsonb;
  v_survivor_ids  uuid[];
  v_survivor_amts numeric[];
  v_absorb_ids    uuid[];
  v_offset_ids    uuid[];
  v_relabel_ids   uuid[];
  v_skip_ids      uuid[];
  v_families      integer;
  v_skip_families jsonb;
  v_touched       uuid[];
  v_before        jsonb;
  v_after         jsonb;
  v_method_moved  integer := 0;
BEGIN
  -- Materialised ONCE. The non-bundled family key reads updated_at, which the UPDATEs below
  -- rewrite; a classifier re-evaluated after them would see different families.
  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
  INTO v_plan
  FROM public.kwenta_collapse_legacy_credit_plan() p;

  SELECT
    COALESCE(array_agg(p.settlement_id ORDER BY p.settlement_id)
               FILTER (WHERE p.action = 'survivor'), '{}'),
    COALESCE(array_agg(p.new_amount    ORDER BY p.settlement_id)
               FILTER (WHERE p.action = 'survivor'), '{}'),
    COALESCE(array_agg(p.settlement_id) FILTER (WHERE p.action = 'absorb'),  '{}'),
    COALESCE(array_agg(p.settlement_id) FILTER (WHERE p.action = 'offset'),  '{}'),
    COALESCE(array_agg(p.settlement_id) FILTER (WHERE p.action = 'relabel'), '{}'),
    COALESCE(array_agg(p.settlement_id) FILTER (WHERE p.action = 'skip'),    '{}'),
    COUNT(DISTINCT p.family_key)        FILTER (WHERE p.action = 'survivor')
  INTO v_survivor_ids, v_survivor_amts, v_absorb_ids, v_offset_ids,
       v_relabel_ids, v_skip_ids, v_families
  FROM jsonb_to_recordset(v_plan)
    AS p(family_key text, settlement_id uuid, action text, new_amount numeric, skip_reason text);

  SELECT COALESCE(jsonb_object_agg(r.reason, r.n), '{}'::jsonb)
  INTO v_skip_families
  FROM (
    SELECT p.skip_reason AS reason, COUNT(DISTINCT p.family_key) AS n
    FROM jsonb_to_recordset(v_plan)
      AS p(family_key text, settlement_id uuid, action text, new_amount numeric, skip_reason text)
    WHERE p.action = 'skip'
    GROUP BY p.skip_reason
  ) r;

  v_touched := v_survivor_ids || v_absorb_ids || v_offset_ids || v_relabel_ids;

  SELECT COALESCE(jsonb_object_agg(t.k, t.v), '{}'::jsonb) INTO v_before FROM (
    SELECT LEAST(s.from_user_id, s.to_user_id)::text || '|'
           || GREATEST(s.from_user_id, s.to_user_id)::text || '|'
           || s.currency AS k,
           ROUND(SUM(CASE WHEN s.from_user_id < s.to_user_id
                          THEN s.amount ELSE -s.amount END), 2)::text AS v
    FROM public.settlements s
    WHERE s.id = ANY (v_touched) AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
    GROUP BY 1
  ) t;

  IF NOT p_dry_run THEN
    INSERT INTO public.kwenta_legacy_credit_repair_backup
      (run_id, swept_at, settlement_id, family_key, planned_action, new_amount, row_data)
    SELECT v_run_id, now(), s.id, p.family_key, p.action, p.new_amount, to_jsonb(s)
    FROM jsonb_to_recordset(v_plan)
      AS p(family_key text, settlement_id uuid, action text, new_amount numeric, skip_reason text)
    JOIN public.settlements s ON s.id = p.settlement_id
    WHERE p.action <> 'skip';

    UPDATE public.settlements s
    SET is_deleted = TRUE,
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    WHERE s.id = ANY (v_offset_ids);

    UPDATE public.settlements s
    SET is_deleted = TRUE,
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    WHERE s.id = ANY (v_absorb_ids);

    -- Group rows keep their money AND their bill tag; only the dead feature's wording goes.
    UPDATE public.settlements s
    SET label      = '',
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    WHERE s.id = ANY (v_relabel_ids);

    UPDATE public.settlements s
    SET amount     = u.new_amount,
        bill_id    = NULL,
        label      = '',
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    FROM unnest(v_survivor_ids, v_survivor_amts) AS u(id, new_amount)
    WHERE s.id = u.id;

    SELECT COALESCE(jsonb_object_agg(t.k, t.v), '{}'::jsonb) INTO v_after FROM (
      SELECT LEAST(s.from_user_id, s.to_user_id)::text || '|'
             || GREATEST(s.from_user_id, s.to_user_id)::text || '|'
             || s.currency AS k,
             ROUND(SUM(CASE WHEN s.from_user_id < s.to_user_id
                            THEN s.amount ELSE -s.amount END), 2)::text AS v
      FROM public.settlements s
      WHERE s.id = ANY (v_touched) AND s.is_deleted IS FALSE AND s.is_settled IS TRUE
      GROUP BY 1
    ) t;

    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION
        'kwenta_collapse_legacy_credit_settlements would move money (run %); before=% after=%',
        v_run_id, v_before, v_after;
    END IF;

    -- Unrelated to the collapse, same cleanup pass: the method field was write-only until 069, so
    -- users typed the method into the LABEL instead (GCash x6, GoTyme x6, BDO x3, Cash x2). Move
    -- the unambiguous ones into the column they belong in. EXACT case-insensitive matches only --
    -- 'Gcash 6/4', 'CashG' and 'Bank Transfer' are someone's notes, not an enum, and are left
    -- alone. `method IS NULL` keeps this idempotent and stops it overwriting a real method.
    -- Balance-neutral: label is read only by 064, method by nothing before 069.
    WITH moved AS (
      UPDATE public.settlements s
      SET method     = BTRIM(s.label),
          label      = '',
          updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
          synced_at  = NULL
      WHERE s.is_deleted IS FALSE
        AND s.method IS NULL
        AND LOWER(BTRIM(s.label)) IN ('cash', 'gcash', 'gotyme', 'bdo')
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_method_moved FROM moved;
  END IF;

  RETURN jsonb_build_object(
    'dry_run',          p_dry_run,
    'run_id',           CASE WHEN p_dry_run THEN NULL ELSE v_run_id END,
    'families',         v_families,
    'survivors',        cardinality(v_survivor_ids),
    'absorbed',         cardinality(v_absorb_ids),
    'offsets_removed',  cardinality(v_offset_ids),
    'relabeled',        cardinality(v_relabel_ids),
    'skipped',          cardinality(v_skip_ids),
    'skipped_families', v_skip_families,
    'method_moved',     v_method_moved,
    'rows_touched',     cardinality(v_touched)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_collapse_legacy_credit_settlements(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_collapse_legacy_credit_settlements(boolean) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Run it. A skip is the SAFE outcome, so it is reported loudly but does not abort the migration;
-- a money-moving plan aborts inside the function itself.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v jsonb;
BEGIN
  v := public.kwenta_collapse_legacy_credit_settlements(false);
  RAISE NOTICE '068 collapse_legacy_credit_settlements: %', v;
  IF (v ->> 'skipped')::int > 0 THEN
    RAISE WARNING '068 left % row(s) uncollapsed: %', v ->> 'skipped', v -> 'skipped_families';
  END IF;
END;
$$;
