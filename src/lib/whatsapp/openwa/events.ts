// ============================================================
// OpenWA webhook events → the shared ingestion path.
//
// Translates OpenWA's delivery envelope
//   { event, timestamp, sessionId, idempotencyKey, deliveryId, data }
// into `InboundMessage` / `InboundStatusUpdate` / session-state writes.
// Signature verification and idempotency happen in the route before
// anything here runs.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  applyMessageMutation,
  applyStatusUpdate,
  ingestInboundMessage,
  recordOutboundEcho,
  type InboundContent,
  type InboundMessage,
} from '@/lib/whatsapp/inbound/ingest'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { WaIdentity } from '@/lib/whatsapp/wa-identity'
import {
  downloadOpenWaMedia,
  getOpenWaContactPhone,
  getOpenWaProfilePicture,
  isOpenWaSessionStatus,
  type OpenWaCredentials,
} from './client'
import type { OpenWaConnectionRow } from './connection'
import { decrypt } from '@/lib/whatsapp/encryption'
import { reconcileAttemptFromEcho } from '@/lib/whatsapp/broadcast-attempts'

export interface OpenWaEnvelope {
  event: string
  /** ISO dispatch time. */
  timestamp?: string
  /** Session UUID. */
  sessionId: string
  idempotencyKey?: string
  deliveryId?: string
  data?: Record<string, unknown>
}

/** HMAC-SHA256 over the raw body, `sha256=<hex>`, constant-time compare. */
export function verifyOpenWaSignature(
  rawBody: string,
  header: string | null,
  secret: string | null | undefined,
): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---- inbound message classification -------------------------------

interface OpenWaMessageData {
  id?: string
  from?: string
  to?: string
  chatId?: string
  body?: string
  type?: string
  timestamp?: number
  fromMe?: boolean
  isGroup?: boolean
  kind?: string
  isStatusBroadcast?: boolean
  senderPhone?: string | null
  contact?: { name?: string; pushName?: string }
  media?: {
    mimetype?: string
    filename?: string
    data?: string
    omitted?: boolean
    sizeBytes?: number
  }
  quotedMessage?: { id?: string; body?: string }
  location?: {
    latitude?: number
    longitude?: number
    description?: string
    address?: string
  }
  /** Baileys only: a tapped button / list row. */
  button?: { id?: string; text?: string }
  poll?: { name?: string }
}

/**
 * Only one-to-one chats become conversations. Groups, status posts,
 * channels and broadcast lists are dropped.
 */
export function isIgnorableChat(data: OpenWaMessageData): boolean {
  const chatId = data.chatId ?? data.from ?? ''
  if (data.isGroup) return true
  if (data.isStatusBroadcast) return true
  if (data.kind && data.kind !== 'individual') return true
  if (/@(g\.us|broadcast|newsletter)$/.test(chatId)) return true
  if (chatId === 'status@broadcast') return true
  return false
}

/** `5511999999999@c.us` → `5511999999999`; other JIDs → null. */
export function phoneFromChatId(chatId: string | undefined | null): string | null {
  if (!chatId) return null
  const m = chatId.match(/^(\d{6,20})@(c\.us|s\.whatsapp\.net)$/)
  return m ? m[1] : null
}

/** OpenWA message type → the ingestion vocabulary (Meta's). */
export function toIngestType(data: OpenWaMessageData): string {
  if (data.button?.id) return 'interactive'
  switch (data.type) {
    case 'voice':
      return 'audio'
    case 'text':
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker':
    case 'location':
      return data.type
    default:
      // contact, poll, call, order, product, unknown → text
      return 'text'
  }
}

function vcardName(body: string): string | null {
  const fn = body.match(/^FN:(.+)$/m)
  return fn ? fn[1].trim() : null
}

