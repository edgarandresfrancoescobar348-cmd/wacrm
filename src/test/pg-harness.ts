// ============================================================
// Ephemeral PostgreSQL for SQL-level tests (migrations, triggers,
// concurrency). Starts a throwaway cluster with `initdb` + `pg_ctl` on a
// unix socket in a temp dir; talks to it through `psql`. Tests use
// `describe.skipIf(!pgAvailable())` so a machine without PostgreSQL
// binaries skips them instead of failing.
// ============================================================

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function findBin(): string | null {
  if (process.env.PG_BIN && existsSync(path.join(process.env.PG_BIN, 'initdb'))) return process.env.PG_BIN
  const base = '/usr/lib/postgresql'
  if (!existsSync(base)) return null
  const versions = readdirSync(base).sort().reverse()
  for (const v of versions) {
    const bin = path.join(base, v, 'bin')
    if (existsSync(path.join(bin, 'initdb')) && existsSync(path.join(bin, 'psql'))) return bin
  }
  return null
}

const BIN = findBin()

export function pgAvailable(): boolean {
  return BIN !== null && process.env.SKIP_PG_TESTS !== '1'
}

export interface Pg {
  /** Run SQL as `role` (default the superuser); returns trimmed tuples-only output. */
  sql: (query: string, opts?: { role?: string }) => Promise<string>
  /** Apply a repo migration file. */
  migrate: (file: string) => Promise<string>
  stop: () => void
}

