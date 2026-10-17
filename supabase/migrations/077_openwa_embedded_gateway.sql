-- ============================================================
-- 077_openwa_embedded_gateway.sql — the OpenWA gateway is wacrm's own
--
-- OpenWA now ships inside wacrm (packages/openwa) and is started with
-- it (`npm run dev` / `npm run start` / docker compose). Its URL and
-- admin key are server config, provisioned automatically, so the
-- per-account `base_url` / `api_key` columns go away. Sessions, webhook
-- secrets, status and pacing stay per account.
--
-- An account that pointed at an external gateway keeps its row; its
-- session id names nothing on the embedded gateway, so the next
-- refresh shows it disconnected and "Conectar" creates a new session
-- there (a new QR scan).
--
-- apply_openwa_session_state (074) copied both columns: it is
-- recreated without them, same signature, lock order and grants.
--
-- Idempotent. Service-role only.
-- ============================================================

ALTER TABLE public.whatsapp_openwa_config DROP COLUMN IF EXISTS base_url;
ALTER TABLE public.whatsapp_openwa_config DROP COLUMN IF EXISTS api_key;

CREATE OR REPLACE FUNCTION public.apply_openwa_session_state(
  p_account_id UUID,
  p_patch      JSONB,
  p_session_id TEXT,
  p_event_at   TIMESTAMPTZ
)
RETURNS SETOF public.whatsapp_openwa_config
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cur public.whatsapp_openwa_config;
  nw  public.whatsapp_openwa_config;
BEGIN
  PERFORM public.lock_whatsapp_connection(p_account_id);
  SELECT * INTO cur FROM public.whatsapp_openwa_config
   WHERE account_id = p_account_id
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

REVOKE ALL ON FUNCTION public.apply_openwa_session_state(uuid,jsonb,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_openwa_session_state(uuid,jsonb,text,timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
