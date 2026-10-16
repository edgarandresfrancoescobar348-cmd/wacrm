import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

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

function makeMessaging(client: Record<string, unknown>): WwebjsMessaging {
  const host = {
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
    const text = historyMessage({ id: { _serialized: `false_${CHAT}_TXT` }, type: 'chat', body: 'oi', hasMedia: false });
    const chat = { fetchMessages: jest.fn().mockResolvedValue([historyMessage(), doc, text]) };
    const messaging = makeMessaging({ getChatById: jest.fn().mockResolvedValue(chat) });

    const [voice, pdf, plain] = await messaging.getChatHistory(CHAT, 2000, false);
    expect(voice.media).toEqual({ mimetype: 'audio/ogg; codecs=opus', omitted: true, sizeBytes: 4096, durationSeconds: 7 });
    expect(pdf.media).toEqual({
      mimetype: 'application/pdf',
      filename: 'Fechamento - Resumo.pdf',
      omitted: true,
      sizeBytes: 52_000,
    });
    expect(plain.media).toBeUndefined();
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
    [{ mimetype: 'video/mp4', data: '', sizeBytes: 9_999 }, { status: 'too_large', sizeBytes: 9_999 }],
  ])('page answer %p → %p', async (answer, expected) => {
    await expect(withPage(answer).messaging.downloadMessageMedia(CHAT, 'm', 1000)).resolves.toEqual(expected);
  });
});
