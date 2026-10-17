-- ============================================================
-- 089_whatsapp_connection_scope_change.sql — a number can change between
--     Pessoal and Empresa (phase 6b)
--
-- Phase 6 made a number's scope immutable. The owner's real QR number was
-- migrated as Empresa but is his personal phone, and removing it and
-- scanning again is not acceptable. The scope (and a personal number's
-- owner) now change through ONE function, set_connection_scope, under the
-- number's lock; the identity guard lets nothing else change them.
--
-- Who:
--   Empresa → Pessoal  an admin / owner of the account; the new owner is a
--                      member (by default the caller).
--   Pessoal → Empresa  only that number's owner: an admin never exposes
--                      someone else's personal number.
--   The official (Meta) number is always Empresa.
--
-- What changes with it (same transaction):
--   * contacts.personal_only, both ways, by phase 6's rule: personal-only
--     exactly when none of the contact's conversations is on a business
--     number.
--   * Empresa → Pessoal: assignments to anyone but the owner are removed;
--     active flow runs end ('failed', end_reason number_became_personal);
--     pending automation executions of its conversations are superseded;
--     broadcasts still going out from it fail; automations / flows bound
--     to it fall back to the account's default business number (NULL).
--     Its media leaves the public bucket (the app moves the files and
--     rewrites the links; media_private_pending marks the work left —
--     src/lib/whatsapp/connection-scope.ts).
--   * whatsapp_connection_events: who changed what, when, with counts.
--
-- Service role only (the route checks the caller and passes it as actor;
-- the function checks it again). Idempotent.
-- ============================================================

ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS media_private_pending BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.whatsapp_connection_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  actor_user_id UUID,
  action        TEXT NOT NULL,
  from_scope    TEXT,
  to_scope      TEXT,
  from_owner    UUID,
  to_owner      UUID,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_connection_events_connection
  ON public.whatsapp_connection_events (connection_id, created_at DESC);
ALTER TABLE public.whatsapp_connection_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_connection_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.whatsapp_connection_events TO service_role;

