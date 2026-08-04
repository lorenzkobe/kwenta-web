-- 055_fix_merged_contact_double_count.sql
--
-- BUG. Merging two contacts as "the same person" double-counted the Home headline. One 100 bill
-- split evenly — you are owed 50 — displayed as 100.
--
-- CAUSE. `kwenta_canonical_peer_ids` (054), ported faithfully from iterCanonicalPeerIds
-- (src/lib/people.ts:469-511), resolved each id independently through a first-match chain whose
-- FIRST branch was "is this one of my own local contacts?". For two contacts the viewer owns that
-- answer is yes for both, so the merge branch further down was never reached and both survived as
-- separate peers. Balance math *does* honour the merge (both expand to the same identity set), so
-- each peer reported the same amount and the rollup added it twice.
--
-- The same shape bit the ordinary case too: two local contacts both linked to one remote account
-- were likewise two peers.
--
-- WHY NOT JUST REORDER THE BRANCHES. Resolving one hop in a different order fixes a1<->a2 and
-- still breaks a1<->a2<->a3: a3 resolves to a2, a2 resolves to a1, and you are left with two
-- peers for one person. Identity is an equivalence relation, so the fix has to work on the whole
-- class, not on a single edge.
--
-- FIX. Group the related ids by their identity CLUSTER — `kwenta_expand_identity` already returns
-- the full class, so every id denoting one person yields the same set and therefore the same
-- cluster key — then emit exactly ONE representative per cluster. The old display preference is
-- kept: a contact the viewer owns wins, so people keep the name they filed someone under, with
-- the lowest id as a deterministic tiebreak.
--
-- The equivalent TypeScript fix lands in the same change (src/lib/people.ts), so both
-- implementations agree while the read path is being moved to SQL.
--
-- APPLY AFTER 054.

CREATE OR REPLACE FUNCTION public.kwenta_canonical_peer_ids(p_viewer uuid)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  me_ids AS (SELECT id FROM public.kwenta_expand_identity(p_viewer, p_viewer)),
  related AS (
    SELECT r.id FROM public.kwenta_related_profile_ids(p_viewer) r
    WHERE r.id <> p_viewer AND r.id NOT IN (SELECT id FROM me_ids)
  ),
  -- Two ids for one person expand to the same set, so MIN over that set is a stable key for the
  -- whole equivalence class — transitive merges included.
  -- Compared as text, not as uuid: Postgres has no MIN(uuid), and text ordering is also exactly
  -- what the TypeScript does (`[...cluster].sort()[0]`), so both implementations pick the same
  -- representative for the same data.
  clustered AS (
    SELECT
      rel.id,
      (SELECT MIN(e.id::text) FROM public.kwenta_expand_identity(rel.id, p_viewer) e) AS cluster_key
    FROM related rel
  ),
  ranked AS (
    SELECT
      c.cluster_key,
      c.id,
      -- 1 when this id is a contact the viewer owns, NULL otherwise; drives the preference below.
      (SELECT 1 FROM public.profiles p
        WHERE p.id = c.id
          AND p.is_deleted IS FALSE
          AND p.is_local IS TRUE
          AND p.owner_id = p_viewer) AS own_contact
    FROM clustered c
  ),
  picked AS (
    SELECT DISTINCT ON (r.cluster_key) r.cluster_key, r.id
    FROM ranked r
    -- Prefer the viewer's own contact (so their chosen name shows), then lowest id for
    -- determinism — the same person must not change identity between two reads.
    ORDER BY r.cluster_key, r.own_contact NULLS LAST, r.id::text
  )
  SELECT p.id
  FROM picked p
  WHERE p.id NOT IN (SELECT id FROM me_ids);
$$;
