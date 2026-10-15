// ============================================================
// OpenWA session lifecycle for one account.
//
// wacrm owns exactly one OpenWA session per account: it creates it,
// registers a per-account webhook on it (random secret, encrypted at
// rest), starts it, and mirrors its state into
// `whatsapp_openwa_config`. All functions here assume the caller has
// already checked the user is an admin of `accountId`; every query is
// filtered by it.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { encrypt } from '@/lib/whatsapp/encryption'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  createOpenWaSession,
  createOpenWaWebhook,
  deleteOpenWaWebhook,
  getOpenWaSession,
  listOpenWaWebhooks,
  logoutOpenWaSession,
  OpenWaError,
  startOpenWaSession,
  stopOpenWaSession,
  type OpenWaCredentials,
  type OpenWaSession,
} from './client'
import {
  configStatusFor,
  loadOpenWaRow,
  toPublicOpenWaState,
  type OpenWaConnectionRow,
  type PublicOpenWaState,
} from './connection'
import { credsForRow } from './events'

export const OPENWA_WEBHOOK_PATH = '/api/whatsapp/openwa/webhook'

/** Random webhook secret: 32 bytes → 64 hex chars (OpenWA needs ≥ 16). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Public base URL OpenWA should deliver to. `OPENWA_WEBHOOK_BASE_URL`
 * wins (a gateway in Docker reaches the host as
 * `http://host.docker.internal:<port>`), then `NEXT_PUBLIC_SITE_URL`,
 * then the origin of the request that triggered the connect.
 */
export function webhookBaseUrl(requestOrigin: string): string {
  const configured =
    process.env.OPENWA_WEBHOOK_BASE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim()
  return (configured || requestOrigin).replace(/\/+$/, '')
}

function sessionName(accountId: string): string {
  return `wacrm-${accountId.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`
}

function sessionPatch(session: OpenWaSession, row: OpenWaConnectionRow | null) {
  const now = new Date().toISOString()
  return {
    status: session.status,
    phone: session.phone ? normalizePhone(session.phone) || null : null,
    push_name: session.pushName ?? null,
    last_error: session.lastError ?? null,
    restriction: session.restriction ?? null,
    connected_at:
      session.status === 'ready' ? (session.connectedAt ?? row?.connected_at ?? now) : null,
    status_updated_at: now,
  }
}

