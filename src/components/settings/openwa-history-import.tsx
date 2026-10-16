'use client';

// Settings › WhatsApp › QR code: the history import (A1) — progress
// (conversations and messages imported, errors), the Baileys limit
// notice, and "Import history" (re-runnable).

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, History, Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ImportState {
  status: 'queued' | 'listing' | 'importing' | 'waiting_session' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  limited_history: boolean;
  chats_total: number;
  chats_done: number;
  chats_skipped: number;
  messages_imported: number;
  errors: number;
  last_error: string | null;
}

const RUNNING = new Set(['queued', 'listing', 'importing']);

export function OpenWaHistoryImport({ connected, canEdit }: { connected: boolean; canEdit: boolean }) {
  const t = useTranslations('Settings.whatsapp.openwa.history');
  const [job, setJob] = useState<ImportState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/openwa/history', { cache: 'no-store' });
      if (res.ok) setJob(((await res.json()) as { import: ImportState | null }).import);
    } finally {
      setLoaded(true);
    }
  }, []);

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
      const res = await fetch('/api/whatsapp/openwa/history', { method: 'POST' });
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
            {running ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : done ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <AlertTriangle className="size-4 text-amber-500" />
            )}
            <span className="font-medium">{t(`status.${job.status}`)}</span>
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
          {job.last_error && job.errors > 0 ? (
            <p className="text-xs text-muted-foreground">{t('lastError', { error: job.last_error })}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{connected ? t('notStarted') : t('connectFirst')}</p>
      )}
    </section>
  );
}
