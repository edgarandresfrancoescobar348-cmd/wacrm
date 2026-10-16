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
  validateOpenWaKey,
  type OpenWaCredentials,
  type OpenWaSession,
} from './client'
import {
  loadOpenWaRow,
  toPublicOpenWaState,
  type OpenWaConnectionRow,
  type PublicOpenWaState,
} from './connection'
import { openWaWebhookBaseUrl, requireOpenWaGateway } from './gateway'

export const OPENWA_WEBHOOK_PATH = '/api/whatsapp/openwa/webhook'

/** Random webhook secret: 32 bytes → 64 hex chars (OpenWA needs ≥ 16). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

function sessionName(accountId: string): string {
  return `wacrm-${accountId.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Row patch for a session state read live from the gateway. It is the
 * state as of NOW, so it also advances `status_event_at`: a webhook
 * event dated before this read (late redelivery, replay) must not
 * overwrite it (migration 049).
 */
export function sessionPatch(session: OpenWaSession, row: OpenWaConnectionRow | null) {
  const now = new Date().toISOString()
  return {
    status_event_at: now,
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
  // Through the per-account connection lock (migration 061): a session
  // change and a switch to QR mode never interleave (K6).
  const { data, error } = await admin.rpc('apply_openwa_session_state', {
    p_account_id: accountId,
    p_patch: patch,
    p_session_id: null,
    p_event_at: null,
  })
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) throw new Error(`Failed to save OpenWA state: ${error?.message ?? 'no row'}`)
  return row as OpenWaConnectionRow
}

/** The account's session row, created on its first "Conectar". */
async function createRow(admin: SupabaseClient, accountId: string, userId: string): Promise<OpenWaConnectionRow> {
  const { data, error } = await admin
    .from('whatsapp_openwa_config')
    .upsert({ account_id: accountId, user_id: userId }, { onConflict: 'account_id', ignoreDuplicates: true })
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`Failed to create the QR-code connection: ${error.message}`)
  // A concurrent "Conectar" created it first (ignoreDuplicates returns nothing).
  const row = (data as OpenWaConnectionRow | null) ?? (await loadOpenWaRow(admin, accountId))
  if (!row) throw new Error('Failed to create the QR-code connection')
  return row
}

/**
 * Make QR mode the account's active connection. Creates the config row
 * for an account that never had one (Meta columns stay null — allowed in
 * OpenWA mode by migration 047's CHECK). The status is derived from the
 * session row by the database (058), under the same per-account
 * connection lock as every session change (061, K6).
 */
export async function activateOpenWaProvider(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<void> {
  const { error } = await admin.rpc('set_openwa_active', { p_account_id: accountId, p_user_id: userId })
  if (error) throw new Error(`Failed to activate QR-code mode: ${error.message}`)
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
): Promise<PublicOpenWaState> {
  // The gateway is the deployment's own: nothing to configure first.
  const creds = requireOpenWaGateway()
  // Fails fast (503) when the gateway is down or refuses the server key.
  const info = await validateOpenWaKey(creds)
  const engine = info?.engineType === 'baileys' || info?.engineType === 'whatsapp-web.js' ? info.engineType : null
  let row = (await loadOpenWaRow(admin, accountId)) ?? (await createRow(admin, accountId, userId))

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

  const webhookUrl = `${openWaWebhookBaseUrl()}${OPENWA_WEBHOOK_PATH}`
  const hook = await ensureWebhook(creds, row, session.id, webhookUrl)
  row = await updateRow(admin, accountId, {
    engine,
    webhook_id: hook.webhookId,
    ...(hook.secret ? { webhook_secret: encrypt(hook.secret) } : {}),
  })

  if (['created', 'disconnected', 'failed'].includes(session.status)) {
    session = await startOpenWaSession(creds, session.id)
  }
  row = await updateRow(admin, accountId, sessionPatch(session, row))
  await activateOpenWaProvider(admin, accountId, userId)
  return toPublicOpenWaState(row)
}

/** "Reiniciar sessão": stop, then start (OpenWA has no restart route). */
export async function restartOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) throw new OpenWaError('No OpenWA session to restart', 400, 'no_session')
  const creds = requireOpenWaGateway()
  await stopOpenWaSession(creds, row.session_id).catch((err) => {
    // Already stopped is fine; anything else surfaces from start below.
    console.warn('[openwa] stop before restart failed:', err instanceof Error ? err.message : err)
  })
  const session = await startOpenWaSession(creds, row.session_id)
  // whatsapp_config.status follows the session row (migration 058).
  const updated = await updateRow(admin, accountId, sessionPatch(session, row))
  return toPublicOpenWaState(updated)
}

/** "Desconectar": log the device out (unlinks it on the phone). */
export async function logoutOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) throw new OpenWaError('No OpenWA session to disconnect', 400, 'no_session')
  const creds = requireOpenWaGateway()
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
  return toPublicOpenWaState(updated)
}

/** Pull the live session state from OpenWA (webhooks may lag or be blocked). */
export async function refreshOpenWa(
  admin: SupabaseClient,
  accountId: string,
): Promise<PublicOpenWaState> {
  const row = await loadOpenWaRow(admin, accountId)
  if (!row?.session_id) return toPublicOpenWaState(row)
  const session = await fetchSession(requireOpenWaGateway(), row.session_id)
  if (!session) {
    const updated = await updateRow(admin, accountId, {
      status: 'disconnected',
      status_updated_at: new Date().toISOString(),
      connected_at: null,
    })
    return toPublicOpenWaState(updated)
  }
  const updated = await updateRow(admin, accountId, sessionPatch(session, row))
  return toPublicOpenWaState(updated)
}
