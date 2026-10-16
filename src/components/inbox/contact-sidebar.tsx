"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  WaAvatar,
  WaDrawerPanel,
  WaDrawerSection,
} from "@/components/layout/wa-panel";
import { useLocale, useTranslations } from "next-intl";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { formatDateTimeMedium, formatMoney } from "@/lib/locale-format";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { contactDisplayName, contactHandleDisplay, contactProfileName } from '@/lib/whatsapp/phone-display';

interface ContactSidebarProps {
  contact: Contact | null;
  /** Close (X) in the panel header — the inbox wires its show/hide toggle. */
  onClose?: () => void;
}

/**
 * WA "Contact info" panel: header with close X + title, big centred
 * avatar, name and handle, then sections (tags, deals, notes) separated
 * by rail-coloured gaps.
 */
export function ContactSidebar({ contact, onClose }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");
  const locale = useLocale();

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    // Copies whatever the row displays — a BSUID-only contact has no
    // phone number to copy, but its @username still identifies them.
    const handle = contact ? contactHandle(contact) : '';
    if (!handle) return;
    await navigator.clipboard.writeText(handle);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <WaDrawerPanel
        title={tSidebar("contactInfo")}
        closeLabel={tSidebar("close")}
        onClose={onClose}
      >
        <WaDrawerSection>
          <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
        </WaDrawerSection>
      </WaDrawerPanel>
    );
  }

  const displayName = contactDisplayName(contact);
  // Shown formatted (+55 11 93373-9259); the copy button copies the raw number.
  const handle = contactHandleDisplay(contact);

  return (
    <WaDrawerPanel
      title={tSidebar("contactInfo")}
      closeLabel={tSidebar("close")}
      onClose={onClose}
    >
      {/* Identity */}
      <WaDrawerSection className="flex flex-col items-center pt-7 pb-6 text-center">
        <WaAvatar src={contact.avatar_url} name={displayName} size={160} />
        <h3 className="mt-4 text-2xl leading-8 text-foreground">{displayName}</h3>
        {handle && handle !== displayName ? (
          <p className="mt-0.5 text-base text-muted-foreground">{handle}</p>
        ) : contactProfileName(contact) ? (
          // A number that isn't saved: WhatsApp's "~Sara Ferreira" under it.
          <p className="mt-0.5 text-base text-muted-foreground" data-testid="profile-name">{contactProfileName(contact)}</p>
        ) : null}
        {contact.company && (
          <p className="mt-0.5 text-sm text-muted-foreground">{contact.company}</p>
        )}
      </WaDrawerSection>

      {/* Contact rows */}
      <WaDrawerSection className="px-3 py-2">
        <button
          type="button"
          onClick={handleCopyPhone}
          className="flex w-full items-center gap-5 rounded-lg px-3 py-3 text-left transition-colors hover:bg-hover-surface"
        >
          <Phone className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{handle}</span>
          {copied ? (
            <Check className="size-4 text-primary-text" />
          ) : (
            <Copy className="size-4 text-muted-foreground" />
          )}
        </button>
        {contact.email && (
          <div className="flex items-center gap-5 rounded-lg px-3 py-3">
            <Mail className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-[15px] text-foreground">{contact.email}</span>
          </div>
        )}
      </WaDrawerSection>

      {/* Tags */}
      <WaDrawerSection
        label={
          <span className="inline-flex items-center gap-2">
            <TagIcon className="size-4" />
            {tSidebar("tags")}
          </span>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tSidebar("noTags")}</p>
          ) : (
            tags.map((tag) => (
              <span
                key={tag.contact_tag_id}
                className="rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: `${tag.color}24`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))
          )}
        </div>
      </WaDrawerSection>

      {/* Deals */}
      <WaDrawerSection
        label={
          <span className="inline-flex items-center gap-2">
            <DollarSign className="size-4" />
            {tSidebar("deals")}
          </span>
        }
      >
        <div className="space-y-2">
          {deals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tSidebar("noDeals")}</p>
          ) : (
            deals.map((deal) => (
              <div key={deal.id} className="rounded-xl bg-hover-surface px-3.5 py-2.5">
                <p className="text-[15px] text-foreground">{deal.title}</p>
                <div className="mt-1 flex items-center justify-between text-[13px] text-muted-foreground">
                  <span>{formatMoney(deal.value, deal.currency ?? DEFAULT_CURRENCY, locale)}</span>
                  {deal.stage && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: `${deal.stage.color}24`,
                        color: deal.stage.color,
                      }}
                    >
                      {deal.stage.name}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </WaDrawerSection>

      {/* Notes */}
      <WaDrawerSection
        className="flex-1"
        label={
          <span className="inline-flex items-center gap-2">
            <StickyNote className="size-4" />
            {tSidebar("notes")}
          </span>
        }
      >
        <div className="flex items-end gap-2">
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder={tSidebar("addNotePlaceholder")}
            rows={2}
            className="min-h-11 flex-1 resize-none rounded-xl bg-hover-surface px-3.5 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            size="icon"
            aria-label={tSidebar("addNote")}
            onClick={handleAddNote}
            disabled={!newNote.trim() || addingNote}
          >
            <Plus />
          </Button>
        </div>

        <div className="mt-3 space-y-2">
          {notes.map((note) => (
            <div key={note.id} className="rounded-xl bg-hover-surface px-3.5 py-2.5">
              <p className="whitespace-pre-wrap text-sm text-foreground">{note.note_text}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {formatDateTimeMedium(note.created_at, locale)}
              </p>
            </div>
          ))}
        </div>
      </WaDrawerSection>
    </WaDrawerPanel>
  );
}
