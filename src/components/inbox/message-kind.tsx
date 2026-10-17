"use client";

// ============================================================
// Inbox bubbles for the message kinds that carry structure beyond text
// and media (messages.content_meta, migration 062) — the same rendering
// for both connection modes, live and imported (owner adjustment A2).
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Ban,
  BarChart3,
  Clock,
  EyeOff,
  MapPin,
  Package,
  Phone,
  PhoneMissed,
  ShoppingCart,
  UserPlus,
  UserRound,
  Video,
  VideoOff,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { mapsUrl, type ContentMeta, type SharedContact } from "@/lib/whatsapp/message-content";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { sharePersonalContact } from "@/lib/contacts/dedupe";
import type { Message } from "@/types";

const TEXT = "flow-root whitespace-pre-wrap break-words text-[14.2px] leading-[19px]";

/** The structured kind of a message, when it has one. */
export function messageKind(message: Message): ContentMeta | null {
  const meta = (message as Message & { content_meta?: ContentMeta | null }).content_meta;
  return meta && typeof meta === "object" && "kind" in meta ? meta : null;
}

/**
 * Renders a structured kind, or returns null to let the content_type
 * renderer handle it (media kinds: sticker, voice, document are drawn
 * by the media bubbles with small adjustments).
 */
export function KindContent({
  message,
  meta,
  inlineMeta,
  metaBlock,
}: {
  message: Message;
  meta: ContentMeta;
  /** Time + ticks floated at the end of a text line. */
  inlineMeta: React.ReactNode;
  /** Same meta as its own right-aligned row. */
  metaBlock: React.ReactNode;
}) {
  const t = useTranslations("Inbox.kinds");
  switch (meta.kind) {
    case "location":
      return (
        <div className="min-w-[220px]">
          <a
            href={mapsUrl(meta)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2.5 rounded-lg bg-bubble-quote p-2.5 hover:opacity-90"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <MapPin className="size-5" />
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{meta.name || t("location")}</span>
              {meta.address ? <span className="block text-xs opacity-80">{meta.address}</span> : null}
              <span className="mt-0.5 block text-xs text-primary-text">{t("openMap")}</span>
            </span>
          </a>
          {metaBlock}
        </div>
      );

    case "contact":
      return (
        <div className="min-w-[220px]">
          {(meta.contacts.length ? meta.contacts : [{ name: null, phones: [] }]).map((c, i) => (
            <SharedContactCard key={i} contact={c} t={t} />
          ))}
          {metaBlock}
        </div>
      );

    case "poll":
      return (
        <div className="min-w-[220px]">
          <span className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <BarChart3 className="size-3.5" />
            {meta.multiple ? t("pollMultiple") : t("poll")}
          </span>
          <p className="mb-1.5 text-[14.2px] font-medium">{meta.question}</p>
          <ul className="space-y-1">
            {meta.options.map((o, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md bg-bubble-quote px-2 py-1 text-sm">
                <span
                  className={cn(
                    "size-3.5 shrink-0 border border-current opacity-60",
                    meta.multiple ? "rounded-sm" : "rounded-full",
                  )}
                />
                {o}
              </li>
            ))}
          </ul>
          {metaBlock}
        </div>
      );

    case "call": {
      const Icon = meta.video ? (meta.missed ? VideoOff : Video) : meta.missed ? PhoneMissed : Phone;
      const outgoing = message.sender_type !== "customer";
      const label = meta.video
        ? meta.missed
          ? outgoing ? t("videoCallUnanswered") : t("videoCallMissed")
          : t("videoCall")
        : meta.missed
          ? outgoing ? t("voiceCallUnanswered") : t("voiceCallMissed")
          : t("voiceCall");
      return (
        <p className={cn(TEXT, "flex items-center gap-2")}>
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              meta.missed ? "bg-destructive/12 text-destructive" : "bg-primary/15 text-primary",
            )}
          >
            <Icon className="size-4" />
          </span>
          <span>{label}</span>
          {inlineMeta}
        </p>
      );
    }

    case "order":
      return (
        <div className="min-w-[220px]">
          <div className="flex items-start gap-2.5 rounded-lg bg-bubble-quote p-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <ShoppingCart className="size-5" />
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{t("order")}</span>
              {meta.itemCount ? (
                <span className="block text-xs opacity-80">{t("orderItems", { count: meta.itemCount })}</span>
              ) : null}
              {meta.text ? <span className="block text-xs opacity-80">{meta.text}</span> : null}
            </span>
          </div>
          {metaBlock}
        </div>
      );

    case "product":
      return (
        <div className="min-w-[220px]">
          <div className="flex items-start gap-2.5 rounded-lg bg-bubble-quote p-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Package className="size-5" />
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{meta.title || t("product")}</span>
              {meta.description ? <span className="block text-xs opacity-80">{meta.description}</span> : null}
            </span>
          </div>
          {metaBlock}
        </div>
      );

    case "waiting":
      // WhatsApp's own words for a message not delivered to this device yet.
      return (
        <p className={cn(TEXT, "flex items-center gap-1.5 italic opacity-75")} data-testid="waiting-message">
          <Clock className="size-4 shrink-0" />
          <span>{t("waiting")}</span>
          {inlineMeta}
        </p>
      );

    case "masked":
      return (
        <p className={cn(TEXT, "flex items-center gap-1.5 italic opacity-75")}>
          <EyeOff className="size-4 shrink-0" />
          <span>{t("masked")}</span>
          {inlineMeta}
        </p>
      );

    default:
      return null;
  }
}

