"use client";

// The conversation-list preview line, like WhatsApp's: an icon and a
// label for media and structured kinds ("📷 Photo", "🎤 Voice message",
// "👤 Maria", "📊 Question?"), plain text otherwise — never "[text]" or
// empty (owner adjustment A2). Reads the tokens previewFor() stores in
// `last_message_text` (message-content.ts); the older bare `[image]`
// tokens keep working.

import { useTranslations } from "next-intl";
import {
  Ban,
  BarChart3,
  Camera,
  Clock,
  EyeOff,
  FileText,
  Headphones,
  LayoutTemplate,
  MapPin,
  Mic,
  Package,
  Phone,
  PhoneMissed,
  ShoppingCart,
  Sticker,
  UserRound,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";

import { parsePreviewToken } from "@/lib/whatsapp/message-content";

export interface PreviewParts {
  icon: LucideIcon | null;
  label: string;
}

export function usePreviewParts(): (text: string | null | undefined, empty: string) => PreviewParts {
  const t = useTranslations("Inbox.kinds");
  return (text, empty) => previewParts(text, empty, t);
}

export function previewParts(
  text: string | null | undefined,
  empty: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): PreviewParts {
  const token = parsePreviewToken(text);
  if (!token) return { icon: null, label: text?.trim() || empty };
  const d = token.detail;
  switch (token.kind) {
    case "image":
      // WhatsApp's camera, not a picture frame.
      return { icon: Camera, label: d || t("photo") };
    case "video":
      return { icon: Video, label: d || t("video") };
    case "audio":
      return { icon: Headphones, label: d || t("audio") };
    case "voice":
      // "Mensagem de voz (0:09)" when the length is known (phase 5e).
      return { icon: Mic, label: d ? t("voiceWithDuration", { duration: d }) : t("voice") };
    case "document": {
      // "3 ANTECEDENTES.pdf · 1 página" — `name|pages`.
      const sep = d?.lastIndexOf("|") ?? -1;
      const name = sep >= 0 ? d!.slice(0, sep).trim() : d;
      const pages = sep >= 0 ? Number(d!.slice(sep + 1)) : NaN;
      const label = name || t("document");
      return { icon: FileText, label: Number.isFinite(pages) && pages > 0 ? `${label} · ${t("pages", { count: pages })}` : label };
    }
    case "revoked":
      return { icon: Ban, label: t("revoked") };
    case "album":
      return { icon: Camera, label: t("album", { count: Number(d) || 2 }) };
    case "sticker":
      return { icon: Sticker, label: t("sticker") };
    case "location":
      return { icon: MapPin, label: d || t("location") };
    case "contact":
      return { icon: UserRound, label: d || t("contact") };
    case "poll":
      return { icon: BarChart3, label: d || t("poll") };
    case "call": {
      const missed = d?.startsWith("missed");
      const video = d?.endsWith("video");
      return {
        icon: video ? (missed ? VideoOff : Video) : missed ? PhoneMissed : Phone,
        label: video
          ? missed ? t("videoCallMissed") : t("videoCall")
          : missed ? t("voiceCallMissed") : t("voiceCall"),
      };
    }
    case "order":
      return { icon: ShoppingCart, label: d || t("order") };
    case "product":
      return { icon: Package, label: d || t("product") };
    case "masked":
      return { icon: EyeOff, label: t("masked") };
    case "waiting":
      return { icon: Clock, label: t("waiting") };
    case "template":
      return { icon: LayoutTemplate, label: d || t("template") };
    case "message":
    case "text":
      return { icon: null, label: d || t("message") };
    default:
      return { icon: null, label: d || t("message") };
  }
}
