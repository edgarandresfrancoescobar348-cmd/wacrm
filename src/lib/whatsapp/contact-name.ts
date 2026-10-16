// Which name a WhatsApp contact goes by — the phone's rule (phase 5e):
//   the name saved in the phone's address book
//   > the verified business name
//   > the sender's own profile ("push") name, shown as "~Name"
//   > the number, formatted.
// A name a CRM user typed (`manual`, set by the DB trigger of migration
// 067 on any app edit) is never overwritten by WhatsApp. A contact from
// before 067 (no source) is treated as a push name: replaced by a saved
// or verified one, like the push names that used to overwrite them.

export type NameSource = 'saved' | 'verified' | 'push' | 'phone' | 'import' | 'manual'

const RANK: Record<NameSource, number> = {
  phone: 0,
  push: 1,
  import: 2,
  verified: 3,
  saved: 4,
  manual: Number.POSITIVE_INFINITY,
}

/** Only a number — digits with the usual separators — not a name. */
export const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/

export interface NameCandidate {
  name: string
  source: NameSource
}

/**
 * The best name WhatsApp gives for a contact: the address-book name (a
 * contact's `name` when the account has them saved, or the chat list's
 * title when it is not a number), the verified business name, or the
 * push name. Null when WhatsApp gave nothing better than the number.
 */
export function nameFromWhatsApp(c: {
  savedName?: string | null
  isMyContact?: boolean | null
  verifiedName?: string | null
  pushName?: string | null
  chatTitle?: string | null
}): NameCandidate | null {
  const clean = (v: string | null | undefined) => {
    const t = v?.trim()
    return t && !PHONE_LIKE.test(t) ? t : null
  }
  const saved = c.isMyContact === false ? null : clean(c.savedName)
  if (saved) return { name: saved, source: 'saved' }
  const title = clean(c.chatTitle)
  if (title) return { name: title, source: 'saved' }
  const verified = clean(c.verifiedName)
  if (verified) return { name: verified, source: 'verified' }
  const push = clean(c.pushName)
  if (push) return { name: push, source: 'push' }
  return null
}

function rankOf(existing: { name?: string | null; name_source?: string | null }): number {
  const source = existing.name_source as NameSource | null | undefined
  if (source && source in RANK) return RANK[source]
  // Before 067: a real name counts as a push name, a number as nothing.
  const name = existing.name?.trim()
  return name && !PHONE_LIKE.test(name) ? RANK.push : RANK.phone
}

/**
 * The contact columns to write for what WhatsApp says now, or null. The
 * name moves only up (or sideways within the same source, e.g. a renamed
 * address-book entry); a manual name stays; the push name is kept apart.
 */
export function contactNamePatch(
  existing: { name?: string | null; name_source?: string | null; push_name?: string | null },
  incoming: NameCandidate | null,
  pushName?: string | null,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  if (incoming && existing.name_source !== 'manual') {
    const sameSourceRename = existing.name_source === incoming.source
    if (RANK[incoming.source] > rankOf(existing) || (sameSourceRename && incoming.name !== existing.name)) {
      patch.name = incoming.name
      patch.name_source = incoming.source
    }
  }
  const push = pushName?.trim()
  if (push && !PHONE_LIKE.test(push) && push !== existing.push_name) patch.push_name = push
  return Object.keys(patch).length ? patch : null
}
