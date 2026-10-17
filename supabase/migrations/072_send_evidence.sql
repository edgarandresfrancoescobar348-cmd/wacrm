-- ============================================================
-- 072_send_evidence.sql — fourth review K1, K2 and the quarantine of
--     uncertain legacy failures (broadcast send attempts, 069)
--
-- K1  A refusal proven to come BEFORE any effect (Meta 429, the budget
--     running out before the request left) no longer leaves the attempt
--     "pending with first_sent_at" — a state no pass could claim on a
--     provider without de-duplication. If that try was the attempt's
--     first contact, the contact is undone (first_sent_at and the
--     gateway identity cleared): the next pass sends normally. If an
--     EARLIER try may have reached the provider, the attempt stays
--     `unknown` and goes through reconciliation / the resend rules.
--
-- K2  A provider message id proves at most ONE attempt: `finish` reserves
--     it atomically (the unique index of 069, a unique violation caught)
--     and a conflict puts the attempt up for a decision instead of
--     marking it sent. Text-based evidence (echo, stored message, gateway
--     history) only settles an attempt when it is unambiguous: exactly
--     one unreserved message and no other open attempt that could own it,
--     inside a window tied to the attempt's own tries. Otherwise: a
--     person decides.
--
-- Quarantine (069 note): `failed` recipients from before send attempts
-- existed that carry a send checkpoint (send_started_at) may have been
-- sent: they become `unknown` (a person decides) instead of retryable.
--
-- Idempotent. Service-role only.
-- ============================================================

-- ------------------------------------------------------------ K2 core
-- Settle an attempt from candidate provider message ids (evidence that
-- is NOT the provider's own answer to this attempt). Returns
--   {"outcome":"sent","message_id":…} | {"outcome":"ambiguous"} | {"outcome":"none"}
CREATE OR REPLACE FUNCTION public.broadcast_attempt_settle_evidence(
  p_account_id  UUID,
  p_attempt_id  UUID,
  p_message_ids TEXT[],
  p_source      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a           public.broadcast_send_attempts;
  free_ids    TEXT[];
  competitors INTEGER;
  res         TEXT;
BEGIN
  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE id = p_attempt_id AND account_id = p_account_id
     FOR UPDATE;
  IF NOT FOUND OR a.state NOT IN ('in_flight', 'unknown', 'pending') OR a.first_sent_at IS NULL THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m), '{}') INTO free_ids
    FROM unnest(COALESCE(p_message_ids, '{}')) m
   WHERE m IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.broadcast_send_attempts o
                      WHERE o.account_id = p_account_id AND o.provider_message_id = m);
  IF cardinality(free_ids) = 0 THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;

  -- Another open attempt to the same phone with the same text whose
  -- tries overlap could own the same message.
  SELECT count(*) INTO competitors
    FROM public.broadcast_send_attempts o
   WHERE o.account_id = p_account_id
     AND o.id <> a.id
     AND o.state IN ('pending', 'in_flight', 'unknown')
     AND o.first_sent_at IS NOT NULL
     AND o.to_phone = a.to_phone
     AND o.expected_body IS NOT DISTINCT FROM a.expected_body
     AND o.first_sent_at <= COALESCE(a.started_at, a.first_sent_at) + interval '2 minutes'
     AND COALESCE(o.started_at, o.first_sent_at) + interval '2 minutes' >= a.first_sent_at;

  IF cardinality(free_ids) > 1 OR competitors > 0 THEN
    PERFORM public.broadcast_attempt_hold(p_account_id, a.id,
      'Ambiguous evidence (' || p_source || '): ' || cardinality(free_ids) || ' matching message(s), '
      || competitors || ' other open send(s) to this number with the same text — check the chat');
    RETURN jsonb_build_object('outcome', 'ambiguous');
  END IF;

  res := public.broadcast_attempt_finish(
    p_account_id, a.id, a.started_at, 'sent', free_ids[1], NULL, NULL, NULL, false, p_source);
  IF res = 'sent' THEN
    RETURN jsonb_build_object('outcome', 'sent', 'message_id', free_ids[1]);
  END IF;
  RETURN jsonb_build_object('outcome', 'ambiguous');
END
$$;

