-- ============================================================
-- 073_fanout_outcomes.sql — fourth review K3/K4, K5
--
-- K3/K4  Fan-out tasks get a `held` status: a step whose outcome is
--     uncertain stops the task for a person instead of completing it.
--
-- K5  The fan-out inputs are stored with the inbound message
--     (messages.ingest_fanout) so a message whose completion couldn't be
--     written is completed later by the cron
--     (complete_stale_inbound_messages) — through the outbox, never by a
--     side-channel run.
--
-- Idempotent. Service-role only.
-- ============================================================

-- ------------------------------------------------------------ K3/K4
ALTER TABLE public.inbound_fanout_tasks DROP CONSTRAINT IF EXISTS inbound_fanout_tasks_status_check;
ALTER TABLE public.inbound_fanout_tasks ADD CONSTRAINT inbound_fanout_tasks_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'held'));

-- ------------------------------------------------------------ K5
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS ingest_fanout JSONB;
-- When the row was written by ingestion (created_at is the provider's
-- message time, which can be much older).
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ DEFAULT now();

-- Complete inbound messages whose completion never got written (the
-- webhook was acknowledged up front and the write failed, or the worker
-- died): re-open a closed thread as ingestion does, then complete and
-- enqueue through the same function (066/070) — the fan-out then runs
-- from the outbox like any other. Only rows with stored fan-out inputs.
CREATE OR REPLACE FUNCTION public.complete_stale_inbound_messages(
  p_limit           INTEGER,
  p_min_age_seconds INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m RECORD;
  n INTEGER := 0;
BEGIN
  FOR m IN
    SELECT msg.id, msg.conversation_id, msg.ingest_fanout
      FROM public.messages msg
     WHERE msg.ingest_completed_at IS NULL
       AND msg.ingest_fanout IS NOT NULL
       AND msg.ingested_at <= now() - make_interval(secs => p_min_age_seconds)
     ORDER BY msg.ingested_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.conversations SET status = 'open', updated_at = now()
     WHERE id = m.conversation_id AND status = 'closed';
    IF public.complete_inbound_message(
         m.conversation_id,
         COALESCE(m.ingest_fanout->>'lastMessageText', '[message]'),
         m.id,
         (m.ingest_fanout->>'accountId')::uuid,
         m.ingest_fanout) THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END
$$;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.complete_stale_inbound_messages(integer,integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
