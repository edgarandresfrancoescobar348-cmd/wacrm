-- ============================================================
-- 072_whatsapp_connections.sql — several WhatsApp numbers per account
--     (phase 6)
--
-- Until now an account had ONE active connection (whatsapp_config.provider
-- = 'meta' | 'openwa'). From here an account has any number of
-- `whatsapp_connections`: at most one official number (Meta Cloud API)
-- plus any number of numbers paired by QR code (OpenWA). Each is
--
--   business  the team's ("Empresa"): every member sees its conversations,
--             bots / automations / flows / AI / broadcasts run on it;
--   personal  one member's ("Pessoal"): only that member sees its
--             conversations (073), nothing automated ever runs on it.
--
-- The official number is always business. Scope, provider, owner and
-- account never change after creation (re-pairing can't flip a personal
-- number into the team's inbox); "remove" is logical (`removed_at`) so a
-- number's history stays.
--
--   * whatsapp_config (Meta credentials) and whatsapp_openwa_config (one
--     OpenWA session) point at their connection (`connection_id`).
--     whatsapp_config.provider, set_openwa_active and the 058 mirror into
--     a single "active" flag are gone: each connection carries its own
--     `status`, derived in the same transaction from the session row
--     (QR) or from the credentials row (Meta).
--   * conversations.connection_id NOT NULL. One conversation per
--     (connection, contact) and per (connection, wa_chat_id): the same
--     person on two numbers is two conversations and ONE contact.
--   * The history import job and its checkpoints, the self-chat triggers
--     and the session-state RPC are per connection.
--   * conversations.saved_name: the name a PERSONAL number's address book
--     gives the contact. It stays on that conversation — never on the
--     shared CRM contact (073 keeps the rest of the personal data private).
--   * contacts.personal_only: the contact exists only because of a
--     personal number (073 hides it from everyone else).
--   * broadcasts.connection_id (the business number they go out from);
--     automations / flows .connection_id (NULL = the account's default
--     business number).
--
-- Existing data: every existing connection becomes a BUSINESS number, so
-- nothing anyone sees today changes. A conversation goes to the QR number
-- when it has a WhatsApp chat id (only QR conversations do) or is a group,
-- to the official number when one of its messages has a Meta wamid, and
-- otherwise to the number that was active. An account with conversations
-- but no connection at all gets a disconnected QR number "WhatsApp" so
-- its history keeps an owner.
--
-- Clean cut — the app of this phase must be deployed with it.
-- ============================================================

-- ---- 1. whatsapp_connections ----------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('meta', 'openwa')),
  scope                TEXT NOT NULL CHECK (scope IN ('personal', 'business')),
  -- The member a personal number belongs to (NULL for business).
  owner_user_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Optional name given in Settings; the UI falls back to the profile
  -- name / phone.
  label                TEXT,
  -- Health: derived from the session (QR) / the credentials row (Meta).
  status               TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  phone                TEXT,
  connected_at         TIMESTAMPTZ,
  -- Keep a copy of received media in storage (was whatsapp_config's).
  mirror_inbound_media BOOLEAN NOT NULL DEFAULT true,
  created_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  removed_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_connections_official_is_business CHECK (provider <> 'meta' OR scope = 'business'),
  CONSTRAINT whatsapp_connections_personal_owner CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL))
);

-- At most one official number per account (a removed one doesn't count).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_one_official
  ON public.whatsapp_connections (account_id) WHERE provider = 'meta' AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS whatsapp_connections_account ON public.whatsapp_connections (account_id);

ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;
-- No client policies: the browser reads numbers through the server
-- (/api/whatsapp/connections), which shows a personal number's phone only
-- to its owner. RLS helpers (073) are SECURITY DEFINER.
REVOKE ALL ON TABLE public.whatsapp_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.whatsapp_connections TO service_role;

DROP TRIGGER IF EXISTS set_updated_at ON public.whatsapp_connections;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Identity never changes; a personal number's owner is a member of the account.
CREATE OR REPLACE FUNCTION public.whatsapp_connections_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id) THEN
    RAISE EXCEPTION 'a WhatsApp number''s account, provider, scope and owner never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.owner_user_id AND p.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'the owner of a personal number must be a member of the account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.whatsapp_connections_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_connections_guard ON public.whatsapp_connections;
CREATE TRIGGER whatsapp_connections_guard
  BEFORE INSERT OR UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_connections_guard();

