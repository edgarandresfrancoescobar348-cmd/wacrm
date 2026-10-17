import type { SupabaseClient } from '@supabase/supabase-js'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Conversation tenancy guard for the service-role send paths.
//
// Both engines persist an outbound message as `messages.insert({
// conversation_id })` plus a `conversations` preview update, through
// the service-role client — so RLS does not scope either write, and an
// INSERT has no `WHERE` clause to hang a tenancy predicate off.
//
// The engines already refuse a contact outside the account. A
// conversation id was taken on trust, which is what made
// GHSA-m4fx-g6pr-hrw8 exploitable: the manual trigger at
// POST /api/automations/engine copies `body.context` verbatim into the
// run, so `context.conversation_id` is caller-controlled, and a known
// foreign UUID wrote a message row into another tenant's thread.
//
// Callers check here before the Meta call rather than after: once Meta
// has the message it is delivered, and there is nothing left to undo.
// ------------------------------------------------------------

/**
 * Throw unless `conversationId` is a conversation of `accountId` on a
 * BUSINESS number, and return that number's id — the one the engines'
 * reply goes out from. A personal number's conversation (phase 6) never
 * runs anything automated, so it answers like an unknown one.
 *
 * The message is deliberately the same for "no such conversation" and
 * "not yours" — the engines surface it into automation logs the
 * triggering user can read, and distinguishing the two would confirm
 * whether a given UUID exists.
 */
export async function assertConversationInAccount(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
): Promise<{ connectionId: string }> {
  const { data, error } = await db
    .from('conversations')
    .select('id, connection_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    throw new Error(t('send.conversationLookupFailed', { message: error.message }))
  }
  if (!data) {
    throw new Error(t('send.conversationNotFound'))
  }
  const { data: number } = await db
    .from('whatsapp_connections')
    .select('scope')
    .eq('id', data.connection_id)
    .maybeSingle()
  if (number?.scope !== 'business') {
    throw new Error(t('send.conversationNotFound'))
  }
  return { connectionId: data.connection_id as string }
}
