-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 055 replaced its JSONB[] params argument with JSONB (PostgREST turned
  -- per-recipient param arrays into a 2-D jsonb[]); the check below reads
  -- the JSONB signature.
  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb)'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients is missing or has the ambiguous RETURNING — migrations 041/055 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL')
      AND (roles && ARRAY['public', 'anon']::name[])
      AND (qual LIKE '%avatars%' OR qual LIKE '%flow-media%' OR qual LIKE '%chat-media%')
  ) THEN
    RAISE EXCEPTION
      'a storage SELECT policy on avatars/flow-media/chat-media still applies to anon — migration 043 did not apply';
  END IF;
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
      AND policyname IN (
        'Users can read their own avatar',
        'Members can read flow media',
        'Members can read chat media'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'the scoped storage SELECT policies are missing — migration 043 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public._bcast_bump(uuid,text,integer)',
      'public.recompute_broadcast_counts(uuid)',
      'public.claim_ai_reply_slot(uuid,integer)',
      'public.record_webhook_failure(uuid,integer)',
      'public.merge_duplicate_contacts()',
      'public.merge_duplicate_conversations()'
    ]::regprocedure[]) AS f(fn)
    WHERE has_function_privilege('anon', f.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', f.fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f.fn, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'an internal SECURITY DEFINER function is still executable by anon/authenticated — migration 044 did not apply';
  END IF;

  -- 045 widens the automation_pending_executions status CHECK. It is a
  -- DROP + ADD by name, so a wrong constraint name would leave the old
  -- CHECK in place and every "wait for reply" park would be rejected at
  -- runtime, not at migration time.
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint
        WHERE conname = 'automation_pending_executions_status_check')
     ) NOT LIKE '%awaiting_reply%' THEN
    RAISE EXCEPTION
      'automation_pending_executions_status_check does not allow awaiting_reply — migration 045 did not apply';
  END IF;
  IF to_regclass('public.idx_automation_pending_awaiting_reply') IS NULL THEN
    RAISE EXCEPTION
      'idx_automation_pending_awaiting_reply is missing — migration 045 did not apply';
  END IF;

  -- 047: the OpenWA connection. A typo'd table name would apply cleanly
  -- and leave QR-code mode with nowhere to keep its session; a missing
  -- RLS flag would expose the encrypted gateway key to PostgREST.
  IF to_regclass('public.whatsapp_openwa_config') IS NULL THEN
    RAISE EXCEPTION 'whatsapp_openwa_config is missing — migration 047 did not apply';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.whatsapp_openwa_config'::regclass) THEN
    RAISE EXCEPTION 'whatsapp_openwa_config must have RLS enabled — migration 047';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'provider'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.provider is missing — migration 047 did not apply';
  END IF;

  -- 048: the delivery ledger must track processing state, or a failed
  -- delivery is answered "duplicate" on redelivery and lost.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'openwa_webhook_deliveries'
      AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'openwa_webhook_deliveries.status is missing — migration 048 did not apply';
  END IF;

  -- 050: early delivery receipts are kept and applied by triggers.
  IF to_regclass('public.message_status_pending') IS NULL THEN
    RAISE EXCEPTION 'message_status_pending is missing — migration 050 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'apply_pending_status' AND tgrelid = 'public.messages'::regclass) THEN
    RAISE EXCEPTION 'apply_pending_status trigger on messages is missing — migration 050 did not apply';
  END IF;

  -- 051: SECURITY DEFINER receipt triggers must pin pg_temp last.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_apply_pending_status_to_message'
      AND 'search_path=pg_catalog, public, pg_temp' = ANY (proconfig)
  ) THEN
    RAISE EXCEPTION '_apply_pending_status_to_message has an unsafe search_path — migration 051 did not apply';
  END IF;
  -- 052–054: receipts RPC, inbound completion, broadcast checkpoint.
  IF to_regprocedure('public.apply_message_receipt(uuid,text,text,jsonb,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'apply_message_receipt is missing — migration 052 did not apply';
  END IF;
  IF to_regprocedure('public.bump_conversation_on_inbound(uuid,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'bump_conversation_on_inbound(uuid,text,uuid) is missing — migration 053 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcasts' AND column_name = 'auto_resume_at'
  ) THEN
    RAISE EXCEPTION 'broadcasts.auto_resume_at is missing — migration 054 did not apply';
  END IF;

  -- 056: durable broadcast send attempts (third review H3–H7).
  IF to_regclass('public.broadcast_send_attempts') IS NULL
     OR to_regprocedure('public.broadcast_attempt_begin(uuid,uuid,timestamptz,text,text,interval)') IS NULL
     OR to_regprocedure('public.broadcast_attempt_reconcile_echo(uuid,text,text,text,timestamptz)') IS NULL
     OR to_regprocedure('public.broadcast_attempt_decide(uuid,uuid,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'broadcast send attempts are missing — migration 056 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcast_recipients'::regclass
      AND conname = 'broadcast_recipients_status_check'
      AND pg_get_constraintdef(oid) LIKE '%unknown%'
  ) THEN
    RAISE EXCEPTION 'broadcast_recipients.status does not allow ''unknown'' — migration 056 did not apply';
  END IF;
  IF has_function_privilege('authenticated', 'public.broadcast_attempt_begin(uuid,uuid,timestamptz,text,text,interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'broadcast_attempt_begin is executable by authenticated — migration 056 grants are wrong';
  END IF;

  -- 057: the inbound fan-out outbox (H1).
  IF to_regclass('public.inbound_fanout_tasks') IS NULL
     OR to_regprocedure('public.complete_inbound_message(uuid,text,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.claim_inbound_fanout(uuid,integer,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'inbound fan-out outbox is missing — migration 057 did not apply';
  END IF;

  -- 058: the active-connection flag is derived from the OpenWA session.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mirror_openwa_session_status' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'derive_openwa_config_status' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'OpenWA status mirror triggers are missing — migration 058 did not apply';
  END IF;

  -- 059: send evidence (fourth review K1, K2, quarantine).
  IF to_regprocedure('public.broadcast_attempt_settle_evidence(uuid,uuid,text[],text)') IS NULL
     OR (SELECT format_type(prorettype, NULL) FROM pg_proc
          WHERE oid = to_regprocedure('public.broadcast_attempt_reconcile_stored(uuid,uuid)')) IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'send evidence functions are missing — migration 059 did not apply';
  END IF;

  -- 060: fan-out outcomes (K3–K5).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inbound_fanout_tasks_status_check' AND pg_get_constraintdef(oid) LIKE '%held%'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'ingest_fanout'
  ) OR to_regprocedure('public.complete_stale_inbound_messages(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'fan-out outcomes are missing — migration 060 did not apply';
  END IF;

  -- 061: the per-account connection lock (K6).
  IF to_regprocedure('public.set_openwa_active(uuid,uuid)') IS NULL
     OR to_regprocedure('public.apply_openwa_session_state(uuid,jsonb,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'connection lock RPCs are missing — migration 061 did not apply';
  END IF;
  IF has_function_privilege('authenticated', 'public.apply_openwa_session_state(uuid,jsonb,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'apply_openwa_session_state is executable by authenticated — migration 061 grants are wrong';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
