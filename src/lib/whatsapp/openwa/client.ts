// ============================================================
// OpenWA REST client — the only code that talks HTTP to an OpenWA
// gateway (https://github.com/rmyndharis/OpenWA, API v0.25).
//
// The gateway is wacrm's own: vendored under packages/openwa and
// started next to the app (scripts/wacrm.mjs, docker-compose.yml). Its
// URL and admin key come from server config (./gateway.ts), never from
// a tenant, so there is no per-request URL guard. Redirects are still
// never followed.
//
// Responses are bare JSON (no envelope); errors are Nest's
// `{ message, error, statusCode, code? }`.
// ============================================================

import { SendBudgetExceededError, UncertainSendError } from '@/lib/whatsapp/transport/types'

const DEFAULT_TIMEOUT_MS = 20_000
/** Sends wait out OpenWA's simulated typing (≤ 5 s) before answering. */
export const SEND_TIMEOUT_MS = 45_000

export type OpenWaSessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed'

export const OPENWA_SESSION_STATUSES: readonly OpenWaSessionStatus[] = [
  'created',
  'initializing',
  'qr_ready',
  'authenticating',
  'ready',
  'disconnected',
  'action_required',
  'failed',
]

export function isOpenWaSessionStatus(v: unknown): v is OpenWaSessionStatus {
  return typeof v === 'string' && (OPENWA_SESSION_STATUSES as readonly string[]).includes(v)
}

export type OpenWaEngine = 'whatsapp-web.js' | 'baileys'

export interface OpenWaRestriction {
  kind: string
  code: string
  expiresAt: string | null
}

export interface OpenWaSession {
  id: string
  name: string
  status: OpenWaSessionStatus
  phone: string | null
  pushName: string | null
  connectedAt: string | null
  lastError: string | null
  restriction: OpenWaRestriction | null
}

export interface OpenWaCredentials {
  baseUrl: string
  /** Plaintext — decrypted by the caller, never logged. */
  apiKey: string
}

/** Typed failure: `status` is OpenWA's HTTP status (0 = unreachable). */
export class OpenWaError extends Error {
  readonly status: number
  readonly code: string | null
  /** How long the gateway asked us to wait (429 `Retry-After*`), if it said. */
  readonly retryAfterMs: number | null
  constructor(message: string, status: number, code: string | null = null, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'OpenWaError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * The longest wait a response asks for. OpenWA's throttler (Nest) sends
 * one `Retry-After-<tier>` header per exhausted tier (short/medium/long),
 * in seconds; a plain `Retry-After` may also be seconds or an HTTP date.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  let longest: number | null = null
  headers.forEach((value, name) => {
    if (!/^retry-after(-|$)/i.test(name)) return
    const seconds = Number(value)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
    if (Number.isFinite(ms) && ms >= 0) longest = Math.max(longest ?? 0, ms)
  })
  return longest
}

/**
 * Canonical base URL: scheme + host + optional path prefix, no trailing
 * slash, no trailing `/api` (the client adds it), no query, no fragment,
 * no credentials. Throws OpenWaError('invalid_url') otherwise.
 */
export function normalizeOpenWaBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new OpenWaError('Invalid OpenWA URL', 400, 'invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenWaError('OpenWA URL must use http or https', 400, 'invalid_url')
  }
  if (url.username || url.password) {
    throw new OpenWaError('OpenWA URL must not contain credentials', 400, 'invalid_url')
  }
  if (url.search || url.hash) {
    throw new OpenWaError('OpenWA URL must not have a query or fragment', 400, 'invalid_url')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')
  return `${url.protocol}//${url.host}${path}`
}

interface RequestOptions {
  body?: unknown
  timeoutMs?: number
  /**
   * Absolute epoch ms the WHOLE request must finish by. The time left
   * caps this request's timeout; past it, SendBudgetExceededError
   * (nothing was sent).
   */
  deadline?: number
  /** Return the raw Response (binary downloads). */
  raw?: boolean
  idempotencyKey?: string
}

export async function openWaRequest<T = unknown>(
  creds: OpenWaCredentials,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = normalizeOpenWaBaseUrl(creds.baseUrl)
  const deadline = opts.deadline
  // What is left of the deadline caps this request's own timeout.
  let timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (deadline !== undefined) {
    const left = deadline - Date.now()
    if (left <= 0) throw new SendBudgetExceededError()
    timeoutMs = Math.min(timeoutMs, left)
  }

  const headers: Record<string, string> = {
    'X-API-Key': creds.apiKey,
    Accept: opts.raw ? '*/*' : 'application/json',
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  let response: Response
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Still status 0 (no answer) for every caller; the code tells a
    // gateway that is slow to answer from one that refused the connection.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new OpenWaError(`OpenWA did not answer within ${Math.round(timeoutMs / 1000)} s`, 0, 'timeout')
    }
    throw new OpenWaError(`OpenWA unreachable: ${reason}`, 0, 'unreachable')
  }

