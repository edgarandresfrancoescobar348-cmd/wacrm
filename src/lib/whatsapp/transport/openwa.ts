// ============================================================
// OpenWA transport — a regular WhatsApp number paired by QR code,
// driven through a self-hosted OpenWA gateway.
//
// Where WhatsApp-the-app has no equivalent of a Cloud API concept, the
// transport sends the honest equivalent (see capabilities):
//
//   - templates   → rendered locally and sent as text (a media header
//                   becomes a media message with the text as caption);
//   - buttons / lists → a numbered text menu; the reply is mapped back
//                   to the option id on the way in (numbered-menu.ts);
//   - typing      → "mark read" + the typing chat state.
//
// Everything else is native: text, media (voice notes as PTT), quoted
// replies, reactions.
// ============================================================

import { isBusinessScopedUserId } from '@/lib/whatsapp/wa-identity'
import { renderNumberedMenu } from '@/lib/whatsapp/inbound/numbered-menu'
import { renderLocalTemplate, LOCAL_CAPTION_MAX } from '@/lib/whatsapp/template-local-render'
import { getT } from '@/lib/i18n/translate'
import {
  listOpenWaMessages,
  openWaMarkRead,
  openWaReact,
  openWaSend,
  openWaTyping,
  OpenWaError,
  normalizeOpenWaBaseUrl,
} from '@/lib/whatsapp/openwa/client'
import type { OpenWaConnection } from '@/lib/whatsapp/openwa/connection'
import {
  budgetTimeout,
  type MediaKind,
  type SendControl,
  type SendResult,
  type SendTemplateArgs,
  type TransportCapabilities,
  type WhatsAppTransport,
} from './types'

const t = getT('WhatsAppTransport')

export const OPENWA_DEFAULT_BROADCAST_DELAY_MS = 8000

/** OpenWA keeps a send's Idempotency-Key for 24 h (SEND_IDEMPOTENCY_TTL_MS). */
export const OPENWA_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

export function openWaCapabilities(broadcastDelayMs: number): TransportCapabilities {
  return {
    templates: 'local',
    serviceWindow: false,
    // OpenWA exposes no send endpoint for buttons or lists on either
    // engine (docs/29 capability matrix), so the fallback is always on.
    interactive: 'numbered_text',
    broadcastDelayMs,
    // OpenWA's send routes honour an Idempotency-Key header (24 h).
    idempotentSends: true,
    idempotencyWindowMs: OPENWA_IDEMPOTENCY_WINDOW_MS,
  }
}

/** `5511999999999` → `5511999999999@c.us`; JIDs pass through. */
export function toOpenWaChatId(to: string): string {
  const value = to.trim()
  if (value.includes('@')) return value
  if (isBusinessScopedUserId(value)) {
    // A Meta username-only contact: there is no number to reach over
    // a QR-paired WhatsApp.
    throw new OpenWaError(t('noPhoneForQr'), 400, 'no_phone')
  }
  const digits = value.replace(/\D/g, '')
  if (!digits) throw new OpenWaError(t('noPhoneForQr'), 400, 'no_phone')
  return `${digits}@c.us`
}

const SEND_ENDPOINT: Record<MediaKind, 'send-image' | 'send-video' | 'send-document' | 'send-audio'> = {
  image: 'send-image',
  video: 'send-video',
  document: 'send-document',
  audio: 'send-audio',
}

/** Our own uploads are inlined (the gateway may not reach Supabase). */
const MAX_INLINE_MEDIA_BYTES = 16 * 1024 * 1024

