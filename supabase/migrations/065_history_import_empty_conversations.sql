-- ============================================================
-- 065_history_import_empty_conversations.sql — remove the empty
--     conversations the QR-code history import created (phase 5c)
--
-- Until this release the import created the contact and the
-- conversation BEFORE reading the chat's history. For chats whose
-- history holds only WhatsApp's content-less placeholders (skipped,
-- correctly) that left a conversation with no messages and no
-- last_message_at, listed as "Nenhuma mensagem ainda" — 91 of 498 on a
-- real account. The import now reads the history first and creates
-- nothing for such a chat; this removes the ones already created.
--
-- Only what the import created and nobody touched:
--   conversation — referenced by an import checkpoint
--                  (whatsapp_history_import_chats.conversation_id), no
--                  messages, no last_message_at, not assigned, and no
--                  deal, flow run, notification, reaction or AI usage;
--   contact      — the contact of such a conversation, created after
--                  that account's import started, left with no other
--                  conversation, and with no tags, notes, custom
--                  values, deals, broadcasts, automations, flow runs or
--                  notifications (several of those cascade, so they are
--                  checked, never deleted through it).
-- The checkpoint becomes `skipped` ("no messages to import") and the
-- job's done/skipped counters follow.
--
-- Idempotent: a second run finds nothing. Service role / migration only.
-- ============================================================

DO $$
DECLARE
  removed_conversations INTEGER;
  removed_contacts INTEGER;
BEGIN
  CREATE TEMP TABLE _empty_import_conv ON COMMIT DROP AS
  SELECT c.id, c.account_id, c.contact_id
    FROM public.conversations c
    JOIN public.whatsapp_history_import_chats ic
      ON ic.conversation_id = c.id AND ic.account_id = c.account_id
   WHERE c.last_message_at IS NULL
     AND c.assigned_agent_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.flow_runs f WHERE f.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.message_reactions r WHERE r.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.ai_usage_log u WHERE u.conversation_id = c.id);

  -- Checkpoints first (their FK is ON DELETE SET NULL, which would lose
  -- the link), with the job counters.
  UPDATE public.whatsapp_history_imports j
     SET chats_done = GREATEST(0, j.chats_done - x.n),
         chats_skipped = j.chats_skipped + x.n,
         updated_at = now()
    FROM (SELECT account_id, count(*)::int AS n FROM _empty_import_conv GROUP BY account_id) x
   WHERE j.account_id = x.account_id;

  UPDATE public.whatsapp_history_import_chats ic
     SET status = 'skipped', error = 'no messages to import', conversation_id = NULL, updated_at = now()
    FROM _empty_import_conv e
   WHERE ic.conversation_id = e.id;

  DELETE FROM public.conversations c USING _empty_import_conv e WHERE c.id = e.id;
  GET DIAGNOSTICS removed_conversations = ROW_COUNT;

  DELETE FROM public.contacts ct
   USING (SELECT DISTINCT e.contact_id, e.account_id FROM _empty_import_conv e) e
    JOIN public.whatsapp_history_imports j ON j.account_id = e.account_id
   WHERE ct.id = e.contact_id
     AND ct.account_id = e.account_id
     AND ct.created_at >= j.started_at - interval '1 minute'
     AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.contact_tags t WHERE t.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.contact_notes n WHERE n.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.contact_custom_values v WHERE v.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.broadcast_recipients b WHERE b.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.automation_pending_executions a WHERE a.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.automation_logs l WHERE l.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.flow_runs f WHERE f.contact_id = ct.id)
     AND NOT EXISTS (SELECT 1 FROM public.notifications n2 WHERE n2.contact_id = ct.id);
  GET DIAGNOSTICS removed_contacts = ROW_COUNT;

  RAISE NOTICE '065: removed % empty imported conversations and % contacts created only for them',
    removed_conversations, removed_contacts;
END
$$;
