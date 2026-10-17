-- ============================================================
-- 080_whatsapp_parity.sql — the QR-code inbox matches the phone's
--     WhatsApp (phase 5e)
--
-- conversations
--   wa_chat_id         the WhatsApp chat id (5511…@c.us, …@lid, …@g.us)
--                      of a QR-code conversation; unique per account.
--   is_group           a WhatsApp group (no CRM contact: contact_id NULL).
--   group_name, group_avatar_url
--   archived           mirrored from the phone; out of the main list.
--   pinned_at          set while pinned on the phone (pinned chats first).
--   last_message_sender  the group member who sent the last message
--                      (preview "Luciana Alves: …").
-- messages
--   sender_wa_id, sender_name   who sent a group message.
--   is_forwarded, forwarding_score  "Encaminhada" / "many times".
--   media_meta         what WhatsApp declares about the media without
--                      downloading it: { thumbnail (base64 JPEG),
--                      durationSeconds, pageCount, sizeBytes, mimetype,
--                      played }.
-- contacts
--   name_source        where `name` came from: saved (the phone's address
--                      book), verified (business name), push (the
--                      sender's own profile name), phone, import, manual.
--                      A name a CRM user typed (manual) is never
--                      overwritten by WhatsApp; saved > verified > push.
--   push_name          the sender's profile name, kept apart.
--   A trigger marks a name written by an app user (authenticated role)
--   as manual — every edit path, without touching each one.
--
-- bump_group_conversation(): newest-wins summary + unread for group
-- messages (they never run the contact pipeline: no bots, no CRM contact).
--
-- Idempotent.
-- ============================================================

-- ---- conversations -------------------------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS wa_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS group_name TEXT,
  ADD COLUMN IF NOT EXISTS group_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_sender TEXT;

ALTER TABLE public.conversations ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_contact_or_group;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_contact_or_group CHECK (is_group OR contact_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_wa_chat
  ON public.conversations (account_id, wa_chat_id) WHERE wa_chat_id IS NOT NULL;

-- ---- messages ------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sender_wa_id TEXT,
  ADD COLUMN IF NOT EXISTS sender_name TEXT,
  ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forwarding_score INTEGER,
  ADD COLUMN IF NOT EXISTS media_meta JSONB;

-- ---- contacts ------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS name_source TEXT,
  ADD COLUMN IF NOT EXISTS push_name TEXT;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_name_source_check;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_name_source_check
  CHECK (name_source IS NULL OR name_source IN ('saved', 'verified', 'push', 'phone', 'import', 'manual'));

-- A name written by an app user (PostgREST as `authenticated`) is the
-- user's: mark it manual unless the same statement set the source.
CREATE OR REPLACE FUNCTION public.contacts_mark_manual_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  role TEXT := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
BEGIN
  IF role IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.name_source IS NULL AND coalesce(NEW.name, '') <> '' THEN
      NEW.name_source := 'manual';
    END IF;
  ELSIF NEW.name IS DISTINCT FROM OLD.name AND NEW.name_source IS NOT DISTINCT FROM OLD.name_source THEN
    NEW.name_source := 'manual';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS contacts_mark_manual_name ON public.contacts;
CREATE TRIGGER contacts_mark_manual_name
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_mark_manual_name();

-- ---- history import checkpoints ------------------------------------
-- The chat list's state per chat, applied when the chat is imported.
DO $$
BEGIN
  IF to_regclass('public.whatsapp_history_import_chats') IS NOT NULL THEN
    ALTER TABLE public.whatsapp_history_import_chats
      ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
  END IF;
END
$$;

-- ---- group conversation summary ------------------------------------
-- Newest-wins preview/time; unread +1 for an inbound message. Returns
-- whether the summary moved.
CREATE OR REPLACE FUNCTION public.bump_group_conversation(
  p_conversation_id UUID,
  p_account_id      UUID,
  p_last_text       TEXT,
  p_sender          TEXT,
  p_at              TIMESTAMPTZ,
  p_inbound         BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  moved BOOLEAN;
BEGIN
  UPDATE public.conversations c
     SET last_message_text = CASE WHEN c.last_message_at IS NULL OR c.last_message_at <= p_at THEN p_last_text ELSE c.last_message_text END,
         last_message_sender = CASE WHEN c.last_message_at IS NULL OR c.last_message_at <= p_at THEN p_sender ELSE c.last_message_sender END,
         last_message_at = GREATEST(coalesce(c.last_message_at, p_at), p_at),
         unread_count = coalesce(c.unread_count, 0) + CASE WHEN p_inbound THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE c.id = p_conversation_id AND c.account_id = p_account_id AND c.is_group
  RETURNING (c.last_message_at = p_at) INTO moved;
  RETURN coalesce(moved, false);
END
$$;

REVOKE ALL ON FUNCTION public.bump_group_conversation(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_group_conversation(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
