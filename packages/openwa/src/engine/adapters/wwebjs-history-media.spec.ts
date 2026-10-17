import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { withDocumentThumbnail } from './wwebjs-document-thumbnail';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * wacrm patch. A metadata-only history read (deep history never inlines media) used to return media
 * messages with no `media` at all, so a client could neither show them as media nor fetch them later;
 * and nothing could download a never-archived message's media. Now history carries the declared-only
 * marker and downloadMessageMedia fetches one message's media through the page.
 */
const logger = createLogger('wwebjs-history-media.spec');
const CHAT = '5511999990000@c.us';

function historyMessage(over: Record<string, unknown> = {}) {
  return {
    id: { _serialized: `false_${CHAT}_ABC` },
    from: CHAT,
    to: 'me@c.us',
    body: '',
    type: 'ptt',
    timestamp: 1_790_000_000,
    fromMe: false,
    hasMedia: true,
    hasQuotedMsg: false,
    _data: { mimetype: 'audio/ogg; codecs=opus', size: 4096, duration: '7' },
    getContact: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function makeMessaging(client: Record<string, unknown>, extra: Record<string, unknown> = {}): WwebjsMessaging {
  const host = {
    ...extra,
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsMessaging(host);
}

describe('history media marker (wacrm patch)', () => {
  it('a metadata-only read still says the message has media, and what it is', async () => {
    const doc = historyMessage({
      id: { _serialized: `false_${CHAT}_DOC` },
      type: 'document',
      body: 'Fechamento - Resumo.pdf',
      _data: { mimetype: 'application/pdf', filename: 'Fechamento - Resumo.pdf', size: 52_000 },
    });
    const text = historyMessage({
      id: { _serialized: `false_${CHAT}_TXT` },
      type: 'chat',
      body: 'oi',
      hasMedia: false,
    });
    const chat = { fetchMessages: jest.fn().mockResolvedValue([historyMessage(), doc, text]) };
    const messaging = makeMessaging({ getChatById: jest.fn().mockResolvedValue(chat) });

    const [voice, pdf, plain] = await messaging.getChatHistory(CHAT, 2000, false);
    expect(voice.media).toEqual({
      mimetype: 'audio/ogg; codecs=opus',
      omitted: true,
      sizeBytes: 4096,
      durationSeconds: 7,
    });
    expect(pdf.media).toEqual({
      mimetype: 'application/pdf',
      filename: 'Fechamento - Resumo.pdf',
      omitted: true,
      sizeBytes: 52_000,
    });
    expect(plain.media).toBeUndefined();
  });
});

describe('history payload for WhatsApp parity (wacrm patch)', () => {
  it('carries the ticks, the forwarded flag, page count and the JPEG preview WhatsApp keeps', async () => {
    const thumb = '/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(40);
    const pdf = historyMessage({
      id: { _serialized: `true_${CHAT}_PDF` },
      fromMe: true,
      from: 'me@c.us',
      to: CHAT,
      type: 'document',
      body: '3 ANTECEDENTES.pdf',
      ack: 3,
      isForwarded: true,
      forwardingScore: 5,
      _data: {
        mimetype: 'application/pdf',
        filename: '3 ANTECEDENTES.pdf',
        size: 2_097_152,
        pageCount: 1,
        body: thumb,
      },
    });
    const caption = historyMessage({
      id: { _serialized: `false_${CHAT}_IMG` },
      type: 'image',
      body: 'legenda',
      ack: 4,
      _data: { mimetype: 'image/jpeg', size: 1000, body: 'not a jpeg <script>' },
    });
    const chat = { fetchMessages: jest.fn().mockResolvedValue([pdf, caption]) };
    const messaging = makeMessaging({ getChatById: jest.fn().mockResolvedValue(chat) });
    const [doc, img] = await messaging.getChatHistory(CHAT, 2000, false);
    expect(doc).toMatchObject({ ack: 3, isForwarded: true, forwardingScore: 5 });
    expect(doc.media).toMatchObject({
      pageCount: 1,
      sizeBytes: 2_097_152,
      thumbnail: thumb,
      filename: '3 ANTECEDENTES.pdf',
    });
    expect(img.ack).toBe(4);
    expect(img.isForwarded).toBeUndefined();
    // Only a base64 JPEG is passed on as a preview.
    expect(img.media?.thumbnail).toBeUndefined();
    expect(img.body).toBe('legenda');
  });
});

describe('downloadMessageMedia (wacrm patch)', () => {
  const withPage = (answer: unknown) => {
    const evaluate = jest.fn().mockResolvedValue(answer);
    return { messaging: makeMessaging({ pupPage: { evaluate } }), evaluate };
  };

  it('returns the bytes the page downloaded, addressed by message id', async () => {
    const { messaging, evaluate } = withPage({ mimetype: 'image/jpeg', data: 'SlBH', sizeBytes: 3 });
    await expect(messaging.downloadMessageMedia(CHAT, 'false_x_1', 1000)).resolves.toEqual({
      status: 'ok',
      mimetype: 'image/jpeg',
      data: 'SlBH',
      sizeBytes: 3,
    });
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), { msgId: 'false_x_1', maxBytes: 1000 });
  });

  it.each([
    [null, { status: 'not_found' }],
    [undefined, { status: 'expired' }],
    [
      { mimetype: 'video/mp4', data: '', sizeBytes: 9_999 },
      { status: 'too_large', sizeBytes: 9_999 },
    ],
  ])('page answer %p → %p', async (answer, expected) => {
    await expect(withPage(answer).messaging.downloadMessageMedia(CHAT, 'm', 1000)).resolves.toEqual(expected);
  });
});

// Phase 5f, real account: no document had a preview — WhatsApp Web held no inline JPEG, only the
// uploaded copy (thumbnailDirectPath). The history marker now carries it.
describe('history document preview from the uploaded copy (wacrm patch)', () => {
  it('a document with no inline preview gets the decrypted first page', async () => {
    const v = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', 'document-thumbnail.baileys.json'), 'utf8'),
    ) as Record<'jpeg' | 'encrypted' | 'mediaKey' | 'thumbnailSha256' | 'thumbnailEncSha256', string>;
    const pdf = historyMessage({
      id: { _serialized: `false_${CHAT}_PDF2` },
      type: 'document',
      body: '',
      _data: {
        type: 'document',
        mimetype: 'application/pdf',
        filename: '7 DOSSIE.pdf',
        size: 3_900_000,
        pageCount: 21,
        body: '',
        mediaKey: v.mediaKey,
        thumbnailDirectPath: '/v/t62.36145-24/1_2.enc?ccb=11-4',
        thumbnailSha256: v.thumbnailSha256,
        thumbnailEncSha256: v.thumbnailEncSha256,
      },
    });
    const fetched: string[] = [];
    const chat = { fetchMessages: jest.fn().mockResolvedValue([pdf]) };
    const messaging = makeMessaging(
      { getChatById: jest.fn().mockResolvedValue(chat) },
      {
        withDocumentThumbnail: (msg: unknown, media: never) =>
          withDocumentThumbnail(
            msg,
            media,
            url => (fetched.push(url), Promise.resolve(Buffer.from(v.encrypted, 'base64'))),
          ),
      },
    );
    const [doc] = await messaging.getChatHistory(CHAT, 2000, false);
    expect(fetched).toEqual(['https://mmg.whatsapp.net/v/t62.36145-24/1_2.enc?ccb=11-4']);
    expect(doc.media).toMatchObject({ pageCount: 21, filename: '7 DOSSIE.pdf', omitted: true, thumbnail: v.jpeg });
  });
});

// wacrm patch 7 (phase 5g): the bubble's size before the photo loads — on the real account a photo
// with a caption became a cropped strip as wide as the conversation.
describe('history media marker carries the declared pixel size (wacrm patch)', () => {
  it('an image says its width and height; nonsense sizes are dropped', async () => {
    const photo = historyMessage({
      id: { _serialized: `false_${CHAT}_IMG2` },
      type: 'image',
      body: 'Realizamos os exames nesta clinica',
      _data: { mimetype: 'image/jpeg', size: 90_000, width: 1200, height: 1600 },
    });
    const odd = historyMessage({
      id: { _serialized: `false_${CHAT}_IMG3` },
      type: 'image',
      _data: { mimetype: 'image/jpeg', size: 1000, width: 'x', height: -3 },
    });
    const chat = { fetchMessages: jest.fn().mockResolvedValue([photo, odd]) };
    const messaging = makeMessaging({ getChatById: jest.fn().mockResolvedValue(chat) });
    const [a, b] = await messaging.getChatHistory(CHAT, 2000, false);
    expect(a.media).toMatchObject({ width: 1200, height: 1600 });
    expect(b.media?.width).toBeUndefined();
    expect(b.media?.height).toBeUndefined();
  });
});