  if (response.status >= 300 && response.status < 400) {
    throw new OpenWaError('OpenWA answered with a redirect; refusing to follow', response.status, 'redirect')
  }

  if (!response.ok) {
    let message = `OpenWA error ${response.status}`
    let code: string | null = null
    try {
      const data = (await response.json()) as {
        message?: string | string[]
        code?: string
      }
      if (Array.isArray(data.message)) message = data.message.join('; ')
      else if (data.message) message = data.message
      if (data.code) code = data.code
    } catch {
      // non-JSON error body — keep the status line
    }
    throw new OpenWaError(message, response.status, code, retryAfterMs(response.headers))
  }

  if (opts.raw) return response as unknown as T
  if (response.status === 204) return undefined as T
  // The request was accepted: anything that goes wrong reading the answer
  // leaves the effect UNKNOWN (K7) — never a definitive failure.
  try {
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  } catch (err) {
    throw new UncertainSendError(
      `OpenWA answered ${response.status} but the response could not be read`,
      err,
    )
  }
}

// ---- auth / health ------------------------------------------------

export interface OpenWaKeyInfo {
  valid: boolean
  role: string
  engineType: OpenWaEngine | string
  scoped: boolean
}

/** POST /auth/validate — 401 on a bad key. The gateway health probe. */
export function validateOpenWaKey(creds: OpenWaCredentials) {
  return openWaRequest<OpenWaKeyInfo>(creds, 'POST', '/auth/validate')
}

export async function openWaVersion(creds: OpenWaCredentials): Promise<string | null> {
  const health = await openWaRequest<{ version?: string }>(creds, 'GET', '/health')
  return health?.version ?? null
}

// ---- sessions -----------------------------------------------------

const enc = encodeURIComponent

export function createOpenWaSession(creds: OpenWaCredentials, name: string) {
  return openWaRequest<OpenWaSession>(creds, 'POST', '/sessions', { body: { name } })
}

export function getOpenWaSession(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<OpenWaSession>(creds, 'GET', `/sessions/${enc(sessionId)}`)
}

export function startOpenWaSession(creds: OpenWaCredentials, sessionId: string) {
  // Start waits for the engine to launch (≈10 s on whatsapp-web.js).
  return openWaRequest<OpenWaSession>(creds, 'POST', `/sessions/${enc(sessionId)}/start`, {
    timeoutMs: 60_000,
  })
}

export function stopOpenWaSession(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<OpenWaSession>(creds, 'POST', `/sessions/${enc(sessionId)}/stop`, {
    timeoutMs: 60_000,
  })
}

export function logoutOpenWaSession(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<OpenWaSession>(creds, 'POST', `/sessions/${enc(sessionId)}/logout`, {
    timeoutMs: 60_000,
  })
}

export function deleteOpenWaSession(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<void>(creds, 'DELETE', `/sessions/${enc(sessionId)}`)
}

