// ============================================================
// Adding and removing one of the account's WhatsApp numbers (phase 6).
// Server only, service role; callers check who may (connection-access).
//
// Removing is logical: the number gets `removed_at`, its session is
// unlinked and deleted on the gateway (QR) or its credentials dropped
// (official), and it leaves the lists — but its conversations stay, as
// read-only history, visible to whoever could see them before.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { CONNECTION_COLUMNS, toConnection, type WaConnection, type WhatsAppConnectionRow } from './connections'
import { deleteOpenWaSession, logoutOpenWaSession } from './openwa/client'
import { loadOpenWaRow } from './openwa/connection'
import { openWaGateway } from './openwa/gateway'

/** A new QR number, not yet paired ("Conectar" shows its QR). */
export async function createQrConnection(
  admin: SupabaseClient,
  args: { accountId: string; scope: 'personal' | 'business'; userId: string; label?: string | null },
): Promise<WaConnection> {
  const { data, error } = await admin
    .from('whatsapp_connections')
    .insert({
      account_id: args.accountId,
      provider: 'openwa',
      scope: args.scope,
      owner_user_id: args.scope === 'personal' ? args.userId : null,
      label: args.label?.trim() || null,
      created_by: args.userId,
    })
    .select(CONNECTION_COLUMNS)
    .single()
  if (error || !data) throw new Error(`Failed to add the number: ${error?.message ?? 'no row'}`)
  return toConnection(data as WhatsAppConnectionRow)
}

/**
 * Remove a number: unlink and drop its session (QR) or its credentials
 * (official), then mark it removed. Gateway failures don't stop it — a
 * number that can't be reached is removed all the same.
 */
export async function removeConnection(admin: SupabaseClient, connection: WaConnection): Promise<void> {
  if (connection.provider === 'openwa') {
    const row = await loadOpenWaRow(admin, connection.id)
    const gateway = openWaGateway()
    if (row?.session_id && gateway) {
      await logoutOpenWaSession(gateway, row.session_id).catch(() => undefined)
      await deleteOpenWaSession(gateway, row.session_id).catch((err) =>
        console.warn('[numbers] gateway session delete failed:', err instanceof Error ? err.message : err),
      )
    }
    await admin.from('whatsapp_history_import_chats').delete().eq('connection_id', connection.id)
    await admin.from('whatsapp_history_imports').delete().eq('connection_id', connection.id)
    const { error } = await admin.from('whatsapp_openwa_config').delete().eq('connection_id', connection.id)
    if (error) throw new Error(`Failed to drop the session: ${error.message}`)
  } else {
    const { error } = await admin.from('whatsapp_config').delete().eq('connection_id', connection.id)
    if (error) throw new Error(`Failed to drop the credentials: ${error.message}`)
  }
  const { error } = await admin
    .from('whatsapp_connections')
    .update({ removed_at: new Date().toISOString(), status: 'disconnected', connected_at: null })
    .eq('id', connection.id)
  if (error) throw new Error(`Failed to remove the number: ${error.message}`)
}

/**
 * A member left the account: their personal numbers there are removed —
 * nobody else may ever see those conversations, and the phone must stop
 * syncing into an inbox its owner no longer has.
 */
export async function removePersonalConnectionsOf(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('whatsapp_connections')
    .select(CONNECTION_COLUMNS)
    .eq('account_id', accountId)
    .eq('owner_user_id', userId)
    .is('removed_at', null)
  if (error) throw new Error(`WhatsApp numbers lookup failed: ${error.message}`)
  const numbers = ((data ?? []) as WhatsAppConnectionRow[]).map(toConnection)
  for (const n of numbers) await removeConnection(admin, n)
  return numbers.length
}
