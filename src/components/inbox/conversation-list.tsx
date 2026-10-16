"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { byRecency } from "@/lib/conversations/order";
import { MentionText } from "./mention-text";
import { contactDisplayName } from "@/lib/whatsapp/phone-display";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  EllipsisVertical,
  Pin,
  Users,
  LayoutTemplate,
  Plug,
  UserPlus,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  WaAvatar,
  WaChip,
  WaChipRow,
  WaListPanel,
  WaListRow,
  WaPrimaryAction,
  WaSearchPill,
  WaUnreadBadge,
} from "@/components/layout/wa-panel";
import { formatListTime } from "./wa-format";
import { usePreviewParts } from "./message-preview";
import { filterOptionsFor, type InboxFilter } from "@/lib/inbox/filters";
import { previewLead } from "@/lib/inbox/preview-lead";
import { StatusIcon } from "./message-bubble";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Optional notice rendered under the filter chips (e.g. WhatsApp not connected). */
  banner?: React.ReactNode;
  /** QR-code mode: the phone's filters come first, "Grupos" always shown. */
  qrMode?: boolean;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};


export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  banner,
  qrMode = false,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const tThread = useTranslations("Inbox.messageThread");
  const locale = useLocale();
  


  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  // WhatsApp's "Arquivadas" (QR mode): archived chats live behind one row.
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    // Archived chats (mirrored from the phone) only in their own view.
    let result = conversations.filter((c) => Boolean(c.archived) === showArchived);

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "groups") {
      result = result.filter((c) => c.is_group);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = (c.is_group ? c.group_name : c.contact?.name)?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    // Most recent first, like WhatsApp — realtime patches rows in place.
    return byRecency(result);
  }, [conversations, filter, search, selectedTagIds, selectedCompany, showArchived]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const unreadTotal = useMemo(
    () => conversations.filter((c) => c.unread_count > 0 && !c.archived).length,
    [conversations],
  );
  const archivedCount = useMemo(() => conversations.filter((c) => c.archived).length, [conversations]);
  const archivedUnread = useMemo(
    () => conversations.filter((c) => c.archived && c.unread_count > 0).length,
    [conversations],
  );
  const hasGroups = useMemo(() => conversations.some((c) => c.is_group), [conversations]);
  // WhatsApp's order — Todas, Não lidas, Grupos — then the CRM's own.
  // "Grupos" is always there in QR mode (the phone has it with no groups too).
  const filterOptions = useMemo(
    () => filterOptionsFor({ qrMode, hasGroups }, t),
    [qrMode, hasGroups, t],
  );

  return (
    <WaListPanel
      title={t("title")}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t("moreOptions")}
                  className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-hover-surface"
                />
              }
            >
              <EllipsisVertical className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem render={<Link href="/settings?tab=templates" />}>
                <LayoutTemplate />
                {t("menuTemplates")}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings?tab=quick-replies" />}>
                <Zap />
                {t("menuQuickReplies")}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings?tab=whatsapp" />}>
                <Plug />
                {t("menuWhatsappSettings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <WaPrimaryAction icon={UserPlus} label={t("newContact")} href="/contacts" />
        </>
      }
      search={
        <WaSearchPill
          value={search}
          onChange={setSearch}
          placeholder={t("searchPlaceholder")}
          clearLabel={t("clearSearch")}
          aria-label={t("searchPlaceholder")}
        />
      }
      filters={
        <div className="space-y-2">
          <WaChipRow>
            {filterOptions.map((opt) => (
              <WaChip
                key={opt.value}
                active={filter === opt.value}
                count={opt.value === "unread" ? unreadTotal : undefined}
                onClick={() => setFilter(opt.value)}
              >
                {opt.label}
              </WaChip>
            ))}

            {tags.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<WaChip active={selectedTagIds.length > 0} />}
                >
                  {t("tags")}
                  {selectedTagIds.length > 0 && (
                    <span className="text-xs opacity-80">{selectedTagIds.length}</span>
                  )}
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-64 w-56">
                  {tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag.id}
                      checked={selectedTagIds.includes(tag.id)}
                      onCheckedChange={() => toggleTag(tag.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className="truncate">{tag.name}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {companies.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<WaChip active={selectedCompany !== null} className="max-w-48" />}
                >
                  <span className="truncate">{selectedCompany ?? t("company")}</span>
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-64 w-56">
                  <DropdownMenuItem
                    onClick={() => setSelectedCompany(null)}
                    className={cn(selectedCompany === null && "text-primary-text")}
                  >
                    {t("allCompanies")}
                  </DropdownMenuItem>
                  {companies.map((co) => (
                    <DropdownMenuItem
                      key={co}
                      onClick={() => setSelectedCompany(co)}
                      className={cn(selectedCompany === co && "text-primary-text")}
                    >
                      <span className="truncate">{co}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </WaChipRow>

          {hasContactFilters && (
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedTagIds.map((id) => {
                const tag = tagsById.get(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleTag(id)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full bg-hover-surface px-2.5 text-xs text-foreground hover:bg-hover-surface/70"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                    />
                    <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                    <X className="h-3 w-3" />
                  </button>
                );
              })}
              {selectedCompany && (
                <button
                  type="button"
                  onClick={() => setSelectedCompany(null)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full bg-hover-surface px-2.5 text-xs text-foreground hover:bg-hover-surface/70"
                >
                  <span className="max-w-24 truncate">{selectedCompany}</span>
                  <X className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={clearContactFilters}
                className="px-1.5 text-xs font-medium text-primary-text hover:underline"
              >
                {t("clearAll")}
              </button>
            </div>
          )}
        </div>
      }
      banner={banner}
    >
      {showArchived ? (
        <button
          type="button"
          onClick={() => setShowArchived(false)}
          className="flex w-full items-center gap-4 px-6 py-3 text-left text-[15px] text-foreground hover:bg-hover-surface"
          data-testid="archived-back"
        >
          <ArrowLeft className="size-5 text-muted-foreground" />
          {t("archived")}
        </button>
      ) : archivedCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowArchived(true)}
          className="flex w-full items-center gap-4 px-6 py-3 text-left hover:bg-hover-surface"
          data-testid="archived-row"
        >
          <span className="flex size-[49px] shrink-0 items-center justify-center">
            <Archive className="size-5 text-muted-foreground" />
          </span>
          <span className="flex-1 text-[17px] text-foreground">{t("archived")}</span>
          {archivedUnread > 0 ? (
            <span className="text-xs font-medium text-primary-text">{archivedUnread}</span>
          ) : null}
        </button>
      ) : null}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {filtered.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              isActive={conv.id === activeConversationId}
              onSelect={handleSelect}
              t={t}
              locale={locale}
              yesterdayLabel={tThread("yesterday")}
            />
          ))}
        </div>
      )}
    </WaListPanel>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  locale: string;
  yesterdayLabel: string;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  locale,
  yesterdayLabel,
}: ConversationItemProps) {
  const previewOf = usePreviewParts();
  const contact = conversation.contact;
  const isGroup = Boolean(conversation.is_group);
  const baseName = isGroup
    ? conversation.group_name || t("group")
    : (contact && contactDisplayName(contact)) || t("unknown");
  // Your own chat, like WhatsApp: "Guilherme Varela (Você)".
  const displayName = conversation.is_self ? `${baseName} ${t("selfSuffix")}` : baseName;
  const unread = conversation.unread_count > 0;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const time = conversation.last_message_at
    ? formatListTime(conversation.last_message_at, locale, yesterdayLabel)
    : "";

  // Preview tokens become icon + label, like WA's "📷 Photo" line (A2).
  const preview = previewOf(conversation.last_message_text, t("noMessagesYet"));
  const MediaIcon = preview.icon;
  const lead = previewLead(conversation);

  return (
    <WaListRow
      onClick={handleClick}
      active={isActive}
      avatar={
        isGroup && !conversation.group_avatar_url ? (
          <span className="flex size-[49px] shrink-0 items-center justify-center rounded-full bg-hover-surface" aria-hidden>
            <Users className="size-6 text-muted-foreground" />
          </span>
        ) : (
          <WaAvatar src={isGroup ? conversation.group_avatar_url ?? undefined : contact?.avatar_url} name={baseName} size={49} />
        )
      }
      title={displayName}
      meta={time}
      metaHighlight={unread}
      subtitle={
        <>
          {/* A group's preview names who wrote it, like WhatsApp: "Luciana Alves: …". */}
          {/* WhatsApp's rule (preview-lead.ts): yours → ticks; a group
              member → "Name:"; a one-to-one chat → nothing. */}
          {lead?.kind === "ticks" ? (
            <span className="inline-flex shrink-0 text-muted-foreground" data-testid="list-ticks" data-status={lead.status}>
              <StatusIcon status={lead.status} />
            </span>
          ) : lead?.kind === "sender" ? (
            <span className="shrink-0">{lead.name}:</span>
          ) : null}
          {MediaIcon ? <MediaIcon className="size-4 shrink-0" /> : null}
          <span className="truncate">
            <MentionText text={preview.label} plain />
          </span>
        </>
      }
      trailing={
        <>
          {conversation.status !== "open" && (
            <span
              className={cn("h-2 w-2 rounded-full", STATUS_COLORS[conversation.status])}
              title={conversation.status}
            />
          )}
          <WaUnreadBadge count={conversation.unread_count} />
          {conversation.pinned_at ? (
            <Pin className="size-4 rotate-45 text-muted-foreground" aria-label={t("pinned")} data-testid="pinned" />
          ) : null}
        </>
      }
    />
  );
}
