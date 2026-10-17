"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
  ImageOff,
  Loader2,
  Maximize2,
  Mic,
  Pause,
  Play,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";
import { downloadMediaMessage } from "@/lib/media/download";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";
import { formatFileSize } from "@/lib/whatsapp/message-content";
import { WaAvatar } from "@/components/layout/wa-panel";

/**
 * The media renderers behind `<MessageBubble>`'s image / video / audio /
 * document cases. Split out of message-bubble.tsx so that file stays a
 * thin content switch — everything here is about the two affordances
 * issue #373 asked for: open it full-size, and save it.
 *
 * Both are less trivial than they look, because the two flavours of
 * `media_url` behave differently in the browser. See
 * `@/lib/media/blob-cache` for the proxy-vs-bucket split and
 * `@/lib/media/download` for why `<a download>` alone isn't enough.
 */

type Translator = ReturnType<typeof useTranslations>;

/** WhatsApp's JPEG preview (media_meta.thumbnail), as an <img> src. */
function thumbnailSrc(message: Message): string | null {
  const b64 = message.media_meta?.thumbnail;
  return b64 && /^[A-Za-z0-9+/=]+$/.test(b64) ? `data:image/jpeg;base64,${b64}` : null;
}


/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = "max-h-[330px] max-w-[min(330px,100%)]";

export function MediaUnavailable({
  label,
  t,
  expired = false,
}: {
  label: string;
  t: Translator;
  /** WhatsApp no longer has the file (media proxy answered 410). */
  expired?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md bg-bubble-quote px-3 py-2 text-xs text-muted-foreground"
      data-testid={expired ? "media-expired" : "media-unavailable"}
    >
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{expired ? t("expired", { label }) : t("unavailable", { label })}</span>
    </div>
  );
}

/**
 * Kicks off a download and reports failure as a toast. Kept as a hook so
 * each bubble owns its own in-flight state — a slow 16 MB video shouldn't
 * put a spinner on every other attachment in the thread.
 */
function useMediaDownload(message: Message, t: Translator) {
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMediaMessage(message);
    } catch {
      toast.error(t("downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }, [downloading, message, t]);

  return { downloading, download };
}

function MediaActionButton({
  icon: Icon,
  label,
  onClick,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      // Own surface rather than inheriting the bubble's, so the same button
      // reads on the muted inbound fill, the primary outbound fill, and on
      // top of an arbitrary photo.
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/40 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/55 disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function MediaPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-48 w-[min(330px,70vw)] items-center justify-center rounded-md bg-bubble-quote">
      {children}
    </div>
  );
}

export function MediaImageBubble({
  message,
  onOpen,
  t,
  overlay,
}: {
  message: Message;
  /** Opens the thread's lightbox on this message. Omitted ⇒ not clickable. */
  onOpen?: () => void;
  t: Translator;
  /** Time + ticks painted over the bottom-right corner (no caption). */
  overlay?: React.ReactNode;
}) {
  const { src, status } = useMediaBlobUrl(message.media_url);
  // The fetch can succeed and the bytes still not be a decodable image.
  const [broken, setBroken] = useState(false);
  const { downloading, download } = useMediaDownload(message, t);

  if (status === "error" || broken) {
    return (
      <MediaPlaceholder>
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </MediaPlaceholder>
    );
  }

  if (status !== "ready" || !src) {
    // WhatsApp's own preview while the photo downloads (phase 5e).
    const thumb = thumbnailSrc(message);
    return thumb ? (
      <div className="relative w-fit" data-testid="media-thumbnail">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumb} alt={t("imageAlt")} className={cn(MEDIA_BOX, "block min-w-40 rounded-[6px] object-cover blur-[2px]")} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
        </div>
      </div>
    ) : (
      <MediaPlaceholder>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </MediaPlaceholder>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={t("imageAlt")}
      className={cn(MEDIA_BOX, "block min-w-40 rounded-[6px] object-cover")}
      onError={() => setBroken(true)}
    />
  );

  return (
    <div className="group/media relative w-fit">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("viewImage")}
          className="block cursor-zoom-in rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Hover-only: on touch there is no hover, but tapping the image opens
          the viewer, which carries a full-size Download button. */}
      <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/media:opacity-100 group-focus-within/media:opacity-100">
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
      {overlay ? (
        <div className="pointer-events-none absolute right-1.5 bottom-1.5">{overlay}</div>
      ) : null}
    </div>
  );
}

