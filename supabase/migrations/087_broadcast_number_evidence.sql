-- ============================================================
-- 087_broadcast_number_evidence.sql — a broadcast send is reconciled
--     only against its own number's messages (phase 6)
--
-- A broadcast whose send outcome is unknown is settled by evidence (072):
-- the gateway's echo of the message, or a stored outbound message with
-- the same phone and text in the send's window. With several numbers per
-- account, the same text to the same phone can go out from another
-- number (a teammate typing it on the business QR phone while the
-- broadcast runs on the official number) — that message is not this
-- broadcast's. Both reconcilers now look only at the broadcast's number
-- (broadcasts.connection_id, migration 085); a broadcast from before it
-- has none and keeps the account-wide match.
--
-- Idempotent. Service-role only.
-- ============================================================

DROP FUNCTION IF EXISTS public.broadcast_attempt_reconcile_echo(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.broadcast_attempt_reconcile_echo(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ);

CREATE FUNCTION public.broadcast_attempt_reconcile_echo(
  p_account_id    UUID,
  p_connection_id UUID,
  p_to_phone      TEXT,
  p_body          TEXT,
  p_message_id    TEXT,
  p_sent_at       TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ids UUID[];
  res JSONB;
BEGIN
  IF p_body IS NULL OR p_message_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Open attempts this echo could belong to: same number, phone and text,
  -- and the echo falls inside one of their tries (first contact − 5 s …
  -- latest try + 2 min).
  SELECT array_agg(a.id ORDER BY a.first_sent_at) INTO ids
    FROM public.broadcast_send_attempts a
    JOIN public.broadcasts b ON b.id = a.broadcast_id
   WHERE a.account_id = p_account_id
     AND (b.connection_id IS NULL OR b.connection_id = p_connection_id)
     AND a.state IN ('in_flight', 'unknown', 'pending')
     AND a.first_sent_at IS NOT NULL
     AND a.to_phone = p_to_phone
     AND a.expected_body = p_body
     AND p_sent_at >= a.first_sent_at - interval '5 seconds'
     AND p_sent_at <= COALESCE(a.started_at, a.first_sent_at) + interval '2 minutes';
  IF ids IS NULL THEN
    RETURN NULL;
  END IF;
  IF cardinality(ids) > 1 THEN
    -- One message, several possible owners: a person decides (attempts
    -- still in a live try are settled by the provider's own answer).
    PERFORM public.broadcast_attempt_hold(p_account_id, x,
      'Ambiguous echo ' || p_message_id || ': ' || cardinality(ids) || ' open sends to this number with the same text — check the chat')
      FROM unnest(ids) x;
    RETURN NULL;
  END IF;
  res := public.broadcast_attempt_settle_evidence(p_account_id, ids[1], ARRAY[p_message_id], 'echo');
  RETURN CASE WHEN res->>'outcome' = 'sent' THEN ids[1] END;
END
$$;

CREATE OR REPLACE FUNCTION public.broadcast_attempt_reconcile_stored(
  p_account_id UUID,
  p_attempt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a   public.broadcast_send_attempts;
  num UUID;
  ids TEXT[];
BEGIN
  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE id = p_attempt_id AND account_id = p_account_id
     AND state IN ('in_flight', 'unknown', 'pending') AND expected_body IS NOT NULL
     AND first_sent_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;
  SELECT b.connection_id INTO num FROM public.broadcasts b WHERE b.id = a.broadcast_id;
  SELECT array_agg(DISTINCT m.message_id) INTO ids
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    JOIN public.contacts ct ON ct.id = c.contact_id
   WHERE c.account_id = p_account_id
     AND (num IS NULL OR c.connection_id = num)
     AND regexp_replace(COALESCE(ct.phone, ''), '\D', '', 'g') = a.to_phone
     AND m.sender_type IN ('agent', 'bot')
     AND m.content_text = a.expected_body
     AND m.message_id IS NOT NULL
     AND m.created_at >= a.first_sent_at - interval '5 seconds'
     AND m.created_at <= COALESCE(a.started_at, a.first_sent_at) + interval '2 minutes';
  RETURN public.broadcast_attempt_settle_evidence(p_account_id, a.id, ids, 'stored_message');
END
$$;

REVOKE ALL ON FUNCTION public.broadcast_attempt_reconcile_echo(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_attempt_reconcile_echo(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.broadcast_attempt_reconcile_stored(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_attempt_reconcile_stored(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