function ownStoragePrefix(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/`
}

/**
 * Media source for OpenWA. A file in this app's own public storage is
 * downloaded here and sent inline — the gateway may not be able to
 * reach Supabase (local dev, private network), and OpenWA SSRF-blocks
 * private addresses anyway. Any other URL is handed to OpenWA, which
 * fetches it behind its own SSRF guard; we never fetch arbitrary
 * caller-supplied URLs server-side.
 */
/** Downloading our own media is bounded too (a broadcast's budget). */
const MEDIA_FETCH_CAP_MS = 30_000

type MediaSource = { url: string } | { base64: string; mimetype: string }

async function mediaSource(link: string, sendBy?: number): Promise<MediaSource> {
  const prefix = ownStoragePrefix()
  let normalized: string
  try {
    // Resolve `..` segments before comparing, so a crafted path can't
    // start inside the public bucket prefix and walk out of it.
    normalized = new URL(link).href
  } catch {
    return { url: link }
  }
  if (!prefix || !normalized.startsWith(prefix)) return { url: link }
  const res = await fetch(normalized, {
    redirect: 'manual',
    signal: AbortSignal.timeout(budgetTimeout(sendBy, MEDIA_FETCH_CAP_MS)),
  })
  if (!res.ok) throw new OpenWaError(`Media fetch failed: ${res.status}`, 400, 'media_fetch')
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > MAX_INLINE_MEDIA_BYTES) {
    throw new OpenWaError('Media file too large', 413, 'media_too_large')
  }
  const mimetype =
    (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
  return { base64: Buffer.from(bytes).toString('base64'), mimetype }
}

/** Voice notes (OGG/Opus) go out as PTT; other audio as a file. */
function isVoiceNote(link: string, mimetype?: string): boolean {
  if (mimetype && /ogg|opus/i.test(mimetype)) return true
  return /\.(ogg|opus)(\?|$)/i.test(link)
}

function fileNameFromUrl(link: string): string | undefined {
  try {
    const last = new URL(link).pathname.split('/').pop()
    return last ? decodeURIComponent(last) : undefined
  } catch {
    return undefined
  }
}

export function createOpenWaTransport(conn: OpenWaConnection): WhatsAppTransport {
  const sessionId = conn.sessionId
  if (!sessionId) throw new OpenWaError('OpenWA session not created', 400, 'no_session')
  const creds = { baseUrl: conn.baseUrl, apiKey: conn.apiKey }

  // Media is prepared once per transport (a broadcast reuses its header
  // for every recipient) — and can be prepared BEFORE a paced slot is
  // reserved, so the slot only waits on the gateway (prepareTemplate).
  const preparedMedia = new Map<string, Promise<MediaSource>>()
  const source = (link: string, sendBy?: number) => {
    let p = preparedMedia.get(link)
    if (!p) {
      p = mediaSource(link, sendBy)
      preparedMedia.set(link, p)
      p.catch(() => preparedMedia.delete(link))
    }
    return p
  }
  // The absolute budget goes all the way down: openWaRequest recomputes
  // what is left right before fetch, after its SSRF/DNS guard.
  const control = (c: SendControl) => ({
    sendBy: c.sendBy,
    idempotencyKey: c.idempotencyKey,
  })

  const sendText = async (to: string, text: string, quoted?: string, c: SendControl = {}): Promise<SendResult> => {
    const body: Record<string, unknown> = { chatId: toOpenWaChatId(to), text }
    if (quoted) body.quotedMessageId = quoted
    const r = await openWaSend(creds, sessionId, 'send-text', body, control(c))
    return { messageId: r.messageId }
  }

  const sendMedia = async (args: {
    to: string
    kind: MediaKind
    link: string
    caption?: string
    filename?: string
    contextMessageId?: string
  } & SendControl): Promise<SendResult> => {
    const media = await source(args.link, args.sendBy)
    const body: Record<string, unknown> = { chatId: toOpenWaChatId(args.to), ...media }
    if (args.caption && args.kind !== 'audio') {
      body.caption = args.caption.slice(0, LOCAL_CAPTION_MAX)
    }
    if (args.kind === 'document') {
      body.filename = args.filename || fileNameFromUrl(args.link) || 'file'
    }
    if (args.kind === 'audio') {
      body.ptt = isVoiceNote(args.link, 'mimetype' in media ? media.mimetype : undefined)
    }
    if (args.contextMessageId) body.quotedMessageId = args.contextMessageId
    const r = await openWaSend(creds, sessionId, SEND_ENDPOINT[args.kind], body, control(args))
    return { messageId: r.messageId }
  }

  const renderTemplate = (args: SendTemplateArgs) => {
    if (!args.template) {
      throw new OpenWaError(t('templateNotFound', { name: args.templateName }), 404, 'template_not_found')
    }
    return renderLocalTemplate(args.template, { ...(args.messageParams ?? {}), legacyBody: args.params })
  }

  return {
    provider: 'openwa',
    capabilities: openWaCapabilities(conn.broadcastDelayMs),
    gateway: { url: normalizeOpenWaBaseUrl(conn.baseUrl), sessionId },

    expectedBody(args) {
      const rendered = renderTemplate(args)
      return rendered.media ? rendered.text.slice(0, LOCAL_CAPTION_MAX) : rendered.text
    },

    async findSentMessage({ to, body, since }) {
      const { messages } = await listOpenWaMessages(creds, sessionId, {
        chatId: toOpenWaChatId(to),
        // A little slack for clock skew between us and the gateway.
        since: since - 120_000,
        limit: 100,
      })
      const hit = (messages ?? []).find(
        (m) => m.direction === 'outgoing' && (m.body ?? '') === body,
      )
      return hit ? (hit.waMessageId ?? hit.id) : null
    },

    sendText: ({ to, text, contextMessageId, ...c }) => sendText(to, text, contextMessageId, c),

    sendMedia: (args) => sendMedia(args),

    async prepareTemplate(args) {
      const rendered = renderTemplate(args)
      if (rendered.media) await source(rendered.media.url, args.sendBy)
    },

    async sendTemplate(args) {
      const rendered = renderTemplate(args)
      if (rendered.media) {
        return sendMedia({
          to: args.to,
          kind: rendered.media.kind,
          link: rendered.media.url,
          caption: rendered.text,
          contextMessageId: args.contextMessageId,
          sendBy: args.sendBy,
          idempotencyKey: args.idempotencyKey,
        })
      }
      return sendText(args.to, rendered.text, args.contextMessageId, args)
    },

    sendInteractive: ({ to, payload, contextMessageId }) =>
      sendText(to, renderNumberedMenu(payload, t('numberedMenuHint')), contextMessageId),

    async sendReaction({ to, targetMessageId, emoji }) {
      await openWaReact(creds, sessionId, {
        chatId: toOpenWaChatId(to),
        messageId: targetMessageId,
        emoji,
      })
    },

    async sendTyping({ to, inboundMessageId }) {
      const chatId = toOpenWaChatId(to)
      await openWaMarkRead(creds, sessionId, { chatId, messageIds: [inboundMessageId] })
      await openWaTyping(creds, sessionId, { chatId, state: 'typing' })
    },

    recipientVariants: (phone) => [phone],
    isRecipientRetryable: () => false,
  }
}