-- ---- 2. backfill: the account's existing connections -----------------
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE public.whatsapp_openwa_config ADD COLUMN IF NOT EXISTS connection_id UUID;

DO $$
DECLARE
  has_provider BOOLEAN := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_config' AND column_name = 'provider');
  r RECORD;
  cid UUID;
BEGIN
  IF NOT has_provider THEN
    RETURN; -- already migrated
  END IF;

  -- Official numbers: a config row with Meta credentials.
  FOR r IN
    EXECUTE 'SELECT id, account_id, user_id, status, connected_at, mirror_inbound_media, provider
               FROM public.whatsapp_config
              WHERE connection_id IS NULL AND phone_number_id IS NOT NULL'
  LOOP
    INSERT INTO public.whatsapp_connections
      (account_id, provider, scope, status, connected_at, mirror_inbound_media, created_by)
    VALUES (r.account_id, 'meta', 'business',
            CASE WHEN r.provider = 'meta' THEN r.status ELSE 'disconnected' END,
            CASE WHEN r.provider = 'meta' THEN r.connected_at END,
            r.mirror_inbound_media, r.user_id)
    RETURNING id INTO cid;
    UPDATE public.whatsapp_config SET connection_id = cid WHERE id = r.id;
  END LOOP;

  -- QR numbers: the account's OpenWA session row.
  FOR r IN
    SELECT o.id, o.account_id, o.user_id, o.status, o.connected_at, o.phone,
           coalesce(c.mirror_inbound_media, true) AS mirror
      FROM public.whatsapp_openwa_config o
      LEFT JOIN public.whatsapp_config c ON c.account_id = o.account_id
     WHERE o.connection_id IS NULL
  LOOP
    INSERT INTO public.whatsapp_connections
      (account_id, provider, scope, status, phone, connected_at, mirror_inbound_media, created_by)
    VALUES (r.account_id, 'openwa', 'business',
            CASE WHEN r.status = 'ready' THEN 'connected' ELSE 'disconnected' END,
            r.phone, CASE WHEN r.status = 'ready' THEN r.connected_at END, r.mirror, r.user_id)
    RETURNING id INTO cid;
    UPDATE public.whatsapp_openwa_config SET connection_id = cid WHERE id = r.id;
  END LOOP;

  -- An account with conversations but no connection keeps its history
  -- on a disconnected QR number.
  INSERT INTO public.whatsapp_connections (account_id, provider, scope, label, status)
  SELECT DISTINCT cv.account_id, 'openwa', 'business', 'WhatsApp', 'disconnected'
    FROM public.conversations cv
   WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_connections w WHERE w.account_id = cv.account_id);

  -- The config rows that existed only to say "QR mode is active" go;
  -- their media setting already moved to the connection.
  DELETE FROM public.whatsapp_config WHERE connection_id IS NULL;
END
$$;

-- ---- 3. whatsapp_config: the official number's credentials -----------
DROP TRIGGER IF EXISTS derive_openwa_config_status ON public.whatsapp_config;
DROP FUNCTION IF EXISTS public.derive_openwa_config_status();
DROP FUNCTION IF EXISTS public.set_openwa_active(UUID, UUID);
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_meta_credentials_check;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS provider;
ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS mirror_inbound_media;
ALTER TABLE public.whatsapp_config ALTER COLUMN phone_number_id SET NOT NULL;
ALTER TABLE public.whatsapp_config ALTER COLUMN access_token SET NOT NULL;
ALTER TABLE public.whatsapp_config ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_connection_id_fkey;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT whatsapp_config_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_connection ON public.whatsapp_config (connection_id);

-- ---- 4. whatsapp_openwa_config: one session per QR number ------------
ALTER TABLE public.whatsapp_openwa_config DROP CONSTRAINT IF EXISTS whatsapp_openwa_config_account_id_key;
ALTER TABLE public.whatsapp_openwa_config ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.whatsapp_openwa_config DROP CONSTRAINT IF EXISTS whatsapp_openwa_config_connection_id_fkey;
ALTER TABLE public.whatsapp_openwa_config
  ADD CONSTRAINT whatsapp_openwa_config_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_openwa_config_connection ON public.whatsapp_openwa_config (connection_id);
CREATE INDEX IF NOT EXISTS whatsapp_openwa_config_account ON public.whatsapp_openwa_config (account_id);

-- ---- 5. each number's health, in the same transaction ----------------
-- Replaces 058's mirror into the single "active" flag.
DROP TRIGGER IF EXISTS mirror_openwa_session_status ON public.whatsapp_openwa_config;

