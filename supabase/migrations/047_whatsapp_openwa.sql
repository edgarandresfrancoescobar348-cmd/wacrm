-- ============================================================
-- 047_whatsapp_openwa
--
-- A second way to connect an account to WhatsApp: a regular number
-- paired by QR code through a self-hosted OpenWA gateway, next to the
-- official Meta Cloud API. One connection is active per account; the
-- other mode's settings are kept so switching back is quick.
--
--   1. `whatsapp_config.provider` — 'meta' | 'openwa', the ACTIVE
--      connection. Existing rows read 'meta'. The Meta columns
--      (`phone_number_id`, `access_token`) become nullable so an account
--      that only ever used the QR code still has its one config row;
--      a CHECK keeps them mandatory whenever the row is in Meta mode.
--      `whatsapp_config.status` keeps meaning "the active connection is
--      up", so the inbox banner and every existing reader still work.
--
--   2. `whatsapp_openwa_config` — one row per account: gateway URL,
--      API key + webhook secret (both encrypted by the app with
--      ENCRYPTION_KEY), the OpenWA session it owns, and the live session
--      state mirrored from OpenWA's webhooks. RLS is enabled with NO
--      client policies: the browser never reads this table; every access
--      is a server route (admin-gated) using the service role. That is
--      stricter than `whatsapp_config` on purpose — the API key unlocks
--      a WhatsApp number.
--
--   3. `openwa_webhook_deliveries` — idempotency ledger for OpenWA's
--      at-least-once deliveries (`X-OpenWA-Idempotency-Key`). Service
--      role only, same as above.
--
--   4. `messages.revoked_at` / `messages.edited_at` — the customer
--      deleted ("apagada para todos") or edited a message. QR-code
--      connections report both; Meta's Cloud API reports neither. The
--      original text is kept, the inbox labels the bubble.
--
--   5. `message_templates.origin` — 'meta' (submitted to Meta, the only
--      kind until now) | 'local' (saved while the account is on a QR
--      connection, where Meta approval does not exist and templates are
--      rendered and sent as text).
--
-- Additive and idempotent — safe to re-run; existing rows unchanged.
-- ============================================================

-- ---- 1. whatsapp_config.provider ---------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'openwa'));

ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_meta_credentials_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_meta_credentials_check
  CHECK (
    provider <> 'meta'
    OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)
  );

-- ---- 2. whatsapp_openwa_config -----------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_openwa_config (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Admin who saved it — audit / NOT NULL FK, like whatsapp_config.user_id.
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  base_url           TEXT NOT NULL,
  -- Encrypted (AES-256-GCM, src/lib/whatsapp/encryption.ts).
  api_key            TEXT NOT NULL,
  -- Engine the gateway reported at the last connection test. Engine
  -- choice is deployment-wide on OpenWA (ENGINE_TYPE), not per session.
  engine             TEXT,
  session_id         TEXT UNIQUE,
  session_name       TEXT,
  webhook_id         TEXT,
  -- Encrypted. Random, >= 32 chars; OpenWA signs deliveries with it.
  webhook_secret     TEXT,
  -- OpenWA's session status, verbatim.
  status             TEXT NOT NULL DEFAULT 'created',
  phone              TEXT,
  push_name          TEXT,
  last_error         TEXT,
  -- `session.restriction` payload while a restriction is active.
  restriction        JSONB,
  reconnect_attempts INTEGER,
  status_updated_at  TIMESTAMPTZ,
  connected_at       TIMESTAMPTZ,
  -- Minimum gap between two broadcast sends (ban-risk guard).
  broadcast_delay_ms INTEGER NOT NULL DEFAULT 8000,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_openwa_config DROP CONSTRAINT IF EXISTS whatsapp_openwa_config_status_check;
ALTER TABLE whatsapp_openwa_config
  ADD CONSTRAINT whatsapp_openwa_config_status_check
  CHECK (status IN (
    'created', 'initializing', 'qr_ready', 'authenticating', 'ready',
    'disconnected', 'action_required', 'failed'
  ));

ALTER TABLE whatsapp_openwa_config DROP CONSTRAINT IF EXISTS whatsapp_openwa_config_engine_check;
ALTER TABLE whatsapp_openwa_config
  ADD CONSTRAINT whatsapp_openwa_config_engine_check
  CHECK (engine IS NULL OR engine IN ('whatsapp-web.js', 'baileys'));

ALTER TABLE whatsapp_openwa_config DROP CONSTRAINT IF EXISTS whatsapp_openwa_config_delay_check;
ALTER TABLE whatsapp_openwa_config
  ADD CONSTRAINT whatsapp_openwa_config_delay_check
  CHECK (broadcast_delay_ms BETWEEN 3000 AND 120000);

ALTER TABLE whatsapp_openwa_config ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service role only (see header).
REVOKE ALL ON TABLE whatsapp_openwa_config FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_openwa_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON whatsapp_openwa_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 3. openwa_webhook_deliveries --------------------------------
CREATE TABLE IF NOT EXISTS openwa_webhook_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_openwa_webhook_deliveries_received
  ON openwa_webhook_deliveries(received_at);

ALTER TABLE openwa_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE openwa_webhook_deliveries FROM anon, authenticated;

-- ---- 4. messages.revoked_at / edited_at --------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- ---- 5. message_templates.origin ---------------------------------
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_origin_check;
ALTER TABLE message_templates
  ADD CONSTRAINT message_templates_origin_check
  CHECK (origin IN ('meta', 'local'));
