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
  /**
   * QR mode (phase 5e), like the phone's list: a voice note's length
   * ("Mensagem de voz (0:09)"), a document's pages ("x.pdf · 1 página"),
   * a deleted message, an album of photos ("4 fotos").
   */
  extra?: { durationSeconds?: number | null; pageCount?: number | null; revoked?: boolean; albumCount?: number | null },
): string {
  const t = (text ?? '').trim().replace(/\s+/g, ' ')
  const detail = (d: string | null | undefined) => (d ? `:${d.replace(/[\]\n|]/g, ' ').slice(0, 120)}` : '')
  if (extra?.revoked) return '[revoked]'
  if (extra?.albumCount && extra.albumCount > 1) return `[album:${extra.albumCount}]`
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
        return extra?.durationSeconds ? `[voice:${formatDuration(extra.durationSeconds)}]` : '[voice]'
      case 'document':
        return `[document${detail(t || meta.filename)}${extra?.pageCount ? `|${extra.pageCount}` : ''}]`
    }
  }
  switch (contentType) {
    case 'image':
    case 'video':
    case 'audio':
      return `[${contentType}${detail(t)}]`
    case 'document':
      return `[document${detail(t)}${extra?.pageCount ? `|${extra.pageCount}` : ''}]`
    case 'location':
      return `[location${detail(t)}]`
    case 'template':
      return t || '[template]'
    default:
      return t || '[message]'
  }
}

/** WhatsApp shows 4+ photos sent together as one album ("4 fotos"). */
export const ALBUM_MIN = 4
const ALBUM_GAP_MS = 60_000

/**
 * How many photos end the conversation as one album: the newest message
 * and the ones right before it that are photos (not stickers) from the
 * same side, each within a minute of the next. 0 when fewer than
 * ALBUM_MIN. Rows newest first.
 */
export function trailingAlbumCount(
  newestFirst: { content_type: string; content_meta?: ContentMeta | null; sender_type: string; created_at: string }[],
): number {
  const first = newestFirst[0]
  const isPhoto = (r: (typeof newestFirst)[number]) => r.content_type === 'image' && r.content_meta?.kind !== 'sticker'
  if (!first || !isPhoto(first)) return 0
  let n = 1
  for (let i = 1; i < newestFirst.length; i++) {
    const r = newestFirst[i]
    if (!isPhoto(r) || r.sender_type !== first.sender_type) break
    if (Date.parse(newestFirst[i - 1].created_at) - Date.parse(r.created_at) > ALBUM_GAP_MS) break
    n++
  }
  return n >= ALBUM_MIN ? n : 0
}

/** 9 → "0:09", 75 → "1:15", like WhatsApp. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
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