CREATE OR REPLACE FUNCTION public.mirror_openwa_session_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.whatsapp_connections w
     SET status = public.openwa_config_status(NEW.status),
         connected_at = CASE WHEN NEW.status = 'ready' THEN COALESCE(NEW.connected_at, w.connected_at, now()) END,
         phone = NEW.phone
   WHERE w.id = NEW.connection_id
     AND (w.status IS DISTINCT FROM public.openwa_config_status(NEW.status)
          OR w.phone IS DISTINCT FROM NEW.phone
          OR (NEW.status <> 'ready' AND w.connected_at IS NOT NULL)
          OR (NEW.status = 'ready' AND w.connected_at IS NULL));
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.mirror_openwa_session_status() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER mirror_openwa_session_status
  AFTER INSERT OR UPDATE OF status, connected_at, phone ON public.whatsapp_openwa_config
  FOR EACH ROW EXECUTE FUNCTION public.mirror_openwa_session_status();

CREATE OR REPLACE FUNCTION public.mirror_meta_config_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.whatsapp_connections w
     SET status = NEW.status, connected_at = NEW.connected_at
   WHERE w.id = NEW.connection_id
     AND (w.status IS DISTINCT FROM NEW.status OR w.connected_at IS DISTINCT FROM NEW.connected_at);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.mirror_meta_config_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS mirror_meta_config_status ON public.whatsapp_config;
CREATE TRIGGER mirror_meta_config_status
  AFTER INSERT OR UPDATE OF status, connected_at ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.mirror_meta_config_status();

-- Per-number lock and session-state RPC (061/064, now keyed by the number).
DROP FUNCTION IF EXISTS public.apply_openwa_session_state(UUID, JSONB, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.lock_whatsapp_connection(UUID);

CREATE FUNCTION public.lock_whatsapp_connection(p_connection_id UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('wa-connection:' || p_connection_id::text, 0))
$$;

CREATE FUNCTION public.apply_openwa_session_state(
  p_connection_id UUID,
  p_patch         JSONB,
  p_session_id    TEXT,
  p_event_at      TIMESTAMPTZ
)
RETURNS SETOF public.whatsapp_openwa_config
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cur public.whatsapp_openwa_config;
  nw  public.whatsapp_openwa_config;
BEGIN
  PERFORM public.lock_whatsapp_connection(p_connection_id);
  SELECT * INTO cur FROM public.whatsapp_openwa_config
   WHERE connection_id = p_connection_id
     AND (p_session_id IS NULL OR session_id = p_session_id)
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_event_at IS NOT NULL AND cur.status_event_at IS NOT NULL AND cur.status_event_at > p_event_at THEN
    RETURN; -- older than the state already applied
  END IF;
  nw := jsonb_populate_record(cur, p_patch);
  UPDATE public.whatsapp_openwa_config t
     SET engine = nw.engine,
         session_id = nw.session_id, session_name = nw.session_name,
         webhook_id = nw.webhook_id, webhook_secret = nw.webhook_secret,
         status = nw.status, phone = nw.phone, push_name = nw.push_name,
         last_error = nw.last_error, restriction = nw.restriction,
         reconnect_attempts = nw.reconnect_attempts,
         status_updated_at = nw.status_updated_at,
         status_event_at = CASE WHEN p_event_at IS NOT NULL THEN p_event_at ELSE nw.status_event_at END,
         connected_at = nw.connected_at,
         broadcast_delay_ms = nw.broadcast_delay_ms,
         updated_at = now()
   WHERE t.id = cur.id
  RETURNING t.* INTO nw;
  RETURN NEXT nw;
END
$$;

-- ---- 6. conversations: one per (number, contact) ----------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS connection_id UUID,
  ADD COLUMN IF NOT EXISTS saved_name TEXT;

WITH conns AS (
  SELECT a.account_id,
         (SELECT w.id FROM public.whatsapp_connections w
           WHERE w.account_id = a.account_id AND w.provider = 'openwa'
           ORDER BY w.created_at, w.id LIMIT 1) AS qr,
         (SELECT w.id FROM public.whatsapp_connections w
           WHERE w.account_id = a.account_id AND w.provider = 'meta'
           ORDER BY w.created_at, w.id LIMIT 1) AS meta,
         -- The number that was active: the QR one unless only Meta existed.
         EXISTS (SELECT 1 FROM public.whatsapp_openwa_config o WHERE o.account_id = a.account_id) AS had_qr
    FROM (SELECT DISTINCT account_id FROM public.conversations WHERE connection_id IS NULL) a
)
UPDATE public.conversations cv
   SET connection_id = CASE
         WHEN (cv.wa_chat_id IS NOT NULL OR cv.is_group) THEN coalesce(k.qr, k.meta)
         WHEN k.meta IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.messages m
            WHERE m.conversation_id = cv.id AND m.message_id LIKE 'wamid.%') THEN k.meta
         WHEN k.had_qr THEN coalesce(k.qr, k.meta)
         ELSE coalesce(k.meta, k.qr)
       END
  FROM conns k
 WHERE k.account_id = cv.account_id
   AND cv.connection_id IS NULL;