async function updateRow(
  admin: SupabaseClient,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<OpenWaConnectionRow> {
  const { data, error } = await admin
    .from('whatsapp_openwa_config')
    .update(patch)
    .eq('account_id', accountId)
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to save OpenWA state: ${error?.message}`)
  return data as OpenWaConnectionRow
}

/**
 * Make QR mode the account's active connection, mirroring the session
 * status into `whatsapp_config.status`. Creates the config row for an
 * account that never had one (Meta columns stay null — allowed in
 * OpenWA mode by migration 047's CHECK).
 */
export async function activateOpenWaProvider(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
  status: string,
): Promise<void> {
  const configStatus = status === 'ready' ? 'connected' : 'disconnected'
  const { data: existing } = await admin
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()
  const patch = {
    provider: 'openwa',
    status: configStatus,
    connected_at: configStatus === 'connected' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }
  const { error } = existing
    ? await admin.from('whatsapp_config').update(patch).eq('account_id', accountId)
    : await admin.from('whatsapp_config').insert({ account_id: accountId, user_id: userId, ...patch })
  if (error) throw new Error(`Failed to activate QR-code mode: ${error.message}`)
}

async function syncConfigStatus(admin: SupabaseClient, accountId: string, status: string) {
  await admin
    .from('whatsapp_config')
    .update({ status: configStatusFor(status as never) })
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
}

/** The session row on OpenWA, or null when it no longer exists there. */
async function fetchSession(
  creds: OpenWaCredentials,
  sessionId: string | null,
): Promise<OpenWaSession | null> {
  if (!sessionId) return null
  try {
    return await getOpenWaSession(creds, sessionId)
  } catch (err) {
    if (err instanceof OpenWaError && (err.status === 404 || err.status === 400)) return null
    throw err
  }
}

/**
 * Ensure the session's webhook points at us with a secret we hold.
 * Re-registers (with a fresh secret) when ours is missing or stale.
 */
async function ensureWebhook(
  creds: OpenWaCredentials,
  row: OpenWaConnectionRow,
  sessionId: string,
  webhookUrl: string,
): Promise<{ webhookId: string; secret: string | null }> {
  const hooks = await listOpenWaWebhooks(creds, sessionId)
  const ours = hooks.find((h) => h.id === row.webhook_id)
  if (ours && ours.url === webhookUrl && ours.active && row.webhook_secret && row.session_id === sessionId) {
    return { webhookId: ours.id, secret: null }
  }
  // Drop our previous registration and any leftover one pointing at a
  // wacrm webhook path (a re-created session, a changed public URL).
  for (const hook of hooks) {
    if (hook.id === row.webhook_id || hook.url.endsWith(OPENWA_WEBHOOK_PATH)) {
      await deleteOpenWaWebhook(creds, sessionId, hook.id).catch(() => undefined)
    }
  }
  const secret = generateWebhookSecret()
  const created = await createOpenWaWebhook(creds, sessionId, { url: webhookUrl, secret })
  return { webhookId: created.id, secret }
}

/**
 * "Conectar": create the session if needed, (re)register the webhook,
 * start it (OpenWA answers once the engine is up — usually `qr_ready`)
 * and make QR mode the active connection.
 */
export async function connectOpenWa(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
  requestOrigin: string,
): Promise<PublicOpenWaState> {
  let row = await loadOpenWaRow(admin, accountId)
  if (!row) throw new OpenWaError('Save the OpenWA URL and API key first', 400, 'not_configured')
  const creds = credsForRow(row)

  let session = await fetchSession(creds, row.session_id)
  if (!session) {
    session = await createOpenWaSession(creds, sessionName(accountId))
    row = await updateRow(admin, accountId, {
      session_id: session.id,
      session_name: session.name,
      webhook_id: null,
      webhook_secret: null,
      ...sessionPatch(session, row),
    })
  }

  const webhookUrl = `${webhookBaseUrl(requestOrigin)}${OPENWA_WEBHOOK_PATH}`
  const hook = await ensureWebhook(creds, row, session.id, webhookUrl)
  row = await updateRow(admin, accountId, {
    webhook_id: hook.webhookId,
    ...(hook.secret ? { webhook_secret: encrypt(hook.secret) } : {}),
  })

  if (['created', 'disconnected', 'failed'].includes(session.status)) {
    session = await startOpenWaSession(creds, session.id)
  }
  row = await updateRow(admin, accountId, sessionPatch(session, row))
  await activateOpenWaProvider(admin, accountId, userId, session.status)
  return toPublicOpenWaState(row)
}

/** "Reiniciar sessão": stop, then start (OpenWA has no restart route). */
export async function restartOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) throw new OpenWaError('No OpenWA session to restart', 400, 'no_session')
  const creds = credsForRow(row)
  await stopOpenWaSession(creds, row.session_id).catch((err) => {
    // Already stopped is fine; anything else surfaces from start below.
    console.warn('[openwa] stop before restart failed:', err instanceof Error ? err.message : err)
  })
  const session = await startOpenWaSession(creds, row.session_id)
  const updated = await updateRow(admin, accountId, sessionPatch(session, row))
  await syncConfigStatus(admin, accountId, session.status)
  return toPublicOpenWaState(updated)
}

/** "Desconectar": log the device out (unlinks it on the phone). */
export async function logoutOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) throw new OpenWaError('No OpenWA session to disconnect', 400, 'no_session')
  const creds = credsForRow(row)
  let session: OpenWaSession
  try {
    session = await logoutOpenWaSession(creds, row.session_id)
  } catch (err) {
    // "not started" — nothing linked; stopping is the honest equivalent.
    if (err instanceof OpenWaError && err.status === 400) {
      session = await stopOpenWaSession(creds, row.session_id)
    } else {
      throw err
    }
  }
  const updated = await updateRow(admin, accountId, {
    ...sessionPatch(session, row),
    phone: null,
    push_name: null,
    connected_at: null,
  })
  await syncConfigStatus(admin, accountId, session.status)
  return toPublicOpenWaState(updated)
}

/** Pull the live session state from OpenWA (webhooks may lag or be blocked). */
export async function refreshOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) return toPublicOpenWaState(row)
  const session = await fetchSession(credsForRow(row), row.session_id)
  if (!session) {
    const updated = await updateRow(admin, accountId, {
      status: 'disconnected',
      status_updated_at: new Date().toISOString(),
      connected_at: null,
    })
    await syncConfigStatus(admin, accountId, 'disconnected')
    return toPublicOpenWaState(updated)
  }
  const updated = await updateRow(admin, accountId, sessionPatch(session, row))
  await syncConfigStatus(admin, accountId, session.status)
  return toPublicOpenWaState(updated)
}
