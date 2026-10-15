'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { countAudience } from '@/lib/broadcast-audience';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { StepCard, StepHeading, StepNav, WA_SELECT_CLASS } from './wizard-ui';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Filter,
  Upload,
  FileText,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  UserMinus,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(() => [
    { value: 'is', label: t('selectAudience.operatorIs') },
    { value: 'is_not', label: t('selectAudience.operatorIsNot') },
    { value: 'contains', label: t('selectAudience.operatorContains') },
  ], [t]);

  const audienceOptions = useMemo<{
    type: AudienceType;
    label: string;
    description: string;
    icon: typeof Users;
  }[]>(() => [
    {
      type: 'all',
      label: t('selectAudience.method.all'),
      description: t('selectAudience.allDescLoading'),
      icon: Users,
    },
    {
      type: 'tags',
      label: t('selectAudience.method.tags'),
      description: t('selectAudience.tagDesc'),
      icon: Tags,
    },
    {
      type: 'custom_field',
      label: t('selectAudience.method.customField'),
      description: t('selectAudience.customFieldDesc'),
      icon: Filter,
    },
    {
      type: 'csv',
      label: t('selectAudience.method.csv'),
      description: t('selectAudience.csvDesc'),
      icon: Upload,
    },
  ], [t]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  // The picked file's name, shown back to the user. The parsed rows
  // themselves live on `audience.csvContacts` (owned by the wizard) so
  // they survive stepping forward and back.
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const csvCount = audience.csvContacts?.length ?? 0;
  // Only meaningful while the rows it produced are still in play —
  // picking another audience type wipes `csvContacts`.
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      setEstimatedCount(
        await countAudience(createClient(), {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        }),
      );
    } catch {
      setEstimatedCount(null);
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const result = parseBroadcastCsv(await selected.text());

    if (!result.ok) {
      toast.error(
        result.error === 'missing_phone_column'
          ? t('selectAudience.errorCsvMissingPhone')
          : t('selectAudience.errorCsvParse'),
      );
      // Clear the input so re-picking the same corrected file still
      // fires `change` (the browser suppresses it for an identical value).
      e.target.value = '';
      setPickedCsvName(null);
      onUpdate({ ...audience, csvContacts: undefined });
      return;
    }

    // Rows without a leading `+` and country code were refused (issue
    // #586). Say so, or a spreadsheet export that stripped the `+` looks
    // like a mysteriously smaller audience.
    if (result.invalid > 0) {
      toast.warning(
        t('selectAudience.csvInvalidPhones', { count: result.invalid }),
      );
    }

    setPickedCsvName(selected.name);
    onUpdate({ ...audience, csvContacts: result.contacts });
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <StepHeading title={t('selectAudience.title')} subtitle={t('selectAudience.subtitle')} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option: { type: AudienceType; label: string; description: string; icon: typeof Users }) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              type="button"
              aria-pressed={isSelected}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={cn(
                'flex items-center gap-3 rounded-2xl bg-surface p-3 text-left shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] outline-none transition-[box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring',
                isSelected ? 'ring-2 ring-primary' : 'hover:bg-hover-surface/60',
              )}
            >
              <span
                className={cn(
                  'flex size-11 shrink-0 items-center justify-center rounded-full',
                  isSelected
                    ? 'bg-chip-active text-chip-active-foreground'
                    : 'bg-hover-surface text-muted-foreground',
                )}
              >
                <Icon className="size-5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] text-foreground">{option.label}</p>
                <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'tags' && (
        <StepCard icon={Tags} title={t('selectAudience.selectTags')}>
          {loadingTags ? (
            <Loader2 className="size-5 animate-spin text-primary-text" />
          ) : tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={tag}
                  active={!!audience.tagIds?.includes(tag.id)}
                  onClick={() => toggleTag(tag.id)}
                />
              ))}
            </div>
          )}
        </StepCard>
      )}

      {audience.type === 'custom_field' && (
        <StepCard icon={Filter} title={t('selectAudience.method.customField')}>
          {loadingFields ? (
            <Loader2 className="size-5 animate-spin text-primary-text" />
          ) : customFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className={WA_SELECT_CLASS}
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className={WA_SELECT_CLASS}
              >
                {OPERATOR_OPTIONS.map((op: { value: CustomFieldOperator; label: string }) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <Input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
              />
            </div>
          )}
        </StepCard>
      )}

      {audience.type === 'csv' && (
        <StepCard icon={Upload} title={t('selectAudience.uploadCsv')}>
          <p className="-mt-1 mb-3 text-[13px] text-muted-foreground">
            {t('selectAudience.csvFormatDesc')}
          </p>

          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="group flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center outline-none transition-colors hover:bg-hover-surface/60 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'flex size-12 items-center justify-center rounded-full',
                csvFileName
                  ? 'bg-chip-active text-chip-active-foreground'
                  : 'bg-hover-surface text-muted-foreground group-hover:text-foreground',
              )}
            >
              {csvFileName ? (
                <FileText className="size-5" />
              ) : (
                <Upload className="size-5" />
              )}
            </span>
            <p className="text-sm text-foreground">
              {csvFileName ?? t('selectAudience.uploadCsv')}
            </p>
            {csvCount > 0 && (
              <p className="text-[13px] text-primary-text">
                {t('selectAudience.csvContactsFound', { count: csvCount })}
              </p>
            )}
          </button>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvChange}
            className="hidden"
          />
        </StepCard>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <StepCard icon={UserMinus} title={t('selectAudience.excludeTags')}>
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('selectAudience.noTagsFound')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                active={!!audience.excludeTagIds?.includes(tag.id)}
                destructive
                onClick={() => toggleExcludeTag(tag.id)}
              />
            ))}
          </div>
        )}
      </StepCard>

      {/* Audience Summary — WA soft green notice */}
      <div className="flex items-center gap-3 rounded-2xl bg-chip-active px-4 py-3 text-chip-active-foreground">
        <Users className="size-5 shrink-0" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="opacity-80">{t('selectAudience.audienceSummary')}</p>
          {loadingCount ? (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {t('selectAudience.calculating')}
            </p>
          ) : estimatedCount !== null ? (
            <p>
              <span className="text-lg font-medium tabular-nums">
                {estimatedCount.toLocaleString()}
              </span>{' '}
              {t('selectAudience.estimatedRecipients')}
            </p>
          ) : (
            <p>{t('selectAudience.selectTypeForEstimate')}</p>
          )}
        </div>
      </div>

      <StepNav
        back={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t('back')}
          </Button>
        }
        next={
          <Button onClick={onNext} disabled={!isValid}>
            {t('next')}
            <ArrowRight className="size-4" />
          </Button>
        }
      />
    </div>
  );
}

/** Filter-chip style tag toggle (WA chip; destructive tint for excludes). */
function TagChip({
  tag,
  active,
  destructive = false,
  onClick,
}: {
  tag: Tag;
  active: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? destructive
            ? 'border-transparent bg-destructive/12 text-destructive'
            : 'border-transparent bg-chip-active text-chip-active-foreground'
          : 'border-border text-muted-foreground hover:bg-hover-surface hover:text-foreground',
      )}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
      {active && (destructive ? <X className="size-3.5" /> : <Check className="size-3.5" />)}
    </button>
  );
}