export async function startPg(): Promise<Pg> {
  if (!BIN) throw new Error('PostgreSQL binaries not found')
  const dir = mkdtempSync(path.join(tmpdir(), 'wacrm-pg-'))
  const data = path.join(dir, 'data')
  execFileSync(path.join(BIN, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync'], { stdio: 'ignore' })
  const port = String(20000 + Math.floor(Math.random() * 20000))
  execFileSync(
    path.join(BIN, 'pg_ctl'),
    ['-D', data, '-w', '-o', `-k ${dir} -p ${port} -c listen_addresses='' -c fsync=off`, '-l', path.join(dir, 'log'), 'start'],
    { stdio: 'ignore' },
  )
  const run = (query: string, role?: string) =>
    new Promise<string>((resolve, reject) => {
      const input = (role ? `SET ROLE ${role};\n` : '') + query
      const p = spawn(path.join(BIN, 'psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', dir, '-p', port, '-U', 'postgres', 'postgres'])
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${code}`))))
      p.stdin.end(input)
    })
  return {
    sql: (query, opts) => run(query, opts?.role),
    migrate: (file) => run(readFileSync(path.join(process.cwd(), 'supabase/migrations', file), 'utf8')),
    stop: () => {
      try {
        execFileSync(path.join(BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/**
 * The slice of the app schema the WhatsApp receipt/ingest migrations
 * touch, with Supabase's roles. Column names match the real tables.
 */
export const MINIMAL_SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.accounts(id uuid PRIMARY KEY);
CREATE TABLE public.conversations(id uuid PRIMARY KEY, account_id uuid NOT NULL, unread_count int NOT NULL DEFAULT 0,
  last_message_text text, last_message_at timestamptz, updated_at timestamptz);
CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.conversations,
  sender_type text NOT NULL DEFAULT 'customer', message_id text, status text NOT NULL DEFAULT 'sent',
  error_code integer, error_title text, error_details text, created_at timestamptz DEFAULT now());
CREATE TABLE public.broadcasts(id uuid PRIMARY KEY, account_id uuid NOT NULL, status text DEFAULT 'sending');
CREATE TABLE public.broadcast_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id uuid NOT NULL REFERENCES public.broadcasts,
  whatsapp_message_id text, status text NOT NULL DEFAULT 'pending', sent_at timestamptz, delivered_at timestamptz,
  read_at timestamptz, error_message text, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
GRANT SELECT, INSERT, UPDATE ON public.messages, public.broadcast_recipients TO authenticated;
GRANT SELECT ON public.conversations, public.broadcasts TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`

/**
 * MINIMAL_SCHEMA plus every column/table the WhatsApp migrations 053–059
 * and the code under test touch (contacts, conversation/contact link,
 * broadcast and recipient columns, the two connection tables). Column
 * names match the real tables.
 */
export const WA_SCHEMA = MINIMAL_SCHEMA + `
CREATE TABLE public.contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, phone text);
ALTER TABLE public.conversations ADD COLUMN contact_id uuid, ADD COLUMN status text NOT NULL DEFAULT 'open';
ALTER TABLE public.messages ADD COLUMN content_text text;
ALTER TABLE public.broadcasts ADD COLUMN template_name text, ADD COLUMN template_language text,
  ADD COLUMN delivery_locked_at timestamptz, ADD COLUMN updated_at timestamptz;
ALTER TABLE public.broadcast_recipients ADD COLUMN contact_id uuid, ADD COLUMN template_params jsonb,
  ADD CONSTRAINT broadcast_recipients_status_check
    CHECK (status IN ('pending','sent','delivered','read','replied','failed'));
CREATE TABLE public.whatsapp_config(id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid PRIMARY KEY, user_id uuid, provider text NOT NULL DEFAULT 'meta',
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected')), connected_at timestamptz,
  updated_at timestamptz);
CREATE TABLE public.whatsapp_openwa_config(id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid PRIMARY KEY,
  base_url text, api_key text, engine text, session_id text, session_name text, webhook_id text, webhook_secret text,
  status text, phone text, push_name text, last_error text, restriction jsonb, reconnect_attempts int,
  status_updated_at timestamptz, connected_at timestamptz, broadcast_delay_ms int, updated_at timestamptz,
  status_event_at timestamptz);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`

/** The WhatsApp migrations in order (each idempotent). */
export const WA_MIGRATIONS = [
  '053_inbound_completion.sql',
  '054_broadcast_send_checkpoint.sql',
  '056_broadcast_send_attempts.sql',
  '057_inbound_fanout_outbox.sql',
  '058_openwa_status_mirror.sql',
  '059_send_evidence.sql',
  '060_fanout_outcomes.sql',
  '061_connection_lock.sql',
  '064_openwa_embedded_gateway.sql',
  '067_whatsapp_parity.sql',
]

/**
 * The account / member / WhatsApp slice as it stood before phase 6
 * (migrations 072–073 apply on top of it): Supabase's auth.uid() from
 * the request's JWT claims, storage's buckets/objects, profiles and
 * is_account_member, the conversation / contact / message tables with
 * their pre-072 uniques and their 017 policies, both connection tables
 * in their one-per-account shape, the 063 history-import tables and the
 * outbound rows that get a number. Column names match the real tables.
 */
export const CONNECTIONS_SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO authenticated, service_role;
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;

CREATE TYPE public.account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TABLE public.accounts(id uuid PRIMARY KEY);
CREATE TABLE public.profiles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users,
  account_id uuid NOT NULL REFERENCES public.accounts, account_role public.account_role_enum NOT NULL);
CREATE FUNCTION public.is_account_member(target_account_id uuid, min_role public.account_role_enum DEFAULT 'viewer')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
    AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
     >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END) $$;
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE FUNCTION public.openwa_config_status(p_status text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT CASE WHEN p_status = 'ready' THEN 'connected' ELSE 'disconnected' END $$;

CREATE TABLE public.contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, account_id uuid NOT NULL,
  phone text NOT NULL DEFAULT '', name text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone, '\\D', '', 'g')) STORED);
CREATE UNIQUE INDEX idx_contacts_account_phone_normalized ON public.contacts(account_id, phone_normalized) WHERE phone_normalized <> '';
CREATE TABLE public.conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, account_id uuid NOT NULL,
  contact_id uuid REFERENCES public.contacts ON DELETE CASCADE, status text NOT NULL DEFAULT 'open', assigned_agent_id uuid,
  unread_count int DEFAULT 0, last_message_text text, last_message_at timestamptz, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), wa_chat_id text, is_group boolean NOT NULL DEFAULT false, is_self boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX idx_conversations_account_contact ON public.conversations(account_id, contact_id);
CREATE UNIQUE INDEX conversations_account_wa_chat ON public.conversations(account_id, wa_chat_id) WHERE wa_chat_id IS NOT NULL;
CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.conversations ON DELETE CASCADE,
  sender_type text NOT NULL DEFAULT 'customer', content_text text, message_id text, status text NOT NULL DEFAULT 'sent',
  created_at timestamptz DEFAULT now());
CREATE TABLE public.message_reactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL REFERENCES public.messages ON DELETE CASCADE,
  conversation_id uuid NOT NULL, emoji text NOT NULL);
