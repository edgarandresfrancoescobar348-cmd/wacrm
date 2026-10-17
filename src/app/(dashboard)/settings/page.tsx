'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppSettings } from '@/components/settings/whatsapp-settings';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { InboxSettings } from '@/components/settings/inbox-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import {
  resolveSection,
  SECTION_META,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import { SettingsTitleInHeaderProvider } from '@/components/settings/settings-panel-head';
import { WaListLayout, WaPanelHeader } from '@/components/layout/wa-panel';

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: t(`appearance.modes.${mode}`),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency, t],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: <WhatsAppSettings />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    inbox: <InboxSettings />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  // Mobile shows one pane: the section list, or the open section. The
  // bare /settings landing (no ?tab) is the list; an explicit section —
  // Overview included — opens the main pane.
  const showMain = searchParams.get('tab') !== null;
  const meta = SECTION_META[section];
  const SectionIcon = meta.icon;

  const back = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('tab');
    const qs = params.toString();
    router.replace(qs ? `/settings?${qs}` : '/settings', { scroll: false });
  };

  return (
    <WaListLayout
      showMain={showMain}
      list={<SettingsRail active={section} onSelect={go} hints={hints} />}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <WaPanelHeader
          leading={
            <>
              <button
                type="button"
                onClick={back}
                aria-label={t('back')}
                className="-ml-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-hover-surface hover:text-foreground lg:hidden"
              >
                <ArrowLeft className="size-5" />
              </button>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-chip-active text-chip-active-foreground">
                <SectionIcon className="size-5" />
              </span>
            </>
          }
          title={t(`sections.${section}`)}
          subtitle={t(`sectionHints.${section}`)}
        />
        {/* Wallpaper tone under the content so surface cards stay
            raised in light mode (in dark it equals the app bg). */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-wallpaper">
          <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-8 sm:py-6">
            <SettingsTitleInHeaderProvider>{panel[section]}</SettingsTitleInHeaderProvider>
          </div>
        </div>
      </div>
    </WaListLayout>
  );
}
