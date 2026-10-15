/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + mode-safe WA pill classes (tokens / 600-tone text that
 * reads on both the dark and light surfaces) so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 */

import type { MessageTemplateStatus } from '@/types';
import { getT } from '@/lib/i18n/translate';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

const t = getT('TemplateStatus');

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: t('DRAFT'),
    classes: 'bg-hover-surface text-muted-foreground border-transparent',
  },
  PENDING: {
    label: t('PENDING'),
    classes: 'bg-amber-500/15 text-amber-600 border-transparent',
  },
  APPROVED: {
    label: t('APPROVED'),
    classes: 'bg-chip-active text-chip-active-foreground border-transparent',
  },
  REJECTED: {
    label: t('REJECTED'),
    classes: 'bg-destructive/12 text-destructive border-transparent',
  },
  PAUSED: {
    label: t('PAUSED'),
    classes: 'bg-orange-500/15 text-orange-600 border-transparent',
  },
  DISABLED: {
    label: t('DISABLED'),
    classes: 'bg-destructive/20 text-destructive border-transparent',
  },
  IN_APPEAL: {
    label: t('IN_APPEAL'),
    classes: 'bg-sky-500/15 text-sky-600 border-transparent',
  },
  PENDING_DELETION: {
    label: t('PENDING_DELETION'),
    classes: 'bg-hover-surface text-muted-foreground border-transparent',
  },
};
