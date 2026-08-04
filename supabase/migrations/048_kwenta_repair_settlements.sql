-- Migration 048: settlement repair becomes SERVER-AUTHORITATIVE.
--
-- Supersedes the client-side plan/apply in src/lib/kwenta-data-repair.ts, which decided what to
-- soft-delete from a cache that is incomplete BY DESIGN: kwenta_build_pull_bundle only ever sends
-- a device its own profile plus its own local contacts, so a counterparty's account profile is
-- invisible there. A personal payment between two accounts with no shared group therefore looked
-- like it referenced a non-existent person, and the client soft-deleted it and pushed that
-- deletion — the payment vanished for BOTH sides and balances jumped back up. A device cannot
-- judge existence; only the server can, so the decision moves here.
--
-- Same three classes as before, all conservative — a real money movement is never removed:
--   orphan        -- references a bill/group that is gone or soft-deleted, or a party whose
--                    CANONICAL id has no live profile row ANYWHERE (true absence, not "absent
--                    from my cache")
--   duplicate     -- byte-identical to another row across every distinguishing field, keyed on
--                    CANONICAL parties; the earliest is kept
--   non-canonical -- party id points at a local contact that has a linked account, or (in a
--                    group) is not the roster id; rewritten so RLS, sync and balance matching
--                    agree
--
-- Classification lives in ONE place — kwenta_repair_settlement_plan — so the dry run and the
-- apply can never disagree about what would change.

-- ---------------------------------------------------------------------------------------------
-- Identity: every profile id that represents an account (the account itself plus local contacts
-- linked to it). Used by the repair scope here and by delivery in migration 049; both must agree,
-- otherwise the repair cannot reach rows the pull hands out (a user pulls a settlement filed under
-- a contact linked to them, presses "Repair my data", and is told their data is clean).
-- ---------------------------------------------------------------------------------------------

-- linked_profile_id is on the read path for every pull and every repair; make the lookup indexed.
CREATE INDEX IF NOT EXISTS profiles_linked_profile_id_idx
  ON public.profiles (linked_profile_id)
  WHERE linked_profile_id IS NOT NULL;

/**
 * Mirrors kwenta_canonical_user_id in reverse (that maps contact -> account; this maps
 * account -> {account, contacts}).
 */
CREATE OR REPLACE FUNCTION public.kwenta_identity_ids(p_uid uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid
  UNION
  SELECT p.id
  FROM public.profiles p
  WHERE p.is_local IS TRUE
    AND p.linked_profile_id = p_uid
    AND p.is_deleted IS FALSE;
$$;

-- Not granted to `authenticated`: it takes an arbitrary uid, so a direct caller could enumerate
-- which contact profiles are linked to another account. Every caller is SECURITY DEFINER and
-- therefore executes as the owner, which does not need the grant.
REVOKE ALL ON FUNCTION public.kwenta_identity_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_identity_ids(uuid) TO service_role;

/**
 * Canonical id for a settlement party, server-side equivalent of the client's
 * resolveGroupMemberUserId (src/db/operations.ts). kwenta_canonical_user_id alone only follows
 * linked_profile_id; in a group the id that balance matching and settle-up use is the ROSTER id,
 * which may differ. Without this, a group settlement filed under a non-roster id is unrepairable:
 * balances keep showing "Unknown" and optimizeSettlements keeps proposing a transfer already paid.
 *
 * Resolution order matches the client:
 *   1/2. the linked-account id when it is already on the roster (or there is no group)
 *   3.   a roster member whose profile is linked to this id
 *   4.   a roster member with the same email
 *   5.   otherwise the linked-account id unchanged
 */
CREATE OR REPLACE FUNCTION public.kwenta_settlement_party_id(p_id uuid, p_group_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH linked AS (
    SELECT public.kwenta_canonical_user_id(p_id) AS id
  ), roster AS (
    SELECT gm.user_id
    FROM public.group_members gm
    WHERE p_group_id IS NOT NULL
      AND gm.group_id = p_group_id
      AND gm.is_deleted IS FALSE
  )
  SELECT COALESCE(
    (SELECT l.id FROM linked l
      WHERE p_group_id IS NULL
         OR EXISTS (SELECT 1 FROM roster r WHERE r.user_id = l.id)),
    (SELECT r.user_id FROM roster r
       JOIN public.profiles mp ON mp.id = r.user_id
      WHERE mp.is_deleted IS FALSE
        AND mp.linked_profile_id = p_id
      LIMIT 1),
    (SELECT r.user_id FROM roster r
       JOIN public.profiles mp ON mp.id = r.user_id
       JOIN public.profiles src ON src.id = p_id
      WHERE mp.is_deleted IS FALSE
        AND COALESCE(btrim(src.email), '') <> ''
        AND lower(btrim(mp.email)) = lower(btrim(src.email))
      LIMIT 1),
    (SELECT l.id FROM linked l)
  );
$$;

REVOKE ALL ON FUNCTION public.kwenta_settlement_party_id(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_settlement_party_id(uuid, uuid) TO service_role;

/**
 * What a repair would change for p_uid, one row per settlement with the action to take.
 *
 * Single source of truth for both the dry run and the apply. The chain is sequential: orphans drop
 * out first, duplicates are ranked over the survivors, and only the rows that survive both are
 * considered for canonicalization — so the three sets are disjoint and the counts are exact.
 *
 * Ordering note: orphan detection resolves each party through kwenta_settlement_party_id BEFORE
 * asking whether a live profile exists. Judging the literal id instead soft-deletes a real payment
 * whenever it is filed under a local contact that was deleted from the owner's phonebook after
 * being linked — kwenta_canonical_user_id deliberately ignores is_deleted, so the account behind
 * that contact is alive and the row only needs rewriting, not removing. Those are exactly the rows
 * migration 049 exists to deliver.
 *
 * Duplicate detection also keys on canonical parties, so two rows for one payment that differ only
 * by local-vs-linked id still collapse.
 */
CREATE OR REPLACE FUNCTION public.kwenta_repair_settlement_plan(p_uid uuid)
RETURNS TABLE (id uuid, action text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH identity AS (
    SELECT i.id FROM public.kwenta_identity_ids(p_uid) AS i
  ), scope AS (
    SELECT s.id, s.bill_id, s.group_id, s.from_user_id, s.to_user_id, s.amount, s.currency,
           s.created_at, s.bundle_id, s.label, s.method, s.is_settled,
           public.kwenta_settlement_party_id(s.from_user_id, s.group_id) AS canon_from,
           public.kwenta_settlement_party_id(s.to_user_id,   s.group_id) AS canon_to
    FROM public.settlements s
    WHERE s.is_deleted IS FALSE
      AND (
        (s.group_id IS NULL AND (
           s.from_user_id IN (SELECT identity.id FROM identity)
           OR s.to_user_id IN (SELECT identity.id FROM identity)))
        OR (s.group_id IS NOT NULL AND public.is_group_member(s.group_id, p_uid))
      )
  ), orphans AS (
    SELECT r.id
    FROM scope r
    WHERE (r.bill_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.bills b WHERE b.id = r.bill_id AND b.is_deleted IS FALSE))
       OR (r.group_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.groups g WHERE g.id = r.group_id AND g.is_deleted IS FALSE))
       OR NOT EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = r.canon_from AND p.is_deleted IS FALSE)
       OR NOT EXISTS (
            SELECT 1 FROM public.profiles p WHERE p.id = r.canon_to AND p.is_deleted IS FALSE)
  ), survivors AS (
    SELECT r.* FROM scope r WHERE r.id NOT IN (SELECT orphans.id FROM orphans)
  ), ranked AS (
    SELECT r.id,
           row_number() OVER (
             PARTITION BY r.canon_from, r.canon_to, r.amount, r.currency,
                          COALESCE(r.bill_id::text, ''), COALESCE(r.group_id::text, ''),
                          r.created_at, COALESCE(r.bundle_id::text, ''),
                          COALESCE(r.label, ''), COALESCE(r.method, ''), r.is_settled
             ORDER BY r.created_at, r.id
           ) AS rn
    FROM survivors r
  ), duplicates AS (
    SELECT ranked.id FROM ranked WHERE ranked.rn > 1
  ), canonical AS (
    SELECT r.id
    FROM survivors r
    WHERE r.id NOT IN (SELECT duplicates.id FROM duplicates)
      AND (r.from_user_id IS DISTINCT FROM r.canon_from
           OR r.to_user_id IS DISTINCT FROM r.canon_to)
  )
  SELECT orphans.id, 'orphan'::text FROM orphans
  UNION ALL
  SELECT duplicates.id, 'duplicate'::text FROM duplicates
  UNION ALL
  SELECT canonical.id, 'canonical'::text FROM canonical;
$$;

REVOKE ALL ON FUNCTION public.kwenta_repair_settlement_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_settlement_plan(uuid) TO service_role;

/**
 * Repair (or, with p_dry_run, report) this caller's settlements. Self-scoped by auth.uid():
 * personal rows are matched by IDENTITY (account + contacts linked to it, the same set delivery
 * uses in 049), group rows by membership. Idempotent. Returns the counts.
 *
 * updated_at note: every UPDATE stamps GREATEST(now(), updated_at + 1us), never a bare now().
 * kwenta_server_wins_updated_at_guard (021b) is a BEFORE UPDATE trigger that returns OLD whenever
 * OLD.updated_at > NEW.updated_at, so a row written by a device with a fast clock would silently
 * keep its old values while this function still counted it as repaired — reporting success on
 * every run while the bad row stayed put. Stamping strictly forward keeps the guard satisfied and
 * the counts honest.
 */
CREATE OR REPLACE FUNCTION public.kwenta_repair_settlements(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  orphan_ids uuid[];
  duplicate_ids uuid[];
  canonical_ids uuid[];
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT COALESCE(array_agg(p.id) FILTER (WHERE p.action = 'orphan'), '{}'),
         COALESCE(array_agg(p.id) FILTER (WHERE p.action = 'duplicate'), '{}'),
         COALESCE(array_agg(p.id) FILTER (WHERE p.action = 'canonical'), '{}')
    INTO orphan_ids, duplicate_ids, canonical_ids
    FROM public.kwenta_repair_settlement_plan(uid) AS p;

  IF NOT p_dry_run THEN
    UPDATE public.settlements s
    SET is_deleted = TRUE,
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    WHERE s.id = ANY (orphan_ids);

    UPDATE public.settlements s
    SET is_deleted = TRUE,
        updated_at = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at  = NULL
    WHERE s.id = ANY (duplicate_ids);

    UPDATE public.settlements s
    SET from_user_id = public.kwenta_settlement_party_id(s.from_user_id, s.group_id),
        to_user_id   = public.kwenta_settlement_party_id(s.to_user_id, s.group_id),
        updated_at   = GREATEST(now(), s.updated_at + interval '1 microsecond'),
        synced_at    = NULL
    WHERE s.id = ANY (canonical_ids);
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'orphans', cardinality(orphan_ids),
    'duplicates', cardinality(duplicate_ids),
    'canonicalized', cardinality(canonical_ids),
    'total', cardinality(orphan_ids) + cardinality(duplicate_ids) + cardinality(canonical_ids)
  );
END;
$$;

-- The 0-arg signature from the first cut of this migration would otherwise survive as an overload
-- and keep being resolved for `rpc('kwenta_repair_settlements')` calls with no arguments.
DROP FUNCTION IF EXISTS public.kwenta_repair_settlements();

REVOKE ALL ON FUNCTION public.kwenta_repair_settlements(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_settlements(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_repair_settlements(boolean) TO service_role;