ALTER TABLE public.conversations ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_connection_id_fkey;
-- No cascade: a number is removed logically, its history stays.
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES public.whatsapp_connections(id);

DROP INDEX IF EXISTS public.idx_conversations_account_contact;
DROP INDEX IF EXISTS public.conversations_account_wa_chat;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_connection_contact
  ON public.conversations (connection_id, contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_connection_wa_chat
  ON public.conversations (connection_id, wa_chat_id) WHERE wa_chat_id IS NOT NULL;

-- A conversation never moves to another number or account.
CREATE OR REPLACE FUNCTION public.conversations_keep_connection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'a conversation''s WhatsApp number never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.conversations_keep_connection() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_keep_connection ON public.conversations;
CREATE TRIGGER conversations_keep_connection
  BEFORE UPDATE OF connection_id, account_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_keep_connection();

-- The number belongs to the conversation's account.
CREATE OR REPLACE FUNCTION public.conversations_connection_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections w WHERE w.id = NEW.connection_id AND w.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'the conversation''s WhatsApp number belongs to another account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.conversations_connection_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_connection_account ON public.conversations;
CREATE TRIGGER conversations_connection_account
  BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_connection_account();

-- 036's merge, per number.
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT connection_id, contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0) AS total_unread
      FROM conversations
     WHERE contact_id IS NOT NULL
     GROUP BY connection_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_survivor := v_group.ids[1];
    v_losers   := v_group.ids[2:array_length(v_group.ids, 1)];
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE conversations c
       SET unread_count = v_group.total_unread,
           last_message_text = lm.content_text,
           last_message_at = lm.created_at,
           updated_at = NOW()
      FROM (SELECT content_text, created_at FROM messages
             WHERE conversation_id = v_survivor ORDER BY created_at DESC LIMIT 1) lm
     WHERE c.id = v_survivor;
    UPDATE conversations SET unread_count = v_group.total_unread, updated_at = NOW()
     WHERE id = v_survivor AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);
    DELETE FROM conversations WHERE id = ANY(v_losers);
    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;
  RETURN v_merged;
END;
$$;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

-- ---- 7. self chat, per number (068) ----------------------------------
DROP TRIGGER IF EXISTS conversations_mark_self ON public.conversations;
DROP FUNCTION IF EXISTS public.openwa_self_chat_id(UUID);

CREATE FUNCTION public.openwa_self_chat_id(p_connection_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT nullif(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), '') || '@c.us'
    FROM public.whatsapp_openwa_config o
   WHERE o.connection_id = p_connection_id
