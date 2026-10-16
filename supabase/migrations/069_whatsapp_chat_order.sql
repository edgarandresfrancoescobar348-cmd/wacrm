-- ============================================================
-- 069_whatsapp_chat_order.sql — the QR-code list in the phone's order
--     (phase 5f)
--
-- conversations.wa_sort_at  WhatsApp's own timestamp for the chat (the
--                           chat list's `timestamp`). The phone orders by
--                           it, and it can be newer than the last message
--                           wacrm has (a chat whose content WhatsApp hasn't
--                           delivered yet, an event that isn't a message).
--                           The inbox orders by the later of it and
--                           last_message_at. Set by the history import and
--                           the chat-state sync; NULL for official-API
--                           conversations, which keep last_message_at.
--
-- Backfills from the history import's checkpoints. Idempotent.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS wa_sort_at TIMESTAMPTZ;

DO $$
BEGIN
  IF to_regclass('public.whatsapp_history_import_chats') IS NOT NULL THEN
    UPDATE public.conversations c
       SET wa_sort_at = to_timestamp(ch.chat_timestamp)
      FROM public.whatsapp_history_import_chats ch
     WHERE ch.conversation_id = c.id
       AND ch.account_id = c.account_id
       AND ch.chat_timestamp IS NOT NULL
       AND ch.chat_timestamp > 0
       AND c.wa_sort_at IS DISTINCT FROM to_timestamp(ch.chat_timestamp);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
