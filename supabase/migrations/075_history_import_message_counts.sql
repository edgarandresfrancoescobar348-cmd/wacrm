-- ============================================================
-- 075_history_import_message_counts.sql — what a re-import did
--
-- The history import counted only the messages it INSERTED. A re-import
-- of a number already imported finds almost everything stored and, after
-- refreshing ~14 thousand of them (ticks, parity details, placeholders
-- that became real), the card said "Mensagens 1" (owner, phase 6). Two
-- counters per job:
--
--   messages_seen     messages the import found already stored
--   messages_updated  of those, the ones it changed
--
-- Idempotent; existing jobs read 0.
-- ============================================================

ALTER TABLE public.whatsapp_history_imports
  ADD COLUMN IF NOT EXISTS messages_seen INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_updated INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
