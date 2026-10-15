// ============================================================
// The account's OpenWA connection row (`whatsapp_openwa_config`).
//
// Service role only — the table has no client RLS policies. The API
// key and webhook secret are decrypted here and nowhere else; what goes
// to the browser is `toPublicOpenWaState`, which carries neither.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import {
  isOpenWaSessionStatus,
  normalizeOpenWaBaseUrl,
  type OpenWaCredentials,
  type OpenWaRestriction,
  type OpenWaSessionStatus,
} from './client'

export interface OpenWaConnectionRow {
  id: string
  account_id: string
  user_id: string
  base_url: string
  api_key: string
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

export async function loadOpenWaRow(
  admin: SupabaseClient,
  accountId: string,
): Promise<OpenWaConnectionRow | null> {
  const { data, error } = await admin
    .from('whatsapp_openwa_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[openwa] connection lookup failed:', error.message)
    return null
  }
  return (data as OpenWaConnectionRow | null) ?? null
}

export function rowToConnection(row: OpenWaConnectionRow): OpenWaConnection {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    baseUrl: row.base_url,
    apiKey: decrypt(row.api_key),
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
  accountId: string,
): Promise<OpenWaConnection | null> {
  const row = await loadOpenWaRow(admin, accountId)
  return row ? rowToConnection(row) : null
}

/** `whatsapp_config.status` for an OpenWA session status. */
export function configStatusFor(status: OpenWaSessionStatus): 'connected' | 'disconnected' {
  return status === 'ready' ? 'connected' : 'disconnected'
}

/** What the settings UI may see. No key, no secret. */
export interface PublicOpenWaState {
  configured: boolean
  base_url: string | null
  has_api_key: boolean
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
    base_url: row?.base_url ?? null,
    has_api_key: Boolean(row?.api_key),
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

function sameGateway(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  try {
    return normalizeOpenWaBaseUrl(a) === b
  } catch {
    return false
  }
}

/**
 * The API key to use for `baseUrl` (already normalized).
 *
 * A key is a credential FOR ONE GATEWAY. A typed key is the admin's own
 * to send wherever they point it. A key we hold — the account's stored
 * key, or the operator's `OPENWA_API_KEY` default — is only ever sent to
 * the gateway it is bound to: the stored row's URL, or `OPENWA_URL`.
 * Otherwise a tenant admin could aim "Testar conexão" at a server they
 * control and receive the operator's (possibly unscoped admin) key in
 * `X-API-Key`. Returns '' when no key may be used — the caller asks for
 * one explicitly.
 */
export function resolveBoundApiKey(args: {
  baseUrl: string
  typedKey?: unknown
  stored?: Pick<OpenWaConnectionRow, 'base_url' | 'api_key'> | null
}): string {
  const typed = typeof args.typedKey === 'string' ? args.typedKey.trim() : ''
  if (typed) return typed
  if (args.stored && sameGateway(args.stored.base_url, args.baseUrl)) {
    return decrypt(args.stored.api_key)
  }
  const envKey = process.env.OPENWA_API_KEY?.trim() ?? ''
  if (envKey && sameGateway(process.env.OPENWA_URL, args.baseUrl)) return envKey
  return ''
}
