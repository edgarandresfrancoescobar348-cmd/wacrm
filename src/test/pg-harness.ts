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
CREATE TABLE public.whatsapp_config(account_id uuid PRIMARY KEY, user_id uuid, provider text NOT NULL DEFAULT 'meta',
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
]