CREATE TABLE public.contact_tags(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.contacts ON DELETE CASCADE, tag_id uuid);
CREATE TABLE public.contact_custom_values(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.contacts ON DELETE CASCADE,
  custom_field_id uuid, value text);
CREATE TABLE public.contact_notes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.contacts ON DELETE CASCADE,
  user_id uuid, account_id uuid NOT NULL, note_text text);
CREATE TABLE public.deals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid, conversation_id uuid, title text);
CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid);
CREATE TABLE public.flow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid);
CREATE TABLE public.ai_usage_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid);
CREATE TABLE public.broadcasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
CREATE TABLE public.automations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
CREATE TABLE public.flows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL);
CREATE TABLE public.whatsapp_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  account_id uuid NOT NULL UNIQUE, phone_number_id text UNIQUE, access_token text, status text NOT NULL DEFAULT 'disconnected',
  connected_at timestamptz, updated_at timestamptz, provider text NOT NULL DEFAULT 'meta', mirror_inbound_media boolean NOT NULL DEFAULT true,
  CONSTRAINT whatsapp_config_meta_credentials_check CHECK (provider <> 'meta' OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)));
CREATE TABLE public.whatsapp_openwa_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  user_id uuid, engine text, session_id text UNIQUE, session_name text, webhook_id text, webhook_secret text,
  status text NOT NULL DEFAULT 'created', phone text, push_name text, last_error text, restriction jsonb, reconnect_attempts int,
  status_updated_at timestamptz, status_event_at timestamptz, connected_at timestamptz, broadcast_delay_ms int NOT NULL DEFAULT 8000,
  updated_at timestamptz, CONSTRAINT whatsapp_openwa_config_account_id_key UNIQUE (account_id));
