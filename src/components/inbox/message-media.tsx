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
import { shouldDownloadDocumentClick } from "@/lib/media/document-click";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";

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

/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = "max-h-[330px] max-w-[min(330px,100%)]";

export function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: Translator;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-bubble-quote px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
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
    return (
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
}: {
  message: Message;
  t: Translator;
  /** Time + ticks row, rendered under the track on the right. */
  meta?: React.ReactNode;
}) {
  const { downloading, download } = useMediaDownload(message, t);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(() => waveformBars(message.id), [message.id]);
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const onPlay = () => setPlaying(true);
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
  }, []);

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

  return (
    <div className="flex w-[min(300px,62vw)] items-center gap-2 pt-1">
      <audio ref={audioRef} src={message.media_url} preload="metadata" className="hidden" />
      <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-bubble-quote text-foreground/70">
        <Mic className="size-5" />
      </span>
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
            className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-read-ticks"
          />
        </button>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] leading-[15px] text-foreground/60">
          <span>{formatClock(playing || current > 0 ? current : duration)}</span>
          {meta}
        </div>
      </div>
      <button
        type="button"
        onClick={download}
        disabled={downloading}
        aria-label={t("download")}
        title={t("download")}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/60 hover:bg-bubble-quote hover:text-foreground disabled:opacity-60"
      >
        {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
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

  return (
    <div className="w-[min(320px,62vw)] pt-0.5">
      <div className="flex items-center gap-2 rounded-md bg-bubble-quote p-2.5">
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!shouldDownloadDocumentClick(message.media_url, event)) return;
            event.preventDefault();
            void download();
          }}
          aria-busy={downloading || undefined}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <span className="relative flex h-10 w-8 shrink-0 items-end justify-center rounded-[4px] bg-[#e5533d] pb-1 text-[8px] font-bold tracking-wide text-white">
            <FileText className="absolute top-1.5 size-3.5 opacity-80" />
            {ext ?? ""}
          </span>
          <span className="min-w-0">
            <span className="line-clamp-2 text-[14px] leading-[19px] break-words text-foreground">
              {message.content_text || t("document")}
            </span>
            <span className="block text-[12px] leading-4 text-foreground/60">
              {ext ? ext.toLowerCase() : t("document")}
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          aria-label={t("download")}
          title={t("download")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-foreground/20 text-foreground/70 transition-colors hover:bg-background/40 hover:text-foreground disabled:opacity-60"
        >
          {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </button>
      </div>
      <div className="mt-1">{meta}</div>
    </div>
  );
}
