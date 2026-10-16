// @mentions in WhatsApp text. WhatsApp writes a mention as `@` and the
// user part of the mentioned id — a phone number, or, for a contact known
// by a privacy id, the LID (`@154112083632297`). WhatsApp Web shows the
// contact's name (or number) instead; the inbox resolves them the same
// way through /api/whatsapp/mentions.

/** `@` + 6–20 digits, not glued to a word or a longer number. */
const MENTION = /(^|[^\w@])@(\d{6,20})(?!\d)/g

export type MentionPart = { text: string } | { mention: string }

/** The distinct mentioned ids (digits) in a text, in order. */
export function mentionIds(text: string | null | undefined): string[] {
  if (!text) return []
  const ids: string[] = []
  for (const m of text.matchAll(MENTION)) if (!ids.includes(m[2])) ids.push(m[2])
  return ids
}

/** The text split into plain runs and mentions (ids without the `@`). */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    const at = m.index! + m[1].length
    if (at > last) parts.push({ text: text.slice(last, at) })
    parts.push({ mention: m[2] })
    last = at + 1 + m[2].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
