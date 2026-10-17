-- ============================================================
-- 065_apply_message_receipt
--
-- A delivery receipt (sent / delivered / read / failed) now lands in
-- ONE atomic, monotonic database operation instead of app-side
-- check-then-write steps, which lost or regressed receipts under
-- concurrency (second review G2–G4):
--
--   * an ack checked for the message, found none, and wrote its pending
--     row only after the sender's insert (and its trigger) had passed —
--     the receipt was never applied;
--   * two early acks read "no pending", then the lower one overwrote the
--     higher one;
--   * an ack that found the message (written by OpenWA's echo) skipped
--     retention, so the broadcast recipient stamped later never got it;
--   * broadcast_recipients was advanced by a JS check followed by an
--     unconditional UPDATE — concurrent acks regressed it.
--
-- public.apply_message_receipt():
--   1. takes a transaction-scoped advisory lock on the provider message
--      id — the same lock the AFTER INSERT / id-stamp triggers take, so
--      receipt and row creation are serialized: whichever commits second
--      sees the other;
--   2. ALWAYS retains the receipt in message_status_pending, merged
--      monotonically (ON CONFLICT … WHERE it advances) — retention is
--      per destination: a row that appears later still gets it;
--   3. advances every matching messages row and broadcast_recipients
--      row with the ladder in the UPDATE's own WHERE clause.
--
-- Scope: the account for OpenWA (ids unique per number), NULL = global
-- for Meta wamids (matched globally, as the Meta webhook always has).
-- Callable by the service role only. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_message_receipt(
  p_account UUID,
  p_provider_message_id TEXT,
  p_status TEXT,
  p_failure JSONB,
  p_status_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n_messages INTEGER := 0;
  n_recipients INTEGER := 0;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RETURN jsonb_build_object('messages', 0, 'recipients', 0, 'ignored', true);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('wa-receipt:' || p_provider_message_id));

  INSERT INTO public.message_status_pending AS s (scope, provider_message_id, status, failure, status_at)
  VALUES (COALESCE(p_account::TEXT, 'global'), p_provider_message_id, p_status, p_failure, p_status_at)
  ON CONFLICT (scope, provider_message_id) DO UPDATE
    SET status = EXCLUDED.status,
        failure = COALESCE(EXCLUDED.failure, s.failure),
        status_at = EXCLUDED.status_at
    WHERE public._wa_status_advances(s.status, EXCLUDED.status);

  UPDATE public.messages m
     SET status = p_status,
         error_code    = CASE WHEN p_status = 'failed' THEN (p_failure->>'code')::INTEGER ELSE m.error_code END,
         error_title   = CASE WHEN p_status = 'failed' THEN p_failure->>'title' ELSE m.error_title END,
         error_details = CASE WHEN p_status = 'failed' THEN p_failure->>'details' ELSE m.error_details END
    FROM public.conversations c
   WHERE c.id = m.conversation_id
     AND m.message_id = p_provider_message_id
     AND (p_account IS NULL OR c.account_id = p_account)
     AND public._wa_status_advances(m.status, p_status);
  GET DIAGNOSTICS n_messages = ROW_COUNT;

  UPDATE public.broadcast_recipients r
     SET status        = p_status,
         sent_at       = CASE WHEN p_status = 'sent' THEN COALESCE(r.sent_at, p_status_at) ELSE r.sent_at END,
         delivered_at  = CASE WHEN p_status = 'delivered' THEN p_status_at ELSE r.delivered_at END,
         read_at       = CASE WHEN p_status = 'read' THEN p_status_at ELSE r.read_at END,
         error_message = CASE WHEN p_status = 'failed' AND p_failure IS NOT NULL
                              THEN '[' || (p_failure->>'code') || '] ' || (p_failure->>'title')
                                   || COALESCE(': ' || (p_failure->>'details'), '')
                              ELSE r.error_message END
    FROM public.broadcasts b
   WHERE b.id = r.broadcast_id
     AND r.whatsapp_message_id = p_provider_message_id
     AND (p_account IS NULL OR b.account_id = p_account)
     AND public._wa_status_advances(r.status, p_status);
  GET DIAGNOSTICS n_recipients = ROW_COUNT;

  RETURN jsonb_build_object('messages', n_messages, 'recipients', n_recipients);
END
$$;

REVOKE ALL ON FUNCTION public.apply_message_receipt(UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_message_receipt(UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ) TO service_role;

-- The row-creation side takes the same lock before reading pending.
CREATE OR REPLACE FUNCTION public._apply_pending_status_to_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct UUID;
  p RECORD;
BEGIN
  IF NEW.message_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wa-receipt:' || NEW.message_id));
  SELECT c.account_id INTO acct FROM public.conversations c WHERE c.id = NEW.conversation_id;
  FOR p IN
    SELECT s.* FROM public.message_status_pending s
    WHERE s.provider_message_id = NEW.message_id
      AND s.scope IN (acct::text, 'global')
    ORDER BY CASE s.status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END
  LOOP
    UPDATE public.messages m
       SET status = p.status,
           error_code    = CASE WHEN p.status = 'failed' THEN (p.failure->>'code')::INTEGER ELSE m.error_code END,
           error_title   = CASE WHEN p.status = 'failed' THEN p.failure->>'title' ELSE m.error_title END,
           error_details = CASE WHEN p.status = 'failed' THEN p.failure->>'details' ELSE m.error_details END
     WHERE m.id = NEW.id
       AND public._wa_status_advances(m.status, p.status);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public._apply_pending_status_to_recipient()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct UUID;
  p RECORD;
BEGIN
  IF NEW.whatsapp_message_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.whatsapp_message_id IS NOT DISTINCT FROM NEW.whatsapp_message_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wa-receipt:' || NEW.whatsapp_message_id));
  SELECT b.account_id INTO acct FROM public.broadcasts b WHERE b.id = NEW.broadcast_id;
  FOR p IN
    SELECT s.* FROM public.message_status_pending s
    WHERE s.provider_message_id = NEW.whatsapp_message_id
      AND s.scope IN (acct::text, 'global')
    ORDER BY CASE s.status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END
  LOOP
    UPDATE public.broadcast_recipients r
       SET status        = p.status,
           sent_at       = CASE WHEN p.status = 'sent' THEN COALESCE(r.sent_at, p.status_at) ELSE r.sent_at END,
           delivered_at  = CASE WHEN p.status = 'delivered' THEN p.status_at ELSE r.delivered_at END,
           read_at       = CASE WHEN p.status = 'read' THEN p.status_at ELSE r.read_at END,
           error_message = CASE WHEN p.status = 'failed'
                                THEN COALESCE('[' || (p.failure->>'code') || '] ' || (p.failure->>'title'), r.error_message)
                                ELSE r.error_message END
     WHERE r.id = NEW.id
       AND public._wa_status_advances(r.status, p.status);
  END LOOP;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public._apply_pending_status_to_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._apply_pending_status_to_recipient() FROM PUBLIC, anon, authenticated;
