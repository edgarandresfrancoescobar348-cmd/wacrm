'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import {
  WaAvatar,
  WaListPanel,
  WaListRow,
  WaSearchPill,
} from '@/components/layout/wa-panel';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';

/**
 * The settings section list, in the WhatsApp Web "Settings" idiom: it is
 * the left list panel of the page — a profile row on top, then grouped
 * rows (icon + title + one-line subtitle) with a search pill that
 * filters them. The selected section opens in the main pane.
 */
export function SettingsRail({
  active,
  onSelect,
  hints,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
}) {
  const t = useTranslations('Settings');
  const { profile } = useAuth();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const set = new Set<SettingsSection>();
    for (const s of SETTINGS_SECTIONS) {
      const haystack = `${t(`sections.${s}`)} ${t(`sectionHints.${s}`)}`.toLowerCase();
      if (!q || haystack.includes(q)) set.add(s);
    }
    return set;
  }, [q, t]);

  const displayName = profile?.full_name || profile?.email || t('overview.yourAccount');

  return (
    <WaListPanel
      title={t('pageTitle')}
      search={
        <WaSearchPill
          value={query}
          onChange={setQuery}
          placeholder={t('searchPlaceholder')}
          clearLabel={t('clearSearch')}
          aria-label={t('searchPlaceholder')}
        />
      }
    >
      <nav aria-label={t('sectionsNav')} className="pb-2">
        {!q ? (
          <WaListRow
            className="mb-1 h-[88px]"
            // Shortcut to "Your profile" (that section's own row below
            // carries the selected state).
            onClick={() => onSelect('profile')}
            avatar={
              <WaAvatar src={profile?.avatar_url} name={displayName} size={64} />
            }
            title={<span className="text-[17px]">{displayName}</span>}
            subtitle={
              profile?.email ? <span className="truncate">{profile.email}</span> : null
            }
          />
        ) : null}

        {RAIL_GROUPS.map(({ label, group }) => {
          const items = SETTINGS_SECTIONS.filter(
            (s) => SECTION_META[s].group === group && matches.has(s),
          );
          if (items.length === 0) return null;
          return (
            <div key={group} className="pt-1">
              {label ? (
                <h2 className="px-3 pt-4 pb-2 text-sm text-primary-text">
                  {t(`groups.${group}`)}
                </h2>
              ) : null}
              {items.map((s) => {
                const Icon = SECTION_META[s].icon;
                return (
                  <WaListRow
                    key={s}
                    onClick={() => onSelect(s)}
                    active={s === active}
                    avatar={
                      <span className="flex size-10 items-center justify-center text-muted-foreground">
                        <Icon className="size-[22px]" strokeWidth={1.75} />
                      </span>
                    }
                    title={t(`sections.${s}`)}
                    meta={hints?.[s] ?? undefined}
                    subtitle={
                      <span className="truncate">{t(`sectionHints.${s}`)}</span>
                    }
                  />
                );
              })}
            </div>
          );
        })}

        {matches.size === 0 ? (
          <div className="flex justify-center py-8">
            <span className="rounded-full bg-surface px-4 py-2 text-sm text-muted-foreground">
              {t('noMatches')}
            </span>
          </div>
        ) : null}
      </nav>
    </WaListPanel>
  );
}
