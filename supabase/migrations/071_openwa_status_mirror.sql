-- ============================================================
-- 071_openwa_status_mirror.sql — the active-connection flag is DERIVED
--     from the OpenWA session state, in the same transaction
--     (third review: F4 residue)
--
-- The problem
--
--   A session event updated whatsapp_openwa_config (guarded newest-wins
--   by status_event_at, 062) and then, in a SECOND statement, mirrored
--   the status into whatsapp_config.status — the flag the inbox banner
--   and every sender read. Two valid events could apply the first write
--   old→new and the second new→old: an old "disconnected" suspended
--   between its two writes, a newer "ready" applying both, then the old
--   one finishing its mirror. The session row said ready; the active
--   connection said disconnected. The settings routes had the same
--   two-write shape.
--
-- The fix
--
--   The mirror is no longer written by the application. It is derived:
--
--   * AFTER INSERT/UPDATE of status or connected_at on
--     whatsapp_openwa_config, a trigger sets whatsapp_config's status
--     (and connected_at) from the NEW session row — inside the same
--     statement, under the session row's lock. Session writes are
--     serialised by that lock and filtered by the watermark, so the
--     mirror follows exactly the order in which session state is applied
--     (newest wins across both tables).
--   * BEFORE INSERT/UPDATE of status, connected_at or provider on
--     whatsapp_config, while QR mode is the active provider, the row's
--     status is taken from the session row — a stale or direct write
--     can't make the flag disagree with the session, and switching to QR
--     mode picks up the current session state.
--
--   Meta mode is untouched (the triggers only act when provider = 'openwa').
--
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.openwa_config_status(p_status TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_status = 'ready' THEN 'connected' ELSE 'disconnected' END
$$;

-- Session state → active-connection flag (same transaction).
CREATE OR REPLACE FUNCTION public.mirror_openwa_session_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.whatsapp_config c
     SET status = public.openwa_config_status(NEW.status),
         connected_at = CASE WHEN NEW.status = 'ready' THEN COALESCE(NEW.connected_at, c.connected_at, now()) END
   WHERE c.account_id = NEW.account_id
     AND c.provider = 'openwa'
     AND (c.status IS DISTINCT FROM public.openwa_config_status(NEW.status)
          OR (NEW.status <> 'ready' AND c.connected_at IS NOT NULL)
          OR (NEW.status = 'ready' AND c.connected_at IS NULL));
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS mirror_openwa_session_status ON public.whatsapp_openwa_config;
CREATE TRIGGER mirror_openwa_session_status
  AFTER INSERT OR UPDATE OF status, connected_at ON public.whatsapp_openwa_config
  FOR EACH ROW EXECUTE FUNCTION public.mirror_openwa_session_status();

-- Any write of the flag while QR mode is active takes the session's state.
CREATE OR REPLACE FUNCTION public.derive_openwa_config_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  IF NEW.provider IS DISTINCT FROM 'openwa' THEN
    RETURN NEW;
  END IF;
  SELECT o.status, o.connected_at INTO s
    FROM public.whatsapp_openwa_config o
   WHERE o.account_id = NEW.account_id;
  IF FOUND THEN
    NEW.status := public.openwa_config_status(s.status);
    NEW.connected_at := CASE WHEN s.status = 'ready'
                             THEN COALESCE(s.connected_at, NEW.connected_at, now()) END;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS derive_openwa_config_status ON public.whatsapp_config;
CREATE TRIGGER derive_openwa_config_status
  BEFORE INSERT OR UPDATE OF status, connected_at, provider ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.derive_openwa_config_status();

REVOKE ALL ON FUNCTION public.mirror_openwa_session_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.derive_openwa_config_status() FROM PUBLIC, anon, authenticated;

-- Bring existing rows in line once.
UPDATE public.whatsapp_config c
   SET status = public.openwa_config_status(o.status)
  FROM public.whatsapp_openwa_config o
 WHERE o.account_id = c.account_id
   AND c.provider = 'openwa'
   AND c.status IS DISTINCT FROM public.openwa_config_status(o.status);
