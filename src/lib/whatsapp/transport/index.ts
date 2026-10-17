// ============================================================
// Transports — a WhatsApp number (`whatsapp_connections`, phase 6)
// resolved into a ready-to-use sender.
//
// The official number's credentials live in `whatsapp_config`; a QR
// number's session in `whatsapp_openwa_config`. Neither table is read by
// the browser for secrets: the Meta token and the OpenWA webhook secret
// are only ever read here, server-side, through the service role.
//
// A reply goes out from the conversation's own number
// (loadConversationTransport); what the business starts goes out from a
// business number (pickBusinessConnection, then loadConnectionTransport).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadConnection, type WaConnection } from '@/lib/whatsapp/connections'
import { createMetaTransport } from './meta'
import { createOpenWaTransport } from './openwa'
import { loadOpenWaConnection } from '@/lib/whatsapp/openwa/connection'
import {
  TransportNotConfiguredError,
  type WhatsAppTransport,
} from './types'

export * from './types'
export { sendWithRecipientVariants } from './recipient-retry'

/** The number a conversation belongs to, and the transport that sends from it. */
export interface ConnectionTransport {
  connection: WaConnection
  transport: WhatsAppTransport
}

/**
 * Build the transport for one number. `connection` is the number or its
 * id. Throws {@link TransportNotConfiguredError} when it can't send:
 * removed, never set up, or (QR) no session.
 */
export async function loadConnectionTransport(
  connection: WaConnection | string,
  opts: {
    /** Re-encrypt a legacy CBC Meta token in the background (the
     *  dashboard/public send path has always done this). */
    upgradeLegacyToken?: boolean
  } = {},
): Promise<ConnectionTransport> {
  const admin = supabaseAdmin()
  const conn = typeof connection === 'string' ? await loadConnection(admin, connection) : connection
  if (!conn) throw new TransportNotConfiguredError()
  if (conn.removedAt) throw new TransportNotConfiguredError('This WhatsApp number was removed')

  if (conn.provider === 'openwa') {
    const session = await loadOpenWaConnection(admin, conn.id)
    if (!session || !session.sessionId) {
      throw new TransportNotConfiguredError('WhatsApp (QR Code) not connected')
    }
    return { connection: conn, transport: createOpenWaTransport(session) }
  }

  const { data: config, error } = await admin
    .from('whatsapp_config')
    .select('id, phone_number_id, access_token')
    .eq('connection_id', conn.id)
    .maybeSingle()
  if (error || !config?.phone_number_id || !config.access_token) throw new TransportNotConfiguredError()
  const accessToken = decrypt(config.access_token)

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (opts.upgradeLegacyToken && isLegacyFormat(config.access_token)) {
    void admin
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error: upgradeError }: { error: { message: string } | null }) => {
        if (upgradeError) {
          console.warn('[whatsapp-transport] access_token GCM upgrade failed:', upgradeError.message)
        }
      })
  }

  return {
    connection: conn,
    transport: createMetaTransport({ phoneNumberId: config.phone_number_id, accessToken }),
  }
}

/**
 * The transport of a conversation's own number — every reply goes out
 * from it. `db` reads the conversation: pass the user's RLS client on a
 * user-initiated send, so a member who can't see a personal number's
 * conversation can't send in it either (migration 086).
 */
export async function loadConversationTransport(
  db: SupabaseClient,
  conversationId: string,
  opts: { upgradeLegacyToken?: boolean } = {},
): Promise<ConnectionTransport> {
  const { data, error } = await db.from('conversations').select('connection_id').eq('id', conversationId).maybeSingle()
  if (error || !data?.connection_id) throw new TransportNotConfiguredError()
  return loadConnectionTransport(data.connection_id as string, opts)
}
