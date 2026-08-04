-- 057_contacts_subtitle.sql
--
-- `kwenta_contacts_with_balances` (054) returned a name and a balance but no subtitle, so wiring
-- the People page to it would have silently dropped the "Linked · <account name>" /
-- "Local contact" line each row carries today.
--
-- Port of the subtitle half of resolveProfileDisplay (src/lib/people.ts:245-280):
--   * a contact with `linked_profile_id` resolving to a live profile -> "Linked · <their name>"
--   * a linked contact whose target is missing/deleted                -> "Linked · Loading their profile…"
--   * an unlinked contact with no email                               -> "Local contact"
--   * anything else                                                   -> no subtitle
--
-- The "Loading" wording is deliberately kept even though the server never waits for anything: it
-- is what the client shows for the same state, and changing copy is a product decision, not a
-- side effect of moving the computation.
--
-- APPLY AFTER 056.

CREATE OR REPLACE FUNCTION public.kwenta_peer_subtitle(p_peer uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p.linked_profile_id IS NOT NULL THEN COALESCE(
      (SELECT 'Linked · ' || l.display_name
         FROM public.profiles l
        WHERE l.id = p.linked_profile_id AND l.is_deleted IS FALSE),
      'Linked · Loading their profile…'
    )
    WHEN NULLIF(p.email, '') IS NULL THEN 'Local contact'
    ELSE NULL
  END
  FROM public.profiles p
  WHERE p.id = p_peer;
$$;

CREATE OR REPLACE FUNCTION public.kwenta_contacts_with_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  out jsonb := '[]'::jsonb;
  peer uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  FOR peer IN SELECT id FROM public.kwenta_canonical_peer_ids(v_uid) LOOP
    out := out || jsonb_build_array(jsonb_build_object(
      'peerId',      peer,
      'displayName', public.kwenta_peer_display_name(v_uid, peer),
      'subtitle',    public.kwenta_peer_subtitle(peer),
      'net',         public.kwenta_pairwise_breakdown(v_uid, peer) -> 'total'
    ));
  END LOOP;

  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.kwenta_peer_subtitle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kwenta_peer_subtitle(uuid) TO service_role;
