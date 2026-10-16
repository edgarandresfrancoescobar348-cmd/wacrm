import type { ConversationStatus } from '@/types'

export type InboxFilter = ConversationStatus | 'all' | 'unread' | 'groups'

/**
 * The inbox chip row: WhatsApp's filters first, in its order (Todas, Não
 * lidas, Grupos), then the CRM's (Abertas, Pendentes, Fechadas). In QR-code
 * mode "Grupos" is always there, like on the phone; with the official API
 * only once a group exists (phase 5f).
 */
export function filterOptionsFor(
  { qrMode, hasGroups }: { qrMode: boolean; hasGroups: boolean },
  t: (key: string) => string,
): { label: string; value: InboxFilter }[] {
  return [
    { label: t('filterAll'), value: 'all' },
    { label: t('filterUnread'), value: 'unread' },
    ...(qrMode || hasGroups ? [{ label: t('filterGroups'), value: 'groups' as const }] : []),
    { label: t('filterOpen'), value: 'open' },
    { label: t('filterPending'), value: 'pending' },
    { label: t('filterClosed'), value: 'closed' },
  ]
}
