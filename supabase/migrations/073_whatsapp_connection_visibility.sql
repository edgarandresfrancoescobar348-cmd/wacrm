-- ============================================================
-- 073_whatsapp_connection_visibility.sql — a personal number's
--     conversations are its owner's alone (phase 6)
--
-- The rule (owner decision): the conversations of a PERSONAL number are
-- seen only by the member who owns it — not by the account's admins or
-- owner either — and that is enforced here, in the database, for every
-- reader that goes through RLS: the inbox, realtime (postgres_changes
-- applies the subscriber's RLS), search, the dashboard and exports.
-- Server code on the service role filters to business numbers itself
-- (public API, outbound webhooks, automations).
--
--   visible_connection_ids()   the numbers the caller may see: the
--                              business numbers of their accounts plus
--                              their own personal ones. A set, computed
--                              once per query (the open-bsp pattern).
--   conversations              … AND connection_id IN visible
--   messages, message_reactions, contact_tags, contact_custom_values
--                              unchanged: their policies read
--                              conversations / contacts, whose RLS
--                              applies inside them.
--   contacts                   a `personal_only` contact (one that exists
--                              only because of a personal number) is
--                              seen only by the owner(s) of a personal
--                              number with a conversation with it.
--   contact_notes, deals       follow their contact / conversation.
--   whatsapp_history_imports   progress of the numbers you can see.
--
-- A contact stops being personal-only when a business conversation opens
-- with it (trigger) or when a member creates it by hand
-- (share_personal_contact, called by the create paths: they typed the
-- number). A personal conversation can't be assigned to anyone but its
-- owner (the assignment notification would carry the contact's name).
--
-- Media: chat-media is a PUBLIC bucket (URLs bypass RLS). A personal
-- number's media goes to the private bucket chat-media-private under
-- `connection-<id>/…`, readable through storage RLS by the owner only.
--
-- Idempotent.
-- ============================================================

-- ---- helpers -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.visible_connection_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT w.id
    FROM public.whatsapp_connections w
   WHERE w.account_id IN (SELECT p.account_id FROM public.profiles p WHERE p.user_id = auth.uid())
     AND (w.scope = 'business' OR w.owner_user_id = auth.uid())
$$;

-- Contacts the caller talks to on their own personal numbers.
CREATE OR REPLACE FUNCTION public.my_personal_contact_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cv.contact_id
    FROM public.conversations cv
    JOIN public.whatsapp_connections w ON w.id = cv.connection_id
   WHERE w.scope = 'personal'
     AND w.owner_user_id = auth.uid()
     AND cv.contact_id IS NOT NULL
     AND w.account_id IN (SELECT p.account_id FROM public.profiles p WHERE p.user_id = auth.uid())
$$;

REVOKE ALL ON FUNCTION public.visible_connection_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_personal_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visible_connection_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_personal_contact_ids() TO authenticated, service_role;

-- ---- conversations -------------------------------------------------
DROP POLICY IF EXISTS conversations_select ON public.conversations;
DROP POLICY IF EXISTS conversations_insert ON public.conversations;
DROP POLICY IF EXISTS conversations_update ON public.conversations;
DROP POLICY IF EXISTS conversations_delete ON public.conversations;

CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (is_account_member(account_id)
         AND connection_id IN (SELECT public.visible_connection_ids()));
CREATE POLICY conversations_insert ON public.conversations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent')
              AND connection_id IN (SELECT public.visible_connection_ids()));
CREATE POLICY conversations_update ON public.conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent')
         AND connection_id IN (SELECT public.visible_connection_ids()))
  WITH CHECK (is_account_member(account_id, 'agent')
              AND connection_id IN (SELECT public.visible_connection_ids()));
CREATE POLICY conversations_delete ON public.conversations FOR DELETE
  USING (is_account_member(account_id, 'agent')
         AND connection_id IN (SELECT public.visible_connection_ids()));

-- ---- contacts ------------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON public.contacts;
DROP POLICY IF EXISTS contacts_insert ON public.contacts;
DROP POLICY IF EXISTS contacts_update ON public.contacts;
DROP POLICY IF EXISTS contacts_delete ON public.contacts;

CREATE POLICY contacts_select ON public.contacts FOR SELECT
  USING (is_account_member(account_id)
         AND (NOT personal_only OR id IN (SELECT public.my_personal_contact_ids())));
-- A member never creates a hidden contact.
CREATE POLICY contacts_insert ON public.contacts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent') AND NOT personal_only);
CREATE POLICY contacts_update ON public.contacts FOR UPDATE
  USING (is_account_member(account_id, 'agent')
         AND (NOT personal_only OR id IN (SELECT public.my_personal_contact_ids())))
  WITH CHECK (is_account_member(account_id, 'agent')
              AND (NOT personal_only OR id IN (SELECT public.my_personal_contact_ids())));
CREATE POLICY contacts_delete ON public.contacts FOR DELETE
  USING (is_account_member(account_id, 'agent')
         AND (NOT personal_only OR id IN (SELECT public.my_personal_contact_ids())));

-- ---- contact_notes, deals: follow their contact / conversation -------
DROP POLICY IF EXISTS contact_notes_select ON public.contact_notes;
DROP POLICY IF EXISTS contact_notes_insert ON public.contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON public.contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON public.contact_notes;

CREATE POLICY contact_notes_select ON public.contact_notes FOR SELECT
  USING (is_account_member(account_id)
         AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_notes.contact_id));
