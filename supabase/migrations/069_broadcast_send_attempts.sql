-- ============================================================
-- 069_broadcast_send_attempts.sql — a durable identity for every
--     broadcast send (third review: H3, H5, H6, H7, G7 residue)
--
-- The problem
--
--   A broadcast send had no identity of its own. The "checkpoint" was a
--   timestamp on the recipient row, written without checking that it
--   landed; the idempotency key was derived on the fly (and replaced by
--   a fresh timestamped one on a retry of a failed recipient); the body
--   was re-rendered on every pass; the gateway's answers "still running"
--   (409 IDEMPOTENCY_KEY_IN_PROGRESS) and "may have been sent"
--   (409 IDEMPOTENCY_OUTCOME_UNKNOWN) were read as plain failures; and a
--   resend trusted the gateway's de-duplication forever, though OpenWA
--   only remembers a key for 24 h, per gateway and session.
--
-- The model
--
--   One row per send attempt of a recipient, created BEFORE anything
--   leaves the building:
--
--     pending ─begin─▶ in_flight ─▶ sent | failed | unknown
--                          │  ▲
--          409 in progress │  │ resend (same key, same payload) —
--          (backoff)       └──┘ only inside the gateway's window, on
--                               the same gateway URL + session
--     unknown ─reconcile (echo / stored message / gateway history)─▶ sent
--     unknown ─human decision─▶ sent | failed
--
--   * The attempt carries its idempotency key and its frozen payload, so
--     every retry of THE SAME attempt resends the identical request with
--     the identical key. A new key exists only as a NEW attempt, created
--     after the previous one is known `failed` (definitely not sent).
--   * `begin` is the checkpoint: one conditional UPDATE (account, state,
--     lease, recipient still pending, resend window, same gateway) that
--     returns the claimed row. No row back — no send.
--   * An attempt whose outcome can't be established and can't be safely
--     resent is put up for a human decision: the recipient's status
--     becomes `unknown`, visible (and decidable) in the broadcast page.
--
--   All functions are service-role only.
--
-- Idempotent.
-- ============================================================

-- Recipient status `unknown`: outcome not established, needs a decision.
ALTER TABLE public.broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE public.broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'unknown'));

CREATE TABLE IF NOT EXISTS public.broadcast_send_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  broadcast_id        UUID NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  recipient_id        UUID NOT NULL REFERENCES public.broadcast_recipients(id) ON DELETE CASCADE,
  attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
  idempotency_key     TEXT NOT NULL UNIQUE,
  provider            TEXT NOT NULL CHECK (provider IN ('meta', 'openwa')),
  -- The gateway that received the key (OpenWA de-duplicates per gateway
  -- and session). Fixed by the first `begin`.
  gateway_url         TEXT,
  gateway_session_id  TEXT,
  to_phone            TEXT NOT NULL,
  -- Exactly what is sent, on every try of this attempt.
  payload             JSONB NOT NULL,
  payload_hash        TEXT NOT NULL,
  -- The text the customer receives (QR mode), for reconciliation
  -- against echoes, stored messages and gateway history.
  expected_body       TEXT,
  state               TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'in_flight', 'sent', 'failed', 'unknown')),
  needs_decision      BOOLEAN NOT NULL DEFAULT false,
  -- When the key first reached the provider — the start of its window.
  first_sent_at       TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  lease_until         TIMESTAMPTZ,
  next_retry_at       TIMESTAMPTZ,
  tries               INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error_code          TEXT,
  error_message       TEXT,
  resolved_by         TEXT CHECK (resolved_by IN ('provider', 'echo', 'stored_message', 'history', 'human')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  UNIQUE (recipient_id, attempt_no)
);

-- At most one open attempt per recipient.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_send_attempts_one_open
  ON public.broadcast_send_attempts (recipient_id)
  WHERE state IN ('pending', 'in_flight', 'unknown');