/**
 * "Esta mensagem foi apagada" / "Você apagou esta mensagem": a message
 * deleted for everyone shows only that, like WhatsApp — never its content,
 * even when we stored it before the deletion (phase 5f).
 */
export function RevokedLine({ inlineMeta, own = false }: { inlineMeta: React.ReactNode; own?: boolean }) {
  const t = useTranslations("Inbox.kinds");
  return (
    <p className={cn(TEXT, "flex items-center gap-1.5 italic opacity-75")}>
      <Ban className="size-4 shrink-0" />
      <span>{t(own ? "revokedByYou" : "revokedEmpty")}</span>
      {inlineMeta}
    </p>
  );
}

function SharedContactCard({
  contact,
  t,
}: {
  contact: SharedContact;
  t: ReturnType<typeof useTranslations>;
}) {
  const { accountId } = useAuth();
  const [saving, setSaving] = useState(false);
  const phone = contact.phones[0] ? normalizePhone(contact.phones[0]) : "";

  async function addContact() {
    if (!phone || !accountId) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) return;
      await sharePersonalContact(supabase, accountId, phone);
      const { error } = await supabase.from("contacts").insert({
        user_id: session.user.id,
        account_id: accountId,
        name: contact.name,
        phone,
      });
      if (error) {
        if (error.code === "23505") toast.info(t("contactExists"));
        else toast.error(error.message);
        return;
      }
      toast.success(t("contactAdded"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-1 overflow-hidden rounded-lg bg-bubble-quote">
      <div className="flex items-center gap-2.5 p-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UserRound className="size-5" />
        </span>
        <span className="min-w-0 text-sm">
          <span className="block font-medium">{contact.name || t("contact")}</span>
          {contact.phones.map((p) => (
            <span key={p} className="block text-xs opacity-80">
              {p}
            </span>
          ))}
        </span>
      </div>
      {phone ? (
        <button
          type="button"
          onClick={addContact}
          disabled={saving}
          className="flex w-full items-center justify-center gap-1.5 border-t border-current/10 py-2 text-sm font-medium text-primary-text hover:bg-hover-surface disabled:opacity-60"
        >
          <UserPlus className="size-4" />
          {t("addContact")}
        </button>
      ) : null}
    </div>
  );
}
