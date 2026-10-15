'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { ArrowRight, Check, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StepHeading, StepNav } from './wizard-ui';
import { useTranslations } from 'next-intl';

// Category pills on WA tokens: marketing = soft green, utility = read
// tick blue, authentication = neutral.
const categoryColors: Record<string, string> = {
  Marketing: 'bg-chip-active text-chip-active-foreground',
  Utility: 'bg-read-ticks/15 text-read-ticks',
  Authentication: 'bg-hover-surface text-muted-foreground',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        // On the official API a `local` template (QR-code mode) isn't
        // Meta-approved in its current form — hide it.
        const { data: cfg } = await supabase
          .from('whatsapp_config')
          .select('provider')
          .maybeSingle();
        let query = supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED');
        if (cfg?.provider !== 'openwa') query = query.neq('origin', 'local');
        const { data, error: fetchError } = await query.order('created_at', {
          ascending: false,
        });

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StepHeading title={t('chooseTemplate.title')} subtitle={t('chooseTemplate.subtitle')} />

      {templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl bg-surface px-6 py-12 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-hover-surface text-muted-foreground">
            <FileText className="size-7" strokeWidth={1.5} />
          </div>
          <p className="mt-4 text-[15px] text-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('chooseTemplate.createFirst')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(template)}
                className={cn(
                  'relative flex flex-col gap-3 rounded-2xl bg-surface p-3 text-left shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] outline-none transition-[box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected ? 'ring-2 ring-primary' : 'hover:bg-hover-surface/60',
                )}
              >
                <div className="flex items-center gap-3 px-1 pt-1">
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-full',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-hover-surface text-muted-foreground',
                    )}
                  >
                    {isSelected ? (
                      <Check className="size-5" strokeWidth={2.5} />
                    ) : (
                      <FileText className="size-5" strokeWidth={1.75} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] text-foreground">{template.name}</h3>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium',
                          catColor,
                        )}
                      >
                        {template.category}
                      </span>
                      {/* Status is omitted on purpose — every template
                          shown here is already filtered to APPROVED,
                          so the chip carried no information. */}
                      <span>{template.language ?? 'en_US'}</span>
                    </p>
                  </div>
                </div>
                {/* The template body as it lands on the phone: an
                    outgoing bubble on the chat wallpaper. */}
                <div className="wa-wallpaper overflow-hidden rounded-xl p-2.5">
                  <p className="ml-auto line-clamp-4 w-fit max-w-[92%] rounded-[7.5px] bg-bubble-out px-2.5 py-1.5 text-[13px] leading-[18px] whitespace-pre-wrap text-foreground shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
                    {template.body_text}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <StepNav
        back={
          <Button variant="outline" onClick={onBack}>
            {t('back')}
          </Button>
        }
        next={
          <Button onClick={onNext} disabled={!selectedTemplate}>
            {t('next')}
            <ArrowRight className="size-4" />
          </Button>
        }
      />
    </div>
  );
}
