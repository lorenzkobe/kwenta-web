-- Migration 057: the contact subtitle the People page renders under each name.
-- Ported from the subtitle half of resolveProfileDisplay (src/lib/people.ts:245-280).

SET client_min_messages = notice;

DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; c_plain uuid;
  ghost uuid := gen_random_uuid();
BEGIN
  alice := test.new_account('sub-alice@example.com', 'Alice');
  bob   := test.new_account('sub-bob@example.com', 'Bob');

  c_bob   := test.new_contact(alice, 'Bobby', bob);
  c_plain := test.new_contact(alice, 'Dave');

  PERFORM test.assert_eq(public.kwenta_peer_subtitle(c_bob), 'Linked · Bob',
    'a linked contact shows the account it points at');

  PERFORM test.assert_eq(public.kwenta_peer_subtitle(c_plain), 'Local contact',
    'an unlinked contact with no email is a local contact');

  -- No dangling-link case: `profiles.linked_profile_id` has a FK, so a link to a nonexistent
  -- profile cannot exist on the server. The client's "Loading their profile…" state is a
  -- SYNC phenomenon — the target row has not reached that device yet — which is why the
  -- fallback wording is kept even though the only server-reachable path to it is a
  -- soft-deleted target, asserted below.

  PERFORM test.assert_eq(public.kwenta_peer_subtitle(bob), NULL,
    'a real account with an email carries no subtitle');

  PERFORM test.assert_eq(public.kwenta_peer_subtitle(ghost), NULL,
    'an id with no profile has no subtitle rather than erroring');

  -- A linked target that has been soft-deleted falls back to the loading wording, not to a
  -- half-rendered "Linked · " with an empty name.
  UPDATE public.profiles SET is_deleted = true WHERE id = bob;
  PERFORM test.assert_eq(public.kwenta_peer_subtitle(c_bob), 'Linked · Loading their profile…',
    'a soft-deleted link target falls back rather than rendering an empty name');

  PERFORM test.note('peer_subtitle: linked, local, dangling, deleted target');
END;
$$;

-- The contacts RPC must actually carry the subtitle through.
DO $$
DECLARE
  alice uuid; bob uuid; c_bob uuid; rows jsonb; row0 jsonb;
BEGIN
  alice := test.new_account('sub2-alice@example.com', 'Alice');
  bob   := test.new_account('sub2-bob@example.com', 'Bob');
  c_bob := test.new_contact(alice, 'Bobby', bob);

  PERFORM set_config('request.jwt.claim.sub', alice::text, true);
  rows := public.kwenta_contacts_with_balances();
  PERFORM test.assert_eq(jsonb_array_length(rows), 1, 'one contact');

  row0 := rows -> 0;
  PERFORM test.assert_eq(row0 ->> 'displayName', 'Bobby', 'the viewer''s own name for them wins');
  PERFORM test.assert_eq(row0 ->> 'subtitle', 'Linked · Bob', 'the subtitle is carried through');
  PERFORM test.assert_true(row0 ? 'net', 'the balance is still present');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM test.note('contacts_with_balances: subtitle included');
END;
$$;
