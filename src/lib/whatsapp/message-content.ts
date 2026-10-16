// ============================================================
// Message kinds — one structure for every WhatsApp message type, written
// the same way by the official API webhook and the QR-code (OpenWA)
// ingestion (live and history import), and rendered by one set of inbox
// components (owner adjustment A2).
//
// `content_type` stays in the messages CHECK vocabulary; what a kind
// needs beyond text + media lives in `messages.content_meta`
// (migration 062). The conversation preview stored in
// `last_message_text` is a token the list renders like WhatsApp does
// (icon + "Photo", "Voice message", "👤 Name"…), never "[text]" or empty.
// ============================================================

export type ContentMeta =
  | {
      kind: 'location'
      latitude: number
      longitude: number
      name?: string | null
      address?: string | null
      url?: string | null
    }
  | { kind: 'contact'; contacts: SharedContact[] }
  | { kind: 'poll'; question: string; options: string[]; multiple: boolean }
  | { kind: 'call'; video: boolean; missed: boolean }
  | { kind: 'order'; orderId?: string | null; itemCount?: number | null; text?: string | null }
  | { kind: 'product'; productId?: string | null; title?: string | null; description?: string | null }
  /** WhatsApp withheld the payload from linked devices (e.g. some OTPs). */
  | { kind: 'masked' }
  | { kind: 'sticker' }
  | { kind: 'voice' }
  | { kind: 'document'; filename?: string | null; sizeBytes?: number | null }

export type ContentKind = ContentMeta['kind']

export interface SharedContact {
  name: string | null
  phones: string[]
}

/** The `content_type` (messages CHECK vocabulary) each kind is stored as. */
export function contentTypeForKind(kind: ContentKind): string {
  switch (kind) {
    case 'location':
      return 'location'
    case 'sticker':
      return 'image'
    case 'voice':
      return 'audio'
    case 'document':
      return 'document'
    default:
      return 'text'
  }
}

/** All vCards in a text (a shared contact can carry several). */
export function parseVcards(text: string | null | undefined): SharedContact[] {
  if (!text || !/BEGIN:VCARD/i.test(text)) return []
  return text
    .split(/BEGIN:VCARD/i)
    .slice(1)
    .map((card) => {
      const unfolded = card.replace(/\r?\n[ \t]/g, '')
      const fn = /^FN(?:;[^:]*)?:(.*)$/im.exec(unfolded)?.[1]?.trim()
      const n = /^N(?:;[^:]*)?:(.*)$/im.exec(unfolded)?.[1]
      const nameFromN = n
        ? n.split(';').filter(Boolean).reverse().join(' ').trim()
        : ''
      const phones = [...unfolded.matchAll(/^(?:item\d+\.)?TEL[^:\n]*:(.*)$/gim)]
        .map((m) => m[1].trim())
        .filter(Boolean)
      // waid= carries the WhatsApp number when TEL is formatted.
      const waids = [...unfolded.matchAll(/waid=(\d+)/gi)].map((m) => m[1])
      return {
        name: fn || nameFromN || null,
        phones: phones.length ? phones : waids,
      }
    })
}

/**
 * The list preview for a message, stored as `last_message_text`.
 * Tokens: `[kind]` or `[kind:detail]` — the list renders them with an
 * icon and a label; plain text stays plain text.
 */
export function previewFor(
  contentType: string,
  meta: ContentMeta | null | undefined,
  text: string | null | undefined,
): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ')
  const detail = (d: string | null | undefined) => (d ? `:${d.replace(/[\]\n]/g, ' ').slice(0, 120)}` : '')
  if (meta) {
    switch (meta.kind) {
      case 'location':
        return `[location${detail(meta.name || meta.address)}]`
      case 'contact':
        return `[contact${detail(meta.contacts.map((c) => c.name).filter(Boolean).join(', '))}]`
      case 'poll':
        return `[poll${detail(meta.question)}]`
      case 'call':
        return `[call:${meta.missed ? 'missed' : 'answered'}_${meta.video ? 'video' : 'voice'}]`
      case 'order':
        return `[order${detail(meta.text)}]`
      case 'product':
        return `[product${detail(meta.title)}]`
      case 'masked':
        return '[masked]'
      case 'sticker':
        return '[sticker]'
      case 'voice':
        return '[voice]'
      case 'document':
        return `[document${detail(t || meta.filename)}]`
    }
  }
  switch (contentType) {
    case 'image':
    case 'video':
    case 'audio':
      return `[${contentType}${detail(t)}]`
    case 'document':
      return `[document${detail(t)}]`
    case 'location':
      return `[location${detail(t)}]`
    case 'template':
      return t || '[template]'
    default:
      return t || '[message]'
  }
}

/** `[kind]` / `[kind:detail]` → its parts; null for plain text. */
export function parsePreviewToken(text: string | null | undefined): { kind: string; detail: string | null } | null {
  if (!text) return null
  const m = /^\[([a-z_]+)(?::([^\]]*))?\]$/.exec(text.trim())
  return m ? { kind: m[1], detail: m[2]?.trim() || null } : null
}

/** A Google Maps link for a location (what WhatsApp opens too). */
export function mapsUrl(meta: { latitude: number; longitude: number; url?: string | null }): string {
  if (meta.url && /^https:\/\//.test(meta.url)) return meta.url
  return `https://www.google.com/maps/search/?api=1&query=${meta.latitude},${meta.longitude}`
}
