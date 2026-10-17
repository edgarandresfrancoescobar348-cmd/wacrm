// WhatsApp groups in QR mode (phase 5e). WhatsApp lists them with the
// chats, so the inbox does too: the group's name and photo, each message
// labelled with its sender, the preview "Sender: text", replies to the
// group. They are NOT CRM contacts and never run bots, automations, flows,
// AI auto-reply or broadcasts — group messages never enter the contact
// pipeline (ingestInboundMessage) or the fan-out outbox.

import type { SupabaseClient } from '@supabase/supabase-js'

import { previewFor } from '@/lib/whatsapp/message-content'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { getOpenWaGroup, getOpenWaProfilePicture, type OpenWaCredentials } from './client'
import { mapOpenWaMessage, openWaMediaProxyUrl, phoneFromChatId, type OpenWaMessageData } from './events'
import { forwardFlags, groupSenderName, mediaMetaFor, statusFromAck } from './parity'
import type { IncomingMessageRow } from './import-refresh'
import { replaceWaitingPlaceholder } from './placeholders'

export function isGroupChatId(chatId: string | null | undefined): boolean {
  return Boolean(chatId?.endsWith('@g.us'))
}

export interface GroupConversation {
  id: string
  group_name: string | null
  last_message_at: string | null
}

function isUniqueViolation(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23505'
}

/**
 * The number's conversation for a group, created on first sight (name
 * and photo from the gateway when not given). Keyed on (number,
 * wa_chat_id) — migration 085's unique index (the same group on two of
 * the account's numbers is two conversations); a concurrent creator wins
 * and its row is returned.
 */
export async function findOrCreateGroupConversation(
  admin: SupabaseClient,
  args: {
    accountId: string
    /** The QR number (whatsapp_connections.id). */
    connectionId: string
    userId: string
    chatId: string
    name?: string | null
    creds?: OpenWaCredentials
    sessionId?: string | null
  },
): Promise<GroupConversation> {
  const select = () =>
    admin
      .from('conversations')
      .select('id, group_name, last_message_at')
      .eq('connection_id', args.connectionId)
      .eq('wa_chat_id', args.chatId)
      .maybeSingle()
  const { data: existing, error } = await select()
  if (error) throw new Error(`group conversation lookup failed: ${error.message}`)
  if (existing) {
    if (args.name && args.name !== existing.group_name) {
      await admin.from('conversations').update({ group_name: args.name }).eq('id', existing.id)
    }
    return existing as GroupConversation
  }

  let name = args.name?.trim() || null
  let avatar: string | null = null
  if (args.creds && args.sessionId) {
    if (!name) name = await getOpenWaGroup(args.creds, args.sessionId, args.chatId).then((g) => g.name || null).catch(() => null)
    avatar = await getOpenWaProfilePicture(args.creds, args.sessionId, args.chatId).then((p) => p.url ?? null).catch(() => null)
  }
  const { data: created, error: insertErr } = await admin
    .from('conversations')
    .insert({
      account_id: args.accountId,
      connection_id: args.connectionId,
      user_id: args.userId,
      contact_id: null,
      is_group: true,
      wa_chat_id: args.chatId,
      group_name: name,
      group_avatar_url: avatar,
      status: 'open',
      unread_count: 0,
    })
    .select('id, group_name, last_message_at')
    .single()
  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      const { data: raced } = await select()
      if (raced) return raced as GroupConversation
    }
    throw new Error(`group conversation insert failed: ${insertErr.message}`)
  }
  return created as GroupConversation
}

/** A group member's phone, when their id is a phone JID. */
export function memberPhone(data: OpenWaMessageData): string | null {
  const id = data.author ?? null
  return phoneFromChatId(id) ?? (data.senderPhone ? normalizePhone(data.senderPhone) || null : null)
}

/** The message row of a group message (live or history), shared columns. */
export function groupMessageRow(
  data: OpenWaMessageData,
  conversationId: string,
  chatId: string,
  at: string,
): Record<string, unknown> {
  const mapped = mapOpenWaMessage(data)
  const fromMe = Boolean(data.fromMe)
  return {
    conversation_id: conversationId,
    sender_type: fromMe ? 'agent' : 'customer',
    sender_wa_id: fromMe ? null : (data.author ?? null),
    sender_name: fromMe ? null : groupSenderName(data.contact, memberPhone(data)) || null,
    content_type: mapped.contentType,
    content_text: mapped.contentText,
    content_meta: mapped.meta,
    media_url: mapped.hasMedia && data.id ? openWaMediaProxyUrl(chatId, data.id) : null,
    media_type: mapped.hasMedia ? (data.media?.mimetype ?? null) : null,
    message_id: data.id,
    status: fromMe ? statusFromAck(data.ack) : 'delivered',
    created_at: at,
    revoked_at: mapped.revoked ? at : null,
    ...forwardFlags(data),
    media_meta: mediaMetaFor(data),
  }
}

/**
 * A live group message (webhook message.received / message.sent): store
 * it and move the group's summary. Never bots, never the fan-out outbox.
 * Idempotent on (conversation_id, message_id).
 */
export async function ingestGroupMessage(
  admin: SupabaseClient,
  args: {
    accountId: string
    connectionId: string
    userId: string
    chatId: string
    data: OpenWaMessageData
    at: string
    creds?: OpenWaCredentials
    sessionId?: string | null
  },
): Promise<'ingested' | 'duplicate'> {
  const conversation = await findOrCreateGroupConversation(admin, args)
  const row: Record<string, unknown> = {
    ...groupMessageRow(args.data, conversation.id, args.chatId, args.at),
    ingest_completed_at: new Date().toISOString(),
  }
  const { data: inserted, error } = await admin
    .from('messages')
    .upsert(row, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
    .select('id')
  if (error) throw new Error(`group message insert failed: ${error.message}`)
  if (!inserted?.length) {
    // An imported "waiting" placeholder gets its message (phase 5f).
    const replaced = await replaceWaitingPlaceholder(admin, {
      conversationId: conversation.id,
      messageId: String(row.message_id),
      row: row as unknown as IncomingMessageRow,
    })
    return replaced ? 'ingested' : 'duplicate'
  }
  const mediaMeta = row.media_meta as { durationSeconds?: number; pageCount?: number } | null
  const preview = previewFor(String(row.content_type), (row.content_meta as never) ?? null, (row.content_text as string | null) ?? null, {
    durationSeconds: mediaMeta?.durationSeconds,
    pageCount: mediaMeta?.pageCount,
    revoked: Boolean(row.revoked_at),
  })
  const { error: bumpErr } = await admin.rpc('bump_group_conversation', {
    p_conversation_id: conversation.id,
    p_account_id: args.accountId,
    p_last_text: preview,
    p_sender: (row.sender_name as string | null) ?? null,
    p_at: args.at,
    p_inbound: !args.data.fromMe,
  })
  if (bumpErr) throw new Error(`group summary failed: ${bumpErr.message}`)
  return 'ingested'
}
