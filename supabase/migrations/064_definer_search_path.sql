-- ============================================================
-- 064_definer_search_path
--
-- Migration 063's SECURITY DEFINER trigger functions set
-- `search_path = public` and used unqualified table names. PostgreSQL
-- still searches the session's temporary schema FIRST for relations
-- unless pg_temp is listed explicitly — so a session allowed to create
-- temp tables could shadow `messages` / `message_status_pending` / …
-- with its own and have the trigger (running as the function owner)
-- touch them, firing the session's own triggers with the owner's
-- privileges.
--
-- Recreated here with every relation schema-qualified AND
-- `SET search_path = pg_catalog, public, pg_temp` (pg_temp last), the
-- pattern PostgreSQL documents for SECURITY DEFINER functions. Behaviour
-- is otherwise unchanged. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public._wa_status_advances(cur TEXT, nxt TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN nxt = 'failed' THEN cur IN ('pending', 'sending', 'sent')
    WHEN cur = 'failed' THEN false
    ELSE (CASE nxt WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'replied' THEN 4 ELSE -1 END)
       > (CASE cur WHEN 'pending' THEN 0 WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                   WHEN 'read' THEN 3 WHEN 'replied' THEN 4 ELSE 0 END)
  END
$$;

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
  SELECT b.account_id INTO acct FROM public.broadcasts b WHERE b.id = NEW.broadcast_id;
  FOR p IN
    SELECT s.* FROM public.message_status_pending s
    WHERE s.provider_message_id = NEW.whatsapp_message_id
      AND s.scope IN (acct::text, 'global')
    ORDER BY CASE s.status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END
  LOOP
    UPDATE public.broadcast_recipients r
       SET status        = p.status,
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