CREATE POLICY contact_notes_insert ON public.contact_notes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent')
              AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_notes.contact_id));
CREATE POLICY contact_notes_update ON public.contact_notes FOR UPDATE
  USING (is_account_member(account_id, 'agent')
         AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_notes.contact_id));
CREATE POLICY contact_notes_delete ON public.contact_notes FOR DELETE
  USING (is_account_member(account_id, 'agent')
         AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_notes.contact_id));

DROP POLICY IF EXISTS deals_select ON public.deals;
DROP POLICY IF EXISTS deals_insert ON public.deals;
DROP POLICY IF EXISTS deals_update ON public.deals;
DROP POLICY IF EXISTS deals_delete ON public.deals;

CREATE POLICY deals_select ON public.deals FOR SELECT
  USING (is_account_member(account_id)
         AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = deals.contact_id))
         AND (conversation_id IS NULL OR EXISTS (SELECT 1 FROM public.conversations v WHERE v.id = deals.conversation_id)));
CREATE POLICY deals_insert ON public.deals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent')
              AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = deals.contact_id))
              AND (conversation_id IS NULL OR EXISTS (SELECT 1 FROM public.conversations v WHERE v.id = deals.conversation_id)));
CREATE POLICY deals_update ON public.deals FOR UPDATE
  USING (is_account_member(account_id, 'agent')
         AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = deals.contact_id))
         AND (conversation_id IS NULL OR EXISTS (SELECT 1 FROM public.conversations v WHERE v.id = deals.conversation_id)));
CREATE POLICY deals_delete ON public.deals FOR DELETE
  USING (is_account_member(account_id, 'agent')
         AND (contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = deals.contact_id))
         AND (conversation_id IS NULL OR EXISTS (SELECT 1 FROM public.conversations v WHERE v.id = deals.conversation_id)));

-- ---- history import progress ---------------------------------------
DROP POLICY IF EXISTS whatsapp_history_imports_read ON public.whatsapp_history_imports;
CREATE POLICY whatsapp_history_imports_read ON public.whatsapp_history_imports
  FOR SELECT TO authenticated
  USING (connection_id IN (SELECT public.visible_connection_ids()));

-- ---- a contact joins the team when the business talks to it ---------
CREATE OR REPLACE FUNCTION public.conversations_share_business_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_connections w WHERE w.id = NEW.connection_id AND w.scope = 'business'
  ) THEN
    UPDATE public.contacts SET personal_only = false
     WHERE id = NEW.contact_id AND personal_only;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.conversations_share_business_contact() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_share_business_contact ON public.conversations;
CREATE TRIGGER conversations_share_business_contact
  AFTER INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_share_business_contact();

-- A member creates a contact by hand whose number only a personal
-- number knew: the existing (hidden) row becomes the team's, instead of
-- the insert failing on the account's unique phone index.
CREATE OR REPLACE FUNCTION public.share_personal_contact(p_account_id UUID, p_phone TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  digits TEXT := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  cid UUID;
BEGIN
  IF digits = '' THEN
    RETURN NULL;
  END IF;
  -- The service role (public API, imports) passes; a user must be an agent of the account.
  IF auth.uid() IS NOT NULL AND NOT public.is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.contacts
     SET personal_only = false
   WHERE account_id = p_account_id AND personal_only AND phone_normalized = digits
  RETURNING id INTO cid;
  RETURN cid;
END
$$;
REVOKE ALL ON FUNCTION public.share_personal_contact(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_personal_contact(UUID, TEXT) TO authenticated, service_role;

-- ---- a personal conversation is its owner's to handle ---------------
CREATE OR REPLACE FUNCTION public.conversations_personal_assignee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.whatsapp_connections w
     WHERE w.id = NEW.connection_id AND w.scope = 'personal'
       AND w.owner_user_id IS DISTINCT FROM NEW.assigned_agent_id
  ) THEN
    RAISE EXCEPTION 'a personal number''s conversation can only be assigned to its owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.conversations_personal_assignee() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_personal_assignee ON public.conversations;
CREATE TRIGGER conversations_personal_assignee
  BEFORE INSERT OR UPDATE OF assigned_agent_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_personal_assignee();

-- ---- private media of personal numbers -------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chat-media-private', 'chat-media-private', FALSE, 16777216)
ON CONFLICT (id) DO UPDATE SET public = FALSE;

DROP POLICY IF EXISTS "Owners read personal chat media" ON storage.objects;
DROP POLICY IF EXISTS "Owners upload personal chat media" ON storage.objects;
DROP POLICY IF EXISTS "Owners update personal chat media" ON storage.objects;
DROP POLICY IF EXISTS "Owners delete personal chat media" ON storage.objects;

CREATE POLICY "Owners read personal chat media" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media-private'
         AND (storage.foldername(name))[1] IN (SELECT 'connection-' || v::text FROM public.visible_connection_ids() v));
CREATE POLICY "Owners upload personal chat media" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-media-private'
              AND (storage.foldername(name))[1] IN (SELECT 'connection-' || v::text FROM public.visible_connection_ids() v));
CREATE POLICY "Owners update personal chat media" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'chat-media-private'
         AND (storage.foldername(name))[1] IN (SELECT 'connection-' || v::text FROM public.visible_connection_ids() v));
CREATE POLICY "Owners delete personal chat media" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-media-private'
         AND (storage.foldername(name))[1] IN (SELECT 'connection-' || v::text FROM public.visible_connection_ids() v));

NOTIFY pgrst, 'reload schema';