-- The identity guard (085): account and provider never change; scope and
-- owner only inside set_connection_scope.
CREATE OR REPLACE FUNCTION public.whatsapp_connections_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.provider IS DISTINCT FROM OLD.provider) THEN
    RAISE EXCEPTION 'a WhatsApp number''s account and provider never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.scope IS DISTINCT FROM OLD.scope OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
     AND coalesce(current_setting('wacrm.connection_scope_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'a WhatsApp number''s scope and owner change only through set_connection_scope'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.owner_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.owner_user_id AND p.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'the owner of a personal number must be a member of the account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.whatsapp_connections_guard() FROM PUBLIC, anon, authenticated;

-- Phase 6's rule for the contacts of one number's conversations.
CREATE OR REPLACE FUNCTION public.recompute_personal_only_for(p_connection_id UUID)
RETURNS INTEGER
LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH touched AS (
    SELECT DISTINCT cv.contact_id FROM public.conversations cv
     WHERE cv.connection_id = p_connection_id AND cv.contact_id IS NOT NULL
  ), next AS (
    SELECT t.contact_id,
           NOT EXISTS (
             SELECT 1 FROM public.conversations x
               JOIN public.whatsapp_connections w ON w.id = x.connection_id
              WHERE x.contact_id = t.contact_id AND w.scope = 'business'
           ) AS personal_only
      FROM touched t
  ), upd AS (
    UPDATE public.contacts ct SET personal_only = n.personal_only
      FROM next n
     WHERE ct.id = n.contact_id AND ct.personal_only IS DISTINCT FROM n.personal_only
    RETURNING 1
  )
  SELECT count(*)::int FROM upd
$$;
REVOKE ALL ON FUNCTION public.recompute_personal_only_for(UUID) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.set_connection_scope(UUID, TEXT, UUID, UUID);
CREATE FUNCTION public.set_connection_scope(
  p_connection_id UUID,
  p_scope         TEXT,
  p_owner_user_id UUID,
  p_actor_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  w public.whatsapp_connections;
  actor_role TEXT;
  next_owner UUID;
  n_contacts INTEGER := 0;
  n_unassigned INTEGER := 0;
  n_flows INTEGER := 0;
  n_pending INTEGER := 0;
  n_broadcasts INTEGER := 0;
  n_bound INTEGER := 0;
  n_media INTEGER := 0;
  result JSONB;
BEGIN
  IF p_scope NOT IN ('personal', 'business') THEN
    RAISE EXCEPTION 'scope must be personal or business' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.lock_whatsapp_connection(p_connection_id);
  SELECT * INTO w FROM public.whatsapp_connections WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND OR w.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'no such WhatsApp number' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT p.account_role::text INTO actor_role FROM public.profiles p
   WHERE p.user_id = p_actor_user_id AND p.account_id = w.account_id;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;

  next_owner := CASE WHEN p_scope = 'personal' THEN coalesce(p_owner_user_id, p_actor_user_id) END;
  -- Nothing to do: the same scope and owner (a repeated request).
  IF w.scope = p_scope AND w.owner_user_id IS NOT DISTINCT FROM next_owner THEN
    RETURN jsonb_build_object('changed', false, 'scope', w.scope, 'owner_user_id', w.owner_user_id);
  END IF;

  IF p_scope = 'personal' THEN
    IF w.provider = 'meta' THEN
      RAISE EXCEPTION 'the official number is always business' USING ERRCODE = 'check_violation';
    END IF;
    IF w.scope = 'personal' THEN
      -- Handing a personal number to someone else: its owner only.
      IF w.owner_user_id IS DISTINCT FROM p_actor_user_id THEN
        RAISE EXCEPTION 'only its owner hands a personal number over' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF actor_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'only an admin makes a business number personal' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF w.owner_user_id IS DISTINCT FROM p_actor_user_id THEN
      RAISE EXCEPTION 'only its owner makes a personal number the team''s' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  PERFORM set_config('wacrm.connection_scope_change', 'on', true);
  UPDATE public.whatsapp_connections
     SET scope = p_scope,
         owner_user_id = next_owner,
         media_private_pending = (p_scope = 'personal'),
         updated_at = now()
   WHERE id = w.id;
  PERFORM set_config('wacrm.connection_scope_change', 'off', true);

  n_contacts := public.recompute_personal_only_for(w.id);

  IF p_scope = 'personal' THEN
    WITH u AS (
      UPDATE public.conversations SET assigned_agent_id = NULL
       WHERE connection_id = w.id AND assigned_agent_id IS NOT NULL AND assigned_agent_id <> next_owner
      RETURNING 1)
    SELECT count(*) INTO n_unassigned FROM u;

    WITH u AS (
      UPDATE public.flow_runs SET status = 'failed', ended_at = now(), end_reason = 'number_became_personal'
       WHERE status = 'active'
         AND conversation_id IN (SELECT id FROM public.conversations WHERE connection_id = w.id)
      RETURNING 1)
    SELECT count(*) INTO n_flows FROM u;

    WITH u AS (
      UPDATE public.automation_pending_executions SET status = 'superseded'
       WHERE status IN ('pending', 'awaiting_reply')
         AND (context->>'conversation_id') IN (SELECT id::text FROM public.conversations WHERE connection_id = w.id)
      RETURNING 1)
    SELECT count(*) INTO n_pending FROM u;

    WITH u AS (
      UPDATE public.broadcasts SET status = 'failed', updated_at = now()
       WHERE connection_id = w.id AND status IN ('scheduled', 'sending')
      RETURNING 1)
    SELECT count(*) INTO n_broadcasts FROM u;

    WITH a AS (UPDATE public.automations SET connection_id = NULL WHERE connection_id = w.id RETURNING 1),
         f AS (UPDATE public.flows SET connection_id = NULL WHERE connection_id = w.id RETURNING 1)
    SELECT (SELECT count(*) FROM a) + (SELECT count(*) FROM f) INTO n_bound;

    SELECT count(*) INTO n_media FROM public.messages m
     WHERE m.conversation_id IN (SELECT id FROM public.conversations WHERE connection_id = w.id)
       AND m.media_url LIKE '%/storage/v1/object/public/chat-media/%';
  END IF;

  result := jsonb_build_object(
    'changed', true,
    'scope', p_scope,
    'owner_user_id', next_owner,
    'contacts_changed', n_contacts,
    'unassigned', n_unassigned,
    'flow_runs_ended', n_flows,
    'automation_executions_superseded', n_pending,
    'broadcasts_failed', n_broadcasts,
    'automations_unbound', n_bound,
    'public_media', n_media
  );
  INSERT INTO public.whatsapp_connection_events
    (account_id, connection_id, actor_user_id, action, from_scope, to_scope, from_owner, to_owner, details)
  VALUES (w.account_id, w.id, p_actor_user_id, 'scope_changed', w.scope, p_scope, w.owner_user_id, next_owner, result);
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.set_connection_scope(UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_connection_scope(UUID, TEXT, UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
