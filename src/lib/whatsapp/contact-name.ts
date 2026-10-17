// Which name a WhatsApp contact goes by — the phone's rule (phase 5e):
//   the name saved in the phone's address book
//   > the name of an OFFICIAL business account (verified level 2 /
//     enterprise — PicPay)
//   > the sender's own profile ("push") name, shown as "~Name"
//   > the number, formatted.
// Every WhatsApp Business account has a business name (`verifiedName`),
// verified or not; an unofficial one is only a profile name: WhatsApp
// lists "+55 62 99842-3737" and shows "~Sara Ferreira" (phase 5f, real
// account).
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
  /** WhatsApp's business verification: 2 is an official account. */
  verifiedLevel?: number | null
  isEnterprise?: boolean | null
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
  const business = clean(c.verifiedName)
  if (business && isOfficialBusiness(c)) return { name: business, source: 'verified' }
  // An unofficial business name is a profile name, like the push name.
  const push = clean(c.pushName) ?? business
  if (push) return { name: push, source: 'push' }
  return null
}

/** An official business account: WhatsApp titles its chat with the business name. */
export function isOfficialBusiness(c: { verifiedLevel?: number | null; isEnterprise?: boolean | null }): boolean {
  return c.isEnterprise === true || (typeof c.verifiedLevel === 'number' && c.verifiedLevel >= 2)
}

/**
 * WhatsApp sent a business name that isn't an official account's: a name
 * an earlier version stored as the title ('verified') is only the profile
 * name (contactNamePatch's `unofficialBusiness`).
 */
export function isUnofficialBusinessName(c: {
  verifiedName?: string | null
  verifiedLevel?: number | null
  isEnterprise?: boolean | null
}): boolean {
  return Boolean(c.verifiedName?.trim()) && !isOfficialBusiness(c)
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
  /**
   * WhatsApp says the business name isn't an official account's: one
   * stored as the title ('verified') becomes the profile name it is —
   * "~Sara Ferreira" next to "+55 62 99842-3737". Never a saved or typed
   * name.
   */
  opts: { unofficialBusiness?: boolean } = {},
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  if (opts.unofficialBusiness && existing.name_source === 'verified') {
    patch.name_source = 'push'
    const name = existing.name?.trim()
    if (!existing.push_name?.trim() && name && !PHONE_LIKE.test(name)) patch.push_name = name
  }
  if (incoming && existing.name_source !== 'manual' && !patch.name_source) {
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
