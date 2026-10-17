// WhatsApp's "Aguardando mensagem. Isso pode levar algum tempo." (phase 5f):
// the history import stores a message WhatsApp listed but hasn't delivered
// to this device as that bubble (content_meta.kind = 'waiting'). When the
// real message arrives live under the same id — a webhook, which would
// otherwise be a duplicate and ignored — it replaces the placeholder in
// place, and the conversation's preview follows if it is the newest.
// The placeholder came from the import, so nothing else runs: no unread
// bump, no bots, no fan-out.

import type { SupabaseClient } from '@supabase/supabase-js'

import { previewFor, type ContentMeta } from '@/lib/whatsapp/message-content'
import { isWaiting, refreshPatch, type IncomingMessageRow, type StoredMessageState } from './import-refresh'

/** Replace the waiting placeholder with this message. False when there is none. */
export async function replaceWaitingPlaceholder(
  admin: SupabaseClient,
  args: { conversationId: string; messageId: string; row: IncomingMessageRow },
): Promise<boolean> {
  const { data, error } = await admin
    .from('messages')
    .select('id, sender_type, status, content_meta, is_forwarded, forwarding_score, media_meta, revoked_at, created_at')
    .eq('conversation_id', args.conversationId)
    .eq('message_id', args.messageId)
    .maybeSingle()
  if (error || !data) return false
  const existing = data as StoredMessageState & { created_at: string }
  if (!isWaiting(existing.content_meta)) return false
  const patch = refreshPatch(existing, args.row)
  if (!patch) return false
  const { error: upErr } = await admin
    .from('messages')
    .update(patch)
    .eq('id', existing.id)
  if (upErr) throw new Error(`placeholder replace failed: ${upErr.message}`)

  const meta = (args.row.media_meta ?? null) as { durationSeconds?: number; pageCount?: number } | null
  const preview = previewFor(args.row.content_type, (args.row.content_meta as ContentMeta | null) ?? null, args.row.content_text, {
    durationSeconds: meta?.durationSeconds,
    pageCount: meta?.pageCount,
    revoked: Boolean(args.row.revoked_at),
  })
  // The preview is the newest REAL message's: this one, unless a later
  // message (not another placeholder) is already there.
  const { data: later } = await admin
    .from('messages')
    .select('content_meta')
    .eq('conversation_id', args.conversationId)
    .gt('created_at', existing.created_at)
    .limit(200)
  const newest = !((later ?? []) as { content_meta: ContentMeta | null }[]).some((m) => !isWaiting(m.content_meta))
  if (newest) {
    await admin
      .from('conversations')
      .update({
        last_message_text: preview,
        ...(args.row.sender_name !== undefined ? { last_message_sender: args.row.sender_name } : {}),
      })
      .eq('id', args.conversationId)
  }
  return true
}
