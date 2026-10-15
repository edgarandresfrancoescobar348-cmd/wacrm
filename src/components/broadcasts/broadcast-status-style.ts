import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerDownLeft,
  Loader2,
  PencilLine,
  type LucideIcon,
} from "lucide-react";
import type { BroadcastStatus, RecipientStatus } from "@/types";

/**
 * WhatsApp-style presentation of broadcast / recipient statuses: an icon
 * (ticks like a message's delivery state) plus token colours. Labels
 * still come from `getBroadcastStatus` / `getRecipientStatus` in
 * `@/lib/broadcast-status`; this only replaces their badge classes,
 * which predate the WA tokens.
 */
export interface WaStatusStyle {
  icon: LucideIcon;
  /** Text / icon colour. */
  text: string;
  /** Soft background for pills and icon discs. */
  soft: string;
  /** Solid dot colour. */
  dot: string;
  /** Animate the icon (in-flight). */
  spin?: boolean;
}

const MUTED: Omit<WaStatusStyle, "icon"> = {
  text: "text-muted-foreground",
  soft: "bg-hover-surface",
  dot: "bg-muted-foreground",
};
const GREEN: Omit<WaStatusStyle, "icon"> = {
  text: "text-primary-text",
  soft: "bg-chip-active",
  dot: "bg-primary",
};
const BLUE: Omit<WaStatusStyle, "icon"> = {
  text: "text-read-ticks",
  soft: "bg-read-ticks/15",
  dot: "bg-read-ticks",
};
const RED: Omit<WaStatusStyle, "icon"> = {
  text: "text-destructive",
  soft: "bg-destructive/12",
  dot: "bg-destructive",
};

const BROADCAST: Record<BroadcastStatus, WaStatusStyle> = {
  draft: { ...MUTED, icon: PencilLine },
  scheduled: { ...BLUE, icon: Clock },
  sending: { ...GREEN, icon: Loader2, spin: true },
  sent: { ...GREEN, icon: CheckCheck },
  failed: { ...RED, icon: AlertCircle },
};

const RECIPIENT: Record<RecipientStatus, WaStatusStyle> = {
  pending: { ...MUTED, icon: Clock },
  sent: { ...MUTED, icon: Check },
  delivered: { ...MUTED, icon: CheckCheck },
  read: { ...BLUE, icon: CheckCheck },
  replied: { ...GREEN, icon: CornerDownLeft },
  failed: { ...RED, icon: AlertCircle },
};

export function broadcastStatusStyle(status: string): WaStatusStyle {
  return BROADCAST[status as BroadcastStatus] ?? BROADCAST.draft;
}

export function recipientStatusStyle(status: string): WaStatusStyle {
  return RECIPIENT[status as RecipientStatus] ?? RECIPIENT.pending;
}
