'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const t = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content — the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(t('notConfigured'));
        } else {
          toast.error(data.error ?? t('noReply'));
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      setTurns([
        ...next,
        {
          role: 'assistant',
          content:
            typeof data.reply === 'string' && data.reply.trim()
              ? data.reply
              : '',
          handoff: Boolean(data.handoff),
        },
      ]);
    } catch {
      toast.error(t('unreachable'));
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[440px] flex-col overflow-hidden rounded-xl bg-background ring-1 ring-border">
      {/* Header — WA chat header: avatar, name, muted subtitle, actions */}
      <div className="flex h-16 shrink-0 items-center gap-3 bg-background px-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-chip-active text-chip-active-foreground">
          <Bot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base leading-5 text-foreground">{t('title')}</p>
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {/* The catalogue string is written as a trailing clause
                ("— test replies…"); as a header subtitle it stands alone. */}
            {t('subtitle').replace(/^[—–-]\s*/, '')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="size-4" /> {t('reset')}
        </Button>
      </div>

      {/* Transcript — doodle wallpaper + WA bubbles */}
      <div className="wa-wallpaper relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="flex h-full flex-col gap-3 overflow-y-auto px-[6%] py-5"
        >
          {turns.length === 0 && (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex max-w-sm flex-col items-center rounded-2xl bg-surface px-6 py-6 text-center shadow-sm">
                <span className="flex size-14 items-center justify-center rounded-full bg-hover-surface text-muted-foreground">
                  <Bot className="size-7" strokeWidth={1.75} />
                </span>
                <p className="mt-3 text-[15px] text-foreground">{t('emptyTitle')}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t('emptyDesc')}</p>
                {onGoToSetup && (
                  <button
                    type="button"
                    onClick={onGoToSetup}
                    className="mt-4 inline-flex h-9 items-center gap-1 rounded-full bg-chip-active px-4 text-sm font-medium text-chip-active-foreground transition-opacity hover:opacity-90"
                  >
                    {t('goToSetup')} <ArrowRight className="size-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          {turns.map((turn, i) => (
            <div
              key={i}
              className={cn(
                'flex',
                turn.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              <div
                className={cn(
                  'max-w-[65%] rounded-[7.5px] px-[9px] pt-1.5 pb-2 text-[14.2px] leading-[19px] text-foreground shadow-[0_1px_0.5px_rgba(11,20,26,.13)]',
                  turn.role === 'user' ? 'bg-bubble-out' : 'bg-bubble-in',
                )}
              >
                {turn.content && <p className="whitespace-pre-wrap">{turn.content}</p>}
                {turn.role === 'assistant' && turn.handoff && (
                  <p
                    className={cn(
                      'flex items-center gap-1 rounded-md bg-bubble-quote px-2 py-1 text-xs text-muted-foreground',
                      turn.content && 'mt-1.5',
                    )}
                  >
                    <UserCircle2 className="size-3.5 text-primary-text" />
                    {t('handoff')}
                  </p>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-[7.5px] bg-bubble-in px-3 py-2 text-[13px] text-muted-foreground shadow-[0_1px_0.5px_rgba(11,20,26,.13)]">
                <Loader2 className="size-4 animate-spin" /> {t('thinking')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer — WA floating pill + round green send */}
      <div className="flex shrink-0 items-end gap-2 bg-background px-4 py-3">
        <div className="flex min-h-[46px] flex-1 items-center rounded-3xl bg-surface px-4 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('placeholder')}
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent py-1.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Button
          size="icon"
          onClick={send}
          disabled={!input.trim() || sending}
          aria-label={t('send')}
          className="size-[46px] shrink-0"
        >
          {sending ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Send className="size-5" />
          )}
        </Button>
      </div>
    </div>
  );
}
