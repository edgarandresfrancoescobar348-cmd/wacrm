-- ============================================================
-- 062_openwa_replay_guards
--
-- 1. The delivery ledger's key becomes (account_id, idempotency_key).
--    The idempotency key is taken from the SIGNED body, and the body is
--    signed by the account's own gateway — a tenant controls both. With
--    a global key, one account could pre-register another account's
--    future keys and have its real deliveries answered "duplicate".
--
-- 2. `whatsapp_openwa_config.status_event_at` — the gateway timestamp of
--    the newest session event applied. A session event older than it
--    (an at-least-once redelivery arriving late, or a replayed capture)
--    no longer overwrites newer state (e.g. an old "disconnected" over
--    a live session).
--
-- Additive and idempotent.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'openwa_webhook_deliveries_pkey'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (idempotency_key)'
  ) THEN
    ALTER TABLE openwa_webhook_deliveries DROP CONSTRAINT openwa_webhook_deliveries_pkey;
    ALTER TABLE openwa_webhook_deliveries
      ADD CONSTRAINT openwa_webhook_deliveries_pkey PRIMARY KEY (account_id, idempotency_key);
  END IF;
END
$$;

ALTER TABLE whatsapp_openwa_config
  ADD COLUMN IF NOT EXISTS status_event_at TIMESTAMPTZ;
