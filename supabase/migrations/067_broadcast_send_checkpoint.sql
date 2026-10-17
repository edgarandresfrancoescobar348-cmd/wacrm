-- ============================================================
-- 067_broadcast_send_checkpoint
--
-- Paced (QR-code) broadcasts run in time-boxed passes (second review G7
-- and F8):
--
--   * broadcast_recipients.send_started_at — written BEFORE the send's
--     external effect. A recipient still `pending` with it set was
--     interrupted mid-send: on a transport with idempotent sends (OpenWA,
--     keyed by the recipient id) the next pass re-sends safely; on Meta
--     it is failed as "interrupted" instead of risking a duplicate.
--   * broadcasts.auto_resume_at — set when a pass stopped at its time
--     budget with recipients left; the cron continuation
--     (/api/whatsapp/broadcast/cron, also run by /api/automations/cron)
--     picks such broadcasts up without anyone pressing Resume.
--
-- Additive and idempotent.
-- ============================================================

ALTER TABLE public.broadcast_recipients ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ;
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS auto_resume_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_broadcasts_auto_resume
  ON public.broadcasts(auto_resume_at) WHERE auto_resume_at IS NOT NULL;
