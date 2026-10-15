// ============================================================
// loadAccountTransport — resolve an account's active WhatsApp
// connection into a ready-to-use transport.
//
// `whatsapp_config.provider` names the active connection. The Meta
// credentials live on that row (as they always have); the OpenWA
// connection lives in `whatsapp_openwa_config`, which has no client
// RLS policies at all — its API key and webhook secret are only ever
// read here, server-side, through the service-role client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createMetaTransport } from './meta'
import { createOpenWaTransport } from './openwa'
import { loadOpenWaConnection } from '@/lib/whatsapp/openwa/connection'
import {
  TransportNotConfiguredError,
  isWhatsAppProvider,
  type WhatsAppProvider,
  type WhatsAppTransport,
} from './types'

export * from './types'
export { sendWithRecipientVariants } from './recipient-retry'

/**
 * The active provider for an account, or null when the account has no
 * WhatsApp configuration at all. A row from before the provider column
 * existed reads as 'meta'.
 */
export async function loadAccountProvider(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppProvider | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('provider')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return isWhatsAppProvider(data.provider) ? data.provider : 'meta'
}

/**
 * Build the transport for the account's active connection.
 *
 * `db` reads `whatsapp_config` (an RLS-scoped user client is fine — the
 * row is member-readable); the OpenWA secrets are read with the service
 * role, always filtered by `accountId`.
 *
 * Throws {@link TransportNotConfiguredError} when there is no usable
 * connection; callers map it to their own "not configured" error.
 */
export async function loadAccountTransport(
  db: SupabaseClient,
  accountId: string,
  opts: {
    /** Re-encrypt a legacy CBC Meta token in the background (the
     *  dashboard/public send path has always done this). */
    upgradeLegacyToken?: boolean
  } = {},
): Promise<WhatsAppTransport> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (error || !config) throw new TransportNotConfiguredError()

  const provider: WhatsAppProvider = isWhatsAppProvider(config.provider)
    ? config.provider
    : 'meta'

  if (provider === 'openwa') {
    const connection = await loadOpenWaConnection(supabaseAdmin(), accountId)
    if (!connection || !connection.sessionId) {
      throw new TransportNotConfiguredError('WhatsApp (QR Code) not connected')
    }
    return createOpenWaTransport(connection)
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new TransportNotConfiguredError()
  }
  const accessToken = decrypt(config.access_token)

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (opts.upgradeLegacyToken && isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error: upgradeError }: { error: { message: string } | null }) => {
        if (upgradeError) {
          console.warn(
            '[whatsapp-transport] access_token GCM upgrade failed:',
            upgradeError.message,
          )
        }
      })
  }

  return createMetaTransport({ phoneNumberId: config.phone_number_id, accessToken })
}
