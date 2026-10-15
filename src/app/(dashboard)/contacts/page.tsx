'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Plus,
  Upload,
  Trash2,
  Loader2,
  Users,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  EllipsisVertical,
  ListChecks,
  CheckCheck,
  SquareMinus,
  Check,
  X,
} from 'lucide-react';
import {
  WaAvatar,
  WaChip,
  WaChipRow,
  WaEmptyState,
  WaIconButton,
  WaListLayout,
  WaListPanel,
  WaListRow,
  WaPrimaryAction,
  WaSearchPill,
} from '@/components/layout/wa-panel';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { ContactsFrame } from '@/components/contacts/contacts-frame';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { cn } from '@/lib/utils';
import { useFormatter, useTranslations } from 'next-intl';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const tGate = useTranslations('GatedButton');
  const format = useFormatter();
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  // Contact shown in the main pane (null = empty pane). `detailRefresh`
  // forces the pane to refetch after an edit made in the form dialog.
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // WA "Select contacts" mode: rows toggle selection instead of opening.
  const [selecting, setSelecting] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      // Tag filter active — resolve it server-side (join + distinct +
      // windowed total count + pagination) so a tag covering many
      // contacts can't silently truncate the result or overflow an IN
      // clause. See migration 025_filter_contacts_by_tags.
      const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = contactRows.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, selectedTagIds, tagsMap, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      if (detailContactId === deleteTarget.id) setDetailContactId(null);
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      setSelecting(false);
      if (detailContactId && ids.includes(detailContactId)) setDetailContactId(null);
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  const selectionMode = selecting || selected.size > 0;

  function exitSelection() {
    setSelecting(false);
    setSelected(new Set());
  }

  const listPanel = (
    <WaListPanel
      title={t('title')}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('moreOptions')}
                  className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-hover-surface"
                />
              }
            >
              <EllipsisVertical className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                disabled={!canEdit}
                onClick={() => setImportOpen(true)}
              >
                <Upload />
                {t('importBtn')}
              </DropdownMenuItem>
              {canEditSettings && (
                <DropdownMenuItem onClick={() => setCustomFieldsOpen(true)}>
                  <SlidersHorizontal />
                  {t('customFieldsBtn')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={contacts.length === 0}
                onClick={() => setSelecting(true)}
              >
                <ListChecks />
                {t('selectContacts')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span title={canEdit ? undefined : tGate('readOnly', { action: tGate('reasons.addOrImportContacts') })}>
            <WaPrimaryAction
              icon={UserPlus}
              label={t('addContactBtn')}
              onClick={openAddForm}
              disabled={!canEdit}
            />
          </span>
        </>
      }
      search={
        <WaSearchPill
          value={search}
          onChange={(value) => {
            setSearch(value);
            // Reset pagination when the query changes — the result
            // set shrinks/grows, page N may no longer be valid.
            setPage(0);
          }}
          placeholder={t('searchPlaceholder')}
          clearLabel={t('clearSearch')}
        />
      }
      filters={
        <WaChipRow>
          <WaChip
            active={selectedTagIds.length === 0}
            count={selectedTagIds.length === 0 ? totalCount : undefined}
            onClick={clearTagFilters}
          >
            {t('allChip')}
          </WaChip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<WaChip active={selectedTagIds.length > 0} />}
            >
              {t('tagsChip')}
              {selectedTagIds.length > 0 && (
                <span className="text-xs opacity-80">{selectedTagIds.length}</span>
              )}
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-60">
              {allTags.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  {t('noTagsYet')}
                </p>
              ) : (
                <>
                  {allTags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag.id}
                      checked={selectedTagIds.includes(tag.id)}
                      onCheckedChange={() => toggleTagFilter(tag.id)}
                      aria-label={t('filterByTag', { name: tag.name })}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="truncate">{tag.name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                  {selectedTagIds.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={clearTagFilters}>
                        <X />
                        {t('clearAll')}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Active tag filters, each removable in place. */}
          {selectedTagIds.map((id) => {
            const tag = tagsMap[id];
            if (!tag) return null;
            return (
              <WaChip
                key={id}
                active
                onClick={() => toggleTagFilter(id)}
                aria-label={t('removeTagFilter', { name: tag.name })}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
                <X />
              </WaChip>
            );
          })}
        </WaChipRow>
      }
      banner={
        selectionMode ? (
          <div className="flex items-center gap-1 rounded-xl bg-chip-active py-1 pr-1 pl-2 text-chip-active-foreground">
            <button
              type="button"
              onClick={exitSelection}
              aria-label={t('exitSelection')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-black/10"
            >
              <X className="size-4" />
            </button>
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              {t('selectedCount', { count: selected.size })}
            </p>
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={contacts.length === 0}
              aria-label={t('selectAllOnPage')}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm hover:bg-black/10 disabled:opacity-50"
            >
              {allOnPageSelected ? <SquareMinus className="size-4" /> : <CheckCheck className="size-4" />}
              {allOnPageSelected ? t('clearSelection') : t('selectAllShort')}
            </button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason={tGate('reasons.deleteContacts')}
              disabled={selected.size === 0}
              onClick={() => setBulkDeleteOpen(true)}
              aria-label={t('deleteSelected')}
            >
              <Trash2 />
              {t('deleteAction')}
            </GatedButton>
          </div>
        ) : null
      }
      footer={
        totalPages > 1 ? (
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-t border-border px-5">
            <p className="truncate text-xs text-muted-foreground">
              {t('showingPagination', {
                start: page * PAGE_SIZE + 1,
                end: Math.min((page + 1) * PAGE_SIZE, totalCount),
                total: totalCount,
              })}
            </p>
            <div className="flex items-center gap-1">
              <WaIconButton
                icon={ChevronLeft}
                label={t('prevPage')}
                tooltipSide="top"
                disabled={!hasPrev}
                onClick={() => setPage((p) => p - 1)}
              />
              <span className="px-1 text-xs text-muted-foreground">
                {t('pageCount', { page: page + 1, total: totalPages })}
              </span>
              <WaIconButton
                icon={ChevronRight}
                label={t('nextPage')}
                tooltipSide="top"
                disabled={!hasNext}
                onClick={() => setPage((p) => p + 1)}
              />
            </div>
          </div>
        ) : null
      }
    >
      {loading ? (
        <div className="flex flex-col items-center gap-2 py-12">
          <Loader2 className="size-6 animate-spin text-primary-text" />
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="rounded-full bg-surface px-4 py-2 text-sm text-muted-foreground">
            {hasActiveFilters ? t('noContactsMatch') : t('noContactsYet')}
          </span>
          {!hasActiveFilters && (
            <GatedButton
              canAct={canEdit}
              gateReason={tGate('reasons.addOrImportContacts')}
              size="sm"
              onClick={openAddForm}
            >
              <Plus />
              {t('addFirstContact')}
            </GatedButton>
          )}
        </div>
      ) : (
        contacts.map((contact) => {
          const label = contact.name || contact.phone;
          const isSelected = selected.has(contact.id);
          const tags = contact.tags ?? [];
          return (
            <WaListRow
              key={contact.id}
              active={selectionMode ? isSelected : detailContactId === contact.id}
              onClick={() =>
                selectionMode ? toggleSelect(contact.id) : openDetail(contact.id)
              }
              avatar={
                selectionMode ? (
                  <span className="relative flex size-[49px] items-center justify-center">
                    <span
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/60',
                      )}
                    >
                      {isSelected && <Check className="size-4" strokeWidth={3} />}
                    </span>
                    <span className="sr-only">
                      {t('selectContact', { name: label })}
                    </span>
                  </span>
                ) : (
                  <WaAvatar src={contact.avatar_url} name={contact.name || contact.phone} />
                )
              }
              title={
                contact.name || (
                  <span className="text-muted-foreground italic">{t('unnamed')}</span>
                )
              }
              meta={format.dateTime(new Date(contact.created_at), {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })}
              subtitle={
                <span className="truncate">
                  {contact.phone}
                  {contact.company ? ` · ${contact.company}` : ''}
                  {!contact.company && contact.email ? ` · ${contact.email}` : ''}
                </span>
              }
              trailing={
                tags.length > 0 ? (
                  <span className="flex items-center gap-1">
                    {tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag.id}
                        title={tag.name}
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                    ))}
                    {tags.length > 3 && (
                      <span className="text-[11px] text-muted-foreground">
                        +{tags.length - 3}
                      </span>
                    )}
                  </span>
                ) : null
              }
            />
          );
        })
      )}
    </WaListPanel>
  );

  return (
    <ContactsFrame>
      <WaListLayout list={listPanel} showMain={!!detailContactId}>
        {detailContactId ? (
          <ContactDetailView
            // Remount per contact so scroll + form state start fresh.
            key={detailContactId}
            contactId={detailContactId}
            refreshKey={detailRefresh}
            onClose={() => setDetailContactId(null)}
            onUpdated={fetchContacts}
            onEdit={openEditForm}
            onDelete={confirmDelete}
            canEdit={canEdit}
          />
        ) : (
          <div className="wa-wallpaper h-full">
            <WaEmptyState
              icon={Users}
              title={t('emptyPaneTitle')}
              description={
                totalCount > 0
                  ? t('subtitle', { count: totalCount })
                  : t('subtitleZero')
              }
              actions={[
                ...(canEdit
                  ? [
                      { icon: UserPlus, label: t('addContactBtn'), onClick: openAddForm },
                      { icon: Upload, label: t('importBtn'), onClick: () => setImportOpen(true) },
                    ]
                  : []),
                ...(canEditSettings
                  ? [
                      {
                        icon: SlidersHorizontal,
                        label: t('customFieldsBtn'),
                        onClick: () => setCustomFieldsOpen(true),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        )}
      </WaListLayout>

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
          setDetailRefresh((n) => n + 1);
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={(open) => {
            setCustomFieldsOpen(open);
            // Fields may have been added/removed — refresh the open detail.
            if (!open) setDetailRefresh((n) => n + 1);
          }}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteBulkTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContactsFrame>
  );
}