-- ------------------------------------------------------------ K1 + K2: finish
CREATE OR REPLACE FUNCTION public.broadcast_attempt_finish(
  p_account_id     UUID,
  p_attempt_id     UUID,
  p_started_at     TIMESTAMPTZ,
  p_outcome        TEXT,
  p_message_id     TEXT,
  p_error_code     TEXT,
  p_error_message  TEXT,
  p_retry_at       TIMESTAMPTZ,
  p_needs_decision BOOLEAN,
  p_resolved_by    TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a     public.broadcast_send_attempts;
  owner UUID;
BEGIN
  IF p_outcome NOT IN ('sent', 'failed', 'unknown', 'in_progress', 'retry_later') THEN
    RAISE EXCEPTION 'unknown outcome %', p_outcome USING ERRCODE = '22023';
  END IF;

  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE id = p_attempt_id AND account_id = p_account_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'send attempt % not found on account %', p_attempt_id, p_account_id
      USING ERRCODE = 'P0002';
  END IF;

  IF p_outcome = 'sent' THEN
    IF a.state = 'sent' THEN
      RETURN 'sent';
    END IF;
    IF a.state = 'failed' THEN
      RETURN 'failed';
    END IF;
    -- K2: one message proves one attempt. Reserved atomically by the
    -- unique index; a conflict is ambiguity, never a second "sent".
    IF p_message_id IS NOT NULL THEN
      SELECT id INTO owner FROM public.broadcast_send_attempts
       WHERE account_id = p_account_id AND provider_message_id = p_message_id AND id <> a.id;
      IF FOUND THEN
        PERFORM public.broadcast_attempt_hold(p_account_id, a.id,
          'Message ' || p_message_id || ' already proves another send — check the chat');
        RETURN 'ambiguous';
      END IF;
    END IF;
    BEGIN
      UPDATE public.broadcast_send_attempts
         SET state = 'sent', provider_message_id = COALESCE(p_message_id, provider_message_id),
             lease_until = NULL, next_retry_at = NULL, needs_decision = false,
             error_code = NULL, error_message = NULL,
             resolved_by = COALESCE(p_resolved_by, 'provider'),
             finished_at = now(), updated_at = now()
       WHERE id = a.id;
    EXCEPTION WHEN unique_violation THEN
      PERFORM public.broadcast_attempt_hold(p_account_id, a.id,
        'Message ' || p_message_id || ' already proves another send — check the chat');
      RETURN 'ambiguous';
    END;
    UPDATE public.broadcast_recipients
       SET status = 'sent',
           whatsapp_message_id = COALESCE(p_message_id, whatsapp_message_id),
           sent_at = COALESCE(sent_at, now()),
           error_message = NULL
     WHERE id = a.recipient_id AND status IN ('pending', 'unknown', 'failed');
    RETURN 'sent';
  END IF;

  IF p_outcome = 'failed' AND a.state = 'pending' AND a.first_sent_at IS NULL THEN
    UPDATE public.broadcast_send_attempts
       SET state = 'failed', next_retry_at = NULL,
           error_code = p_error_code, error_message = p_error_message,
           finished_at = now(), updated_at = now()
     WHERE id = a.id;
    UPDATE public.broadcast_recipients
       SET status = 'failed', error_message = COALESCE(p_error_message, 'Send failed')
     WHERE id = a.recipient_id AND status = 'pending';
    RETURN 'failed';
  END IF;

  IF a.state <> 'in_flight' OR a.started_at IS DISTINCT FROM p_started_at THEN
    RETURN a.state;
  END IF;

  IF p_outcome = 'failed' THEN
    UPDATE public.broadcast_send_attempts
       SET state = 'failed', lease_until = NULL, next_retry_at = NULL,
           error_code = p_error_code, error_message = p_error_message,
           finished_at = now(), updated_at = now()
     WHERE id = a.id;
    UPDATE public.broadcast_recipients
       SET status = 'failed', error_message = COALESCE(p_error_message, 'Send failed')
     WHERE id = a.recipient_id AND status IN ('pending', 'unknown');
    RETURN 'failed';
  END IF;

  IF p_outcome = 'unknown' THEN
    UPDATE public.broadcast_send_attempts
       SET state = 'unknown', lease_until = NULL, next_retry_at = p_retry_at,
           needs_decision = COALESCE(p_needs_decision, false),
           error_code = p_error_code, error_message = p_error_message,
           updated_at = now()
     WHERE id = a.id;
    IF COALESCE(p_needs_decision, false) THEN
      UPDATE public.broadcast_recipients
         SET status = 'unknown', error_message = COALESCE(p_error_message, 'Outcome unknown')
       WHERE id = a.recipient_id AND status = 'pending';
    END IF;
    RETURN 'unknown';
  END IF;

  IF p_outcome = 'in_progress' THEN
    UPDATE public.broadcast_send_attempts
       SET lease_until = NULL, next_retry_at = p_retry_at,
           error_code = p_error_code, error_message = p_error_message,
           updated_at = now()
     WHERE id = a.id;
    RETURN 'in_flight';
  END IF;

  -- retry_later: refused BEFORE any effect (rate limit, out of budget).
  IF a.first_sent_at = a.started_at THEN
    -- This try was the attempt's first contact: undo it, the attempt
    -- never reached the provider. The next pass sends it normally — on
    -- any provider, any gateway.
    UPDATE public.broadcast_send_attempts
       SET state = 'pending', first_sent_at = NULL, started_at = NULL,
           gateway_url = NULL, gateway_session_id = NULL,
           lease_until = NULL, next_retry_at = p_retry_at,
           error_code = p_error_code, error_message = p_error_message,
           updated_at = now()
     WHERE id = a.id;
    UPDATE public.broadcast_recipients SET send_started_at = NULL WHERE id = a.recipient_id;
    RETURN 'pending';
  END IF;
  -- An EARLIER try may have reached the provider: still unknown — the
  -- next pass reconciles it and applies the resend rules.
  UPDATE public.broadcast_send_attempts
     SET state = 'unknown', lease_until = NULL, next_retry_at = p_retry_at,
         error_code = COALESCE(error_code, p_error_code),
         error_message = p_error_message, updated_at = now()
   WHERE id = a.id;
  RETURN 'unknown';
END
$$;

-- ------------------------------------------------------------ K2: echo
CREATE OR REPLACE FUNCTION public.broadcast_attempt_reconcile_echo(
  p_account_id UUID,
  p_to_phone   TEXT,
  p_body       TEXT,
  p_message_id TEXT,
  p_sent_at    TIMESTAMPTZ
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
  -- Open attempts this echo could belong to: same phone and text, and
  -- the echo falls inside one of their tries (first contact − 5 s …
  -- latest try + 2 min).
  SELECT array_agg(id ORDER BY first_sent_at) INTO ids
    FROM public.broadcast_send_attempts
   WHERE account_id = p_account_id
     AND state IN ('in_flight', 'unknown', 'pending')
     AND first_sent_at IS NOT NULL
     AND to_phone = p_to_phone
     AND expected_body = p_body
     AND p_sent_at >= first_sent_at - interval '5 seconds'
     AND p_sent_at <= COALESCE(started_at, first_sent_at) + interval '2 minutes';
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

-- ------------------------------------------------------------ K2: stored
DROP FUNCTION IF EXISTS public.broadcast_attempt_reconcile_stored(UUID, UUID);
CREATE FUNCTION public.broadcast_attempt_reconcile_stored(
  p_account_id UUID,
  p_attempt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a   public.broadcast_send_attempts;
  ids TEXT[];
BEGIN
  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE id = p_attempt_id AND account_id = p_account_id
     AND state IN ('in_flight', 'unknown', 'pending') AND expected_body IS NOT NULL
     AND first_sent_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;
  SELECT array_agg(DISTINCT m.message_id) INTO ids
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    JOIN public.contacts ct ON ct.id = c.contact_id
   WHERE c.account_id = p_account_id
     AND regexp_replace(COALESCE(ct.phone, ''), '\D', '', 'g') = a.to_phone
     AND m.sender_type IN ('agent', 'bot')
     AND m.content_text = a.expected_body
     AND m.message_id IS NOT NULL
     AND m.created_at >= a.first_sent_at - interval '5 seconds'
     AND m.created_at <= COALESCE(a.started_at, a.first_sent_at) + interval '2 minutes';
  RETURN public.broadcast_attempt_settle_evidence(p_account_id, a.id, ids, 'stored_message');
END
$$;

-- ------------------------------------------------------------ quarantine
-- prepare: a failed recipient with a send checkpoint and no attempt
-- history failed before attempts existed — its outcome is uncertain.
CREATE OR REPLACE FUNCTION public.broadcast_attempt_prepare(
  p_account_id    UUID,
  p_recipient_id  UUID,
  p_provider      TEXT,
  p_to_phone      TEXT,
  p_payload       JSONB,
  p_payload_hash  TEXT,
  p_expected_body TEXT
)
RETURNS SETOF public.broadcast_send_attempts
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r      RECORD;
  a      public.broadcast_send_attempts;
  sent_a public.broadcast_send_attempts;
  n      INTEGER;
BEGIN
  SELECT br.id, br.status, br.send_started_at, br.broadcast_id
    INTO r
    FROM public.broadcast_recipients br
    JOIN public.broadcasts b ON b.id = br.broadcast_id
   WHERE br.id = p_recipient_id
     AND b.account_id = p_account_id
     FOR UPDATE OF br;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'broadcast recipient % not found on account %', p_recipient_id, p_account_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE recipient_id = p_recipient_id AND state IN ('pending', 'in_flight', 'unknown');
  IF FOUND THEN
    IF r.status = 'failed' THEN
      UPDATE public.broadcast_recipients SET status = 'pending', error_message = NULL
       WHERE id = p_recipient_id;
    END IF;
    RETURN NEXT a;
    RETURN;
  END IF;

  SELECT * INTO sent_a FROM public.broadcast_send_attempts
   WHERE recipient_id = p_recipient_id AND state = 'sent'
   ORDER BY attempt_no DESC LIMIT 1;
  IF FOUND THEN
    UPDATE public.broadcast_recipients
       SET status = 'sent',
           whatsapp_message_id = COALESCE(whatsapp_message_id, sent_a.provider_message_id),
           sent_at = COALESCE(sent_at, sent_a.finished_at),
           error_message = NULL
     WHERE id = p_recipient_id AND status IN ('pending', 'failed', 'unknown');
    RETURN;
  END IF;

  IF r.status NOT IN ('pending', 'failed') THEN
    RETURN;
  END IF;

  SELECT COALESCE(max(attempt_no), 0) + 1 INTO n
    FROM public.broadcast_send_attempts WHERE recipient_id = p_recipient_id;

  -- Quarantine: failed before send attempts existed, after a send
  -- checkpoint — it may have gone out. A person decides.
  IF n = 1 AND r.status = 'failed' AND r.send_started_at IS NOT NULL THEN
    UPDATE public.broadcast_recipients
       SET status = 'unknown',
           error_message = 'Outcome uncertain (recorded before send attempts existed) — check the chat'
     WHERE id = p_recipient_id;
    RETURN;
  END IF;

  INSERT INTO public.broadcast_send_attempts (
    account_id, broadcast_id, recipient_id, attempt_no, idempotency_key,
    provider, to_phone, payload, payload_hash, expected_body,
    state, first_sent_at, needs_decision, error_message
  ) VALUES (
    p_account_id, r.broadcast_id, p_recipient_id, n,
    CASE WHEN n = 1 THEN 'broadcast-recipient:' || p_recipient_id
         ELSE 'broadcast-recipient:' || p_recipient_id || ':a' || n END,
    p_provider, p_to_phone, p_payload, p_payload_hash, p_expected_body,
    CASE WHEN n = 1 AND r.status = 'pending' AND r.send_started_at IS NOT NULL THEN 'unknown' ELSE 'pending' END,
    CASE WHEN n = 1 AND r.status = 'pending' AND r.send_started_at IS NOT NULL THEN r.send_started_at END,
    false,
    CASE WHEN n = 1 AND r.status = 'pending' AND r.send_started_at IS NOT NULL
         THEN 'Interrupted mid-send before send attempts were recorded' END
  )
  RETURNING * INTO a;

  IF r.status = 'failed' THEN
    UPDATE public.broadcast_recipients
       SET status = 'pending', error_message = NULL, send_started_at = NULL
     WHERE id = p_recipient_id;
  END IF;
  RETURN NEXT a;
END
$$;

-- retry_failed leaves quarantined (legacy, checkpointed) failures alone.
CREATE OR REPLACE FUNCTION public.broadcast_retry_failed(
  p_account_id    UUID,
  p_broadcast_id  UUID,
  p_recipient_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INTEGER;
BEGIN
  -- First quarantine the uncertain legacy ones among them.
  UPDATE public.broadcast_recipients br
     SET status = 'unknown',
         error_message = 'Outcome uncertain (recorded before send attempts existed) — check the chat'
    FROM public.broadcasts b
   WHERE b.id = br.broadcast_id
     AND b.id = p_broadcast_id AND b.account_id = p_account_id
     AND br.status = 'failed'
     AND br.id = ANY (p_recipient_ids)
     AND br.send_started_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.broadcast_send_attempts t WHERE t.recipient_id = br.id);

  UPDATE public.broadcast_recipients br
     SET status = 'pending', error_message = NULL, send_started_at = NULL
    FROM public.broadcasts b
   WHERE b.id = br.broadcast_id
     AND b.id = p_broadcast_id AND b.account_id = p_account_id
     AND br.status = 'failed'
     AND br.id = ANY (p_recipient_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- One-time: quarantine the existing uncertain legacy failures.
UPDATE public.broadcast_recipients br
   SET status = 'unknown',
       error_message = 'Outcome uncertain (recorded before send attempts existed) — check the chat'
 WHERE br.status = 'failed'
   AND br.send_started_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.broadcast_send_attempts t WHERE t.recipient_id = br.id);

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.broadcast_attempt_settle_evidence(uuid,uuid,text[],text)',
    'public.broadcast_attempt_reconcile_stored(uuid,uuid)',
    'public.broadcast_attempt_finish(uuid,uuid,timestamptz,text,text,text,text,timestamptz,boolean,text)',
    'public.broadcast_attempt_reconcile_echo(uuid,text,text,text,timestamptz)',
    'public.broadcast_attempt_prepare(uuid,uuid,text,text,jsonb,text,text)',
    'public.broadcast_retry_failed(uuid,uuid,uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
