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
  row: Pick<MessageTemplate, 'origin'> | null | undefined
): boolean {
  return !(templates === 'meta_approved' && row?.origin === 'local');
}

/** Template capability for an account's active provider. */
export function templateModeFor(
  provider: 'meta' | 'openwa' | null | undefined
): 'meta_approved' | 'local' {
  return provider === 'openwa' ? 'local' : 'meta_approved';
}
