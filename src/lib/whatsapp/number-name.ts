// How the UI names one of the account's WhatsApp numbers (phase 6): the
// label given in Settings, else the linked phone, else what it is.

import { formatPhoneDisplay } from './phone-display'

export interface NamedNumber {
  provider: 'meta' | 'openwa'
  scope: 'personal' | 'business'
  label: string | null
  phone: string | null
}

export interface NumberNameLabels {
  official: string
  personal: string
  business: string
}

export function numberName(n: NamedNumber, labels: NumberNameLabels): string {
  if (n.label?.trim()) return n.label.trim()
  if (n.phone) return formatPhoneDisplay(n.phone)
  if (n.provider === 'meta') return labels.official
  return n.scope === 'personal' ? labels.personal : labels.business
}
