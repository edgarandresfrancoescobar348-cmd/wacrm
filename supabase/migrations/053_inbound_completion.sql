-- ============================================================
-- 053_inbound_completion
--
-- An inbound message's essential follow-up — the conversation's unread
-- count and last-message summary — used to be a separate write after
-- the idempotent message insert. If it failed (or the worker died) the
-- delivery could still be acknowledged, and a redelivery found the
-- message already present and returned early, so the skipped step was
-- never repaired (second review G5).
--
-- `messages.ingest_completed_at` marks the inbound processing as
-- complete. The 3-argument bump_conversation_on_inbound overload sets
-- it AND bumps the conversation in one statement-level transaction, only
-- if it wasn't set yet — so it is idempotent: a redelivery of an
-- incomplete message completes it exactly once; a redelivery of a
-- complete one is a no-op.
--
-- Existing rows are backfilled as complete (they were processed by the
-- old path); new rows start NULL. Idempotent.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'ingest_completed_at'
  ) THEN
    ALTER TABLE public.messages ADD COLUMN ingest_completed_at TIMESTAMPTZ DEFAULT now();
    ALTER TABLE public.messages ALTER COLUMN ingest_completed_at DROP DEFAULT;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT,
  p_message_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.messages
     SET ingest_completed_at = now()
   WHERE id = p_message_id
     AND conversation_id = p_conversation_id
     AND ingest_completed_at IS NULL;
  IF NOT FOUND THEN
    RETURN false; -- already completed (or not this conversation's)
  END IF;
  UPDATE public.conversations
     SET unread_count      = COALESCE(unread_count, 0) + 1,
         last_message_text = p_last_message_text,
         last_message_at   = now(),
         updated_at        = now()
   WHERE id = p_conversation_id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, UUID) TO service_role;