export function MediaVideoBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  onOpen?: () => void;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="relative w-fit">
      {/* Plain URL, not a blob: the element should stream rather than wait
          for up to 16 MB to land. */}
      <video
        src={message.media_url}
        controls
        preload="metadata"
        poster={thumbnailSrc(message) ?? undefined}
        className={cn(MEDIA_BOX, "rounded-[6px]")}
      />
      {/* Top-right, clear of the native controls — and always visible, since
          expanding is the only way to watch a clip capped at 15rem wide and
          a touch device gets no hover. */}
      <div className="absolute right-2 top-2 flex gap-1">
        {onOpen && (
          <MediaActionButton
            icon={Maximize2}
            label={t("expandVideo")}
            onClick={onOpen}
          />
        )}
        <MediaActionButton
          icon={Download}
          label={t("download")}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

/** Deterministic pseudo-waveform (WA-style bars) seeded by the message id. */
function waveformBars(seed: string, count = 40): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const r = ((h >>> 0) % 1000) / 1000;
    // Smooth-ish envelope so it reads like speech, not noise.
    const env = 0.45 + 0.55 * Math.sin((i / count) * Math.PI);
    bars.push(Math.max(0.15, Math.min(1, r * env + 0.12)));
  }
  return bars;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Voice note / audio player in the WA style: play button, waveform track
 * that fills as it plays (click to seek), duration under it, and the
 * bubble's time + ticks on the right. Uses a plain <audio> element, so
 * playback behaves exactly like the old native controls.
 */
export function MediaAudioBubble({
  message,
  t,
  meta,
  onPlayed,
  onDuration,
  avatar,
}: {
  message: Message;
  t: Translator;
  /** Time + ticks row, rendered under the track on the right. */
  meta?: React.ReactNode;
  /** A received voice note was played for the first time here. */
  onPlayed?: () => void;
  /**
   * The length read from the file, when WhatsApp declared none: kept on
   * the message so the list preview says "Mensagem de voz (0:04)" too.
   */
  onDuration?: (seconds: number) => void;
  /** Who recorded it: WhatsApp shows their photo (or initials) with the mic on it. */
  avatar?: { name: string; src?: string | null } | null;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  // WhatsApp's declared length shows before the audio loads (phase 5e).
  const [duration, setDuration] = useState(message.media_meta?.durationSeconds ?? 0);
  const declaredDuration = (message.media_meta?.durationSeconds ?? 0) > 0;
  const reportedDuration = useRef(false);
  const isOwn = message.sender_type === "agent" || message.sender_type === "bot";
  const [played, setPlayed] = useState(Boolean(message.media_meta?.played));
  const bars = useMemo(() => waveformBars(message.id), [message.id]);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => {
      if (!Number.isFinite(el.duration)) return;
      setDuration(el.duration);
      if (!declaredDuration && el.duration > 0 && !reportedDuration.current) {
        reportedDuration.current = true;
        onDuration?.(el.duration);
      }
    };
    const onPlay = () => {
      setPlaying(true);
      setPlayed((was) => {
        if (!was && !isOwn) onPlayed?.();
        return true;
      });
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrent(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [isOwn, onPlayed, onDuration, declaredDuration]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => toast.error(t("playbackFailed")));
    } else {
      el.pause();
    }
  };

  const seek = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrent(el.currentTime);
  };

  // WhatsApp's colours: green while a received voice note is unplayed,
  // blue once played (by you, or — on your own — by the recipient).
  const accent = played ? "text-read-ticks" : !isOwn ? "text-primary" : "text-foreground/60";
  const knob = played ? "bg-read-ticks" : !isOwn ? "bg-primary" : "bg-foreground/60";

  return (
    <div className="group/voice relative flex w-[min(300px,62vw)] items-center gap-2 pt-1">
      <audio ref={audioRef} src={message.media_url} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("pause") : t("play")}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/80 hover:text-foreground"
      >
        {playing ? (
          <Pause className="size-6 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-6 fill-current" strokeWidth={0} />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={seek}
          aria-label={t("seek")}
          className="relative flex h-7 w-full items-center gap-[2px]"
        >
          {bars.map((b, i) => (
            <span
              key={i}
              style={{ height: `${Math.round(b * 100)}%` }}
              className={cn(
                "w-[3px] flex-1 rounded-full",
                i / bars.length < progress ? "bg-read-ticks" : "bg-foreground/35",
              )}
            />
          ))}
          <span
            aria-hidden
            style={{ left: `calc(${progress * 100}% - 6px)` }}
            className={cn("absolute top-1/2 size-3 -translate-y-1/2 rounded-full", knob)}
          />
        </button>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] leading-[15px] text-foreground/60">
          <span>{formatClock(playing || current > 0 ? current : duration)}</span>
          {meta}
        </div>
      </div>
      {/* The recorder's photo (or initials) with the mic on its corner, like WhatsApp. */}
      <span className="relative shrink-0" data-testid={played ? "voice-played" : "voice-unplayed"}>
        <WaAvatar src={avatar?.src} name={avatar?.name || "?"} size={46} />
        <Mic className={cn("absolute -bottom-0.5 -left-1.5 size-[18px] drop-shadow-[0_0_1px_rgba(0,0,0,0.35)]", accent)} strokeWidth={2.4} />
      </span>
      {/* WhatsApp has no download button on a voice note: here it shows on hover / focus. */}
      <button
        type="button"
        onClick={download}
        disabled={downloading}
        aria-label={t("download")}
        title={t("download")}
        className="absolute -top-1 right-12 flex size-7 items-center justify-center rounded-full bg-bubble-quote text-foreground/70 opacity-0 transition-opacity group-hover/voice:opacity-100 focus-visible:opacity-100 disabled:opacity-60 hover:text-foreground"
      >
        {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      </button>
    </div>
  );
}

