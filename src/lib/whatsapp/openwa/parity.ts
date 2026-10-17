// What the phone's WhatsApp shows about a message beyond its content
// (phase 5e): the ticks, "Encaminhada", the media details it knows
// without a download (preview, length, pages, size), and who sent a group
// message. Shared by the live webhook and the history import, so both
// store the same thing.

import type { MediaMeta } from '@/types'
import { nameFromWhatsApp } from '@/lib/whatsapp/contact-name'
import { formatPhoneDisplay } from '@/lib/whatsapp/phone-display'
import type { OpenWaMessageData } from './events'

/** messages.status for one of the account's own messages, from WhatsApp's ack. */
export function statusFromAck(ack: number | undefined): 'sending' | 'sent' | 'delivered' | 'read' | 'failed' {
  if (typeof ack !== 'number') return 'sent'
  if (ack < 0) return 'failed'
  if (ack === 0) return 'sending'
  if (ack === 1) return 'sent'
  if (ack === 2) return 'delivered'
  return 'read' // 3 read, 4 played
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

/** media_meta: preview, length, pages, size, and whether a voice note was played. */
export function mediaMetaFor(data: OpenWaMessageData): MediaMeta | null {
  if (!data.type || !MEDIA_TYPES.has(data.type)) return null
  const m = data.media
  const meta: MediaMeta = {}
  if (m?.thumbnail && /^[A-Za-z0-9+/=]+$/.test(m.thumbnail)) meta.thumbnail = m.thumbnail
  if (m?.durationSeconds && m.durationSeconds > 0) meta.durationSeconds = Math.round(m.durationSeconds)
  if (m?.pageCount && m.pageCount > 0) meta.pageCount = Math.trunc(m.pageCount)
  if (m?.sizeBytes && m.sizeBytes > 0) meta.sizeBytes = m.sizeBytes
  if (m?.mimetype) meta.mimetype = m.mimetype
  // A voice note's "played" (blue mic): WhatsApp's ack 4.
  if ((data.type === 'voice' || data.type === 'audio') && data.ack === 4) meta.played = true
  return Object.keys(meta).length ? meta : null
}

/** is_forwarded / forwarding_score. */
export function forwardFlags(data: OpenWaMessageData): { is_forwarded: boolean; forwarding_score: number | null } {
  return {
    is_forwarded: Boolean(data.isForwarded),
    forwarding_score: data.isForwarded && data.forwardingScore ? data.forwardingScore : null,
  }
}

/**
 * How a group member is labelled on their messages, like WhatsApp: the
 * name saved in the phone, else "~push name", else the number formatted.
 */
export function groupSenderName(contact: OpenWaMessageData['contact'], senderPhone: string | null): string {
  const best = nameFromWhatsApp({
    savedName: contact?.name,
    isMyContact: contact?.isMyContact,
    verifiedName: contact?.verifiedName,
    verifiedLevel: contact?.verifiedLevel,
    isEnterprise: contact?.isEnterprise,
    pushName: contact?.pushName,
  })
  if (best) return best.source === 'push' ? `~${best.name}` : best.name
  return senderPhone ? formatPhoneDisplay(senderPhone) : ''
}
