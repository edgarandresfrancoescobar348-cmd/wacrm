'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { useAuth } from '@/hooks/use-auth';
import { formatMoney } from '@/lib/locale-format';
import { toast } from 'sonner';
import type { Contact, Tag, ContactNote, CustomField, Deal, MessageTemplate } from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  WaAvatar,
  WaIconButton,
  WaPanelHeader,
} from '@/components/layout/wa-panel';
import {
  ArrowLeft,
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
  LayoutTemplate,
  Pencil,
  EllipsisVertical,
  IdCard,
  Tag as TagIcon,
  StickyNote,
  SlidersHorizontal,
  Handshake,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { useWhatsAppConnections } from '@/hooks/use-whatsapp-connections';
import { NumberSelect, defaultNumberId } from '@/components/whatsapp/number-select';

interface ContactDetailViewProps {
  contactId: string | null;
  /** Bump to refetch (e.g. after the edit dialog saved this contact). */
  refreshKey?: number;
  /** Close the pane (back to the list's empty state). */
  onClose: () => void;
  onUpdated: () => void;
  /** Open the full edit dialog (fields + tags) for this contact. */
  onEdit?: (contact: Contact) => void;
  /** Ask the page to confirm and delete this contact. */
  onDelete?: (contact: Contact) => void;
  canEdit?: boolean;
}

/**
 * Contact detail main pane, styled like WhatsApp's "Contact info":
 * 64px header, big centred avatar, then stacked sections (details,
 * tags, notes, custom fields, deals) separated by rail-coloured gaps.
 */
export function ContactDetailView({
  contactId,
  refreshKey = 0,
  onClose,
  onUpdated,
  onEdit,
  onDelete,
  canEdit = true,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const tPage = useTranslations('Contacts.page');
  const format = useFormatter();
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  // The business number it goes out from (phase 6): the default one
  // unless the user picks another.
  const { connections: numbers } = useWhatsAppConnections({ poll: false });
  const [pickedNumber, setPickedNumber] = useState<string | null>(null);
  const numberId = pickedNumber ?? defaultNumberId(numbers);
  const numberProvider = numbers?.find((n) => n.id === numberId)?.provider ?? null;

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [refreshKey, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contactHandle(contact));
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }

    // Same rule as the create form: a changed number must start with `+`
    // and a country code (issue #586). Unchanged numbers — including the
    // digits-only form the inbound webhook stores — are left alone so a
    // name/email edit is never blocked by the phone field.
    const phoneChanged = editPhone.trim() !== (contact?.phone ?? '');
    if (phoneChanged && !parseInternationalPhone(editPhone)) {
      toast.error(t('toastPhoneNeedsCountryCode'));
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    try {
      if (isSelected) {
        await deleteContactTag(contactId, tagId);
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contactId, tagId);
        setContactTagIds((prev) => [...prev, tagId]);
      }
      onUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('toastUpdateFailed'));
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact on the chosen business number, mirroring the inbox
          // template-send payload otherwise.
          contact_id: contactId,
          connection_id: numberId ?? undefined,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : t('networkError');
      toast.error(t('toastTemplateFailed', { reason }));
    } finally {
      setSendingTemplate(false);
    }
  }

  const displayName = contact?.name || t('unnamed');

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <WaPanelHeader
        className="border-b border-border"
        leading={
          <>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('backToList')}
              className="-ml-2 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-hover-surface hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="size-5" />
            </button>
            {contact ? (
              <WaAvatar src={contact.avatar_url} name={contact.name || contact.phone} size={40} />
            ) : null}
          </>
        }
        title={contact ? displayName : t('contactInfo')}
        subtitle={contact ? contactHandle(contact) : undefined}
        actions={
          contact ? (
            <>
              <WaIconButton
                icon={LayoutTemplate}
                label={t('sendTemplateBtn')}
                onClick={() => setTemplatePickerOpen(true)}
                disabled={sendingTemplate}
              />
              {onEdit && (
                <WaIconButton
                  icon={Pencil}
                  label={t('actions.edit')}
                  onClick={() => onEdit(contact)}
                  disabled={!canEdit}
                />
              )}
              {onDelete && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={tPage('moreOptions')}
                        className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-hover-surface"
                      />
                    }
                  >
                    <EllipsisVertical className="size-5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {onEdit && (
                      <DropdownMenuItem disabled={!canEdit} onClick={() => onEdit(contact)}>
                        <Pencil />
                        {t('actions.edit')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!canEdit}
                      onClick={() => onDelete(contact)}
                    >
                      <Trash2 />
                      {t('actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <WaIconButton
                icon={X}
                label={t('closeDetail')}
                onClick={onClose}
                className="hidden lg:inline-flex"
              />
            </>
          ) : undefined
        }
      />

      {loading || !contact ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary-text" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-rail">
          {/* Hero: big avatar, name, handle, primary action */}
          <section className="flex flex-col items-center bg-background px-6 pt-8 pb-7 text-center">
            <WaAvatar src={contact.avatar_url} name={contact.name || contact.phone} size={160} />
            <h2 className="mt-5 max-w-full truncate text-2xl leading-8 text-foreground">
              {displayName}
            </h2>
            <button
              type="button"
              onClick={copyPhone}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-base text-muted-foreground transition-colors hover:text-foreground"
            >
              {contactHandle(contact)}
              {copiedPhone ? (
                <Check className="size-4 text-primary-text" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
            {(contact.company || contact.email) && (
              <p className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {contact.company && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="size-3.5" />
                    {contact.company}
                  </span>
                )}
                {contact.email && (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="size-3.5" />
                    {contact.email}
                  </span>
                )}
              </p>
            )}
            <div className="mt-5 flex justify-center">
              <NumberSelect numbers={numbers} value={numberId} onChange={setPickedNumber} />
            </div>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button onClick={() => setTemplatePickerOpen(true)} disabled={sendingTemplate}>
                {sendingTemplate ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LayoutTemplate className="size-4" />
                )}
                {t('sendTemplateBtn')}
              </Button>
            </div>
          </section>

          {/* Details */}
          <InfoSection icon={IdCard} label={t('tabs.details')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cd-name" className="text-[13px] font-normal text-muted-foreground">
                  {t('name')}
                </Label>
                <Input
                  id="cd-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cd-phone" className="text-[13px] font-normal text-muted-foreground">
                  {t('phone')} <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="cd-phone"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cd-email" className="text-[13px] font-normal text-muted-foreground">
                  {t('email')}
                </Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="cd-email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cd-company" className="text-[13px] font-normal text-muted-foreground">
                  {t('company')}
                </Label>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="cd-company"
                    value={editCompany}
                    onChange={(e) => setEditCompany(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={saveDetails} disabled={savingDetails}>
                {savingDetails ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                {t('saveChangesBtn')}
              </Button>
            </div>
          </InfoSection>

          {/* Tags */}
          <InfoSection icon={TagIcon} label={t('tabs.tags')}>
            <p className="mb-3 text-sm text-muted-foreground">{t('tagsTab.clickTagDesc')}</p>
            {allTags.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('tagsTab.noTagsAvailable')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {allTags.map((tag) => {
                  const selected = contactTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      disabled={savingTags}
                      aria-pressed={selected}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors disabled:opacity-60',
                        selected
                          ? 'border-transparent'
                          : 'border-border text-muted-foreground hover:bg-hover-surface hover:text-foreground',
                      )}
                      style={
                        selected
                          ? { backgroundColor: tag.color + '26', color: tag.color }
                          : undefined
                      }
                    >
                      {selected ? (
                        <Check className="size-3.5" />
                      ) : (
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                      )}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
          </InfoSection>

          {/* Notes */}
          <InfoSection icon={StickyNote} label={t('tabs.notes')}>
            <div className="flex items-end gap-2">
              <Textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder={t('notesTab.placeholder')}
                className="min-h-[60px] flex-1 resize-none"
              />
              <Button
                size="icon"
                onClick={addNote}
                disabled={!newNote.trim() || savingNote}
                aria-label={t('notesTab.save')}
                title={t('notesTab.save')}
              >
                {savingNote ? <Loader2 className="animate-spin" /> : <Plus />}
              </Button>
            </div>

            <div className="mt-3 space-y-2">
              {loadingNotes ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : notes.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">{t('notesTab.noNotes')}</p>
              ) : (
                notes.map((note) => (
                  <div key={note.id} className="group rounded-xl bg-surface px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="flex-1 text-sm whitespace-pre-wrap text-foreground">
                        {note.note_text}
                      </p>
                      <button
                        type="button"
                        onClick={() => deleteNote(note.id)}
                        aria-label={t('actions.delete')}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover-surface hover:text-destructive focus-visible:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {format.dateTime(new Date(note.created_at), {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                ))
              )}
            </div>
          </InfoSection>

          {/* Custom fields */}
          <InfoSection icon={SlidersHorizontal} label={t('tabs.custom')}>
            {loadingCustom ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : customFields.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noCustomFields')}</p>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  {customFields.map((field) => (
                    <div key={field.id} className="space-y-1.5">
                      <Label
                        htmlFor={`cd-cf-${field.id}`}
                        className="text-[13px] font-normal text-muted-foreground capitalize"
                      >
                        {field.field_name}
                      </Label>
                      <Input
                        id={`cd-cf-${field.id}`}
                        value={customValues[field.id] ?? ''}
                        onChange={(e) =>
                          setCustomValues((prev) => ({
                            ...prev,
                            [field.id]: e.target.value,
                          }))
                        }
                        placeholder={t('enterCustomField', { name: field.field_name })}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button onClick={saveCustomFields} disabled={savingCustom}>
                    {savingCustom ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    {t('saveCustomFieldsBtn')}
                  </Button>
                </div>
              </>
            )}
          </InfoSection>

          {/* Deals */}
          <InfoSection icon={Handshake} label={t('tabs.deals')} className="flex-1">
            {loadingDeals ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-5 animate-spin text-primary-text" />
              </div>
            ) : deals.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dealsTab.noDeals')}</p>
            ) : (
              <div className="space-y-2">
                {deals.map((deal) => (
                  <div key={deal.id} className="rounded-xl bg-surface px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[15px] text-foreground">{deal.title}</p>
                      {deal.stage && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: `${deal.stage.color}26`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[13px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <DollarSign className="size-3.5" />
                        {formatMoney(deal.value ?? 0, deal.currency || defaultCurrency, locale)}
                      </span>
                      {deal.status && deal.status !== 'open' && (
                        <span
                          className={
                            deal.status === 'won' ? 'text-primary-text' : 'text-destructive'
                          }
                        >
                          {deal.status}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </InfoSection>
        </div>
      )}

      <TemplatePicker
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
        provider={numberProvider}
      />
    </div>
  );
}

/** A "contact info" section: app-bg block with an icon + label heading. */
function InfoSection({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('bg-background px-6 py-5', className)}>
      <div className="mx-auto w-full max-w-3xl">
        <h3 className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
          <Icon className="size-[18px]" strokeWidth={1.75} />
          {label}
        </h3>
        {children}
      </div>
    </section>
  );
}