/** Upper-case file extension from the stored name / URL / MIME type. */
function fileExtension(message: Message): string | null {
  const candidates = [message.content_text, message.media_url?.split("?")[0]];
  for (const c of candidates) {
    const m = c ? /\.([a-z0-9]{1,5})$/i.exec(c.trim()) : null;
    if (m) return m[1].toUpperCase();
  }
  const sub = message.media_type?.split("/")[1];
  return sub ? sub.split(/[.+;-]/).pop()!.slice(0, 5).toUpperCase() : null;
}

/**
 * Document card (WA image 1): file tile + name + type on a tinted panel,
 * opens the file in a new tab; download button on the right; the bubble
 * meta row underneath.
 */
export function MediaDocumentBubble({
  message,
  t,
  meta,
}: {
  message: Message;
  t: Translator;
  meta?: React.ReactNode;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const ext = fileExtension(message);
  const thumb = thumbnailSrc(message);
  const pages = message.media_meta?.pageCount;
  const size = formatFileSize(message.media_meta?.sizeBytes);
  // "1 página · 2 MB · pdf", like WhatsApp.
  const details = [pages ? t("pages", { count: pages }) : null, size, ext ? ext.toLowerCase() : null].filter(Boolean).join(" · ");

  return (
    <div className="w-[min(240px,62vw)] pt-0.5" data-testid="document-card">
      {/* The document's first page, as WhatsApp previews it. */}
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="block h-[92px] w-full rounded-t-md object-cover object-top" data-testid="document-thumbnail" />
      ) : null}
      <div className={cn("flex items-center gap-2 bg-bubble-quote p-2.5", thumb ? "rounded-b-md" : "rounded-md")}>
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <span className="relative flex h-10 w-8 shrink-0 items-end justify-center rounded-[4px] bg-[#e5533d] pb-1 text-[8px] font-bold tracking-wide text-white">
            <FileText className="absolute top-1.5 size-3.5 opacity-80" />
            {ext ?? ""}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] leading-[19px] text-foreground" title={message.content_text || undefined}>
              {message.content_text || t("document")}
            </span>
            <span className="block text-[12px] leading-4 text-foreground/60" data-testid="document-details">
              {details || t("document")}
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          aria-label={t("download")}
          title={t("download")}
          className="flex size-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-primary text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
        >
          {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </button>
      </div>
      <div className="mt-1">{meta}</div>
    </div>
  );
}
