'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Eye,
  ImageIcon,
  Loader2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { StepCard, StepHeading, StepNav } from './wizard-ui';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const locale = useLocale();
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it. The field is hidden for text-only
  // headers.
  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? {
      ...SAMPLE_CONTACT,
      name: t('personalize.sampleName'),
      company: t('personalize.sampleCompany'),
    };
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
    t,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('personalize.previewSample');

  // `items` lets the Select trigger show the label, not the raw value.
  const typeItems = {
    static: t('personalize.typeStatic'),
    field: t('personalize.typeContact'),
    custom_field: t('personalize.typeCustom'),
  };
  const contactFieldItems = Object.fromEntries(
    contactFields.map((f) => [f.value, t(`personalize.fieldMap.${f.labelKey}`)]),
  );
  const customFieldItems = Object.fromEntries(
    customFields.map((f) => [f.id, f.field_name]),
  );

  const previewTime = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());

  return (
    <div className="space-y-6">
      <StepHeading title={t('personalize.title')} subtitle={t('personalize.subtitle')} />

      {mediaHeaderType && (
        <StepCard
          icon={ImageIcon}
          title={t('personalize.headerImage')}
          aside={
            <span className="inline-flex items-center rounded-full bg-chip-active px-2 py-0.5 text-[11px] font-medium uppercase text-chip-active-foreground">
              {mediaHeaderType}
            </span>
          }
        >
          <label className="mb-1.5 block text-[13px] text-muted-foreground">
            {t('personalize.imageUrl')}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
          />
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {t('personalize.headerImageDesc')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="mt-3 max-h-40 rounded-xl object-contain"
              />
            )}
          {headerMediaError && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-destructive">
              <AlertTriangle className="size-3.5" />
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
        </StepCard>
      )}

      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="flex justify-center">
          <span className="rounded-lg bg-surface px-3 py-1.5 text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </span>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-3">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <StepCard
                key={placeholder}
                title={
                  <span className="inline-flex items-center rounded-md bg-bubble-quote px-2 py-0.5 font-mono text-[13px] text-primary-text">
                    {placeholder}
                  </span>
                }
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-[13px] text-muted-foreground">
                      {t('personalize.type')}
                    </label>
                    <Select
                      items={typeItems}
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="static">{t('personalize.typeStatic')}</SelectItem>
                        <SelectItem value="field">{t('personalize.typeContact')}</SelectItem>
                        <SelectItem value="custom_field">
                          {t('personalize.typeCustom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[13px] text-muted-foreground">
                      {mapping.type === 'static' ? t('personalize.staticValue') : t('personalize.contactField')}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder={t('personalize.enterValue')}
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        items={contactFieldItems}
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('personalize.selectContactField')} />
                        </SelectTrigger>
                        <SelectContent>
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {t(`personalize.fieldMap.${field.labelKey}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        items={customFieldItems}
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? t('personalize.loadingFields')
                                : customFields.length === 0
                                  ? t('personalize.noCustomFields')
                                  : t('personalize.selectCustomField')
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </StepCard>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp outgoing bubble on the
          chat wallpaper so the user sees approximately what the
          recipient will see. */}
      <StepCard
        icon={Eye}
        title={t('personalize.preview')}
        aside={
          <>
            <span className="truncate text-[13px] text-muted-foreground">{previewLabel}</span>
            {loadingPreview && (
              <Loader2 className="size-3.5 animate-spin text-primary-text" />
            )}
          </>
        }
      >
        <div className="wa-wallpaper overflow-hidden rounded-xl px-4 py-5">
          <div className="relative ml-auto w-fit max-w-[85%] rounded-[7.5px] rounded-tr-none bg-bubble-out px-2.5 pt-1.5 pb-2 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
            {/* Outgoing bubble tail (top-right), like the inbox. */}
            <span
              aria-hidden
              className="absolute top-0 -right-2 size-2 bg-bubble-out [clip-path:polygon(0_0,100%_0,0_100%)]"
            />
            <p className="text-[14.2px] leading-[19px] whitespace-pre-wrap text-foreground">
              {previewText}
              <span className="float-right mt-1.5 ml-3 inline-flex items-center gap-0.5 text-[11px] leading-none text-muted-foreground">
                {previewTime}
                <CheckCheck className="size-4 text-read-ticks" />
              </span>
            </p>
          </div>
        </div>
      </StepCard>

      {unmappedKeys.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3 py-2.5 text-[13px] text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>
            {t.rich('personalize.unmappedWarning', {
              keys: unmappedKeys.join(', '),
              mono: (chunks) => <span className="font-mono font-semibold">{chunks}</span>,
            })}
          </p>
        </div>
      )}

      <StepNav
        back={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t('back')}
          </Button>
        }
        next={
          <Button
            onClick={onNext}
            disabled={unmappedKeys.length > 0 || headerMediaError !== null}
          >
            {t('next')}
            <ArrowRight className="size-4" />
          </Button>
        }
      />
    </div>
  );
}