CREATE TABLE public.whatsapp_history_imports(account_id uuid PRIMARY KEY, session_id text NOT NULL, status text NOT NULL DEFAULT 'queued',
  next_run_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.whatsapp_history_import_chats(account_id uuid NOT NULL, chat_id text NOT NULL, status text NOT NULL DEFAULT 'pending',
  chat_timestamp bigint, conversation_id uuid, PRIMARY KEY (account_id, chat_id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','contacts','contact_notes','deals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (is_account_member(account_id))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (is_account_member(account_id, ''agent''))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (is_account_member(account_id, ''agent''))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (is_account_member(account_id, ''agent''))', t || '_delete', t);
  END LOOP;
END $$;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON public.messages FOR SELECT USING (EXISTS (SELECT 1 FROM public.conversations c
  WHERE c.id = messages.conversation_id AND is_account_member(c.account_id)));
CREATE POLICY messages_modify ON public.messages FOR ALL USING (EXISTS (SELECT 1 FROM public.conversations c
  WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent')));
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_reactions_select ON public.message_reactions FOR SELECT USING (EXISTS (SELECT 1 FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = message_reactions.message_id AND is_account_member(c.account_id)));
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_select ON public.contact_tags FOR SELECT USING (EXISTS (SELECT 1 FROM public.contacts c
  WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id)));
ALTER TABLE public.contact_custom_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_custom_values_select ON public.contact_custom_values FOR SELECT USING (EXISTS (SELECT 1 FROM public.contacts c
  WHERE c.id = contact_custom_values.contact_id AND is_account_member(c.account_id)));
ALTER TABLE public.whatsapp_history_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_history_import_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_history_imports_read ON public.whatsapp_history_imports FOR SELECT TO authenticated
  USING (account_id IN (SELECT p.account_id FROM public.profiles p WHERE p.user_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`

/** Phase 6: several numbers per account, and who sees a personal one. */
export const CONNECTIONS_MIGRATIONS = ['072_whatsapp_connections.sql', '073_whatsapp_connection_visibility.sql']

/**
 * The whole WhatsApp schema as of phase 6, for tests that run app code
 * over real tables: CONNECTIONS_SCHEMA plus the columns and tables the
 * WhatsApp migrations 053–071 build on, then WA_FULL_MIGRATIONS on top
 * (053 … 074, each as shipped).
 */
export const WA_FULL_SCHEMA = CONNECTIONS_SCHEMA + `
ALTER TABLE public.messages ADD COLUMN error_code integer, ADD COLUMN error_title text, ADD COLUMN error_details text,
  ADD COLUMN content_type text NOT NULL DEFAULT 'text', ADD COLUMN media_url text, ADD COLUMN media_type text,
  ADD COLUMN reply_to_message_id uuid, ADD COLUMN interactive_reply_id text, ADD COLUMN ai_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN interactive_payload jsonb, ADD COLUMN template_name text, ADD COLUMN sender_id uuid, ADD COLUMN revoked_at timestamptz,
  ADD COLUMN edited_at timestamptz;
CREATE UNIQUE INDEX messages_conversation_message ON public.messages(conversation_id, message_id);
ALTER TABLE public.contacts ADD COLUMN wa_user_id text, ADD COLUMN wa_parent_user_id text, ADD COLUMN wa_username text,
  ADD COLUMN avatar_url text, ADD COLUMN email text, ADD COLUMN company text;
ALTER TABLE public.conversations ADD COLUMN ai_autoreply_disabled boolean NOT NULL DEFAULT false, ADD COLUMN ai_reply_count int NOT NULL DEFAULT 0;
ALTER TABLE public.broadcasts ADD COLUMN user_id uuid, ADD COLUMN name text, ADD COLUMN status text DEFAULT 'sending',
  ADD COLUMN template_name text, ADD COLUMN template_language text, ADD COLUMN delivery_locked_at timestamptz,
  ADD COLUMN updated_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN total_recipients int DEFAULT 0,
  ADD COLUMN sent_count int DEFAULT 0, ADD COLUMN delivered_count int DEFAULT 0, ADD COLUMN read_count int DEFAULT 0,
  ADD COLUMN replied_count int DEFAULT 0, ADD COLUMN failed_count int DEFAULT 0;
CREATE TABLE public.broadcast_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id uuid NOT NULL REFERENCES public.broadcasts,
  contact_id uuid, whatsapp_message_id text, status text NOT NULL DEFAULT 'pending', sent_at timestamptz, delivered_at timestamptz,
  read_at timestamptz, replied_at timestamptz, error_message text, template_params jsonb, created_at timestamptz DEFAULT now(),
  CONSTRAINT broadcast_recipients_status_check CHECK (status IN ('pending','sent','delivered','read','replied','failed')));
ALTER TABLE public.whatsapp_config ADD COLUMN waba_id text, ADD COLUMN verify_token text, ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE public.whatsapp_history_imports ADD COLUMN started_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN finished_at timestamptz,
  ADD COLUMN limited_history boolean NOT NULL DEFAULT false, ADD COLUMN chats_total int NOT NULL DEFAULT 0, ADD COLUMN chats_done int NOT NULL DEFAULT 0,
  ADD COLUMN chats_skipped int NOT NULL DEFAULT 0, ADD COLUMN messages_imported int NOT NULL DEFAULT 0, ADD COLUMN errors int NOT NULL DEFAULT 0,
  ADD COLUMN last_error text;
ALTER TABLE public.whatsapp_history_import_chats ADD COLUMN name text, ADD COLUMN unread_count int NOT NULL DEFAULT 0,
  ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN messages_imported int NOT NULL DEFAULT 0, ADD COLUMN error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public.openwa_webhook_deliveries(idempotency_key text NOT NULL, account_id uuid NOT NULL, event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (account_id, idempotency_key));
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE TABLE public.automation_pending_executions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid);
CREATE TABLE public.automation_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER TABLE public.flow_runs ADD COLUMN contact_id uuid, ADD COLUMN account_id uuid, ADD COLUMN status text;
ALTER TABLE public.notifications ADD COLUMN contact_id uuid;
`

export const WA_FULL_MIGRATIONS = [
  '053_inbound_completion.sql',
  '054_broadcast_send_checkpoint.sql',
  '056_broadcast_send_attempts.sql',
  '057_inbound_fanout_outbox.sql',
  '058_openwa_status_mirror.sql',
  '059_send_evidence.sql',
  '060_fanout_outcomes.sql',
  '061_connection_lock.sql',
  '062_message_content_meta.sql',
  '063_whatsapp_history_import.sql',
  '064_openwa_embedded_gateway.sql',
  '065_history_import_empty_conversations.sql',
  '066_history_media.sql',
  '067_whatsapp_parity.sql',
  '068_whatsapp_list_parity.sql',
  '069_whatsapp_chat_order.sql',
  '070_whatsapp_untimed_chats.sql',
  '071_voice_preview_duration.sql',
  ...CONNECTIONS_MIGRATIONS,
  '074_broadcast_number_evidence.sql',
]
