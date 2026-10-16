-- ============================================================
-- 063_whatsapp_history_import.sql — import the chat history a QR-code
--     (OpenWA) connection gives the linked device (owner adjustment A1)
--
-- A background job per account: list the individual chats
-- (GET /sessions/:id/chats), then per chat import its history
-- (GET …/messages/:chatId/history?deep=true; on Baileys the gateway's
-- stored messages). Resumable — the per-chat rows are the checkpoint —
-- and idempotent: messages are keyed (conversation_id, message_id) like
-- every other path, so a re-run or a webhook that delivers the same
-- message during the import never duplicates it.
--
-- Imported messages carry `imported_at` and are stored COMPLETE
-- (ingest_completed_at): they never run bots, automations, flows, AI,
-- public webhooks or notifications, and never add to unread (the
-- conversation takes the chat's unread count from /chats instead).
--
-- Idempotent. The job tables are read by account members (progress on
-- the settings page) and written by the service role only.
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.whatsapp_history_imports (
  account_id        UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'listing', 'importing', 'waiting_session', 'done', 'failed')),
  -- Messages newer than this are left to the live webhooks.
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until       TIMESTAMPTZ,
  -- Baileys has no live history: only what the gateway stored.
  limited_history   BOOLEAN NOT NULL DEFAULT false,
  chats_total       INTEGER NOT NULL DEFAULT 0,
  chats_done        INTEGER NOT NULL DEFAULT 0,
  chats_skipped     INTEGER NOT NULL DEFAULT 0,
  messages_imported INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_history_import_chats (
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  chat_id           TEXT NOT NULL,
  name              TEXT,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  chat_timestamp    BIGINT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  messages_imported INTEGER NOT NULL DEFAULT 0,
  conversation_id   UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_history_import_chats_pending
  ON public.whatsapp_history_import_chats (account_id, chat_timestamp DESC)
  WHERE status = 'pending';

ALTER TABLE public.whatsapp_history_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_history_import_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_history_imports_read ON public.whatsapp_history_imports;
CREATE POLICY whatsapp_history_imports_read ON public.whatsapp_history_imports
  FOR SELECT TO authenticated
  USING (account_id IN (SELECT p.account_id FROM public.profiles p WHERE p.user_id = auth.uid()));

REVOKE ALL ON public.whatsapp_history_imports, public.whatsapp_history_import_chats FROM PUBLIC, anon;
GRANT SELECT ON public.whatsapp_history_imports TO authenticated;
REVOKE ALL ON public.whatsapp_history_import_chats FROM authenticated;
GRANT ALL ON public.whatsapp_history_imports, public.whatsapp_history_import_chats TO service_role;

-- Claim the job for one run (lease), when it is due.
CREATE OR REPLACE FUNCTION public.claim_history_import(
  p_account_id    UUID,
  p_lease_seconds INTEGER
)
RETURNS SETOF public.whatsapp_history_imports
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.whatsapp_history_imports j
     SET lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE j.account_id = (
     SELECT c.account_id FROM public.whatsapp_history_imports c
      WHERE (p_account_id IS NULL OR c.account_id = p_account_id)
        AND c.status IN ('queued', 'listing', 'importing', 'waiting_session')
        AND c.next_run_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until < now())
      ORDER BY c.next_run_at
      LIMIT 1
        FOR UPDATE SKIP LOCKED)
  RETURNING j.*;
END
$$;

REVOKE ALL ON FUNCTION public.claim_history_import(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_history_import(UUID, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
