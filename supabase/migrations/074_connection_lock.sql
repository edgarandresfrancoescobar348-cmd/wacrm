-- ============================================================
-- 074_connection_lock.sql — fourth review K6: switching modes and
--     changing the OpenWA session state are serialised per account
--
-- The problem
--
--   071 derives the QR "connected" flag in the database, but a switch
--   to QR mode (UPDATE whatsapp_config SET provider='openwa', whose
--   BEFORE trigger reads the session row) and a session change (UPDATE
--   of whatsapp_openwa_config, whose AFTER trigger mirrors into
--   whatsapp_config WHERE provider='openwa') took no common lock: the
--   switch could read 'ready', the session commit 'disconnected' while
--   the switch's row still read as Meta (no mirror), and the switch then
--   commit openwa/connected over a disconnected session. The route's
--   best-effort refresh might repair it — or fail silently.
--
-- The fix
--
--   Both writes go through RPCs that take ONE per-account advisory lock
--   FIRST, before any row lock (lock_whatsapp_connection):
--     set_openwa_active           account lock → config row
--     apply_openwa_session_state  account lock → session row → config row (071 trigger)
--   The lock order is uniform, so the two serialise without deadlock
--   (a row lock taken inside a trigger before an advisory lock would
--   have inverted it). The app writes neither table's state directly.
--
-- Idempotent. Service-role only.
-- ============================================================

-- ------------------------------------------------------------ K6
CREATE OR REPLACE FUNCTION public.lock_whatsapp_connection(p_account_id UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('wa-connection:' || p_account_id::text, 0))
$$;

-- Make QR mode the active connection (creating the config row when the
-- account has none). The status is derived from the session (071).
CREATE OR REPLACE FUNCTION public.set_openwa_active(
  p_account_id UUID,
  p_user_id    UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  st TEXT;
BEGIN
  PERFORM public.lock_whatsapp_connection(p_account_id);
  UPDATE public.whatsapp_config
     SET provider = 'openwa', updated_at = now()
   WHERE account_id = p_account_id
  RETURNING status INTO st;
  IF NOT FOUND THEN
    INSERT INTO public.whatsapp_config (account_id, user_id, provider, status, updated_at)
    VALUES (p_account_id, p_user_id, 'openwa', 'disconnected', now())
    RETURNING status INTO st;
  END IF;
  RETURN st;
END
$$;

-- Apply a patch to the account's OpenWA session row: the account lock
-- first, then the row (newest-wins on p_event_at when given; only for
-- p_session_id when given). The active-connection flag follows (071).
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
     SET base_url = nw.base_url, api_key = nw.api_key, engine = nw.engine,
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

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.lock_whatsapp_connection(uuid)',
    'public.set_openwa_active(uuid,uuid)',
    'public.apply_openwa_session_state(uuid,jsonb,text,timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
