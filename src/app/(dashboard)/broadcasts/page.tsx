'use client';

import { useTranslations } from 'next-intl';
import { LayoutTemplate, Radio, Send, UserPlus } from 'lucide-react';
import { WaEmptyState } from '@/components/layout/wa-panel';
import { useCan } from '@/hooks/use-can';

/**
 * Main pane of `/broadcasts` with nothing selected (WA home idiom). The
 * broadcast list itself is the layout's left panel.
 */
export default function BroadcastsPage() {
  const t = useTranslations('Broadcasts.page');
  const canCreate = useCan('send-messages');

  return (
    <div className="wa-wallpaper h-full">
      <WaEmptyState
        icon={Radio}
        title={t('title')}
        description={t('subtitle')}
        cta={canCreate ? { label: t('newBroadcast'), href: '/broadcasts/new' } : undefined}
        actions={[
          ...(canCreate
            ? [{ icon: Send, label: t('newBroadcast'), href: '/broadcasts/new' }]
            : []),
          { icon: LayoutTemplate, label: t('shortcutTemplates'), href: '/settings?tab=templates' },
          { icon: UserPlus, label: t('shortcutContacts'), href: '/contacts' },
        ]}
      />
    </div>
  );
}
