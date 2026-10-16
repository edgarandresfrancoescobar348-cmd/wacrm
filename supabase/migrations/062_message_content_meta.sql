-- ============================================================
-- 062_message_content_meta.sql — the structure of a message kind
--     (owner adjustment A2: every message type renders the same in
--     both connection modes)
--
-- `content_type` keeps its CHECK vocabulary (text, image, document,
-- audio, video, location, template, interactive). What a kind needs
-- beyond text + media — a location's coordinates, a shared contact's
-- name and phones, a poll's question and options, a call's
-- video/missed flags, an order or product, a sticker or voice note, a
-- message withheld from linked devices — goes here, written the same
-- way by the official API webhook and the QR-code (OpenWA) ingestion,
-- live and imported. NULL for plain messages and every older row.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS content_meta JSONB;

COMMENT ON COLUMN public.messages.content_meta IS
  'Kind-specific structure ({"kind":"location"|"contact"|"poll"|"call"|"order"|"product"|"masked"|"sticker"|"voice"|"document", …}); see src/lib/whatsapp/message-content.ts';
