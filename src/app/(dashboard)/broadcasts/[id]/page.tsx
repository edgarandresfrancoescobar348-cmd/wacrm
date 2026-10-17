'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { fetchAllPages } from '@/lib/supabase/paged-query';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCheck,
  CircleHelp,
  Download,
  Loader2,
  MessageCircle,
  PlayCircle,
  Radio,
  RotateCcw,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';
import { useLocale, useTranslations } from 'next-intl';
import {
  formatDate,
  formatDateTime,
  formatNumber,
} from '@/lib/locale-format';
import {
  WaAvatar,
  WaChip,
  WaChipRow,
  WaEmptyState,
  WaIconButton,
  WaPanelHeader,
} from '@/components/layout/wa-panel';
import {
  broadcastStatusStyle,
  recipientStatusStyle,
} from '@/components/broadcasts/broadcast-status-style';
import { cn } from '@/lib/utils';

/** 36px header pill, same shape as the inbox chat header's status pill. */
const HEADER_PILL =
  'inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-medium';

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: LucideIcon;
  /** Icon disc colours (token classes). */
  tint: string;
}

function StatCard({ label, value, total, icon: Icon, tint }: StatCardProps) {
  const locale = useLocale();
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl bg-surface p-3 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
      <div className="flex items-center justify-between">
        <span className={`flex size-9 items-center justify-center rounded-full ${tint}`}>
          <Icon className="size-[18px]" strokeWidth={1.75} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <p className="mt-2.5 text-[22px] leading-7 font-medium text-foreground tabular-nums">
        {formatNumber(value, locale)}
      </p>
      <p className="truncate text-[13px] text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const t = useTranslations('Broadcasts.detail');
  const locale = useLocale();
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl bg-surface p-4 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
      <h3 className="mb-4 text-[15px] text-foreground">{t('funnel')}</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[13px] text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 overflow-hidden rounded-full bg-hover-surface">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground tabular-nums">
                  {formatNumber(step.value, locale)}
                  <span className="ml-2 opacity-70">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
  'unknown',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const locale = useLocale();
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resumingScope, setResumingScope] = useState<
    'pending' | 'failed' | null
  >(null);
  const [deciding, setDeciding] = useState<'sent' | 'not_sent' | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      // Every page: a broadcast can go to more than PostgREST's max_rows (1000).
      const recs = await fetchAllPages((from, to) =>
        supabase
          .from('broadcast_recipients')
          .select('*, contact:contacts(*)')
          .eq('broadcast_id', broadcastId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      );
      setRecipients(recs);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notFound'));
    } finally {
      setLoading(false);
    }
  }, [broadcastId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  function handleExport() {
    if (!broadcast) return;
    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  /**
   * Hand the leftovers to the server (issue #472).
   *
   * The wizard's send loop lives in the tab that started the campaign,
   * so navigating away strands the rest as 'pending' with the broadcast
   * stuck 'sending'. This is the recovery, and the same call retries
   * failed recipients.
   */
  async function handleResume(scope: 'pending' | 'failed') {
    setResumingScope(scope);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(
          t('toastResumeFailed', {
            error: payload?.error || `HTTP ${res.status}`,
          }),
        );
        return;
      }

      toast.success(
        payload.remaining > 0
          ? t('toastResumeStartedCapped', {
              count: payload.resuming,
              remaining: payload.remaining,
            })
          : t('toastResumeStarted', { count: payload.resuming }),
      );
      // Delivery runs server-side after the 202, so the counts here are
      // a snapshot — reload to pick up the first of it.
      await fetchData();
    } catch (err) {
      toast.error(
        t('toastResumeFailed', {
          error: err instanceof Error ? err.message : t('unknownError'),
        }),
      );
    } finally {
      setResumingScope(null);
    }
  }

  /**
   * A person's decision on recipients whose send outcome is unknown
   * (the gateway couldn't say whether it went out, and resending could
   * message them twice): after checking the chat, record it as sent, or
   * as not sent — which a "Retry failed" then sends with a new attempt.
   */
  async function handleOutcome(outcome: 'sent' | 'not_sent') {
    setDeciding(outcome);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('toastOutcomeFailed', { error: payload?.error || `HTTP ${res.status}` }));
        return;
      }
      toast.success(t('toastOutcomeSaved', { count: payload.decided ?? 0 }));
      await fetchData();
    } catch (err) {
      toast.error(
        t('toastOutcomeFailed', { error: err instanceof Error ? err.message : t('unknownError') }),
      );
    } finally {
      setDeciding(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="wa-wallpaper h-full">
        <WaEmptyState
          icon={AlertCircle}
          title={error ?? t('notFound')}
          cta={{ label: t('backToBroadcasts'), href: '/broadcasts' }}
        />
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);
  const style = broadcastStatusStyle(broadcast.status);
  const StatusIcon = style.icon;

  const pendingCount = recipients.filter((r) => r.status === 'pending').length;
  const retryableCount = recipients.filter((r) => r.status === 'failed').length;
  const unconfirmedCount = recipients.filter((r) => r.status === 'unknown').length;
  // A campaign whose tab went away sits in 'sending' with recipients
  // still pending and nothing left to move them. Name that state rather
  // than leaving a permanently pulsing "sending" badge.
  const isStalled = broadcast.status === 'sending' && pendingCount > 0;

  const recipientCounts = new Map<string, number>();
  for (const r of recipients) {
    recipientCounts.set(r.status, (recipientCounts.get(r.status) ?? 0) + 1);
  }

  const funnelSteps: FunnelStep[] = [
    { label: t('stats.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('stats.delivered'), value: broadcast.delivered_count, color: 'bg-primary/60' },
    { label: t('stats.read'), value: broadcast.read_count, color: 'bg-read-ticks' },
    { label: t('stats.replied'), value: broadcast.replied_count, color: 'bg-read-ticks/60' },
  ];

  const deleteTitle =
    broadcast.status === 'sending' ? t('cannotDeleteSending') : t('deleteHover');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <>
            <WaIconButton
              icon={ArrowLeft}
              label={t('backToBroadcasts')}
              href="/broadcasts"
              className="lg:hidden"
            />
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full',
                style.soft,
                style.text,
              )}
            >
              <Radio className="size-5" strokeWidth={1.75} />
            </span>
          </>
        }
        title={broadcast.name}
        subtitle={`${t('template', { name: broadcast.template_name })} · ${t('createdAt', {
          date: formatDate(broadcast.created_at, locale),
        })}`}
        actions={
          <>
            <span className={cn(HEADER_PILL, style.text)}>
              <StatusIcon className={cn('size-3.5', style.spin && 'animate-spin')} />
              <span className="hidden sm:inline">{tStatus(status.label)}</span>
            </span>
            <WaIconButton
              icon={Download}
              label={t('exportCsv')}
              onClick={handleExport}
              disabled={recipients.length === 0}
            />
            {/* Mid-send broadcasts can't be deleted because orphaning
                in-flight Meta messages would leave the funnel
                inconsistent. The span carries the reason as a title
                since a disabled button gets no hover events. */}
            <span title={deleteTitle} className="inline-flex">
              <WaIconButton
                icon={Trash2}
                label={t('delete')}
                disabled={broadcast.status === 'sending'}
                onClick={() => setConfirmDelete(true)}
                className="hover:text-destructive"
              />
            </span>
          </>
        }
      />

      {/* Wallpaper on a non-scrolling wrapper so the doodle covers the
          pane; the inner div scrolls. */}
      <div className="wa-wallpaper min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
            {/* Resume / retry (issue #472). Only rendered when there is
                actually something outstanding. */}
            {(pendingCount > 0 || retryableCount > 0) && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-chip-active p-4 text-chip-active-foreground">
                <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3 text-sm">
                  <RotateCcw className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium">
                      {isStalled ? t('resumeStalledTitle') : t('resumeTitle')}
                    </p>
                    <p className="mt-0.5 opacity-80">
                      {isStalled
                        ? t('resumeStalledHint', { count: pendingCount })
                        : t('resumeHint', { count: retryableCount })}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {pendingCount > 0 && (
                    <Button
                      size="sm"
                      onClick={() => handleResume('pending')}
                      disabled={resumingScope !== null}
                    >
                      {resumingScope === 'pending' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlayCircle className="size-3.5" />
                      )}
                      {t('resumePending', { count: pendingCount })}
                    </Button>
                  )}
                  {retryableCount > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleResume('failed')}
                      disabled={resumingScope !== null}
                      className="border-current/30 text-current hover:bg-background/30"
                    >
                      {resumingScope === 'failed' ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      {t('retryFailed', { count: retryableCount })}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Unconfirmed sends (migration 069): the outcome could not be
                established and a resend could message the customer twice,
                so a person decides after checking the chat. */}
            {unconfirmedCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-hover-surface p-4 text-sm">
                <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
                  <CircleHelp className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="font-medium">{t('outcomeTitle', { count: unconfirmedCount })}</p>
                    <p className="mt-0.5 text-muted-foreground">{t('outcomeHint')}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleOutcome('sent')} disabled={deciding !== null}>
                    {deciding === 'sent' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    {t('outcomeMarkSent')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleOutcome('not_sent')} disabled={deciding !== null}>
                    {deciding === 'not_sent' ? <Loader2 className="size-3.5 animate-spin" /> : <AlertCircle className="size-3.5" />}
                    {t('outcomeMarkNotSent')}
                  </Button>
                </div>
              </div>
            )}

            {/* Stats — 6 tiles: Total / Sent / Delivered / Read / Replied / Failed */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                label={t('stats.totalRecipients')}
                value={broadcast.total_recipients}
                total={broadcast.total_recipients}
                icon={Users}
                tint="bg-hover-surface text-muted-foreground"
              />
              <StatCard
                label={t('stats.sent')}
                value={broadcast.sent_count}
                total={broadcast.total_recipients}
                icon={Check}
                tint="bg-hover-surface text-muted-foreground"
              />
              <StatCard
                label={t('stats.delivered')}
                value={broadcast.delivered_count}
                total={broadcast.total_recipients}
                icon={CheckCheck}
                tint="bg-hover-surface text-muted-foreground"
              />
              <StatCard
                label={t('stats.read')}
                value={broadcast.read_count}
                total={broadcast.total_recipients}
                icon={CheckCheck}
                tint="bg-read-ticks/15 text-read-ticks"
              />
              <StatCard
                label={t('stats.replied')}
                value={broadcast.replied_count}
                total={broadcast.total_recipients}
                icon={MessageCircle}
                tint="bg-chip-active text-chip-active-foreground"
              />
              <StatCard
                label={t('stats.failed')}
                value={broadcast.failed_count}
                total={broadcast.total_recipients}
                icon={AlertCircle}
                tint="bg-destructive/12 text-destructive"
              />
            </div>

            <FunnelChart steps={funnelSteps} />

            {/* Recipients */}
            <div className="rounded-xl bg-surface shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
              <div className="space-y-3 px-4 pt-4 pb-3">
                <h2 className="text-[15px] text-foreground">
                  {statusFilter !== 'all'
                    ? t('recipientsHeader', {
                        filtered: filteredRecipients.length,
                        total: recipients.length,
                      })
                    : t('recipientsHeaderAll', { total: recipients.length })}
                </h2>
                <WaChipRow>
                  <WaChip
                    active={statusFilter === 'all'}
                    onClick={() => setStatusFilter('all')}
                  >
                    {t('allStatuses')}
                  </WaChip>
                  {RECIPIENT_STATUSES.map((s) => (
                    <WaChip
                      key={s}
                      active={statusFilter === s}
                      count={recipientCounts.get(s)}
                      onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
                    >
                      {tStatus(getRecipientStatus(s).label)}
                    </WaChip>
                  ))}
                </WaChipRow>
              </div>

              {filteredRecipients.length === 0 ? (
                <div className="flex h-32 items-center justify-center">
                  <span className="rounded-lg bg-hover-surface px-3 py-1.5 text-sm text-muted-foreground">
                    {recipients.length === 0
                      ? t('noRecipients')
                      : t('noRecipientsFilter')}
                  </span>
                </div>
              ) : (
                <div className="overflow-x-auto px-2 pb-2">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-0 hover:bg-transparent">
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.contact')}</TableHead>
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.status')}</TableHead>
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.sent')}</TableHead>
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.delivered')}</TableHead>
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.read')}</TableHead>
                        <TableHead className="text-[13px] font-normal text-muted-foreground">{t('table.error')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRecipients.map((recipient) => {
                        const rStatus = getRecipientStatus(recipient.status);
                        const rStyle = recipientStatusStyle(recipient.status);
                        const RIcon = rStyle.icon;
                        const contactName =
                          recipient.contact?.name ?? t('unknownContact');
                        return (
                          <TableRow
                            key={recipient.id}
                            className="border-0 hover:bg-hover-surface/60"
                          >
                            <TableCell className="rounded-l-lg py-2">
                              <div className="flex items-center gap-3">
                                <WaAvatar
                                  src={recipient.contact?.avatar_url}
                                  name={recipient.contact?.name || recipient.contact?.phone || '?'}
                                  size={36}
                                />
                                <div className="min-w-0">
                                  <p className="truncate text-sm text-foreground">
                                    {contactName}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground tabular-nums">
                                    {recipient.contact?.phone ?? '-'}
                                  </p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                                  rStyle.soft,
                                  rStyle.text,
                                )}
                              >
                                <RIcon className="size-3.5" />
                                {tStatus(rStatus.label)}
                              </span>
                            </TableCell>
                            <TableCell className="text-[13px] text-muted-foreground">
                              {recipient.sent_at
                                ? formatDateTime(recipient.sent_at, locale)
                                : '-'}
                            </TableCell>
                            <TableCell className="text-[13px] text-muted-foreground">
                              {recipient.delivered_at
                                ? formatDateTime(recipient.delivered_at, locale)
                                : '-'}
                            </TableCell>
                            <TableCell className="text-[13px] text-muted-foreground">
                              {recipient.read_at
                                ? formatDateTime(recipient.read_at, locale)
                                : '-'}
                            </TableCell>
                            <TableCell
                              title={recipient.error_message ?? undefined}
                              className="max-w-xs truncate rounded-r-lg text-xs text-destructive"
                            >
                              {recipient.error_message ?? '-'}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Delete confirmation (WA modal). */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/12 text-destructive">
              <Trash2 className="size-6" strokeWidth={1.75} />
            </div>
            <DialogTitle>{t('deletePrompt')}</DialogTitle>
            <DialogDescription>{broadcast.name}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? t('deleting') : t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