export function getOpenWaQr(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<{ qrCode: string; status: OpenWaSessionStatus }>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/qr`,
  )
}

export function requestOpenWaPairingCode(
  creds: OpenWaCredentials,
  sessionId: string,
  phoneNumber: string,
) {
  return openWaRequest<{ pairingCode: string; status: OpenWaSessionStatus }>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/pairing-code`,
    { body: { phoneNumber } },
  )
}

// ---- webhooks -----------------------------------------------------

/** Every event wacrm consumes. Groups/status/calls are not subscribed. */
export const OPENWA_WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.edited',
  'message.reaction',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'session.reconnect_loop',
  'session.restriction',
] as const

export interface OpenWaWebhook {
  id: string
  url: string
  events: string[]
  active: boolean
}

export function createOpenWaWebhook(
  creds: OpenWaCredentials,
  sessionId: string,
  args: { url: string; secret: string },
) {
  return openWaRequest<OpenWaWebhook>(creds, 'POST', `/sessions/${enc(sessionId)}/webhooks`, {
    body: {
      url: args.url,
      events: [...OPENWA_WEBHOOK_EVENTS],
      secret: args.secret,
      retryCount: 5,
    },
  })
}

export function listOpenWaWebhooks(creds: OpenWaCredentials, sessionId: string) {
  return openWaRequest<OpenWaWebhook[]>(creds, 'GET', `/sessions/${enc(sessionId)}/webhooks`)
}

export function deleteOpenWaWebhook(creds: OpenWaCredentials, sessionId: string, webhookId: string) {
  return openWaRequest<void>(
    creds,
    'DELETE',
    `/sessions/${enc(sessionId)}/webhooks/${enc(webhookId)}`,
  )
}

// ---- messaging ----------------------------------------------------

export interface OpenWaSendResult {
  messageId: string
  timestamp: number
}

/** A 2xx send answer must carry the message id; otherwise the outcome is unknown. */
function requireMessageId(r: OpenWaSendResult | undefined, status = 200): OpenWaSendResult {
  if (!r || typeof r.messageId !== 'string' || !r.messageId) {
    throw new UncertainSendError(`OpenWA answered ${status} without a message id`)
  }
  return r
}

export function openWaSend(
  creds: OpenWaCredentials,
  sessionId: string,
  endpoint:
    | 'send-text'
    | 'send-image'
    | 'send-video'
    | 'send-audio'
    | 'send-document'
    | 'send-location',
  body: Record<string, unknown>,
  opts: {
    /** Absolute epoch ms the send must have finished by (a broadcast's
     *  budget). Covers the SSRF guard and the request; never more than
     *  SEND_TIMEOUT_MS from now. */
    sendBy?: number
    /** OpenWA de-duplicates a repeated send with the same key (24 h). */
    idempotencyKey?: string
  } = {},
) {
  const cap = Date.now() + SEND_TIMEOUT_MS
  return openWaRequest<OpenWaSendResult>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/messages/${endpoint}`,
    {
      body,
      timeoutMs: SEND_TIMEOUT_MS,
      deadline: opts.sendBy === undefined ? cap : Math.min(opts.sendBy, cap),
      idempotencyKey: opts.idempotencyKey,
    },
  ).then((r) => requireMessageId(r))
}

export interface OpenWaStoredMessage {
  id: string
  waMessageId?: string | null
  chatId: string
  body?: string | null
  direction: 'incoming' | 'outgoing' | string
  timestamp?: number | null
  createdAt?: string
}

export interface OpenWaChatSummary {
  id: string
  name: string
  isGroup: boolean
  kind?: string
  unreadCount: number
  timestamp: number
  lastMessage?: string
  lastMessageType?: string
  archived?: boolean
  pinned?: boolean
}

/** GET /sessions/:id/chats — most recent first, paginated. */
/**
 * The chat list. Right after pairing, whatsapp-web.js loads it from the
 * phone first: the first call can take 90 s or more (then pages are
 * fast), so the caller picks the timeout.
 */
export function listOpenWaChats(
  creds: OpenWaCredentials,
  sessionId: string,
  page: { limit: number; offset: number },
  opts: { timeoutMs?: number } = {},
) {
  return openWaRequest<OpenWaChatSummary[]>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/chats?limit=${page.limit}&offset=${page.offset}`,
    { timeoutMs: opts.timeoutMs ?? 60_000 },
  )
}

