-- ============================================================
-- 048_openwa_delivery_state
--
-- The OpenWA delivery ledger (047) recorded a delivery as soon as it
-- arrived, before any processing. A transient failure afterwards (a DB
-- error inserting the message, a gateway lookup) left the key behind,
-- so OpenWA's redelivery was answered "duplicate" and the message was
-- lost for good.
--
-- The ledger now tracks processing state:
--   processing — claimed by a request that is working on it
--   done       — durable part finished; redeliveries are no-ops
--   failed     — the last attempt failed; a redelivery re-claims it
-- A `processing` row older than the claim timeout (app side) is
-- treated as abandoned (crashed worker) and can be re-claimed too.
--
-- Existing rows predate this distinction and were treated as complete,
-- so they become `done`. Additive and idempotent.
-- ============================================================

ALTER TABLE openwa_webhook_deliveries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE openwa_webhook_deliveries
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE openwa_webhook_deliveries
  ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE openwa_webhook_deliveries
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE openwa_webhook_deliveries DROP CONSTRAINT IF EXISTS openwa_webhook_deliveries_status_check;
ALTER TABLE openwa_webhook_deliveries
  ADD CONSTRAINT openwa_webhook_deliveries_status_check
  CHECK (status IN ('processing', 'done', 'failed'));
