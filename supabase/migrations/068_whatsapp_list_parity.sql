-- ============================================================
-- 068_whatsapp_list_parity.sql — the chat list reads like the phone's
--     (phase 5f)
--
-- conversations
--   is_self              the chat with your own number ("Seu Nome (Você)").
--                        Kept by triggers: a conversation whose wa_chat_id
--                        is the linked number's chat, and again when the
--                        linked number changes.
--   last_message_status  the status of the newest message when it is yours
--                        (sent / delivered / read / …), NULL when the newest
--                        is the contact's: the list shows ✓ / ✓✓ / blue ✓✓
--                        before the preview, like WhatsApp. Kept by a
--                        trigger on messages, so receipts move it too.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_message_status TEXT;

-- The newest-message lookups below (and the thread's ordering).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC);

-- ---- last_message_status ------------------------------------------
CREATE OR REPLACE FUNCTION public.messages_track_last_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  next_status TEXT := CASE WHEN NEW.sender_type IN ('agent', 'bot') THEN NEW.status END;
BEGIN
  -- Only the conversation's newest message decides (ties: the higher id).
  IF EXISTS (
    SELECT 1 FROM public.messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND (m.created_at > NEW.created_at OR (m.created_at = NEW.created_at AND m.id > NEW.id))
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE public.conversations c
     SET last_message_status = next_status
   WHERE c.id = NEW.conversation_id
     AND c.last_message_status IS DISTINCT FROM next_status;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.messages_track_last_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_track_last_status_ins ON public.messages;
CREATE TRIGGER messages_track_last_status_ins
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_track_last_status();

DROP TRIGGER IF EXISTS messages_track_last_status_upd ON public.messages;
CREATE TRIGGER messages_track_last_status_upd
  AFTER UPDATE OF status ON public.messages
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.messages_track_last_status();

-- Existing conversations.
UPDATE public.conversations c
   SET last_message_status = n.status
  FROM (
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id,
           CASE WHEN m.sender_type IN ('agent', 'bot') THEN m.status END AS status
      FROM public.messages m
     ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
  ) n
 WHERE n.conversation_id = c.id
   AND c.last_message_status IS DISTINCT FROM n.status;

-- ---- is_self -------------------------------------------------------
-- The linked number's own chat id: digits of whatsapp_openwa_config.phone.
CREATE OR REPLACE FUNCTION public.openwa_self_chat_id(p_account_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT nullif(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), '') || '@c.us'
    FROM public.whatsapp_openwa_config o
   WHERE o.account_id = p_account_id
$$;

REVOKE ALL ON FUNCTION public.openwa_self_chat_id(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.conversations_mark_self()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.is_self := coalesce(NEW.wa_chat_id = public.openwa_self_chat_id(NEW.account_id), false)
                 AND NOT NEW.is_group;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.conversations_mark_self() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_mark_self ON public.conversations;
CREATE TRIGGER conversations_mark_self
  BEFORE INSERT OR UPDATE OF wa_chat_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_mark_self();

-- A new number linked: its own chat is the self chat from now on.
CREATE OR REPLACE FUNCTION public.openwa_config_remark_self()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  self_id TEXT := nullif(regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g'), '') || '@c.us';
BEGIN
  UPDATE public.conversations c
     SET is_self = coalesce(c.wa_chat_id = self_id, false) AND NOT c.is_group
   WHERE c.account_id = NEW.account_id
     AND (c.is_self OR c.wa_chat_id = self_id)
     AND c.is_self IS DISTINCT FROM (coalesce(c.wa_chat_id = self_id, false) AND NOT c.is_group);
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.openwa_config_remark_self() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS openwa_config_remark_self ON public.whatsapp_openwa_config;
CREATE TRIGGER openwa_config_remark_self
  AFTER INSERT OR UPDATE OF phone ON public.whatsapp_openwa_config
  FOR EACH ROW EXECUTE FUNCTION public.openwa_config_remark_self();

-- Existing conversations.
UPDATE public.conversations c
   SET is_self = true
  FROM public.whatsapp_openwa_config o
 WHERE o.account_id = c.account_id
   AND NOT c.is_self
   AND NOT c.is_group
   AND c.wa_chat_id = nullif(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), '') || '@c.us';

NOTIFY pgrst, 'reload schema';
