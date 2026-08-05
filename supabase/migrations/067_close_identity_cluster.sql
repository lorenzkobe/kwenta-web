-- 067_close_identity_cluster.sql
--
-- WHAT BROKE
-- ----------
-- The People page showed one human as TWO rows, permanently. Reproduced in production:
-- viewer 2ac49ccb had a local contact "Jello" merged (via profile_peer_links) to the "Jello"
-- account, and still saw both.
--
-- `kwenta_expand_identity` (052) walks TWO kinds of edge:
--   * profile links  — `profiles.linked_profile_id`, plus its siblings and its reverse
--   * peer links     — `profile_peer_links`, the viewer's manual "same person" merges
-- but it only ever CLOSED over the second. The profile-link arms lived in the non-recursive
-- `seed` block, so they were applied to the ANCHOR and to nothing else; the recursive `cluster`
-- block then followed peer links only. A cluster reachable by MIXING the two edge types
-- therefore depended on which member you started from:
--
--   expand(contact) = {contact, account}                      -- peer link, then stop
--   expand(account) = {contact, account, other_users_contact} -- reverse profile link, then peer
--
-- The relation was not an equivalence relation: y ∈ expand(x) did not imply expand(y) = expand(x).
--
-- WHY THAT SHOWS UP AS A DUPLICATE
-- --------------------------------
-- `kwenta_canonical_peer_ids` (054/055) keys each person by `MIN(expand(id))` — deliberately, so
-- that any two ids for one human collapse to one row. That argument only holds if expand() is
-- closed. Here the two ids expanded to different SETS, so they produced different keys, so the
-- "one row per person" grouping emitted two. 055 fixed the same CLASS of bug for one-hop
-- resolution (`a1<->a2<->a3`) but left the mixed-edge-type case open, because at the time the
-- profile-link arms and the peer-link arm had not been considered as one graph.
--
-- The extra member in the account's cluster is another user's local contact for the same human
-- (their phonebook row, linked to that same account). It enters through the reverse arm
-- `rev.linked_profile_id = ap.id`, which is not owner-scoped — and that is intentional: it is how
-- a split still filed under someone else's contact id is recognised as this person. The defect
-- was never that the edge exists, only that it was followed from one end and not the other.
--
-- THE SHAPE
-- ---------
-- One recursive closure over the union of both edge types, so the result is the connected
-- component of the anchor and is identical from every member. Written as a LATERAL over the
-- frontier rather than a materialised edge relation: a recursive term may reference the CTE only
-- once, so the alternative was to pre-build every edge in `profiles` on EVERY call, and this
-- function is called once per related id by `kwenta_canonical_peer_ids`.
--
-- WHAT IS DELIBERATELY UNCHANGED
-- ------------------------------
-- * An edge is gated on the row that HOLDS `linked_profile_id` being live. A soft-deleted contact
--   therefore drops out from both ends, which is what 052 already pinned — the fix must not
--   resurrect deleted contacts, only make reachability symmetric.
-- * Peer links stay viewer-scoped and skipped entirely when `p_viewer IS NULL`. A merge is
--   private to the user who made it; 053's invariant (a viewer-private merge never moves a shared
--   group ledger) depends on that and is unaffected.
-- * Signature and return type are unchanged, so `CREATE OR REPLACE` is enough and no dependent
--   function needs restating. The REVOKE is restated only to keep rule 5 legible at this file.
--
-- BLAST RADIUS, STATED
-- --------------------
-- This function feeds split/settlement matching, so the change MOVES MONEY: a cluster reachable
-- only by mixing edge types is now matched from either end. That is a widening, and every id it
-- adds was already reachable from some other member — the fix makes the two ends AGREE rather
-- than inventing a new relationship. It cannot introduce double counting that the one-sided
-- version avoided: the account end already saw the wider set, so any bill that would double-count
-- did so already.
--
-- Apply before or with the client change; the TypeScript twin
-- (`expandProfileIdsForSplitMatching`, src/lib/people.ts) had the identical asymmetry and is
-- fixed in the same commit. The two must agree — see CLAUDE.md, migration 055.

CREATE OR REPLACE FUNCTION public.kwenta_expand_identity(p_anchor uuid, p_viewer uuid DEFAULT NULL)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE cluster AS (
    SELECT p_anchor AS id
    UNION
    SELECT n.id
    FROM cluster c
    CROSS JOIN LATERAL (
      -- forward: this row points at an account
      SELECT p.linked_profile_id AS id
        FROM public.profiles p
       WHERE p.id = c.id
         AND p.is_deleted IS FALSE
         AND p.linked_profile_id IS NOT NULL
      UNION ALL
      -- reverse: rows pointing at this one. Siblings need no arm of their own — two contacts on
      -- one account are two reverse edges from that account, which the closure now walks.
      SELECT rev.id
        FROM public.profiles rev
       WHERE rev.linked_profile_id = c.id
         AND rev.is_deleted IS FALSE
      UNION ALL
      -- the viewer's own manual merges, undirected
      SELECT CASE WHEN l.anchor_profile_id = c.id THEN l.peer_profile_id ELSE l.anchor_profile_id END
        FROM public.profile_peer_links l
       WHERE (l.anchor_profile_id = c.id OR l.peer_profile_id = c.id)
         AND p_viewer IS NOT NULL
         AND l.owner_user_id = p_viewer
         AND l.is_deleted IS FALSE
    ) n
    WHERE n.id IS NOT NULL
  )
  SELECT DISTINCT c.id FROM cluster c WHERE c.id IS NOT NULL;
$$;

-- Rule 5: it takes the viewer as an ARGUMENT, so that argument IS the authorization decision.
REVOKE ALL ON FUNCTION public.kwenta_expand_identity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kwenta_expand_identity(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.kwenta_expand_identity(uuid, uuid) TO service_role;
