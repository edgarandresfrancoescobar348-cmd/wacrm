import type { Conversation, MessageStatus } from '@/types'

/**
 * What goes before a chat's preview in the list, by WhatsApp's rule
 * (phase 5f):
 * - the newest message is yours → its ticks (✓ / ✓✓ / blue ✓✓), in a
 *   one-to-one chat or a group alike ("✓✓ 📷 4 fotos");
 * - a group, newest message from another member → their name
 *   ("Luciana Alves: …", "~Central Evolution: …");
 * - otherwise nothing: a one-to-one chat never names the sender, even a
 *   business whose name reads like a group ("Grupo Bexp": "📷 Olá! …").
 */
export type PreviewLead = { kind: 'ticks'; status: MessageStatus } | { kind: 'sender'; name: string } | null

export function previewLead(
  conv: Pick<Conversation, 'is_group' | 'last_message_status' | 'last_message_sender'>,
): PreviewLead {
  if (conv.last_message_status) return { kind: 'ticks', status: conv.last_message_status }
  if (conv.is_group && conv.last_message_sender?.trim()) return { kind: 'sender', name: conv.last_message_sender.trim() }
  return null
}
