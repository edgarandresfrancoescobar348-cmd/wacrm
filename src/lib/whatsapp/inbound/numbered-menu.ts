// ============================================================
// Numbered text menus — the interactive-message fallback for
// connections without native buttons / lists (OpenWA has no send
// endpoint for either, on any engine).
//
// Outbound, a buttons or list payload is rendered as text:
//
//     *Header*
//     Body
//
//     1. First option
//     2. Second option — its description
//
//     _Footer_
//     Reply with the option number.
//
// Inbound, the customer's typed answer is matched back to the option
// it names — its number ("2", "2.", "2)", "2️⃣") or its title, compared
// case- and accent-insensitively — and the option's id is what Flows,
// automations and the interactive_reply trigger receive, exactly as a
// native tap would have delivered it.
// ============================================================

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'

export interface MenuOption {
  id: string
  title: string
  description?: string
  /** List section the row belongs to (lists only). */
  section?: string
}

/** Options in display order; numbering is 1-based across sections. */
export function menuOptions(payload: InteractiveMessagePayload): MenuOption[] {
  if (payload.kind === 'buttons') {
    return payload.buttons.map((b) => ({ id: b.id, title: b.title }))
  }
  return payload.sections.flatMap((section) =>
    section.rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      section: section.title || undefined,
    })),
  )
}

/**
 * Render the menu as WhatsApp-formatted text. `hint` is the localized
 * "reply with the number" line.
 */
export function renderNumberedMenu(
  payload: InteractiveMessagePayload,
  hint: string,
): string {
  const lines: string[] = []
  if (payload.header?.trim()) lines.push(`*${payload.header.trim()}*`)
  lines.push(payload.body.trim())
  lines.push('')

  let lastSection: string | undefined
  menuOptions(payload).forEach((opt, i) => {
    if (opt.section && opt.section !== lastSection) {
      lines.push(`_${opt.section}_`)
      lastSection = opt.section
    }
    const desc = opt.description ? ` — ${opt.description}` : ''
    lines.push(`${i + 1}. ${opt.title}${desc}`)
  })

  lines.push('')
  if (payload.footer?.trim()) lines.push(`_${payload.footer.trim()}_`)
  lines.push(hint)
  return lines.join('\n')
}

const KEYCAP_DIGITS: Record<string, string> = {
  '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4',
  '5️⃣': '5', '6️⃣': '6', '7️⃣': '7', '8️⃣': '8', '9️⃣': '9', '🔟': '10',
}

/** Lower-case, strip accents, collapse whitespace, trim punctuation. */
export function normalizeMenuText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?()[\]"'*_~-]+|[\s.,;:!?()[\]"'*_~-]+$/g, '')
}

/**
 * The option the customer's reply names, or null. Never guesses: text
 * that is neither a valid option number nor exactly an option title
 * (after normalization) is left alone as an ordinary message.
 */
export function matchNumberedMenuReply(
  payload: InteractiveMessagePayload,
  reply: string,
): { id: string; title: string } | null {
  const options = menuOptions(payload)
  if (options.length === 0) return null

  let text = reply.trim()
  for (const [cap, digit] of Object.entries(KEYCAP_DIGITS)) {
    if (text === cap) text = digit
  }

  // "2", "2.", "2)", "#2", " 2 "
  const numeric = text.match(/^#?\s*(\d{1,2})\s*[.)\-]?$/)
  if (numeric) {
    const n = Number(numeric[1])
    if (n >= 1 && n <= options.length) {
      const opt = options[n - 1]
      return { id: opt.id, title: opt.title }
    }
    return null
  }

  const normalized = normalizeMenuText(text)
  if (!normalized) return null
  const byTitle = options.filter((o) => normalizeMenuText(o.title) === normalized)
  // Two options with the same title can't be told apart — leave it.
  if (byTitle.length === 1) return { id: byTitle[0].id, title: byTitle[0].title }
  return null
}
