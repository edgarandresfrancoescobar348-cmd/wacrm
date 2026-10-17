'use client';

// Settings › WhatsApp › QR code: the history import (A1) — progress
// (conversations and messages imported, errors), the Baileys limit
// notice, and "Import history" (re-runnable). Never a frozen spinner:
// waiting says what for and when the next attempt is, and a job nobody
// has run for a while says the scheduler isn't reaching it.

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Clock, History, Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ImportState {
  status: 'queued' | 'listing' | 'importing' | 'waiting_session' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  next_run_at: string | null;
  lease_until: string | null;
  limited_history: boolean;
  chats_total: number;
  chats_done: number;
  chats_skipped: number;
  messages_imported: number;
  errors: number;
  last_error: string | null;
  updated_at: string;
}

const RUNNING = new Set(['queued', 'listing', 'importing', 'waiting_session']);
/** Due this long ago, unleased and not picked up: the scheduler isn't running it. */
const STALLED_AFTER_MS = 3 * 60_000;

/** Between runs on purpose (gateway rate limit, chats back in the queue): resumes at next_run_at. */
function isPaused(job: ImportState, now: number): boolean {
  if ((job.status !== 'listing' && job.status !== 'importing') || !job.next_run_at) return false;
  const leased = job.lease_until && Date.parse(job.lease_until) > now;
  return !leased && Date.parse(job.next_run_at) > now + 5_000;
}

function isStalled(job: ImportState, now: number): boolean {
  if (!RUNNING.has(job.status) || !job.next_run_at) return false;
  const leased = job.lease_until && Date.parse(job.lease_until) > now;
  return !leased && Date.parse(job.next_run_at) < now - STALLED_AFTER_MS;
}

export function OpenWaHistoryImport({
  connectionId,
  connected,
  canEdit,
}: {
  /** The QR number whose phone's history is imported (phase 6). */
  connectionId: string;
  connected: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.whatsapp.openwa.history');
  const locale = useLocale();
  const time = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—';
  const [job, setJob] = useState<ImportState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/openwa/history?connection_id=${connectionId}`, { cache: 'no-store' });
      if (res.ok) setJob(((await res.json()) as { import: ImportState | null }).import);
    } finally {
      setLoaded(true);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress while it runs.
  useEffect(() => {
    if (!job || !RUNNING.has(job.status)) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [job, load]);

  async function start() {
    setStarting(true);
    try {
      const res = await fetch('/api/whatsapp/openwa/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error || t('startFailed'));
        return;
      }
      toast.success(t('started'));
      await load();
    } finally {
      setStarting(false);
    }
  }

  if (!loaded) return null;
  const running = !!job && RUNNING.has(job.status);
  const done = job?.status === 'done';
  const stalled = !!job && isStalled(job, Date.now());
  const paused = !!job && !stalled && isPaused(job, Date.now());
  // The first chat listing after pairing can take minutes (WhatsApp loads
  // the chats from the phone): say so instead of a bare spinner.
  const listingFor = job?.status === 'listing' && !job.chats_total ? Math.round((Date.now() - Date.parse(job.updated_at)) / 1000) : 0;
  const statusText = !job
    ? ''
    : stalled
      ? t('stalled', { time: time(job.next_run_at) })
      : paused
        ? t('pausedNext', { time: time(job.next_run_at) })
        : job.status === 'waiting_session'
          ? t('waitingNext', { time: time(job.next_run_at) })
          : job.status === 'queued'
            ? t('queuedNext', { time: time(job.next_run_at) })
            : listingFor >= 10
              ? t('listingSlow', { seconds: listingFor })
              : t(`status.${job.status}`);

  return (
    <section aria-labelledby="openwa-history" className="space-y-3 rounded-xl bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="openwa-history" className="flex items-center gap-2 text-[15px] font-medium text-foreground">
            <History className="size-4 text-muted-foreground" />
            {t('title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('desc')}</p>
        </div>
        {canEdit ? (
          <Button variant="outline" onClick={start} disabled={!connected || running || starting}>
            {starting || running ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            {job ? t('runAgain') : t('run')}
          </Button>
        ) : null}
      </div>

      {job ? (
        <div className="space-y-2 text-sm" data-testid="history-import-progress">
          <p className="flex items-center gap-2">
            {stalled ? (
              <AlertTriangle className="size-4 text-amber-500" />
            ) : job.status === 'waiting_session' || paused ? (
              <Clock className="size-4 text-amber-500" />
            ) : running ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : done ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <AlertTriangle className="size-4 text-amber-500" />
            )}
            <span className="font-medium" data-testid="history-import-status">{statusText}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">{t('conversations')}</dt>
              <dd className="tabular-nums">
                {job.chats_done}
                {job.chats_total ? ` / ${job.chats_total}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('messages')}</dt>
              <dd className="tabular-nums">{job.messages_imported}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('skipped')}</dt>
              <dd className="tabular-nums">{job.chats_skipped}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('errors')}</dt>
              <dd className="tabular-nums">{job.errors}</dd>
            </div>
          </dl>
          {job.chats_total > 0 ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-hover-surface">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.min(100, Math.round(((job.chats_done + job.chats_skipped) / job.chats_total) * 100))}%` }}
              />
            </div>
          ) : null}
          {job.limited_history ? <p className="text-xs text-amber-600 dark:text-amber-400">{t('limited')}</p> : null}
          {job.last_error && (job.errors > 0 || paused || job.status === 'waiting_session') ? (
            <p className="text-xs text-muted-foreground">{t('lastError', { error: job.last_error })}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{connected ? t('notStarted') : t('connectFirst')}</p>
      )}
    </section>
  );
}
