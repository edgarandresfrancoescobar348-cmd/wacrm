// ============================================================
// Persisting a message WE sent — race-safe against its own echo.
//
// On a QR-code connection OpenWA reports every outgoing message back as
// `message.sent`, often before the send call has even returned. The
// webhook records such an echo (it is how messages typed on the phone
// reach the CRM), so the sender and the echo race to insert the same
// (conversation_id, message_id). The unique index keeps one row; this
// helper makes sure that row ends up with the SENDER's metadata
// (sender_type, template, interactive payload, AI flag, reply) and that
// the sender never fails because the echo won. Status is not merged:
// acks may already have moved the row past `sent`, and statuses only go
// forward.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface OutboundMessageRow {
  conversation_id: string
  message_id: string
  sender_type: 'agent' | 'bot'
  content_type: string
  content_text?: string | null
  media_url?: string | null
  template_name?: string | null
  interactive_payload?: unknown
  status?: string
  reply_to_message_id?: string | null
  ai_generated?: boolean
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

/**
 * Insert the sender's row, or — when the echo got there first — merge
 * the sender's fields into it. Returns the persisted row; throws only on
 * a real DB error.
 */
export async function persistOutboundMessage<T = Record<string, unknown>>(
  db: SupabaseClient,
  row: OutboundMessageRow,
): Promise<T> {
  const { data, error } = await db.from('messages').insert(row).select().single()
  if (!error) return data as T
  if (!isUniqueViolation(error)) throw new Error(error.message)

  const { status: _ignored, ...metadata } = row
  void _ignored
  const { data: merged, error: mergeError } = await db
    .from('messages')
    .update(metadata)
    .eq('conversation_id', row.conversation_id)
    .eq('message_id', row.message_id)
    .select()
    .single()
  if (mergeError) throw new Error(mergeError.message)
  return merged as T
}
