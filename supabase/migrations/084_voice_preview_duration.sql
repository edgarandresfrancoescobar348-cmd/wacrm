-- ============================================================
-- 084_voice_preview_duration.sql — the list preview of a voice note
--     carries its length, also for conversations already stored
--     (phase 5f, real account round 3)
--
-- The list showed "Mensagem de voz" ('[voice]') while the bubble said
-- 0:04: the preview is written when the message arrives, and the length
-- can come later — a re-import fills media_meta.durationSeconds, the
-- bubble learns it from the file. When a voice note's length lands in
-- media_meta and it is still its conversation's newest message, its
-- '[voice]' preview becomes '[voice:0:04]' (previewFor's token,
-- formatDuration: m:ss). Existing conversations are backfilled.
-- Only a bare '[voice]' preview is touched. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.voice_preview_token(p_seconds NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT '[voice:' || (round(p_seconds)::bigint / 60)::text || ':' || lpad((round(p_seconds)::bigint % 60)::text, 2, '0') || ']'
$$;

CREATE OR REPLACE FUNCTION public.messages_voice_preview_duration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.content_meta->>'kind' IS DISTINCT FROM 'voice'
     OR jsonb_typeof(NEW.media_meta->'durationSeconds') IS DISTINCT FROM 'number'
     OR (NEW.media_meta->>'durationSeconds')::numeric <= 0
     OR NEW.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  -- Only while it is the conversation's newest real message ("waiting"
  -- placeholders don't count, like the import's summary).
  IF EXISTS (
    SELECT 1 FROM public.messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND (m.created_at > NEW.created_at OR (m.created_at = NEW.created_at AND m.id > NEW.id))
       AND m.content_meta->>'kind' IS DISTINCT FROM 'waiting'
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE public.conversations c
     SET last_message_text = public.voice_preview_token((NEW.media_meta->>'durationSeconds')::numeric)
   WHERE c.id = NEW.conversation_id
     AND c.last_message_text = '[voice]';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.messages_voice_preview_duration() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_voice_preview_duration ON public.messages;
CREATE TRIGGER messages_voice_preview_duration
  AFTER UPDATE OF media_meta ON public.messages
  FOR EACH ROW WHEN (OLD.media_meta IS DISTINCT FROM NEW.media_meta)
  EXECUTE FUNCTION public.messages_voice_preview_duration();

-- Existing conversations: '[voice]' whose newest real message is a voice
-- note with a known length.
WITH last AS (
  SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.content_meta, m.media_meta, m.revoked_at
    FROM public.messages m
   WHERE m.conversation_id IN (SELECT id FROM public.conversations WHERE last_message_text = '[voice]')
     AND m.content_meta->>'kind' IS DISTINCT FROM 'waiting'
   ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
)
UPDATE public.conversations c
   SET last_message_text = public.voice_preview_token((last.media_meta->>'durationSeconds')::numeric)
  FROM last
 WHERE last.conversation_id = c.id
   AND c.last_message_text = '[voice]'
   AND last.content_meta->>'kind' = 'voice'
   AND last.revoked_at IS NULL
   AND jsonb_typeof(last.media_meta->'durationSeconds') = 'number'
   AND (last.media_meta->>'durationSeconds')::numeric > 0;
