// wacrm patch: a document's first-page preview (wwebjs-document-thumbnail). On the real account none
// of 230 documents had one: WhatsApp Web held no inline JPEG for them, only the uploaded copy.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  decryptDocumentThumbnail,
  documentThumbnailSource,
  WHATSAPP_MEDIA_HOST,
  withDocumentThumbnail,
} from './wwebjs-document-thumbnail';

// Encrypted by Baileys' own encryptedStream(jpeg, 'thumbnail-document'): the scheme is checked against
// an implementation that isn't the gateway's.
const vector = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'document-thumbnail.baileys.json'), 'utf8')) as {
  jpeg: string;
  encrypted: string;
  mediaKey: string;
  thumbnailSha256: string;
  thumbnailEncSha256: string;
};
const encrypted = Buffer.from(vector.encrypted, 'base64');

// The raw message as WhatsApp Web serializes a received PDF (field names of its Msg model): the
// caption-less body is empty — no inline preview — and the uploaded copy is referenced.
const rawDocument = (over: Record<string, unknown> = {}) => ({
  _data: {
    type: 'document',
    mimetype: 'application/pdf',
    filename: 'Fechamento - Resumo.pdf',
    size: 2_097_152,
    pageCount: 2,
    body: '',
    directPath: '/v/t62.7119-24/12345_67890.enc?ccb=11-4&oh=01_x&oe=6A1B2C3D&_nc_sid=5e03e0',
    mediaKey: vector.mediaKey,
    thumbnailDirectPath: '/v/t62.36145-24/98765_43210.enc?ccb=11-4&oh=01_y&oe=6A1B2C3D&_nc_sid=5e03e0',
    thumbnailSha256: vector.thumbnailSha256,
    thumbnailEncSha256: vector.thumbnailEncSha256,
    thumbnailHeight: 480,
    thumbnailWidth: 370,
    ...over,
  },
});
const marker = {
  mimetype: 'application/pdf',
  filename: 'Fechamento - Resumo.pdf',
  omitted: true,
  sizeBytes: 2_097_152,
  pageCount: 2,
};

describe('document first-page preview (wacrm patch)', () => {
  it('fetches the uploaded copy from the media CDN and decrypts it into the envelope', async () => {
    const urls: string[] = [];
    const media = await withDocumentThumbnail(
      rawDocument(),
      marker,
      url => (urls.push(url), Promise.resolve(encrypted)),
    );
    expect(urls).toEqual([`${WHATSAPP_MEDIA_HOST}${rawDocument()._data.thumbnailDirectPath}`]);
    expect(media).toEqual({ ...marker, thumbnail: vector.jpeg });
    expect(media?.thumbnail?.startsWith('/9j/')).toBe(true);
  });

  it('an inline preview is kept and nothing is fetched', async () => {
    const fetch = jest.fn();
    const inline = { ...marker, thumbnail: '/9j/inline' };
    await expect(withDocumentThumbnail(rawDocument(), inline, fetch)).resolves.toBe(inline);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('nothing unverified: a tampered file, a wrong hash or a wrong key gives no preview', () => {
    const src = documentThumbnailSource(rawDocument()._data)!;
    expect(decryptDocumentThumbnail(encrypted, src)).toBe(vector.jpeg);
    const tampered = Buffer.from(encrypted);
    tampered[20] ^= 1;
    expect(decryptDocumentThumbnail(tampered, src)).toBeNull();
    expect(decryptDocumentThumbnail(encrypted, { ...src, sha256: Buffer.alloc(32) })).toBeNull();
    // Another message's key: the encrypted hash still matches, the MAC doesn't.
    expect(decryptDocumentThumbnail(encrypted, { ...src, mediaKey: Buffer.alloc(32, 7) })).toBeNull();
  });

  it('says why a document got no preview (debug log), without touching the message', async () => {
    const reasons: string[] = [];
    const fail = () => Promise.reject(new Error('Media fetch failed with status 404'));
    await withDocumentThumbnail(rawDocument({ thumbnailDirectPath: undefined }), marker, fail, r => reasons.push(r));
    await withDocumentThumbnail(rawDocument(), marker, fail, r => reasons.push(r));
    await withDocumentThumbnail(
      rawDocument(),
      marker,
      () => Promise.resolve(Buffer.alloc(64)),
      r => reasons.push(r),
    );
    expect(reasons).toEqual([
      'no inline preview and no uploaded copy declared',
      'the uploaded copy could not be fetched: Error: Media fetch failed with status 404',
      'the uploaded copy did not verify',
    ]);
  });

  it('a failed fetch (expired on the CDN, no network) leaves the envelope as it was', async () => {
    await expect(
      withDocumentThumbnail(rawDocument(), marker, () =>
        Promise.reject(new Error('Media fetch failed with status 404')),
      ),
    ).resolves.toBe(marker);
  });

  it('only a document with a CDN path and well-formed keys is fetched', async () => {
    const fetch = jest.fn();
    for (const over of [
      { type: 'image' },
      { thumbnailDirectPath: undefined },
      { thumbnailDirectPath: '//evil.example/x' },
      { thumbnailDirectPath: '@evil.example/x' },
      { thumbnailDirectPath: 'https://evil.example/x' },
      { mediaKey: 'c2hvcnQ=' },
      { thumbnailSha256: undefined },
    ]) {
      await expect(withDocumentThumbnail(rawDocument(over), marker, fetch)).resolves.toBe(marker);
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(withDocumentThumbnail(rawDocument(), undefined, fetch)).resolves.toBeUndefined();
  });
});
