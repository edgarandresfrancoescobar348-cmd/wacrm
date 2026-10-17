// How a phone number reads on screen when the contact has no saved name —
// like WhatsApp Web (libphonenumber's international format): "+55 11
// 93373-9259", "+1 650-253-0000". Stored phones are bare digits
// (normalizePhone); anything else is shown as it is. Display only — never
// use it for sending or matching.

import { contactHandle } from './wa-identity'

export function formatPhoneDisplay(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim()
  if (!raw) return ''
  const digits = raw.replace(/^\+/, '')
  if (!/^\d+$/.test(digits)) return raw
  // Brazil: +55 DDD then 8 (landline) or 9 (mobile) digits. WhatsApp ids
  // of older mobile numbers lack the ninth digit (556298423737); the phone
  // shows them with it, "+55 62 99842-3737": DDD + 8 digits starting 6–9
  // is a mobile. Landlines (2–5) stay as they are. Display only — the
  // stored number and the JID are untouched.
  const oldMobile = /^55([1-9][1-9])([6-9]\d{7})$/.exec(digits)
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(oldMobile ? `55${oldMobile[1]}9${oldMobile[2]}` : digits)
  if (br) return `+55 ${br[1]} ${br[2]}-${br[3]}`
  // North America (NANP).
  const nanp = /^1(\d{3})(\d{3})(\d{4})$/.exec(digits)
  if (nanp) return `+1 ${nanp[1]}-${nanp[2]}-${nanp[3]}`
  // Portugal.
  const pt = /^351(\d{3})(\d{3})(\d{3})$/.exec(digits)
  if (pt) return `+351 ${pt[1]} ${pt[2]} ${pt[3]}`
  return `+${digits}`
}

/** Only a number — digits with the usual separators — not a name. */
const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/

/**
 * The contact's title, like WhatsApp: the saved (or verified, or typed)
 * name, else its number formatted, else its other handle. A name that is
 * only the sender's own profile name is not a title — WhatsApp lists
 * "+55 62 99842-3737" and shows "~Sara Ferreira" as a detail
 * (contactProfileName). A contact created without a name stores its
 * number as `name` (identityDisplayName); that is shown formatted too.
 */
export function contactDisplayName(contact: {
  name?: string | null
  name_source?: string | null
  phone?: string | null
  wa_username?: string | null
  wa_user_id?: string | null
}): string {
  const name = contact.name?.trim()
  const isProfileName = contact.name_source === 'push'
  if (name && !PHONE_LIKE.test(name) && !isProfileName) return name
  if (contact.phone?.trim()) return formatPhoneDisplay(contact.phone)
  // No number to show: the profile name, marked as WhatsApp marks it.
  if (name && isProfileName) return `~${name}`
  if (name) return formatPhoneDisplay(name.replace(/[^\d+]/g, ''))
  return contactHandle(contact)
}

/**
 * The sender's own profile name as WhatsApp shows it next to a number
 * that isn't saved — "~Sara Ferreira" — for the header and contact panel.
 * Null when the title already is a name (saved, verified, typed).
 */
export function contactProfileName(contact: {
  name?: string | null
  name_source?: string | null
  push_name?: string | null
  phone?: string | null
}): string | null {
  const name = contact.name?.trim()
  const titled = Boolean(name && !PHONE_LIKE.test(name) && contact.name_source !== 'push')
  if (titled || !contact.phone?.trim()) return null
  const profile = contact.push_name?.trim() || (contact.name_source === 'push' ? name : null)
  return profile && !PHONE_LIKE.test(profile) ? `~${profile}` : null
}

/** contactHandle for display: the number formatted, else @username / id. */
export function contactHandleDisplay(contact: {
  phone?: string | null
  wa_username?: string | null
  wa_user_id?: string | null
}): string {
  return contact.phone?.trim() ? formatPhoneDisplay(contact.phone) : contactHandle(contact)
}
