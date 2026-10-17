import type { InboxFilter as UpstreamInboxFilter } from './inbox-filters'

/** Upstream's filters (inbox-filters.ts) plus the phone's "Grupos". */
export type InboxFilter = UpstreamInboxFilter | 'groups'

/**
 * The inbox chip row: WhatsApp's filters first, in its order (Todas, Não
 * lidas, Grupos), then the CRM's (Aguardando resposta, Sem responsável,
 * Janela expirando — upstream's — and Abertas, Pendentes, Fechadas). In QR-code
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
    { label: t('filterWaiting'), value: 'waiting' },
    { label: t('filterUnassigned'), value: 'unassigned' },
    { label: t('filterExpiring'), value: 'expiring' },
    { label: t('filterOpen'), value: 'open' },
    { label: t('filterPending'), value: 'pending' },
    { label: t('filterClosed'), value: 'closed' },
  ]
}
