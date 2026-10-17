-- ============================================================
-- 083_whatsapp_untimed_chats.sql — chats with no time on the phone go to
--     the end of the QR-code list (phase 5f, real account round 2)
--
-- WhatsApp lists chats nobody has written in (most often groups) with
-- timestamp 0, at the bottom. The history import gave those conversations
-- the import's time as last_message_at, which put hundreds of empty groups
-- on top of the inbox. The import no longer does (history-import.ts); this
-- takes that time back from rows it already gave it: a conversation the
-- import listed with no chat timestamp, no WhatsApp position (wa_sort_at),
-- an empty preview and no real message (only "waiting" placeholders, or
-- nothing). Rows with a message, or a time from the phone, are untouched.
-- Idempotent.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.whatsapp_history_import_chats') IS NOT NULL THEN
    UPDATE public.conversations c
       SET last_message_at = NULL
      FROM public.whatsapp_history_import_chats ch
     WHERE ch.conversation_id = c.id
       AND ch.account_id = c.account_id
       AND COALESCE(ch.chat_timestamp, 0) <= 0
       AND c.wa_sort_at IS NULL
       AND c.last_message_at IS NOT NULL
       AND COALESCE(c.last_message_text, '') = ''
       AND NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.conversation_id = c.id
            AND COALESCE(m.content_meta->>'kind', '') <> 'waiting'
       );
  END IF;
END
$$;
