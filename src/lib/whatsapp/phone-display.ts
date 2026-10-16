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
  // Brazil: +55 DDD then 8 (landline) or 9 (mobile) digits.
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits)
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
 * The contact's saved name, else its number formatted, else its other
 * handle. A contact created without a name stores its number as `name`
 * (identityDisplayName); that is shown formatted too, never raw.
 */
export function contactDisplayName(contact: {
  name?: string | null
  name_source?: string | null
  phone?: string | null
  wa_username?: string | null
  wa_user_id?: string | null
}): string {
  const name = contact.name?.trim()
  // Only the sender's own profile name: WhatsApp shows "~Name" (phase 5e).
  if (name && !PHONE_LIKE.test(name)) return contact.name_source === 'push' ? `~${name}` : name
  if (contact.phone?.trim()) return formatPhoneDisplay(contact.phone)
  if (name) return formatPhoneDisplay(name.replace(/[^\d+]/g, ''))
  return contactHandle(contact)
}

/** contactHandle for display: the number formatted, else @username / id. */
export function contactHandleDisplay(contact: {
  phone?: string | null
  wa_username?: string | null
  wa_user_id?: string | null
}): string {
  return contact.phone?.trim() ? formatPhoneDisplay(contact.phone) : contactHandle(contact)
}
