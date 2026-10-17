/**
 * wacrm patch: the first-page preview of a document, as WhatsApp shows it on the card.
 *
 * The official apps send a PDF with two previews: a tiny inline JPEG (`jpegThumbnail`, ~96 px — what
 * WhatsApp Web keeps in the raw `body`, read by declaredMediaDetails) and a larger copy (~370x480)
 * uploaded on its own, referenced by `thumbnailDirectPath` / `thumbnailSha256` /
 * `thumbnailEncSha256` and encrypted with the document's own media key under the HKDF info
 * "WhatsApp Document Thumbnail Keys". On the real account none of 230 documents carried the inline
 * one, so the card had no preview. When the inline preview is missing, this fetches the uploaded copy
 * and decrypts it — the same scheme as any WhatsApp media: HKDF-SHA256(mediaKey) → IV, AES-256-CBC key
 * and MAC key; the file is ciphertext + the first 10 bytes of HMAC-SHA256(IV ‖ ciphertext).
 *
 * Nothing is trusted unverified: the encrypted file must match `thumbnailEncSha256`, the MAC must
 * match, and the result must match `thumbnailSha256` and be a JPEG. Any failure (expired on the CDN,
 * no network, a field missing) yields no preview — never a wrong one, never an error for the message.
 */
import { createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

/** WhatsApp's media CDN; a direct path is a path on it. */
export const WHATSAPP_MEDIA_HOST = 'https://mmg.whatsapp.net';
const HKDF_INFO = 'WhatsApp Document Thumbnail Keys';
/** The uploaded copy is a few tens of KB; refuse anything far larger. */
const MAX_ENCRYPTED_BYTES = 512 * 1024;
/** Same ceiling as the inline preview a marker may carry (base64 chars). */
const MAX_THUMBNAIL_CHARS = 150_000;

export interface DocumentThumbnailSource {
  directPath: string;
  mediaKey: Buffer;
  sha256: Buffer;
  encSha256: Buffer;
}

const b64 = (v: unknown): Buffer | null => {
  if (typeof v !== 'string' || !v || !/^[A-Za-z0-9+/=_-]+$/.test(v)) return null;
  const buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length ? buf : null;
};

/** Where a document's uploaded preview is, from WhatsApp Web's raw message; null when it has none. */
export function documentThumbnailSource(data: Record<string, unknown> | undefined): DocumentThumbnailSource | null {
  if (!data || data.type !== 'document') return null;
  const directPath = data.thumbnailDirectPath;
  // A path on the CDN host, nothing that could point the fetch elsewhere.
  if (typeof directPath !== 'string' || !/^\/[^/@\\]/.test(directPath) || /\s/.test(directPath)) return null;
  const mediaKey = b64(data.mediaKey);
  const sha256 = b64(data.thumbnailSha256);
  const encSha256 = b64(data.thumbnailEncSha256);
  if (!mediaKey || mediaKey.length !== 32 || !sha256 || sha256.length !== 32 || !encSha256 || encSha256.length !== 32) {
    return null;
  }
  return { directPath, mediaKey, sha256, encSha256 };
}

/** The preview as base64 JPEG, or null when the file doesn't verify. */
export function decryptDocumentThumbnail(file: Buffer, src: DocumentThumbnailSource): string | null {
  if (file.length <= 10 || file.length > MAX_ENCRYPTED_BYTES) return null;
  if (!timingSafeEqual(createHash('sha256').update(file).digest(), src.encSha256)) return null;
  const keys = Buffer.from(hkdfSync('sha256', src.mediaKey, Buffer.alloc(32), HKDF_INFO, 112));
  const iv = keys.subarray(0, 16);
  const cipherKey = keys.subarray(16, 48);
  const macKey = keys.subarray(48, 80);
  const enc = file.subarray(0, file.length - 10);
  const mac = file.subarray(file.length - 10);
  const expected = createHmac('sha256', macKey).update(iv).update(enc).digest().subarray(0, 10);
  if (!timingSafeEqual(expected, mac)) return null;
  let jpeg: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
    jpeg = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return null;
  }
  if (!timingSafeEqual(createHash('sha256').update(jpeg).digest(), src.sha256)) return null;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const out = jpeg.toString('base64');
  return out.length <= MAX_THUMBNAIL_CHARS ? out : null;
}

export type FetchEncrypted = (url: string) => Promise<Buffer>;

/**
 * The envelope with the document's uploaded preview added, when it has none and WhatsApp declared
 * one. Never throws; returns the envelope unchanged when there is nothing to add.
 */
export async function withDocumentThumbnail(
  msg: unknown,
  media: IncomingMessage['media'] | undefined,
  fetchEncrypted: FetchEncrypted,
): Promise<IncomingMessage['media'] | undefined> {
  if (!media || media.thumbnail) return media;
  const src = documentThumbnailSource((msg as { _data?: Record<string, unknown> } | null)?._data);
  if (!src) return media;
  try {
    const thumbnail = decryptDocumentThumbnail(await fetchEncrypted(`${WHATSAPP_MEDIA_HOST}${src.directPath}`), src);
    return thumbnail ? { ...media, thumbnail } : media;
  } catch {
    return media;
  }
}
