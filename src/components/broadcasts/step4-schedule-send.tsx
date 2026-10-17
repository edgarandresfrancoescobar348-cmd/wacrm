'use client';

import { useEffect, useState } from 'react';
import { countAudience, type AudienceConfig } from '@/lib/broadcast-audience';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  FileText,
  Languages,
  Loader2,
  PencilLine,
  Save,
  Send,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { StepCard, StepHeading, StepNav } from './wizard-ui';
import { useLocale, useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import type { ConnectionView } from '@/hooks/use-whatsapp-connections';
import { formatNumber } from '@/lib/locale-format';

interface Step4Props {
  /** The business number it goes out from (phase 6): pacing on a QR one. */
  number?: ConnectionView;
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  number,
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const locale = useLocale();
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const qrMode = number?.provider === 'openwa';
  // A QR number's pause between two sends (its settings).
  const [delayMs, setDelayMs] = useState<number | null>(null);
  useEffect(() => {
    if (!qrMode || !number) return;
    let cancelled = false;
    fetch(`/api/whatsapp/openwa?connection_id=${number.id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setDelayMs(data?.openwa?.broadcast_delay_ms ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [qrMode, number]);
  const delaySeconds = Math.round((delayMs ?? 8000) / 1000);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        setEstimatedReach((await countAudience(createClient(), audience)) ?? 0);
      } catch {
        setEstimatedReach(0);
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <StepHeading title={t('scheduleSend.title')} subtitle={t('scheduleSend.subtitle')} />

      {/* Broadcast Name */}
      <StepCard icon={PencilLine} title={t('scheduleSend.broadcastName')}>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          aria-label={t('scheduleSend.broadcastName')}
        />
      </StepCard>

      {/* Summary — WA info rows: icon, muted label, value */}
      <StepCard title={t('scheduleSend.summary')} className="pb-2">
        <div className="-mx-1 divide-y divide-border/60">
          <SummaryRow icon={FileText} label={t('scheduleSend.template')} value={template.name} />
          <SummaryRow icon={Users} label={t('scheduleSend.audience')} value={audienceLabel} />
          <SummaryRow
            icon={Send}
            label={t('scheduleSend.estimatedReach')}
            value={
              loadingReach ? (
                <Loader2 className="size-4 animate-spin text-primary-text" />
              ) : (
                <span className="font-medium tabular-nums">
                  {formatNumber(estimatedReach, locale)}
                </span>
              )
            }
          />
          <SummaryRow
            icon={Languages}
            label={t('scheduleSend.language')}
            value={template.language ?? 'en_US'}
          />
        </div>
      </StepCard>

      {/* QR-code connection: mandatory pacing + ban-risk warning */}
      {qrMode && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl bg-amber-500/10 p-4 text-sm"
          data-testid="broadcast-ban-warning"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              {t('scheduleSend.qrWarningTitle')}
            </p>
            <p className="text-muted-foreground">
              {t('scheduleSend.qrWarningBody', { seconds: delaySeconds })}
            </p>
            {!loadingReach && estimatedReach > 0 && (
              <p className="text-muted-foreground">
                {t('scheduleSend.qrEstimate', {
                  minutes: Math.max(1, Math.ceil((estimatedReach * delaySeconds) / 60)),
                })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-2xl bg-chip-active p-4 text-chip-active-foreground">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              <p className="text-sm font-medium">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium tabular-nums">{progress}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-background/40">
            <div
              className="h-1 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <StepNav
        back={
          <Button variant="outline" onClick={onBack} disabled={isProcessing}>
            <ArrowLeft className="size-4" />
            {t('back')}
          </Button>
        }
        next={
          <>
            {onSaveDraft && (
              <Button
                variant="secondary"
                onClick={onSaveDraft}
                disabled={!name.trim() || isProcessing}
              >
                <Save className="size-4" />
                {t('scheduleSend.saveDraft')}
              </Button>
            )}

            <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
              <DialogTrigger
                render={<Button disabled={!name.trim() || isProcessing} />}
              >
                <Send className="size-4" />
                {t('scheduleSend.sendNow')}
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <div className="flex size-12 items-center justify-center rounded-full bg-chip-active text-chip-active-foreground">
                    <Send className="size-6" strokeWidth={1.75} />
                  </div>
                  <DialogTitle>{t('scheduleSend.confirmTitle')}</DialogTitle>
                  <DialogDescription>
                    {t.rich('scheduleSend.confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-foreground">{chunks}</span>
                      ),
                    })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowConfirm(false)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowConfirm(false);
                      onSend();
                    }}
                  >
                    <Send className="size-4" />
                    {t('scheduleSend.sendNow')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />
    </div>
  );
}

function SummaryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-1 py-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      {/* Some summary labels end with ":" (table-style copy); a row
          doesn't need it. */}
      <span className="flex-1 text-sm text-muted-foreground">{label.replace(/:\s*$/, '')}</span>
      <span className="min-w-0 truncate text-right text-sm text-foreground">{value}</span>
    </div>
  );
}
