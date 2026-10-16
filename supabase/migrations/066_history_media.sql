-- ============================================================
-- 066_history_media.sql — imported history media opens (phase 5d)
--
-- The QR-code history import stored every media message (image, video,
-- audio/voice, document, sticker) with media_url = NULL: the gateway's
-- history carried no media info, so no lazy reference was kept, and the
-- inbox showed "Áudio indisponível" (1113 rows on a real account). The
-- importer now keeps a reference for every media kind and the gateway
-- downloads never-archived media from WhatsApp on demand.
--
--   1. messages.media_expired_at — set when WhatsApp answered that the
--      file is gone (410), so the bubble says "expired on WhatsApp"
--      instead of "unavailable".
--   2. openwa_media_proxy_url(chat, message) — the media proxy URL, the
--      same string as openWaMediaProxyUrl() in TypeScript
--      (encodeURIComponent of both parts).
--   3. One-shot backfill: imported media rows without a URL get the proxy
--      reference of their chat (from the import checkpoint). Text is not
--      touched, nothing is re-imported. Idempotent.
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_expired_at TIMESTAMPTZ;

-- encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is
-- percent-encoded, byte by byte of its UTF-8 form.
CREATE OR REPLACE FUNCTION public.uri_encode_component(p TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  out TEXT := '';
  ch TEXT;
  b BYTEA;
  i INTEGER;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  FOR i IN 1 .. length(p) LOOP
    ch := substr(p, i, 1);
    IF ch ~ '^[A-Za-z0-9_.!~*''()-]$' THEN
      out := out || ch;
    ELSE
      b := convert_to(ch, 'UTF8');
      FOR j IN 0 .. length(b) - 1 LOOP
        out := out || '%' || upper(lpad(to_hex(get_byte(b, j)), 2, '0'));
      END LOOP;
    END IF;
  END LOOP;
  RETURN out;
END
$$;

CREATE OR REPLACE FUNCTION public.openwa_media_proxy_url(p_chat_id TEXT, p_message_id TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT '/api/whatsapp/openwa/media?chat=' || public.uri_encode_component(p_chat_id)
      || '&id=' || public.uri_encode_component(p_message_id)
$$;

REVOKE ALL ON FUNCTION public.uri_encode_component(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.openwa_media_proxy_url(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.uri_encode_component(TEXT), public.openwa_media_proxy_url(TEXT, TEXT) TO service_role;

DO $$
DECLARE
  before_null INTEGER;
  fixed INTEGER;
BEGIN
  SELECT count(*) INTO before_null
    FROM public.messages m
   WHERE m.imported_at IS NOT NULL
     AND m.media_url IS NULL
     AND m.revoked_at IS NULL
     AND (m.content_type IN ('image', 'video', 'audio', 'document')
          OR m.content_meta->>'kind' IN ('sticker', 'voice', 'document'));

  UPDATE public.messages m
     SET media_url = public.openwa_media_proxy_url(ic.chat_id, m.message_id)
    FROM public.whatsapp_history_import_chats ic
   WHERE ic.conversation_id = m.conversation_id
     AND m.imported_at IS NOT NULL
     AND m.media_url IS NULL
     AND m.revoked_at IS NULL
     AND m.message_id IS NOT NULL
     AND (m.content_type IN ('image', 'video', 'audio', 'document')
          OR m.content_meta->>'kind' IN ('sticker', 'voice', 'document'));
  GET DIAGNOSTICS fixed = ROW_COUNT;

  RAISE NOTICE '066: imported media rows without a URL: % before, % given the proxy reference, % left',
    before_null, fixed, before_null - fixed;
END
$$;

NOTIFY pgrst, 'reload schema';
