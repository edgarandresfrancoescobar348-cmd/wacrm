-- ============================================================
-- 050_message_status_pending
--
-- Delivery receipts can arrive BEFORE the row they describe exists.
-- OpenWA dispatches `message.ack` asynchronously and the Cloud API can
-- be just as quick: the "read" ack lands while the sender is still
-- writing its `messages` row (or a broadcast is still stamping its
-- recipient's `whatsapp_message_id`). The update matched nothing, the
-- receipt was dropped, and the sender then wrote `sent` — the tick
-- stayed wrong forever.
--
-- Such receipts are now kept in `message_status_pending` (written by
-- the webhook ingestion, service role only) and applied by triggers the
-- moment the message or the recipient row appears. Application is
-- monotonic: a status only ever moves forward on the
-- pending → sent → delivered → read ladder, and `failed` only from
-- pending/sending/sent — the same rule the webhook applies in app code.
--
-- `scope` is the account id for providers whose message ids are only
-- unique per number (OpenWA), or 'global' for Meta wamids (matched
-- globally, as the Meta webhook always has). Rows expire (app side,
-- ~3 days). Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS message_status_pending (
  scope               TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  failure             JSONB,
  status_at           TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_status_pending_id
  ON message_status_pending(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_pending_created
  ON message_status_pending(created_at);

ALTER TABLE message_status_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE message_status_pending FROM anon, authenticated;

-- Ladder: does `nxt` move a row forward from `cur`?
CREATE OR REPLACE FUNCTION public._wa_status_advances(cur TEXT, nxt TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN nxt = 'failed' THEN cur IN ('pending', 'sending', 'sent')
    WHEN cur = 'failed' THEN false
    ELSE (CASE nxt WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'replied' THEN 4 ELSE -1 END)
       > (CASE cur WHEN 'pending' THEN 0 WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                   WHEN 'read' THEN 3 WHEN 'replied' THEN 4 ELSE 0 END)
  END
$$;

-- New message row → apply any receipt that was waiting for it.
-- SECURITY DEFINER: the sender may be an RLS-scoped user client, which
-- can't (and mustn't) read message_status_pending.
CREATE OR REPLACE FUNCTION public._apply_pending_status_to_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct UUID;
  p RECORD;
BEGIN
  IF NEW.message_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT account_id INTO acct FROM conversations WHERE id = NEW.conversation_id;
  FOR p IN
    SELECT * FROM message_status_pending
    WHERE provider_message_id = NEW.message_id
      AND scope IN (acct::text, 'global')
    ORDER BY CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END
  LOOP
    UPDATE messages
       SET status = p.status,
           error_code    = CASE WHEN p.status = 'failed' THEN (p.failure->>'code')::INTEGER ELSE error_code END,
           error_title   = CASE WHEN p.status = 'failed' THEN p.failure->>'title' ELSE error_title END,
           error_details = CASE WHEN p.status = 'failed' THEN p.failure->>'details' ELSE error_details END
     WHERE id = NEW.id
       AND public._wa_status_advances(status, p.status);
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS apply_pending_status ON messages;
CREATE TRIGGER apply_pending_status
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public._apply_pending_status_to_message();

-- Recipient gets its provider message id → apply waiting receipts.
CREATE OR REPLACE FUNCTION public._apply_pending_status_to_recipient()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  SELECT account_id INTO acct FROM broadcasts WHERE id = NEW.broadcast_id;
  FOR p IN
    SELECT * FROM message_status_pending
    WHERE provider_message_id = NEW.whatsapp_message_id
      AND scope IN (acct::text, 'global')
    ORDER BY CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END
  LOOP
    UPDATE broadcast_recipients
       SET status        = p.status,
           delivered_at  = CASE WHEN p.status = 'delivered' THEN p.status_at ELSE delivered_at END,
           read_at       = CASE WHEN p.status = 'read' THEN p.status_at ELSE read_at END,
           error_message = CASE WHEN p.status = 'failed'
                                THEN COALESCE('[' || (p.failure->>'code') || '] ' || (p.failure->>'title'), error_message)
                                ELSE error_message END
     WHERE id = NEW.id
       AND public._wa_status_advances(status, p.status);
  END LOOP;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS apply_pending_status ON broadcast_recipients;
CREATE TRIGGER apply_pending_status
  AFTER INSERT OR UPDATE OF whatsapp_message_id ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public._apply_pending_status_to_recipient();

REVOKE ALL ON FUNCTION public._apply_pending_status_to_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._apply_pending_status_to_recipient() FROM PUBLIC, anon, authenticated;
