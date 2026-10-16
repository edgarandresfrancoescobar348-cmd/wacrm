import type { MessageTemplate } from '@/types';

/**
 * Can this local template row be sent on a transport with these
 * template capabilities? A `local` template (saved or edited on a
 * QR-code connection) was never approved by Meta in its current form —
 * on the official API it must be submitted first. Sending it by name
 * would deliver whatever Meta approved under that name, not this text.
 * Client-safe (used by the template pickers too).
 */
export function templateUsableOn(
  templates: 'meta_approved' | 'local',
  row: Pick<MessageTemplate, 'origin' | 'status'> | null | undefined
): boolean {
  if (templates !== 'meta_approved' || !row) return true;
  // Only the version Meta currently has APPROVED (G8): a local draft, a
  // failed submission or a pending re-review would make a send by name
  // deliver something other than what the row shows.
  if (row.origin === 'local') return false;
  return row.status === undefined || row.status === 'APPROVED';
}

/** Template capability for an account's active provider. */
export function templateModeFor(
  provider: 'meta' | 'openwa' | null | undefined
): 'meta_approved' | 'local' {
  return provider === 'openwa' ? 'local' : 'meta_approved';
}
