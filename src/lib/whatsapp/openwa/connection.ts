// ============================================================
// A QR number's OpenWA session row (`whatsapp_openwa_config`, one per
// QR number — `connection_id`, phase 6).
//
// Service role only — the table has no client RLS policies. The webhook
// secret is decrypted here and nowhere else; what goes to the browser is
// `toPublicOpenWaState`, which never carries it. The gateway URL and key
// are deployment config (./gateway.ts), not per-account data.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import {
  isOpenWaSessionStatus,
  type OpenWaCredentials,
  type OpenWaRestriction,
  type OpenWaSessionStatus,
} from './client'
import { requireOpenWaGateway } from './gateway'

export interface OpenWaConnectionRow {
  id: string
  account_id: string
  connection_id: string
  user_id: string
  engine: string | null
  session_id: string | null
  session_name: string | null
  webhook_id: string | null
  webhook_secret: string | null
  status: string
  phone: string | null
  push_name: string | null
  last_error: string | null
  restriction: OpenWaRestriction | null
  reconnect_attempts: number | null
  status_updated_at: string | null
  connected_at: string | null
  broadcast_delay_ms: number
  updated_at: string
}

export interface OpenWaConnection extends OpenWaCredentials {
  accountId: string
  /** The QR number (whatsapp_connections.id). */
  connectionId: string
  userId: string
  sessionId: string | null
  sessionName: string | null
  webhookId: string | null
  /** Decrypted; null until a webhook was registered. */
  webhookSecret: string | null
  engine: string | null
  status: OpenWaSessionStatus
  phone: string | null
  pushName: string | null
  broadcastDelayMs: number
}

/** The session row of a QR number. */
export async function loadOpenWaRow(
  admin: SupabaseClient,
  connectionId: string,
): Promise<OpenWaConnectionRow | null> {
  const { data, error } = await admin
    .from('whatsapp_openwa_config')
    .select('*')
    .eq('connection_id', connectionId)
    .maybeSingle()
  if (error) {
    console.error('[openwa] connection lookup failed:', error.message)
    return null
  }
  return (data as OpenWaConnectionRow | null) ?? null
}

/** The row plus the gateway's credentials. Throws when the gateway isn't configured. */
export function rowToConnection(row: OpenWaConnectionRow): OpenWaConnection {
  return {
    ...requireOpenWaGateway(),
    accountId: row.account_id,
    connectionId: row.connection_id,
    userId: row.user_id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret ? decrypt(row.webhook_secret) : null,
    engine: row.engine,
    status: isOpenWaSessionStatus(row.status) ? row.status : 'disconnected',
    phone: row.phone,
    pushName: row.push_name,
    broadcastDelayMs: row.broadcast_delay_ms,
  }
}

export async function loadOpenWaConnection(
  admin: SupabaseClient,
  connectionId: string,
): Promise<OpenWaConnection | null> {
  const row = await loadOpenWaRow(admin, connectionId)
  return row ? rowToConnection(row) : null
}

/** What the settings UI may see. No key, no secret. */
export interface PublicOpenWaState {
  configured: boolean
  engine: string | null
  session_id: string | null
  status: OpenWaSessionStatus | null
  phone: string | null
  push_name: string | null
  last_error: string | null
  restriction: OpenWaRestriction | null
  reconnect_attempts: number | null
  status_updated_at: string | null
  connected_at: string | null
  broadcast_delay_ms: number | null
  webhook_registered: boolean
}

export function toPublicOpenWaState(row: OpenWaConnectionRow | null): PublicOpenWaState {
  return {
    configured: Boolean(row),
    engine: row?.engine ?? null,
    session_id: row?.session_id ?? null,
    status: row && isOpenWaSessionStatus(row.status) ? row.status : null,
    phone: row?.phone ?? null,
    push_name: row?.push_name ?? null,
    last_error: row?.last_error ?? null,
    restriction: row?.restriction ?? null,
    reconnect_attempts: row?.reconnect_attempts ?? null,
    status_updated_at: row?.status_updated_at ?? null,
    connected_at: row?.connected_at ?? null,
    broadcast_delay_ms: row?.broadcast_delay_ms ?? null,
    webhook_registered: Boolean(row?.webhook_id),
  }
}