$$;
REVOKE ALL ON FUNCTION public.openwa_self_chat_id(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.conversations_mark_self()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.is_self := coalesce(NEW.wa_chat_id = public.openwa_self_chat_id(NEW.connection_id), false)
                 AND NOT NEW.is_group;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.conversations_mark_self() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER conversations_mark_self
  BEFORE INSERT OR UPDATE OF wa_chat_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_mark_self();

CREATE OR REPLACE FUNCTION public.openwa_config_remark_self()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  self_id TEXT := nullif(regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g'), '') || '@c.us';
BEGIN
  UPDATE public.conversations c
     SET is_self = coalesce(c.wa_chat_id = self_id, false) AND NOT c.is_group
   WHERE c.connection_id = NEW.connection_id
     AND (c.is_self OR c.wa_chat_id = self_id)
     AND c.is_self IS DISTINCT FROM (coalesce(c.wa_chat_id = self_id, false) AND NOT c.is_group);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.openwa_config_remark_self() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS openwa_config_remark_self ON public.whatsapp_openwa_config;
CREATE TRIGGER openwa_config_remark_self
  AFTER INSERT OR UPDATE OF phone ON public.whatsapp_openwa_config
  FOR EACH ROW EXECUTE FUNCTION public.openwa_config_remark_self();

-- ---- 8. history import, per number (063) ------------------------------
ALTER TABLE public.whatsapp_history_imports ADD COLUMN IF NOT EXISTS connection_id UUID;
ALTER TABLE public.whatsapp_history_import_chats ADD COLUMN IF NOT EXISTS connection_id UUID;
UPDATE public.whatsapp_history_imports j
   SET connection_id = o.connection_id
  FROM public.whatsapp_openwa_config o
 WHERE o.account_id = j.account_id AND j.connection_id IS NULL;
UPDATE public.whatsapp_history_import_chats ch
   SET connection_id = o.connection_id
  FROM public.whatsapp_openwa_config o
 WHERE o.account_id = ch.account_id AND ch.connection_id IS NULL;
DELETE FROM public.whatsapp_history_imports WHERE connection_id IS NULL;
DELETE FROM public.whatsapp_history_import_chats WHERE connection_id IS NULL;

ALTER TABLE public.whatsapp_history_imports DROP CONSTRAINT IF EXISTS whatsapp_history_imports_pkey;
ALTER TABLE public.whatsapp_history_imports ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.whatsapp_history_imports ADD CONSTRAINT whatsapp_history_imports_pkey PRIMARY KEY (connection_id);
ALTER TABLE public.whatsapp_history_imports DROP CONSTRAINT IF EXISTS whatsapp_history_imports_connection_id_fkey;
ALTER TABLE public.whatsapp_history_imports
  ADD CONSTRAINT whatsapp_history_imports_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS whatsapp_history_imports_account ON public.whatsapp_history_imports (account_id);

ALTER TABLE public.whatsapp_history_import_chats DROP CONSTRAINT IF EXISTS whatsapp_history_import_chats_pkey;
ALTER TABLE public.whatsapp_history_import_chats ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE public.whatsapp_history_import_chats
  ADD CONSTRAINT whatsapp_history_import_chats_pkey PRIMARY KEY (connection_id, chat_id);
ALTER TABLE public.whatsapp_history_import_chats DROP CONSTRAINT IF EXISTS whatsapp_history_import_chats_connection_id_fkey;
ALTER TABLE public.whatsapp_history_import_chats
  ADD CONSTRAINT whatsapp_history_import_chats_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS public.whatsapp_history_import_chats_pending;
CREATE INDEX IF NOT EXISTS whatsapp_history_import_chats_pending
  ON public.whatsapp_history_import_chats (connection_id, chat_timestamp DESC)
  WHERE status = 'pending';

DROP FUNCTION IF EXISTS public.claim_history_import(UUID, INTEGER);
CREATE FUNCTION public.claim_history_import(
  p_connection_id UUID,
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
   WHERE j.connection_id = (
     SELECT c.connection_id FROM public.whatsapp_history_imports c
      WHERE (p_connection_id IS NULL OR c.connection_id = p_connection_id)
        AND c.status IN ('queued', 'listing', 'importing', 'waiting_session')
        AND c.next_run_at <= now()
        AND (c.lease_until IS NULL OR c.lease_until < now())
      ORDER BY c.next_run_at
      LIMIT 1
        FOR UPDATE SKIP LOCKED)
  RETURNING j.*;
END
$$;

-- ---- 9. contacts / outbound ------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS personal_only BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES public.whatsapp_connections(id);
ALTER TABLE public.automations ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL;
ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS connection_id UUID
  REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL;

-- The account's default business number: the official one, else the
-- oldest business QR number. NULL when it has none.
CREATE OR REPLACE FUNCTION public.default_business_connection(p_account_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT w.id FROM public.whatsapp_connections w
   WHERE w.account_id = p_account_id AND w.scope = 'business' AND w.removed_at IS NULL
   ORDER BY (w.provider = 'meta') DESC, w.created_at, w.id
   LIMIT 1
$$;

UPDATE public.broadcasts b
   SET connection_id = public.default_business_connection(b.account_id)
 WHERE b.connection_id IS NULL;

-- ---- grants ------------------------------------------------------------
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.lock_whatsapp_connection(uuid)',
    'public.apply_openwa_session_state(uuid,jsonb,text,timestamptz)',
    'public.claim_history_import(uuid,integer)',
    'public.default_business_connection(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
