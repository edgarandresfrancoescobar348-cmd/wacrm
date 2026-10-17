'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check, X } from 'lucide-react';
import { WaIconButton, WaPanelHeader } from '@/components/layout/wa-panel';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useWhatsAppConnections } from '@/hooks/use-whatsapp-connections';
import { defaultNumberId } from '@/components/whatsapp/number-select';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  // The business number it goes out from (phase 6): the default one
  // unless the user picks another.
  const { connections: numbers } = useWhatsAppConnections({ poll: false });
  const [pickedNumber, setPickedNumber] = useState<string | null>(null);
  const numberId = pickedNumber ?? defaultNumberId(numbers);
  const number = numbers?.find((n) => n.id === numberId);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        connectionId: numberId,
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('broadcastFailed');
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      connection_id: numberId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <WaIconButton
            icon={X}
            label={t('close')}
            onClick={() => router.push('/broadcasts')}
          />
        }
        title={t('title')}
        subtitle={t('subtitle')}
      />

      {/* Step Indicator — WA-style stepper: numbered discs joined by a
          thin track; done = green disc with a check, current = soft
          green chip. */}
      <nav
        aria-label={t('title')}
        className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] sm:px-6"
      >
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center gap-2">
              <div
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-2 rounded-full pr-3.5 pl-1 text-sm transition-colors',
                  isActive
                    ? 'bg-chip-active font-medium text-chip-active-foreground'
                    : isCompleted
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full text-xs font-medium',
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-hover-surface text-muted-foreground',
                  )}
                >
                  {isCompleted ? <Check className="size-4" strokeWidth={2.5} /> : index + 1}
                </span>
                <span className="hidden sm:inline">{t(`steps.${step.label}`)}</span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 min-w-4 flex-1 rounded-full',
                    index < currentStep ? 'bg-primary' : 'bg-hover-surface',
                  )}
                />
              )}
            </div>
          );
        })}
      </nav>

      {/* Step Content */}
      {/* Wallpaper base (no doodle) under the step cards: the same tone as
          the app in dark, the WA beige in light so the white cards read. */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border bg-wallpaper">
        <div
          className="mx-auto max-w-3xl px-4 py-6 transition-all duration-300 ease-in-out sm:px-6"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              numbers={numbers}
              numberId={numberId}
              onNumberChange={(id) => {
                setPickedNumber(id);
                // Its templates differ (official vs QR): pick again.
                setTemplate(null);
              }}
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              number={number}
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