-- A provider message proves at most one attempt.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_send_attempts_message
  ON public.broadcast_send_attempts (account_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- Echo reconciliation looks open attempts up by phone.
CREATE INDEX IF NOT EXISTS broadcast_send_attempts_open_by_phone
  ON public.broadcast_send_attempts (account_id, to_phone)
  WHERE state IN ('in_flight', 'unknown');
CREATE INDEX IF NOT EXISTS broadcast_send_attempts_broadcast
  ON public.broadcast_send_attempts (broadcast_id, state);

ALTER TABLE public.broadcast_send_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (the API surfaces the recipient status).
REVOKE ALL ON public.broadcast_send_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.broadcast_send_attempts TO service_role;

-- ------------------------------------------------------------
-- prepare: the recipient's open attempt (same key, same payload), or a
-- new one when there is none. A new attempt after an earlier one exists
-- only if every earlier one is `failed`. A recipient with a `sent`
-- attempt is repaired to `sent` and gets none. A failed recipient that
-- is retried becomes `pending` here, so an interrupted retry is picked
-- up by the continuation (H7).
-- ------------------------------------------------------------
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
      -- Marked failed elsewhere while an attempt was still open: the
      -- attempt decides, so the recipient is resumable again.
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
    RETURN; -- sent / delivered / … / unknown: nothing to attempt
  END IF;

  SELECT COALESCE(max(attempt_no), 0) + 1 INTO n
    FROM public.broadcast_send_attempts WHERE recipient_id = p_recipient_id;

  INSERT INTO public.broadcast_send_attempts (
    account_id, broadcast_id, recipient_id, attempt_no, idempotency_key,
    provider, to_phone, payload, payload_hash, expected_body,
    state, first_sent_at, needs_decision, error_message
  ) VALUES (
    p_account_id, r.broadcast_id, p_recipient_id, n,
    -- Attempt 1 keeps the key earlier code already used for this row.
    CASE WHEN n = 1 THEN 'broadcast-recipient:' || p_recipient_id
         ELSE 'broadcast-recipient:' || p_recipient_id || ':a' || n END,
    p_provider, p_to_phone, p_payload, p_payload_hash, p_expected_body,
    -- A row interrupted mid-send before this model existed: its outcome
    -- is unknown and the gateway that saw it is not recorded.
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

-- ------------------------------------------------------------
-- begin: the checkpoint. Claims the attempt for one send (lease) and
-- returns it; nothing returned means DO NOT SEND. A resend of an attempt
-- that already reached the provider is only claimable inside
-- p_resend_window of its first send and on the same gateway + session
-- (NULL window: never resend — a provider without de-duplication).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_attempt_begin(
  p_account_id         UUID,
  p_attempt_id         UUID,
  p_lease_until        TIMESTAMPTZ,
  p_gateway_url        TEXT,
  p_gateway_session_id TEXT,
  p_resend_window      INTERVAL
)
RETURNS SETOF public.broadcast_send_attempts
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a public.broadcast_send_attempts;
BEGIN
  UPDATE public.broadcast_send_attempts t
     SET state = 'in_flight',
         started_at = now(),
         first_sent_at = COALESCE(t.first_sent_at, now()),
         lease_until = p_lease_until,
         next_retry_at = NULL,
         gateway_url = COALESCE(t.gateway_url, p_gateway_url),
         gateway_session_id = COALESCE(t.gateway_session_id, p_gateway_session_id),
         tries = t.tries + 1,
         updated_at = now()
    FROM public.broadcast_recipients br
   WHERE t.id = p_attempt_id
     AND t.account_id = p_account_id
     AND br.id = t.recipient_id
     AND br.status = 'pending'
     AND t.state IN ('pending', 'in_flight', 'unknown')
     AND NOT t.needs_decision
     AND (t.lease_until IS NULL OR t.lease_until < now())
     AND (t.next_retry_at IS NULL OR t.next_retry_at <= now())
     AND (
       t.first_sent_at IS NULL
       OR (
         p_resend_window IS NOT NULL
         AND t.first_sent_at > now() - p_resend_window
         AND t.gateway_url IS NOT DISTINCT FROM p_gateway_url
         AND t.gateway_session_id IS NOT DISTINCT FROM p_gateway_session_id
       )
     )
  RETURNING t.* INTO a;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE public.broadcast_recipients SET send_started_at = now() WHERE id = a.recipient_id;
  RETURN NEXT a;
END
$$;

-- ------------------------------------------------------------
-- finish: record what a try established. p_started_at is the token
-- `begin` handed out (the attempt's started_at): a stale worker can't
-- overwrite a newer try. 'sent' is accepted from any open state (an
-- echo may have reconciled it first) and is idempotent.
--
--   p_outcome      attempt            recipient
--   sent           sent               sent (+ message id)
--   failed         failed             failed (definitely not sent)
--   unknown        unknown            pending, or `unknown` when
--                                     p_needs_decision
--   in_progress    in_flight, backoff pending
--   retry_later    pending, backoff   pending (not sent; e.g. 429)
-- Returns the attempt's resulting state.
-- ------------------------------------------------------------
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
  a public.broadcast_send_attempts;
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
    UPDATE public.broadcast_send_attempts
       SET state = 'sent', provider_message_id = COALESCE(p_message_id, provider_message_id),
           lease_until = NULL, next_retry_at = NULL, needs_decision = false,
           error_code = NULL, error_message = NULL,
           resolved_by = COALESCE(p_resolved_by, 'provider'),
           finished_at = now(), updated_at = now()
     WHERE id = a.id;
    UPDATE public.broadcast_recipients
       SET status = 'sent',
           whatsapp_message_id = COALESCE(p_message_id, whatsapp_message_id),
           sent_at = COALESCE(sent_at, now()),
           error_message = NULL
     WHERE id = a.recipient_id AND status IN ('pending', 'unknown', 'failed');
    RETURN 'sent';
  END IF;

  -- An attempt that never reached the provider (its media couldn't be
  -- prepared, say) can fail without a try.
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

  -- Every other outcome belongs to the try that holds the token.
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
         SET status = 'unknown',
             error_message = COALESCE(p_error_message, 'Outcome unknown')
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

  -- retry_later: the provider refused before sending; same key later.
  UPDATE public.broadcast_send_attempts
     SET state = 'pending', lease_until = NULL, next_retry_at = p_retry_at,
         error_code = p_error_code, error_message = p_error_message,
         updated_at = now()
   WHERE id = a.id;
  RETURN 'pending';
END
$$;

-- ------------------------------------------------------------
-- Put an attempt up for a human decision without a try in flight (it
-- can't be resent: outside the gateway's window, another gateway or
-- session, a provider without de-duplication, a refused key).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_attempt_hold(
  p_account_id    UUID,
  p_attempt_id    UUID,
  p_error_message TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a   public.broadcast_send_attempts;
  cur TEXT;
BEGIN
  UPDATE public.broadcast_send_attempts
     SET state = 'unknown', needs_decision = true, lease_until = NULL,
         error_message = COALESCE(p_error_message, error_message), updated_at = now()
   WHERE id = p_attempt_id AND account_id = p_account_id
     AND state IN ('in_flight', 'unknown')
     AND (lease_until IS NULL OR lease_until < now())
  RETURNING * INTO a;
  IF NOT FOUND THEN
    SELECT state INTO cur FROM public.broadcast_send_attempts
     WHERE id = p_attempt_id AND account_id = p_account_id;
    RETURN cur;
  END IF;
  UPDATE public.broadcast_recipients
     SET status = 'unknown', error_message = a.error_message
   WHERE id = a.recipient_id AND status = 'pending';
  RETURN 'unknown';
END
$$;

-- ------------------------------------------------------------
-- Reconcile from the provider's echo (OpenWA message.sent): the oldest
-- open attempt to this phone with this exact body, started no later than
-- shortly after the echo and within the gateway's memory, becomes sent
-- with the echoed id. Returns the attempt id, or NULL.
-- ------------------------------------------------------------
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
  a public.broadcast_send_attempts;
BEGIN
  IF p_body IS NULL OR p_message_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.broadcast_send_attempts
              WHERE account_id = p_account_id AND provider_message_id = p_message_id) THEN
    RETURN NULL; -- this message already proves an attempt
  END IF;
  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE account_id = p_account_id
     AND state IN ('in_flight', 'unknown')
     AND to_phone = p_to_phone
     AND expected_body = p_body
     AND first_sent_at IS NOT NULL
     AND first_sent_at <= p_sent_at + interval '2 minutes'
     AND first_sent_at >= p_sent_at - interval '25 hours'
   ORDER BY first_sent_at
   LIMIT 1
     FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM public.broadcast_attempt_finish(
    p_account_id, a.id, a.started_at, 'sent', p_message_id, NULL, NULL, NULL, false, 'echo');
  RETURN a.id;
END
$$;

-- ------------------------------------------------------------
-- Reconcile from what is already stored: an outgoing message in the
-- recipient's conversation with the expected body, after the attempt's
-- first send, whose id proves no other attempt. Returns the message id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_attempt_reconcile_stored(
  p_account_id UUID,
  p_attempt_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a   public.broadcast_send_attempts;
  mid TEXT;
BEGIN
  SELECT * INTO a FROM public.broadcast_send_attempts
   WHERE id = p_attempt_id AND account_id = p_account_id
     AND state IN ('in_flight', 'unknown') AND expected_body IS NOT NULL
     AND first_sent_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT m.message_id INTO mid
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    JOIN public.contacts ct ON ct.id = c.contact_id
   WHERE c.account_id = p_account_id
     AND regexp_replace(COALESCE(ct.phone, ''), '\D', '', 'g') = a.to_phone
     AND m.sender_type IN ('agent', 'bot')
     AND m.content_text = a.expected_body
     AND m.message_id IS NOT NULL
     AND m.created_at >= a.first_sent_at - interval '2 minutes'
     AND NOT EXISTS (SELECT 1 FROM public.broadcast_send_attempts o
                      WHERE o.account_id = p_account_id AND o.provider_message_id = m.message_id)
   ORDER BY m.created_at
   LIMIT 1;
  IF mid IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM public.broadcast_attempt_finish(
    p_account_id, a.id, a.started_at, 'sent', mid, NULL, NULL, NULL, false, 'stored_message');
  RETURN mid;
END
$$;

-- ------------------------------------------------------------
-- A person's decision on recipients whose outcome is `unknown`:
-- 'sent' (it arrived) or 'not_sent' (it didn't — a later retry then
-- gets a new attempt and key). Returns how many were decided.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_attempt_decide(
  p_account_id    UUID,
  p_broadcast_id  UUID,
  p_recipient_ids UUID[],
  p_outcome       TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n INTEGER;
BEGIN
  IF p_outcome NOT IN ('sent', 'not_sent') THEN
    RAISE EXCEPTION 'unknown decision %', p_outcome USING ERRCODE = '22023';
  END IF;

  WITH target AS (
    SELECT br.id
      FROM public.broadcast_recipients br
      JOIN public.broadcasts b ON b.id = br.broadcast_id
     WHERE b.id = p_broadcast_id AND b.account_id = p_account_id
       AND br.status = 'unknown'
       AND (p_recipient_ids IS NULL OR br.id = ANY (p_recipient_ids))
       FOR UPDATE OF br
  ), att AS (
    UPDATE public.broadcast_send_attempts t
       SET state = CASE WHEN p_outcome = 'sent' THEN 'sent' ELSE 'failed' END,
           needs_decision = false, lease_until = NULL, next_retry_at = NULL,
           resolved_by = 'human', finished_at = now(), updated_at = now(),
           error_message = CASE WHEN p_outcome = 'sent' THEN NULL
                                ELSE 'Marked as not sent after checking the chat' END
      FROM target
     WHERE t.recipient_id = target.id AND t.state IN ('in_flight', 'unknown')
  ), rec AS (
    UPDATE public.broadcast_recipients br
       SET status = CASE WHEN p_outcome = 'sent' THEN 'sent' ELSE 'failed' END,
           sent_at = CASE WHEN p_outcome = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
           error_message = CASE WHEN p_outcome = 'sent' THEN NULL
                                ELSE 'Marked as not sent after checking the chat' END
      FROM target
     WHERE br.id = target.id
    RETURNING br.id
  )
  SELECT count(*) INTO n FROM rec;
  RETURN n;
END
$$;

-- ------------------------------------------------------------
-- Retry failed recipients (Resume scope failed/all): they become
-- `pending` in one statement, BEFORE the pass, so a pass interrupted
-- halfway leaves them resumable for the continuation (H7). Their next
-- attempt (new key) is created by `prepare` when it is their turn.
-- ------------------------------------------------------------
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

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.broadcast_attempt_prepare(uuid,uuid,text,text,jsonb,text,text)',
    'public.broadcast_attempt_begin(uuid,uuid,timestamptz,text,text,interval)',
    'public.broadcast_attempt_finish(uuid,uuid,timestamptz,text,text,text,text,timestamptz,boolean,text)',
    'public.broadcast_attempt_hold(uuid,uuid,text)',
    'public.broadcast_attempt_reconcile_echo(uuid,text,text,text,timestamptz)',
    'public.broadcast_attempt_reconcile_stored(uuid,uuid)',
    'public.broadcast_attempt_decide(uuid,uuid,uuid[],text)',
    'public.broadcast_retry_failed(uuid,uuid,uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