/** Text the inbox shows for non-media OpenWA messages. */
export function textContentFor(data: OpenWaMessageData): string | null {
  switch (data.type) {
    case 'location': {
      const loc = data.location
      if (!loc) return data.body || null
      return [loc.description, loc.address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(' - ')
    }
    case 'contact': {
      const name = vcardName(data.body ?? '')
      return name ? `👤 ${name}` : data.body || null
    }
    case 'poll':
      return data.poll?.name ? `📊 ${data.poll.name}` : data.body || null
    default:
      return data.body || null
  }
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

/** Stable digits-only media id for the mirror path (see mirrorFileName). */
export function mirrorMediaId(messageId: string): string {
  const hex = crypto.createHash('sha256').update(messageId).digest('hex').slice(0, 15)
  return BigInt(`0x${hex}`).toString()
}

export function openWaMediaProxyUrl(chatId: string, messageId: string): string {
  return `/api/whatsapp/openwa/media?chat=${encodeURIComponent(chatId)}&id=${encodeURIComponent(messageId)}`
}

export interface EventContext {
  admin: SupabaseClient
  row: OpenWaConnectionRow
  creds: OpenWaCredentials
  /** whatsapp_config.provider for the account ('meta' | 'openwa'). */
  activeProvider: string
  mirrorMedia: boolean
  /**
   * Receives the bot fan-out of an ingested message (flows, automations,
   * AI, public webhooks) to run after the delivery is acknowledged.
   * Without it the fan-out runs inline.
   */
  defer?: (task: () => Promise<void>) => void
}

async function resolveOpenWaContent(
  ctx: EventContext,
  data: OpenWaMessageData,
  accountId: string,
): Promise<InboundContent> {
  const empty: InboundContent = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  if (data.button?.id) {
    return {
      ...empty,
      contentText: data.button.text || data.body || data.button.id,
      interactiveReplyId: data.button.id,
    }
  }

  if (!data.type || !MEDIA_TYPES.has(data.type) || !data.media) {
    return { ...empty, contentText: textContentFor(data) }
  }

  const sessionId = ctx.row.session_id!
  const chatId = data.chatId ?? data.from ?? ''
  const messageId = data.id ?? ''
  const mimeType = data.media.mimetype ?? null
  const caption = data.type === 'document'
    ? data.body || data.media.filename || null
    : data.body || null
  const proxyUrl = openWaMediaProxyUrl(chatId, messageId)

  if (!ctx.mirrorMedia) {
    return { ...empty, contentText: caption, mediaUrl: proxyUrl, mediaType: mimeType }
  }

  const mirrored = await mirrorInboundMedia({
    storage: ctx.admin.storage,
    accountId,
    mediaId: mirrorMediaId(messageId),
    downloadUrl: 'openwa',
    accessToken: '',
    mimeType,
    fileSize: data.media.sizeBytes ?? null,
    fileName: data.media.filename ?? null,
    messageTimestamp: data.timestamp ?? null,
    // Inline base64 (≤ 1 MiB) or the gateway's media route.
    download: async () => {
      if (data.media?.data) {
        return {
          buffer: Buffer.from(data.media.data, 'base64'),
          contentType: mimeType ?? 'application/octet-stream',
        }
      }
      const fetched = await downloadOpenWaMedia(ctx.creds, sessionId, chatId, messageId)
      return {
        buffer: Buffer.from(fetched.bytes),
        contentType: fetched.mimeType ?? mimeType ?? 'application/octet-stream',
      }
    },
  })

  return {
    ...empty,
    contentText: caption,
    mediaUrl: mirrored ?? proxyUrl,
    mediaType: mimeType,
  }
}

/**
 * The customer's phone for a one-to-one chat: from a `@c.us` chat id,
 * else OpenWA's `senderPhone`, else (a privacy `@lid` sender) the
 * gateway's contact → phone lookup. Null when none is available.
 */
async function resolveChatPhone(
  ctx: EventContext,
  chatId: string,
  senderPhone?: string | null,
): Promise<string | null> {
  const direct = phoneFromChatId(chatId)
  if (direct) return direct
  if (senderPhone) return normalizePhone(senderPhone) || null
  if (chatId.endsWith('@lid') && ctx.row.session_id) {
    // A failed lookup throws: the delivery is retried rather than the
    // message dropped. Only "no phone known" is a definitive skip.
    const r = await getOpenWaContactPhone(ctx.creds, ctx.row.session_id, chatId)
    return r.phone ? normalizePhone(r.phone) || null : null
  }
  return null
}

function identityFor(phone: string, name: string): WaIdentity {
  return { phone, waUserId: null, waParentUserId: null, waUsername: null, name }
}

/**
 * The envelope's dispatch time at FULL (millisecond) precision — the
 * newest-wins watermark for session state and edits. Must not go through
 * the Unix-seconds format used for message timestamps: truncating to the
 * second made a later event in the same second as a live refresh look
 * older, and dropped it (second review G6).
 */
export function envelopeInstant(env: OpenWaEnvelope): string {
  const ms = env.timestamp ? Date.parse(env.timestamp) : NaN
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
}

function envelopeSeconds(env: OpenWaEnvelope, fallback?: number): string {
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return String(Math.floor(fallback))
  const ms = env.timestamp ? Date.parse(env.timestamp) : NaN
  return String(Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000))
}

// ---- dispatch -------------------------------------------------------

export type OpenWaEventOutcome =
  | 'ingested'
  | 'ignored_group'
  | 'ignored_no_phone'
  | 'ignored'
  | 'status'
  | 'session'
  | 'mutation'
  | 'echo'

/**
 * Process one verified delivery's durable part. THROWS on a transient
 * failure (DB, gateway lookup) so the webhook can answer non-2xx and
 * OpenWA redelivers — every write below is idempotent, so a retry never
 * duplicates. Bot fan-out goes to `ctx.defer` when given.
 */
export async function handleOpenWaEvent(
  env: OpenWaEnvelope,
  ctx: EventContext,
): Promise<OpenWaEventOutcome> {
  return dispatch(env, ctx)
}

async function dispatch(env: OpenWaEnvelope, ctx: EventContext): Promise<OpenWaEventOutcome> {
  const accountId = ctx.row.account_id
  const data = (env.data ?? {}) as Record<string, unknown>

  switch (env.event) {
    case 'message.received': {
      const msg = data as OpenWaMessageData
      if (!msg.id || msg.fromMe) return 'ignored'
      if (isIgnorableChat(msg)) return 'ignored_group'
      const chatId = msg.chatId ?? msg.from ?? ''
      const phone = await resolveChatPhone(ctx, chatId, msg.senderPhone)
      if (!phone) {
        console.warn('[openwa] inbound message without a resolvable phone; skipping', msg.id)
        return 'ignored_no_phone'
      }
      const inbound: InboundMessage = {
        provider: 'openwa',
        messageId: msg.id,
        timestamp: envelopeSeconds(env, msg.timestamp),
        type: toIngestType(msg),
        identity: identityFor(phone, msg.contact?.pushName || msg.contact?.name || ''),
        contextMessageId: msg.quotedMessage?.id ?? null,
        text: msg.body ?? null,
        resolveContent: ({ accountId: acct }) => resolveOpenWaContent(ctx, msg, acct),
      }
      await ingestInboundMessage(inbound, accountId, ctx.row.user_id, {
        runBots: ctx.activeProvider === 'openwa',
        mapNumberedMenuReplies: true,
        throwOnFailure: true,
        deferFanOut: ctx.defer,
        onContactCreated: async (contact) => {
          if (!ctx.row.session_id) return
          const pic = await getOpenWaProfilePicture(ctx.creds, ctx.row.session_id, chatId)
          if (pic.url) {
            await ctx.admin
              .from('contacts')
              .update({ avatar_url: pic.url })
              .eq('id', contact.id)
              .eq('account_id', accountId)
          }
        },
      })
      return 'ingested'
    }

    case 'message.sent': {
      const msg = data as OpenWaMessageData
      if (!msg.id) return 'ignored'
      if (isIgnorableChat(msg)) return 'ignored_group'
      const chatId = msg.chatId ?? msg.to ?? ''
      const phone = await resolveChatPhone(ctx, chatId)
      if (!phone) return 'ignored_no_phone'
      // A broadcast send whose outcome we couldn't establish (gateway
      // timeout, "outcome unknown"): this echo proves it went out —
      // reconcile its attempt instead of ever resending it. Essential:
      // a failure is retried (the delivery is answered non-2xx).
      await reconcileAttemptFromEcho(ctx.admin, {
        accountId,
        toPhone: phone,
        body: msg.body ?? null,
        messageId: msg.id,
        sentAt: envelopeInstant(env),
      })
      // Our own API sends echo back here too, often before the send call
      // has returned. Whichever writes first wins the unique
      // (conversation_id, message_id); the sender then merges its own
      // metadata into the row (persistOutboundMessage) — no timing
      // assumption, and the sender never fails because of the echo.
      await recordOutboundEcho(
        {
          provider: 'openwa',
          messageId: msg.id,
          timestamp: envelopeSeconds(env, msg.timestamp),
          type: toIngestType(msg),
          identity: identityFor(phone, ''),
          contextMessageId: msg.quotedMessage?.id ?? null,
          text: msg.body ?? null,
          resolveContent: ({ accountId: acct }) => resolveOpenWaContent(ctx, msg, acct),
        },
        accountId,
        ctx.row.user_id,
        { throwOnFailure: true },
      )
      return 'echo'
    }

    case 'message.ack':
    case 'message.failed': {
      const id = (data.messageId ?? data.id) as string | undefined
      const status = (env.event === 'message.failed' ? 'failed' : data.status) as string | undefined
      // `pending` is below `sent` and not a messages.status value.
      if (!id || !status || !['sent', 'delivered', 'read', 'failed'].includes(status)) {
        return 'ignored'
      }
      await applyStatusUpdate(
        {
          id,
          status,
          timestamp: envelopeSeconds(env),
          failure:
            status === 'failed'
              ? { code: 0, title: 'OpenWA: message not delivered', details: null }
              : null,
        },
        { accountId, throwOnFailure: true },
      )
      return 'status'
    }

    case 'message.reaction': {
      const messageId = data.messageId as string | undefined
      const senderId = (data.senderId as string | undefined) ?? (data.chatId as string | undefined)
      const chatId = (data.chatId as string | undefined) ?? senderId ?? ''
      if (!messageId || !senderId) return 'ignored'
      if (/@(g\.us|broadcast|newsletter)$/.test(chatId)) return 'ignored_group'
      // Our own reaction (from the phone) echoes back with our JID.
      if (ctx.row.phone && phoneFromChatId(senderId) === ctx.row.phone) return 'ignored'
      const phone = await resolveChatPhone(ctx, senderId)
      if (!phone) return 'ignored_no_phone'
      await ingestInboundMessage(
        {
          provider: 'openwa',
          // Reactions never insert a message row; this id only names the
          // delivery in logs.
          messageId: `reaction:${messageId}:${senderId}`,
          timestamp: envelopeSeconds(env),
          type: 'reaction',
          identity: identityFor(phone, ''),
          reaction: { targetMessageId: messageId, emoji: (data.reaction as string) ?? '' },
          resolveContent: async () => ({
            contentText: null,
            mediaUrl: null,
            mediaType: null,
            interactiveReplyId: null,
          }),
        },
        accountId,
        ctx.row.user_id,
        { runBots: false, throwOnFailure: true },
      )
      return 'ingested'
    }

    case 'message.revoked': {
      const target = (data.revokedId ?? data.id) as string | undefined
      if (!target) return 'ignored'
      await applyMessageMutation(
        accountId,
        target,
        { kind: 'revoked', at: new Date().toISOString() },
        { throwOnFailure: true },
      )
      return 'mutation'
    }

    case 'message.edited': {
      const target = data.messageId as string | undefined
      const body = data.body as string | undefined
      if (!target || typeof body !== 'string') return 'ignored'
      await applyMessageMutation(
        accountId,
        target,
        // Gateway event time — edits apply newest-wins (see ingest).
        { kind: 'edited', at: envelopeInstant(env), text: body },
        { throwOnFailure: true },
      )
      return 'mutation'
    }

    case 'session.status':
    case 'session.qr':
    case 'session.authenticated':
    case 'session.disconnected':
    case 'session.reconnect_loop':
    case 'session.restriction':
      await applySessionEvent(env, ctx)
      return 'session'

    default:
      return 'ignored'
  }
}

/** Session lifecycle → `whatsapp_openwa_config` (+ whatsapp_config.status). */
async function applySessionEvent(env: OpenWaEnvelope, ctx: EventContext): Promise<void> {
  const data = (env.data ?? {}) as Record<string, unknown>
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = {}

  switch (env.event) {
    case 'session.status':
      if (!isOpenWaSessionStatus(data.status)) return
      patch.status = data.status
      patch.status_updated_at = now
      if (data.status === 'ready') {
        patch.last_error = null
        patch.reconnect_attempts = null
        patch.connected_at = ctx.row.connected_at ?? now
      } else if (data.status === 'qr_ready' || data.status === 'disconnected') {
        patch.connected_at = null
      }
      break
    case 'session.qr':
      // The QR itself is fetched live by the settings page; the event
      // only tells us the session is waiting for a scan.
      patch.status = 'qr_ready'
      patch.status_updated_at = now
      break
    case 'session.authenticated':
      patch.status = 'ready'
      patch.status_updated_at = now
      patch.phone = typeof data.phone === 'string' ? normalizePhone(data.phone) || null : null
      patch.push_name = typeof data.pushName === 'string' ? data.pushName : null
      patch.last_error = null
      patch.reconnect_attempts = null
      patch.connected_at = now
      break
    case 'session.disconnected':
      patch.status = 'disconnected'
      patch.status_updated_at = now
      patch.connected_at = null
      patch.last_error = typeof data.reason === 'string' ? data.reason : null
      break
    case 'session.reconnect_loop':
      patch.reconnect_attempts = typeof data.attempts === 'number' ? data.attempts : null
      patch.status_updated_at = now
      break
    case 'session.restriction':
      patch.restriction = data.active
        ? {
            kind: String(data.kind ?? 'unknown'),
            code: String(data.code ?? ''),
            expiresAt: (data.expiresAt as string | null) ?? null,
          }
        : null
      patch.status_updated_at = now
      break
  }

  // Monotonic by the gateway's event time: a session event older than
  // the newest one applied (a late redelivery, a replayed capture) must
  // not overwrite newer state — e.g. an old "disconnected" over a live
  // session.
  const eventAt = envelopeInstant(env)
  patch.status_event_at = eventAt
  const { data: applied, error } = await ctx.admin
    .from('whatsapp_openwa_config')
    .update(patch)
    .eq('account_id', ctx.row.account_id)
    .eq('session_id', env.sessionId)
    .or(`status_event_at.is.null,status_event_at.lte.${eventAt}`)
    .select('id')
  if (error) {
    console.error('[openwa] session state update failed:', error.message)
    throw new Error(`session state update failed: ${error.message}`)
  }
  if (!applied || applied.length === 0) {
    console.info(`[openwa] ignored ${env.event} older than the current session state`)
  }
  // The active-connection flag (whatsapp_config.status) is NOT written
  // here: migration 058 derives it from this row in the same statement,
  // so it can never disagree with the newest applied session state.
}

/** Decrypted credentials for a row (route helper). */
export function credsForRow(row: OpenWaConnectionRow): OpenWaCredentials {
  return { baseUrl: row.base_url, apiKey: decrypt(row.api_key) }
}
