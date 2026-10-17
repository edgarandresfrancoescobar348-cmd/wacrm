// The size of a photo / video bubble, like WhatsApp (phase 5g). On the real
// account a photo with a caption stretched across the conversation and the
// photo became a cropped strip. WhatsApp: the bubble is as wide as the
// photo (at most ~330 px), the photo keeps its proportions up to a maximum
// height (a very tall one is cropped at the centre), and the caption sits
// below at the same width. The size is known before the file loads — from
// what WhatsApp declares (media_meta.width/height, gateway patch 7), else
// from the JPEG preview it sends (same proportions) — so the thread
// doesn't jump when the photo arrives.

import type { MediaMeta } from "@/types";

export const MEDIA_MAX_WIDTH = 330;
export const MEDIA_MAX_HEIGHT = 338;
/** A tiny photo still gets a bubble wide enough for its time and ticks. */
export const MEDIA_MIN_WIDTH = 120;

export interface MediaBox {
  width: number;
  height: number;
}

/** Display size for a photo of `w`×`h` pixels. */
export function mediaBoxFor(w: number, h: number): MediaBox | null {
  if (!(w > 0 && h > 0)) return null;
  const width = Math.max(MEDIA_MIN_WIDTH, Math.min(MEDIA_MAX_WIDTH, Math.round(w)));
  const height = Math.min(MEDIA_MAX_HEIGHT, Math.round((width * h) / w));
  return { width, height };
}

/** The photo's pixel size from a base64 JPEG (its SOF marker), or null. */
export function jpegSize(base64: string | null | undefined): { width: number; height: number } | null {
  if (!base64) return null;
  let bytes: Uint8Array;
  try {
    const bin = atob(base64.slice(0, 64 * 1024));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** The bubble size for a stored photo/video, or null when nothing says it. */
export function mediaBox(meta: MediaMeta | null | undefined): MediaBox | null {
  if (meta?.width && meta.height) return mediaBoxFor(meta.width, meta.height);
  const thumb = jpegSize(meta?.thumbnail);
  return thumb ? mediaBoxFor(thumb.width, thumb.height) : null;
}
