"use client";

import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Forward,
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { MentionText } from "./mention-text";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { KindContent, RevokedLine } from "./message-kind";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /**
   * First bubble of a same-sender run: draws the WA tail (top-left for
   * incoming, top-right for outgoing). Follow-up bubbles have none.
   */
  showTail?: boolean;
  /** Group messages: the member's name on the first bubble of their run (WhatsApp colours it). */
  senderLabel?: string | null;
  /** Who recorded a voice note — its photo or initials sit on the bubble, like WhatsApp. */
  voiceAvatar?: { name: string; src?: string | null } | null;
}

/** WhatsApp-like name colours for group members, stable per sender. */
const SENDER_COLORS = ["#e542a3", "#1f7aec", "#e5900e", "#02a698", "#9c27b0", "#d6524b", "#2fae48", "#5e6ad2", "#c45c00", "#0aa1c8"];
export function senderColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length];
}

/** A received voice note played here: WhatsApp's mic turns blue (media_meta.played). */
function markPlayed(message: Message) {
  void createClient()
    .from("messages")
    .update({ media_meta: { ...(message.media_meta ?? {}), played: true } })
    .eq("id", message.id)
    .then(({ error }) => {
      if (error) console.warn("Failed to mark the voice note played:", error.message);
    });
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
/** InteractivePreview with the empty-state labels in the UI language. */
function LocalizedInteractivePreview({
  payload,
}: {
  payload: NonNullable<Message["interactive_payload"]>;
}) {
  const t = useTranslations("Interactive");
  return (
    <InteractivePreview
      payload={payload}
      labels={{
        body: t("previewBody"),
        button: t("previewButton"),
        menu: t("previewMenu"),
      }}
    />
  );
}

function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

export function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
    case "sending":
      return <Clock className="size-3" />;
    case "sent":
      return <Check className="size-4" />;
    case "delivered":
      return <CheckCheck className="size-4" />;
    case "read":
      return <CheckCheck className="size-4 text-read-ticks" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="size-3.5 text-destructive" />
        </span>
      );
    default:
      return null;
  }
}

/** Body text: wraps, keeps newlines, and contains the floated meta. */
const TEXT = "flow-root whitespace-pre-wrap break-words text-[14.2px] leading-[19px]";

function MessageContent({
  message,
  t,
  isAgent,
  onOpenMedia,
  meta,
  metaBlock,
  metaOverlay,
  voiceAvatar,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  isAgent: boolean;
  voiceAvatar?: { name: string; src?: string | null } | null;
  onOpenMedia?: (messageId: string) => void;
  /** Time + ticks floated at the end of the last text line. */
  meta: React.ReactNode;
  /** Same meta as its own right-aligned row (cards, players). */
  metaBlock: React.ReactNode;
  /** Same meta over the bottom-right of a photo / video. */
  metaOverlay: React.ReactNode;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  // Deleted for everyone: WhatsApp's "this message was deleted" line and
  // nothing else — also when we stored the content before the deletion
  // (a live revoke of an imported message kept its text, phase 5f).
  if (message.revoked_at) {
    return <RevokedLine inlineMeta={meta} own={message.sender_type === "agent" || message.sender_type === "bot"} />;
  }

  // Structured kinds (location, shared contact, poll, call, order,
  // product, masked) render the same in both connection modes (A2).
  const kind = message.content_meta ?? null;
  if (kind && kind.kind !== "sticker" && kind.kind !== "voice" && kind.kind !== "document") {
    const rendered = (
      <KindContent message={message} meta={kind} inlineMeta={meta} metaBlock={metaBlock} />
    );
    if (rendered) return rendered;
  }
  if (kind?.kind === "sticker" && message.media_url) {
    // A sticker: the image alone, no bubble caption, at sticker size.
    return (
      <div className="w-40">
        <MediaImageBubble message={message} onOpen={openMedia} t={t} overlay={metaOverlay} />
      </div>
    );
  }

  // Media: playable unless WhatsApp said the file is gone (media_expired_at,
  // set by the media proxy on a 410) — imported history media opens through
  // the proxy, which fetches it from WhatsApp on first open.
  const expired = Boolean(message.media_expired_at);
  const playable = Boolean(message.media_url) && !expired;

  switch (message.content_type) {
    case "text":
      return (
        <p className={TEXT}>
          <MentionText text={message.content_text} />
          {meta}
        </p>
      );

    case "image":
      return (
        <div>
          {playable ? (
            <MediaImageBubble
              message={message}
              onOpen={openMedia}
              t={t}
              overlay={message.content_text ? undefined : metaOverlay}
            />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} expired={expired} />
          )}
          {message.content_text ? (
            <p className={cn(TEXT, "px-1.5 pt-1.5 pb-1")}>
              <MentionText text={message.content_text} />
              {meta}
            </p>
          ) : (
            !playable && <div className="px-1.5 pb-1">{metaBlock}</div>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {playable ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} expired={expired} />
          )}
          {message.content_text ? (
            <p className={cn(TEXT, "px-1.5 pt-1.5 pb-1")}>
              <MentionText text={message.content_text} />
              {meta}
            </p>
          ) : (
            <div className="px-1.5 pt-1 pb-0.5">{metaBlock}</div>
          )}
        </div>
      );

    case "audio":
      return playable ? (
        <MediaAudioBubble message={message} t={t} meta={metaBlock} onPlayed={() => markPlayed(message)} avatar={voiceAvatar} />
      ) : (
        <div>
          <MediaUnavailable label={t("audio")} t={t} expired={expired} />
          {metaBlock}
        </div>
      );

    case "document":
      if (!playable) {
        return (
          <div>
            <MediaUnavailable label={message.content_text || t("document")} t={t} expired={expired} />
            {metaBlock}
          </div>
        );
      }
      return <MediaDocumentBubble message={message} t={t} meta={metaBlock} />;

    case "template":
      // Templates are almost always outbound, where the bubble fill IS
      // `primary` — so the old `bg-primary/20 text-primary` chip was
      // primary-on-primary and invisible. Paired with a null
      // content_text (issue #483) that rendered a bubble with nothing
      // in it at all. Invert on the primary fill, and fall back to the
      // template's name when we have no stored body (legacy rows sent
      // before the fix).
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded-full bg-bubble-quote px-2 py-0.5 text-[11px] font-medium",
              isAgent ? "text-foreground/80" : "text-primary-text",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text ? (
            <p className={TEXT}>
              {message.content_text}
              {meta}
            </p>
          ) : message.template_name ? (
            <p className={cn(TEXT, "italic opacity-80")}>
              {message.template_name}
              {meta}
            </p>
          ) : (
            metaBlock
          )}
        </div>
      );

    case "location":
      return (
        <p className={TEXT}>
          <MapPin className="mr-1.5 inline size-4 -translate-y-px text-muted-foreground" />
          {message.content_text || t("locationShared")}
          {meta}
        </p>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return (
          <div>
            <LocalizedInteractivePreview payload={message.interactive_payload} />
            {metaBlock}
          </div>
        );
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className={TEXT}>
              {message.content_text || t("interactiveReply")}
              {meta}
            </p>
          </div>
        );
      }
      return (
        <p className={TEXT}>
          {message.content_text || t("interactiveReply")}
          {meta}
        </p>
      );
    }

    default:
      return (
        <p className={TEXT}>
          {message.content_text || t("unsupported")}
          {meta}
        </p>
      );
  }
}

