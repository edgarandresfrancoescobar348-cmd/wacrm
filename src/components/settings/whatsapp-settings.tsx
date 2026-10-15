'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Check, QrCode } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { OpenWaPanel, type OpenWaApiState } from './openwa-panel';

export type ConnectionMode = 'meta' | 'openwa';

async function fetchConnectionState(): Promise<OpenWaApiState | null> {
  const res = await fetch('/api/whatsapp/openwa', { cache: 'no-store' });
  return res.ok ? ((await res.json()) as OpenWaApiState) : null;
}

/**
 * Settings → WhatsApp. Two ways to connect, one active at a time
 * (`whatsapp_config.provider`): Meta's official Cloud API, or a regular
 * number paired by QR code through an OpenWA gateway. The cards pick
 * which panel is shown; a mode becomes ACTIVE when it is saved /
 * connected, or with "Usar este modo" once it is set up. The inactive
 * mode keeps its settings.
 */
export function WhatsAppSettings() {
  const t = useTranslations('Settings.whatsapp.modes');
  const tw = useTranslations('Settings.whatsapp');
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  const [state, setState] = useState<OpenWaApiState | null>(null);
  const [view, setView] = useState<ConnectionMode | null>(null);

  const apply = useCallback((data: OpenWaApiState | null) => {
    if (!data) return;
    setState(data);
    setView((current) => current ?? (data.provider === 'openwa' ? 'openwa' : 'meta'));
  }, []);

  /** Re-read the connection state (after a save / connect / switch). */
  const load = useCallback(async () => {
    try {
      apply(await fetchConnectionState());
    } catch (err) {
      console.error('Failed to load WhatsApp connection mode:', err);
    }
  }, [apply]);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId) return;
    fetchConnectionState()
      .then(apply)
      .catch((err) => console.error('Failed to load WhatsApp connection mode:', err));
  }, [authLoading, profileLoading, accountId, apply]);

  const active: ConnectionMode | null = state?.provider ?? null;
  const shown: ConnectionMode = view ?? 'meta';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={tw('title')} description={t('description')} />

      <div
        role="radiogroup"
        aria-label={t('label')}
        className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <ModeCard
          mode="meta"
          icon={<BadgeCheck className="size-5" />}
          title={t('meta.title')}
          tagline={t('meta.tagline')}
          selected={shown === 'meta'}
          active={active === 'meta'}
          onPick={() => setView('meta')}
        />
        <ModeCard
          mode="openwa"
          icon={<QrCode className="size-5" />}
          title={t('openwa.title')}
          tagline={t('openwa.tagline')}
          selected={shown === 'openwa'}
          active={active === 'openwa'}
          onPick={() => setView('openwa')}
        />
      </div>

      {shown === 'meta' ? (
        <WhatsAppConfig
          embedded
          active={active === null || active === 'meta'}
          onActivated={load}
        />
      ) : (
        <OpenWaPanel state={state} onChanged={load} />
      )}
    </section>
  );
}

function ModeCard({
  mode,
  icon,
  title,
  tagline,
  selected,
  active,
  onPick,
}: {
  mode: ConnectionMode;
  icon: React.ReactNode;
  title: string;
  tagline: string;
  selected: boolean;
  active: boolean;
  onPick: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.modes');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-mode={mode}
      onClick={onPick}
      className={cn(
        'flex items-start gap-3 rounded-xl bg-surface p-4 text-left outline-none transition-colors hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'ring-2 ring-primary',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          selected ? 'bg-chip-active text-chip-active-foreground' : 'bg-hover-surface text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-medium text-foreground">{title}</span>
          {active && (
            <span className="inline-flex items-center gap-1 rounded-full bg-chip-active px-2 py-0.5 text-[11px] font-medium text-chip-active-foreground">
              <Check className="size-3" />
              {t('active')}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{tagline}</span>
      </span>
    </button>
  );
}
