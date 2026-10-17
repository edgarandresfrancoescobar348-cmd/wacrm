-- ============================================================
-- 090_dashboard_business_scope.sql — the dashboard counts the business
--     numbers only; schema convergence after the upstream merge (phase 7)
--
-- 1. Upstream's dashboard_overview (059) is SECURITY DEFINER over the
--    whole account. With several WhatsApp numbers (085/086) that counted
--    — and, in the reply queue, NAMED — the conversations of members'
--    personal numbers for the whole team: the one thing 086 promises
--    never happens. The dashboard is the business's overview, so it now
--    reads the business numbers only, for everyone (a personal number's
--    owner sees their own chats in the inbox, not in team KPIs).
--
--    Done without copying the function: the schema `dashboard_scope`
--    holds views that shadow the tables it reads unqualified —
--      conversations   business numbers', no WhatsApp groups (080);
--      messages        of those conversations;
--      contacts        not personal-only (085);
--      deals           not tied to a personal-only contact or a personal
--                      conversation (086's deals rule);
--      whatsapp_config "a WhatsApp number of the business is connected",
--                      QR numbers included (it was the Meta credentials
--                      only, so a QR-only account was told to connect);
--    and the function's search_path puts that schema first. Its body,
--    owner and grants are upstream's, untouched: a later upstream change
--    to the body keeps the scope as long as it reads these names
--    unqualified (verify-schema.sql checks the setting).
--
-- 2. Convergence: an existing database that applied this fork's
--    migrations under their old numbers (047–076) and upstream's 047–059
--    after them must end like a fresh one —
--      * column defaults: uuid_generate_v4() → gen_random_uuid() (upstream
--        98c4171e edited the old files; 060 likewise), so verify-schema's
--        uuid-ossp guard holds everywhere;
--      * idx_messages_conversation_created: upstream 059 and this fork's
--        081 create it under the same name, ascending / DESC; the first
--        one to run wins. A btree serves both directions — keep 059's;
--      * create_broadcast_with_recipients: upstream 049 and this fork's
--        068 fixed the same JSONB bug; whichever ran last won. 068's is
--        re-asserted here (see the function below).
--
-- Idempotent.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS dashboard_scope;
REVOKE ALL ON SCHEMA dashboard_scope FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE VIEW dashboard_scope.conversations AS
  SELECT c.* FROM public.conversations c
   WHERE NOT c.is_group
     AND EXISTS (SELECT 1 FROM public.whatsapp_connections w
                  WHERE w.id = c.connection_id AND w.scope = 'business');

CREATE OR REPLACE VIEW dashboard_scope.messages AS
  SELECT m.* FROM public.messages m
   WHERE m.conversation_id IN (SELECT id FROM dashboard_scope.conversations);

CREATE OR REPLACE VIEW dashboard_scope.contacts AS
  SELECT ct.* FROM public.contacts ct WHERE NOT ct.personal_only;

CREATE OR REPLACE VIEW dashboard_scope.deals AS
  SELECT d.* FROM public.deals d
   WHERE (d.contact_id IS NULL OR EXISTS (SELECT 1 FROM dashboard_scope.contacts c WHERE c.id = d.contact_id))
     AND (d.conversation_id IS NULL
          OR EXISTS (SELECT 1 FROM public.conversations v
                       JOIN public.whatsapp_connections w ON w.id = v.connection_id
                      WHERE v.id = d.conversation_id AND w.scope = 'business'));

CREATE OR REPLACE VIEW dashboard_scope.whatsapp_config AS
  SELECT w.account_id, w.status FROM public.whatsapp_connections w
   WHERE w.scope = 'business' AND w.removed_at IS NULL;

REVOKE ALL ON ALL TABLES IN SCHEMA dashboard_scope FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.dashboard_overview(integer,text)') IS NOT NULL THEN
    ALTER FUNCTION public.dashboard_overview(integer, text) SET search_path = dashboard_scope, public;
  END IF;
END
$$;

-- ---- 2. convergence -------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default LIKE '%uuid_generate_v4()%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT gen_random_uuid()', r.table_name, r.column_name);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF pg_get_indexdef(to_regclass('public.idx_messages_conversation_created')) LIKE '%DESC%' THEN
    DROP INDEX public.idx_messages_conversation_created;
    CREATE INDEX idx_messages_conversation_created ON public.messages (conversation_id, created_at);
  END IF;
END
$$;

-- ---- create_broadcast_with_recipients: 068's, whichever ran last -----------
-- Upstream 049 requires one JSON array per contact; the public API's
-- structured params ({ "body": [...], "headerText": "..." }, 068) and a
-- recipient without params (null) must keep working.
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);
CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_broadcast_id UUID;
  v_params JSONB := COALESCE(p_template_params, '[]'::jsonb);
BEGIN
  IF jsonb_typeof(v_params) <> 'array' THEN
    RAISE EXCEPTION 'p_template_params must be a JSON array (one element per contact)'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, c.cid, 'pending', NULLIF(p.prm, 'null'::jsonb)
    FROM unnest(p_contact_ids) WITH ORDINALITY AS c(cid, i)
    LEFT JOIN jsonb_array_elements(v_params) WITH ORDINALITY AS p(prm, j)
      ON p.j = c.i
    ORDER BY c.i
    -- Qualified: a bare `contact_id` collides with the RETURNS TABLE
    -- output variable of the same name (041).
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
