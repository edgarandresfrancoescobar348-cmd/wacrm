-- ============================================================
-- 057_inbound_fanout_outbox.sql — the inbound fan-out is durable
--     (third review H1, F3 residue)
--
-- The problem
--
--   After an inbound message was stored and completed (053), its
--   fan-out — flows, automations, the AI auto-reply, public webhooks —
--   lived only as closures in the request that processed it. If that
--   request then failed to mark the delivery done (a transient ledger
--   write error), it answered 503 BEFORE scheduling them, and the
--   redelivery found the message complete and returned: the bot reply
--   for that message never ran. A process dying at the wrong moment had
--   the same effect.
--
-- The fix
--
--   The fan-out is an outbox row, written in the SAME transaction that
--   marks the message complete (complete_inbound_message). Whoever
--   processes the message runs it right after (inline or in after());
--   a redelivery, and the existing cron as a safety net, run it if that
--   didn't happen. A worker claims a task with a lease (only one runs
--   it at a time) and records each step as it finishes, so a re-run
--   resumes after the last recorded step. A completed message that is
--   redelivered enqueues nothing: one task per message (UNIQUE).
--
-- Idempotent. Service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inbound_fanout_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  -- Everything the fan-out needs, captured when the message completed.
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  lease_until     TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Steps already run: { "flows": {"consumed": true}, "automations": true, … }
  progress        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inbound_fanout_tasks_due
  ON public.inbound_fanout_tasks (next_attempt_at)
  WHERE status IN ('pending', 'running', 'failed');

ALTER TABLE public.inbound_fanout_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_fanout_tasks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inbound_fanout_tasks TO service_role;

-- ------------------------------------------------------------
-- Complete an inbound message (053: mark + unread/summary bump, once)
-- AND enqueue its fan-out, in one transaction. Returns false when the
-- message was already complete (nothing enqueued, nothing bumped).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_inbound_message(
  p_conversation_id   UUID,
  p_last_message_text TEXT,
  p_message_id        UUID,
  p_account_id        UUID,
  p_fanout            JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.bump_conversation_on_inbound(p_conversation_id, p_last_message_text, p_message_id) THEN
    RETURN false;
  END IF;
  IF p_fanout IS NOT NULL THEN
    INSERT INTO public.inbound_fanout_tasks (account_id, message_id, payload)
    VALUES (p_account_id, p_message_id, p_fanout)
    ON CONFLICT (message_id) DO NOTHING;
  END IF;
  RETURN true;
END
$$;

-- ------------------------------------------------------------
-- Claim due fan-out tasks: one message's (p_message_id) or any
-- (p_message_id NULL, the cron). A pending task younger than
-- p_min_age_seconds is left to the request that created it. A running
-- task whose lease ran out (its worker died) and a failed one whose
-- backoff is due are claimable again. SKIP LOCKED: concurrent claimers
-- never get the same task.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_inbound_fanout(
  p_message_id      UUID,
  p_limit           INTEGER,
  p_min_age_seconds INTEGER,
  p_lease_seconds   INTEGER
)
RETURNS SETOF public.inbound_fanout_tasks
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.inbound_fanout_tasks t
     SET status = 'running',
         attempts = t.attempts + 1,
         lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE t.id IN (
     SELECT c.id FROM public.inbound_fanout_tasks c
      WHERE (p_message_id IS NULL OR c.message_id = p_message_id)
        AND (
          (c.status = 'pending' AND c.next_attempt_at <= now()
             AND c.created_at <= now() - make_interval(secs => p_min_age_seconds))
          OR (c.status = 'running' AND c.lease_until < now())
          OR (c.status = 'failed' AND c.attempts < 6 AND c.next_attempt_at <= now())
        )
      ORDER BY c.created_at
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   )
  RETURNING t.*;
END
$$;

REVOKE ALL ON FUNCTION public.complete_inbound_message(UUID, TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_inbound_message(UUID, TEXT, UUID, UUID, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.claim_inbound_fanout(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_inbound_fanout(UUID, INTEGER, INTEGER, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
