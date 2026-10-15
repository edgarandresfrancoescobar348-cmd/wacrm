// ============================================================
// OpenWA REST client — the only code that talks HTTP to an OpenWA
// gateway (https://github.com/rmyndharis/OpenWA, API v0.25).
//
// The gateway URL is tenant input, so every request is SSRF-guarded:
// http/https only, no embedded credentials, and the host must resolve
// to public address space unless the operator allow-listed it in
// OPENWA_ALLOWED_HOSTS (self-hosters running OpenWA next to wacrm on
// 127.0.0.1 / a docker host). Redirects are never followed, so a public
// URL can't bounce the server onto an internal one.
//
// Responses are bare JSON (no envelope); errors are Nest's
// `{ message, error, statusCode, code? }`.
// ============================================================

import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

export const OPENWA_ALLOWED_HOSTS_ENV = 'OPENWA_ALLOWED_HOSTS'

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
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'OpenWaError'
    this.status = status
    this.code = code
  }
}

export function allowedOpenWaHosts(): string[] {
  return (process.env[OPENWA_ALLOWED_HOSTS_ENV] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
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

/** SSRF gate. Throws OpenWaError('url_not_allowed'). */
export async function assertOpenWaUrlAllowed(baseUrl: string): Promise<void> {
  const ok = await isDeliverableUrl(baseUrl, {
    allowPrivateHosts: allowedOpenWaHosts(),
  })
  if (!ok) {
    throw new OpenWaError(
      `OpenWA URL points at a private or unresolvable address. Self-hosters can allow it with ${OPENWA_ALLOWED_HOSTS_ENV}.`,
      400,
      'url_not_allowed',
    )
  }
}

interface RequestOptions {
  body?: unknown
  timeoutMs?: number
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
  await assertOpenWaUrlAllowed(base)

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
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
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
    throw new OpenWaError(message, response.status, code)
  }

  if (opts.raw) return response as unknown as T
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// ---- auth / health ------------------------------------------------

export interface OpenWaKeyInfo {
  valid: boolean
  role: string
  engineType: OpenWaEngine | string
  scoped: boolean
}

/** POST /auth/validate — 401 on a bad key. The "Testar conexão" probe. */
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
) {
  return openWaRequest<OpenWaSendResult>(
    creds,
    'POST',
    `/sessions/${enc(sessionId)}/messages/${endpoint}`,
    { body, timeoutMs: SEND_TIMEOUT_MS },
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
    { raw: true, timeoutMs: 60_000 },
  )
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { bytes, mimeType: res.headers.get('content-type') }
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
