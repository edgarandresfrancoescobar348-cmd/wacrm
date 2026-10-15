'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, Settings2, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { FullBleedFrame } from '@/components/dashboard/full-bleed-frame';
import { WaPage } from '@/components/layout/wa-panel';

type Tab = 'playground' | 'setup' | 'usage';

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <FullBleedFrame>
      <WaPage
        title={t('title')}
        subtitle={t('description')}
        bodyClassName="p-0 sm:p-0"
      >
        {decided && (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            className="gap-0"
          >
            {/* Section switcher as WA filter chips, flush under the
                header bar like the inbox chip row. */}
            <div className="sticky top-0 z-10 bg-background px-5 pb-3">
              <TabsList>
                <TabsTrigger value="playground">
                  <Sparkles /> {t('tabPlayground')}
                </TabsTrigger>
                <TabsTrigger value="setup">
                  <Settings2 /> {t('tabSetup')}
                </TabsTrigger>
                {canViewUsage && (
                  <TabsTrigger value="usage">
                    <BarChart3 /> {t('tabUsage')}
                  </TabsTrigger>
                )}
              </TabsList>
            </div>

            <TabsContent value="playground" className="px-4 pb-4 sm:px-6 sm:pb-6">
              <AiPlayground onGoToSetup={() => setTab('setup')} />
            </TabsContent>

            <TabsContent value="setup" className="px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="max-w-4xl">
                <AiConfig />
              </div>
            </TabsContent>

            {canViewUsage && (
              <TabsContent value="usage" className="px-4 pb-4 sm:px-6 sm:pb-6">
                <div className="max-w-5xl">
                  <AiUsageCard />
                </div>
              </TabsContent>
            )}
          </Tabs>
        )}
      </WaPage>
    </FullBleedFrame>
  );
}