/** Small triangle tail, drawn in the bubble's own colour. */
function BubbleTail({ side }: { side: "in" | "out" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 13"
      width="8"
      height="13"
      className={cn(
        "absolute top-0",
        side === "in"
          ? "-left-2 text-bubble-in"
          : "-right-2 -scale-x-100 text-bubble-out",
      )}
    >
      <path d="M8 0H1.6C.3 0-.4 1.5.5 2.5L8 12z" fill="currentColor" />
    </svg>
  );
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  showTail = false,
  senderLabel = null,
  voiceAvatar = null,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;
  const isVisual =
    (message.content_type === "image" || message.content_type === "video") &&
    !!message.media_url;

  const metaInner = (
    <>
      {/* AI badge — only on replies the auto-reply bot generated, so
          agents can tell an AI reply from their own / a Flow's. */}
      {message.ai_generated && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-bubble-quote px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide"
          title={t("aiBadgeTitle")}
        >
          <Sparkles className="h-2.5 w-2.5" />
          {t("aiBadge")}
        </span>
      )}
      {/* QR-code connections report customer edits (migration 047); a
          deletion replaces the whole bubble (RevokedLine). */}
      {message.edited_at && !message.revoked_at ? (
        <span className="italic">{t("edited")}</span>
      ) : null}
      <span>{time}</span>
      {isAgent && <StatusIcon status={message.status} title={failure} />}
    </>
  );
  // WA puts time + ticks inside the bubble, bottom-right. Floated at the
  // end of the text so short messages stay on one line.
  const meta = (
    <span className="relative top-[5px] float-right -mr-0.5 ml-2.5 inline-flex h-[15px] items-center gap-1 text-[11px] leading-[15px] whitespace-nowrap text-foreground/60">
      {metaInner}
    </span>
  );
  const metaBlock = (
    <div className="-mr-0.5 -mb-1 flex h-[15px] items-center justify-end gap-1 text-[11px] leading-[15px] whitespace-nowrap text-foreground/60">
      {metaInner}
    </div>
  );
  const metaOverlay = (
    <span className="inline-flex items-center gap-1 rounded-full bg-black/35 px-1.5 py-0.5 text-[11px] leading-[15px] text-white [&_.text-read-ticks]:text-read-ticks">
      {metaInner}
    </span>
  );

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative max-w-full rounded-[7.5px] text-foreground shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
          isAgent ? "bg-bubble-out" : "bg-bubble-in",
          isVisual ? "p-[3px]" : "pt-1.5 pr-[7px] pb-2 pl-[9px]",
          showTail && (isAgent ? "rounded-tr-none" : "rounded-tl-none"),
        )}
      >
        {showTail && <BubbleTail side={isAgent ? "out" : "in"} />}
        {senderLabel && !isAgent ? (
          <p
            className={cn("text-[12.8px] font-medium leading-[22px]", isVisual && "px-1.5")}
            style={{ color: senderColor(message.sender_wa_id || senderLabel) }}
            data-testid="sender-label"
          >
            {senderLabel}
          </p>
        ) : null}
        {message.is_forwarded ? (
          <p
            className={cn("flex items-center gap-1 text-[12.5px] italic leading-[20px] text-foreground/60", isVisual && "px-1.5")}
            data-testid="forwarded"
          >
            <Forward className="size-3.5" />
            {(message.forwarding_score ?? 0) >= 4 ? t("forwardedMany") : t("forwarded")}
          </p>
        ) : null}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent
          message={message}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
          meta={meta}
          metaBlock={metaBlock}
          metaOverlay={metaOverlay}
          voiceAvatar={voiceAvatar}
        />
      </div>
      {failure && (
        <p
          className="mt-0.5 px-1 text-[11px] leading-tight text-destructive"
          title={failure}
        >
          {t("notDelivered")}: {failure}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <div className={cn("relative z-[1] -mt-1.5", isAgent ? "mr-2" : "ml-2")}>
          <MessageReactions
            reactions={reactions}
            currentUserId={currentUserId}
            onToggle={onToggleReaction}
          />
        </div>
      )}
    </div>
  );
}