/**
 * GET /sessions/:id/messages/:chatId/history — read live from WhatsApp
 * (whatsapp-web.js; `deep` reaches up to 2000 messages, metadata only).
 * 501 on engines without it (Baileys). Oldest first.
 */
export function getOpenWaChatHistory(
  creds: OpenWaCredentials,
  sessionId: string,
  chatId: string,
  opts: { limit: number; deep: boolean },
) {
  return openWaRequest<Record<string, unknown>[]>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/messages/${enc(chatId)}/history?limit=${opts.limit}&deep=${opts.deep}`,
    { timeoutMs: 120_000 },
  )
}

/** GET /sessions/:id/messages — the gateway's stored history, newest first. */
export function listOpenWaMessages(
  creds: OpenWaCredentials,
  sessionId: string,
  query: { chatId: string; since?: number; limit?: number; offset?: number },
  opts: { deadline?: number } = {},
) {
  const params = new URLSearchParams({ chatId: query.chatId, limit: String(query.limit ?? 50) })
  if (query.since !== undefined) params.set('since', String(Math.floor(query.since)))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  return openWaRequest<{ messages: OpenWaStoredMessage[] }>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/messages?${params.toString()}`,
    { deadline: opts.deadline },
  )
}

export function openWaReact(
  creds: OpenWaCredentials,
  sessionId: string,
  body: { chatId: string; messageId: string; emoji: string },
) {
  return openWaRequest<{ success: boolean }>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/messages/react`,
    { body },
  )
}

export function openWaMarkRead(
  creds: OpenWaCredentials,
  sessionId: string,
  body: { chatId: string; messageIds?: string[] },
) {
  return openWaRequest<{ success: boolean }>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/chats/read`,
    { body },
  )
}

export function openWaTyping(
  creds: OpenWaCredentials,
  sessionId: string,
  body: { chatId: string; state: 'typing' | 'recording' | 'paused' },
) {
  return openWaRequest<{ success: boolean }>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/chats/typing`,
    { body },
  )
}

/** Raw media bytes OpenWA stored for an inbound message (404 if none). */
export async function downloadOpenWaMedia(
  creds: OpenWaCredentials,
  sessionId: string,
  chatId: string,
  messageId: string,
): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
  const res = await openWaRequest<Response>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/messages/${enc(chatId)}/${enc(messageId)}/media`,
    // The gateway may download it from WhatsApp first (≤ 60 s on its side).
    { raw: true, timeoutMs: 75_000 },
  )
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { bytes, mimeType: res.headers.get('content-type') }
}

/** GET /groups/:groupId — the group's subject (name). */
export function getOpenWaGroup(creds: OpenWaCredentials, sessionId: string, groupId: string) {
  return openWaRequest<{ id: string; name: string }>(creds, 'GET', `/sessions/${enc(sessionId)}/groups/${enc(groupId)}`)
}

export function getOpenWaContactPhone(
  creds: OpenWaCredentials,
  sessionId: string,
  contactId: string,
) {
  return openWaRequest<{ contactId: string; phone: string | null }>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/phone`,
  )
}

export function getOpenWaProfilePicture(
  creds: OpenWaCredentials,
  sessionId: string,
  contactId: string,
) {
  return openWaRequest<{ url: string | null }>(
    creds,
    'GET',
    `/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/profile-picture`,
  )
}
