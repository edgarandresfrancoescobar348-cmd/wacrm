// ============================================================
// QR-code history import (owner adjustment A1; migration 063).
//
// Imports every individual chat the linked device sees and its message
// history into contacts / conversations / messages:
//
//   1. listing   GET /sessions/:id/chats (paginated) → one checkpoint row
//                per individual chat (groups, channels, status and
//                broadcast lists are skipped).
//   2. importing per chat, most recent first:
//                GET …/messages/:chatId/history?deep=true&limit=2000
//                (whatsapp-web.js). On Baileys (501) the gateway's
//                stored messages instead — the job is flagged
//                `limited_history` and the settings page says so.
//
// Every message goes through the SAME mapping as message.received
// (mapOpenWaMessage, A2). Imported rows are stored complete and flagged
// `imported_at`: no bots, automations, flows, AI, public webhooks or
// notifications, no unread — the conversation takes the chat's
// unreadCount and its newest real message as preview / time, like the
// phone. Media is a lazy reference (the existing media proxy, F2 rules)
// fetched only when someone opens it.
//
// Resumable and idempotent: the per-chat rows are the checkpoint, the
// job holds a lease, messages are keyed (conversation_id, message_id)
// like every other path — a re-run or a webhook delivering the same
// message mid-import never duplicates it. Messages newer than the job
// start are left to the live webhooks. Pauses between chats and backs
// off on 409/429/503 to respect the engine's rate limits.
//
// Who runs it: the scheduler tick (/api/automations/cron — driven by
// scripts/wacrm.mjs in dev/start, the compose `scheduler`, Vercel Cron
// on serverless) and "Importar de novo". Connecting only queues it: the
// first chat listing after pairing can take 90 s+ while whatsapp-web.js
// loads the chats from the phone, which no webhook request should wait
// for. A listing that times out is "WhatsApp still loading", retried
// shortly; every run that stops leaves the job with its reason and
// next attempt (`last_error`, `next_run_at`) and a `[history import]`
// log line — never a silent stall.
//
// Gateway rate limit: OpenWA throttles per client IP (Nest
// ThrottlerModule; stock 10/s, 100/min, 1000/h — wacrm's runner and
// compose raise them for the embedded, internal-only gateway and pass
// the per-minute/per-hour limits on as OPENWA_RATE_LIMIT_PER_MIN/HOUR).
// The import paces every gateway call to a share of that budget, leaving
// the rest to live traffic, and on a 429 waits what `Retry-After*` says
// (every import call waits with it). A chat that hits a 429, a timeout
// or a gateway hiccup goes back to the queue — never a definitive error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { chunkForUrl } from '@/lib/supabase/paged-query'
import { previewFor, trailingAlbumCount } from '@/lib/whatsapp/message-content'
import type { MediaMeta } from '@/types'
import {
  findOrCreateContact,
  findOrCreateConversation,
} from '@/lib/whatsapp/inbound/ingest'
import {
  getOpenWaChatHistory,
  getOpenWaContactPhone,
  getOpenWaProfilePicture,
  listOpenWaChats,
  listOpenWaMessages,
  OpenWaError,
  type OpenWaChatSummary,
  type OpenWaCredentials,
  type OpenWaStoredMessage,
} from './client'
import {
  isContentlessPlaceholder,
  mapOpenWaMessage,
  openWaMediaProxyUrl,
  phoneFromChatId,
} from './events'
import { requireOpenWaGateway } from './gateway'
import { findOrCreateGroupConversation, groupMessageRow } from './groups'
import { forwardFlags, mediaMetaFor, statusFromAck } from './parity'
import { isWaiting, refreshPatch, type IncomingMessageRow, type StoredMessageState } from './import-refresh'
import { contactNamePatch, isUnofficialBusinessName, nameFromWhatsApp } from '@/lib/whatsapp/contact-name'
import type { ContentMeta } from '@/lib/whatsapp/message-content'
import type { OpenWaConnectionRow } from './connection'

/** Longer than any run (cron deadline 280 s + one in-flight call), short
 *  enough that a run whose process died is picked up again soon. */
export const HISTORY_LEASE_SECONDS = 360
/** The chat list's per-call timeout (bounded by the run's deadline). */
export const LIST_TIMEOUT_MS = 180_000
/** Below this much time left, don't start a list call — the next run does. */
const MIN_LIST_WINDOW_MS = 20_000
/** Retry delays: WhatsApp still loading the chats / session not ready / other errors. */
export const WARMING_RETRY_MS = 30_000
const SESSION_RETRY_MS = 2 * 60_000
const ERROR_RETRY_MS = 60_000
const CHATS_PAGE = 100
const HISTORY_LIMIT = 2000
const STORED_PAGE = 100
const INSERT_BATCH = 200
/** Pause between chats — the engine reads history from the phone. */
const CHAT_PAUSE_MS = 300
const RETRY_DELAYS_MS = [2_000, 5_000]
const MAX_CHAT_ATTEMPTS = 3
/** 429 retries in place before the run pauses until the gateway's Retry-After. */
const MAX_THROTTLE_RETRIES = 3
/** Wait after a 429 that names no Retry-After (×1, ×2, ×3). */
const THROTTLE_FALLBACK_MS = 5_000
/** Share of the gateway's rate limit the import may use (the rest is live traffic). */
const IMPORT_RATE_SHARE = 0.4

/** OpenWA's stock limits per client: 100/min and 1000/h (its .env.example). */
const GATEWAY_DEFAULT_PER_MIN = 100
const GATEWAY_DEFAULT_PER_HOUR = 1000

/**
 * Minimum gap between two import calls to the gateway: IMPORT_RATE_SHARE
 * of its per-minute and per-hour limits, whichever is tighter.
 */
export function importCallIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const perMin = Number(env.OPENWA_RATE_LIMIT_PER_MIN) || GATEWAY_DEFAULT_PER_MIN
  const perHour = Number(env.OPENWA_RATE_LIMIT_PER_HOUR) || GATEWAY_DEFAULT_PER_HOUR
  const callsPerMin = Math.max(1, Math.min(perMin, perHour / 60) * IMPORT_RATE_SHARE)
  return Math.ceil(60_000 / callsPerMin)
}

/** A gateway answer that is worth trying again later (not the chat's fault). */
function isTransient(err: unknown): boolean {
  return (
    err instanceof OpenWaError &&
    (err.status === 0 || err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504 ||
      (err.status === 409 && !/not connected|not ready/i.test(err.message)))
  )
}
/** How earlier runs recorded a transient failure on a chat (requeued on the next run). */
const TRANSIENT_CHAT_ERROR = /Too Many Requests|ThrottlerException|rate limit|did not answer within|timed? ?out|unreachable|ECONNRESET|socket hang up/i

export interface HistoryImportJob {
  account_id: string
  session_id: string
  status: 'queued' | 'listing' | 'importing' | 'waiting_session' | 'done' | 'failed'
  started_at: string
  limited_history: boolean
  chats_total: number
  chats_done: number
  chats_skipped: number
  messages_imported: number
  errors: number
}

interface ChatRow {
  account_id: string
  chat_id: string
  name: string | null
  unread_count: number
  chat_timestamp: number | null
  attempts: number
  /** The chat list's state (migration 067), applied to the conversation. */
  is_group?: boolean
  archived?: boolean
  pinned?: boolean
}

/** A message as OpenWA serves it from history (IncomingMessage shape). */
type HistoryMessage = Parameters<typeof mapOpenWaMessage>[0] & {
  quotedMessage?: { id?: string }
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

function log(accountId: string, message: string) {
  console.info(`[history import] ${accountId.slice(0, 8)}: ${message}`)
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19) + ' UTC'

/** The chat list didn't answer in time: WhatsApp is still loading it. */
class GatewayWarming extends Error {
  constructor(readonly waitedMs: number) {
    super(`WhatsApp is still loading the chat list (no answer in ${Math.round(waitedMs / 1000)} s)`)
  }
}

/** Not enough of the run's deadline left to start the next list call. */
class OutOfTime extends Error {}

/** The gateway keeps answering 429: pause the run until it allows calls again. */
class Throttled extends Error {
  constructor(readonly retryAt: number) {
    super('the WhatsApp gateway is rate-limiting the import (429 Too Many Requests)')
  }
}

/** One run's clock and limits, threaded through every gateway call. */
interface RunCtx {
  deadline: number
  now: () => number
  callIntervalMs: number
}

/**
 * When the next import call may go out. Module-wide on purpose: every
 * import running in this process shares the gateway's per-client budget,
 * and a 429 holds all of them back.
 */
let nextCallAt = 0

/** Test hook: forget the pacing state. */
export function __resetImportPacingForTests() {
  nextCallAt = 0
}

async function pace(ctx: RunCtx) {
  const t = ctx.now()
  const at = Math.max(t, nextCallAt)
  nextCallAt = at + ctx.callIntervalMs
  if (at > t) await sleepMs(at - t)
}

export class HistoryStoreError extends Error {
  constructor(step: string, cause?: { message?: string } | null) {
    super(`history import ${step} failed${cause?.message ? `: ${cause.message}` : ''}`)
    this.name = 'HistoryStoreError'
  }
}

/** Is this chat a one-to-one conversation? */
export function isIndividualChat(chat: Pick<OpenWaChatSummary, 'id' | 'isGroup' | 'kind'>): boolean {
  if (chat.isGroup) return false
  if (chat.kind && chat.kind !== 'individual') return false
  return /@(c\.us|s\.whatsapp\.net|lid)$/.test(chat.id) && chat.id !== 'status@broadcast'
}

/**
 * The chats the inbox mirrors, like the phone's list (phase 5e): one-to-one
 * chats and groups. Status, broadcast lists and channels stay out.
 */
export function isImportableChat(chat: Pick<OpenWaChatSummary, 'id' | 'isGroup' | 'kind'>): boolean {
  if (isIndividualChat(chat)) return true
  return chat.id.endsWith('@g.us') && (!chat.kind || chat.kind === 'group')
}

/** A stored-message row (Baileys fallback) in the history shape. */
export function storedToHistory(m: OpenWaStoredMessage & {
  type?: string
  mediaMimetype?: string | null
  from?: string
  to?: string
}): HistoryMessage {
  return {
    id: m.waMessageId ?? m.id,
    chatId: m.chatId,
    from: m.from,
    to: m.to,
    body: m.body ?? '',
    type: m.type ?? 'text',
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : m.createdAt ? Math.floor(Date.parse(m.createdAt) / 1000) : undefined,
    fromMe: m.direction === 'outgoing',
    isGroup: false,
    kind: 'individual',
    ...(m.mediaMimetype ? { media: { mimetype: m.mediaMimetype, omitted: true } } : {}),
  }
}

/**
 * Start (or restart) the import for an account. A restart re-checks
 * every chat; messages already imported are skipped by their key.
 */
export async function startHistoryImport(
  admin: SupabaseClient,
  accountId: string,
  sessionId: string,
): Promise<void> {
  const { error } = await admin.from('whatsapp_history_imports').upsert(
    {
      account_id: accountId,
      session_id: sessionId,
      status: 'queued',
      started_at: new Date().toISOString(),
      finished_at: null,
      next_run_at: new Date().toISOString(),
      lease_until: null,
      chats_total: 0,
      chats_done: 0,
      chats_skipped: 0,
      messages_imported: 0,
      errors: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id' },
  )
  if (error) throw new HistoryStoreError('start', error)
  const { error: resetErr } = await admin
    .from('whatsapp_history_import_chats')
    .update({ status: 'pending', attempts: 0, error: null, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
  if (resetErr) throw new HistoryStoreError('start (reset chats)', resetErr)
}

/** Queue the import once per session (the first time QR mode connects). */
export async function queueHistoryImportOnConnect(
  admin: SupabaseClient,
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('whatsapp_history_imports')
    .select('session_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new HistoryStoreError('lookup', error)
  if (data && data.session_id === sessionId) return false
  await startHistoryImport(admin, accountId, sessionId)
  return true
}

/** A paced gateway call: waits its turn, backs off on 429, retries brief hiccups. */
async function withRetry<T>(work: () => Promise<T>, ctx: RunCtx): Promise<T> {
  let throttled = 0
  for (let i = 0; ; i++) {
    await pace(ctx)
    try {
      return await work()
    } catch (err) {
      if (err instanceof OpenWaError && err.status === 429) {
        throttled++
        const wait = Math.min(
          Math.max(err.retryAfterMs ?? THROTTLE_FALLBACK_MS * throttled, 1_000),
          60 * 60_000,
        )
        // Every import call in this process waits with it.
        nextCallAt = Math.max(nextCallAt, ctx.now() + wait)
        if (throttled > MAX_THROTTLE_RETRIES || ctx.now() + wait > ctx.deadline - 5_000) {
          throw new Throttled(ctx.now() + wait)
        }
        continue
      }
      // A timeout is not retried in place: the call already waited its
      // whole window (the chat list handles it as "still loading", a
      // chat goes back to the queue).
      const retryable = isTransient(err) && (err as OpenWaError).code !== 'timeout'
      if (!retryable || i >= RETRY_DELAYS_MS.length) throw err
      await sleepMs(RETRY_DELAYS_MS[i])
    }
  }
}

function sessionNotReady(err: unknown): boolean {
  return err instanceof OpenWaError && (err.status === 409 || err.status === 400) && /not connected|not ready|not active/i.test(err.message)
}

async function updateJob(admin: SupabaseClient, accountId: string, patch: Record<string, unknown>) {
  const { error } = await admin
    .from('whatsapp_history_imports')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
  if (error) throw new HistoryStoreError('job update', error)
}

/** Phase 1: the chat list → checkpoint rows. */
async function listChats(
  admin: SupabaseClient,
  job: HistoryImportJob,
  creds: OpenWaCredentials,
  opts: RunCtx & { listTimeoutMs: number },
): Promise<number> {
  let offset = 0
  let total = 0
  for (;;) {
    // The first page after pairing can take minutes; never past the deadline.
    const window = Math.min(opts.listTimeoutMs, opts.deadline - opts.now() - 5_000)
    if (window < Math.min(MIN_LIST_WINDOW_MS, opts.listTimeoutMs)) throw new OutOfTime()
    let page: OpenWaChatSummary[]
    try {
      page = await withRetry(
        () => listOpenWaChats(creds, job.session_id, { limit: CHATS_PAGE, offset }, { timeoutMs: window }),
        opts,
      )
    } catch (err) {
      if (err instanceof OpenWaError && err.code === 'timeout') throw new GatewayWarming(window)
      throw err
    }
    const individual = (page ?? []).filter(isImportableChat)
    if (individual.length) {
      const { error } = await admin.from('whatsapp_history_import_chats').upsert(
        individual.map((c) => ({
          account_id: job.account_id,
          chat_id: c.id,
          name: c.name || null,
          unread_count: c.unreadCount ?? 0,
          chat_timestamp: c.timestamp ?? null,
          is_group: c.id.endsWith('@g.us'),
          archived: Boolean(c.archived),
          pinned: Boolean(c.pinned),
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'account_id,chat_id' },
      )
      if (error) throw new HistoryStoreError('chat list', error)
      total += individual.length
    }
    if (!page || page.length < CHATS_PAGE) break
    offset += CHATS_PAGE
  }
  return total
}

/** The messages of one chat, from history (or the stored fallback). */
async function chatMessages(
  admin: SupabaseClient,
  job: HistoryImportJob,
  creds: OpenWaCredentials,
  chatId: string,
  ctx: RunCtx,
): Promise<HistoryMessage[]> {
  if (!job.limited_history) {
    try {
      const rows = await withRetry(
        () => getOpenWaChatHistory(creds, job.session_id, chatId, { limit: HISTORY_LIMIT, deep: true }),
        ctx,
      )
      return (rows ?? []) as HistoryMessage[]
    } catch (err) {
      if (!(err instanceof OpenWaError && err.status === 501)) throw err
      // Baileys: no live history. Only what the gateway stored.
      job.limited_history = true
      await updateJob(admin, job.account_id, { limited_history: true })
    }
  }
  const out: HistoryMessage[] = []
  for (let offset = 0; offset < HISTORY_LIMIT; offset += STORED_PAGE) {
    const { messages } = await withRetry(
      () => listOpenWaMessages(creds, job.session_id, { chatId, limit: STORED_PAGE, offset }),
      ctx,
    )
    out.push(...(messages ?? []).map((m) => storedToHistory(m)))
    if (!messages || messages.length < STORED_PAGE) break
  }
  return out
}

/** Why a chat imported nothing (its checkpoint row says so). */
export const SKIP_NO_PHONE = 'no phone number for this chat'
export const SKIP_NO_MESSAGES = 'no messages to import'

/**
 * Import one chat. Returns the number of messages inserted, or the
 * reason it was skipped. Every chat the phone lists becomes a conversation
 * (phase 5f, replacing 5c's "no messages, no conversation"): placed by
 * WhatsApp's chat timestamp, with the phone's unread count, even when its
 * history holds only WhatsApp's "waiting for this message" placeholders —
 * stored as that bubble and replaced when the real message arrives — or
 * nothing at all. Messages already stored are refreshed (import-refresh.ts).
 */
async function importChat(
  admin: SupabaseClient,
  job: HistoryImportJob,
  row: OpenWaConnectionRow,
  creds: OpenWaCredentials,
  chat: ChatRow,
  ctx: RunCtx,
): Promise<number | { skipped: string }> {
  // A group (phase 5e): listed like on the phone, but not a CRM contact.
  const isGroup = Boolean(chat.is_group) || chat.chat_id.endsWith('@g.us')
  const phone = isGroup
    ? null
    : (phoneFromChatId(chat.chat_id) ??
      (chat.chat_id.endsWith('@lid')
        ? await withRetry(() => getOpenWaContactPhone(creds, job.session_id, chat.chat_id), ctx).then((r) =>
            r.phone ? normalizePhone(r.phone) || null : null,
          )
        : null))
  if (!isGroup && !phone) return { skipped: SKIP_NO_PHONE }

  const startedAtSec = Math.floor(Date.parse(job.started_at) / 1000)
  const history = (await chatMessages(admin, job, creds, chat.chat_id, ctx)).filter(
    (m) =>
      m.id &&
      // Newer than the job: the live webhooks own it.
      (typeof m.timestamp !== 'number' || m.timestamp < startedAtSec),
  )

  let conversationId: string
  let conversationCreated: boolean
  if (isGroup) {
    await pace(ctx)
    const group = await findOrCreateGroupConversation(admin, {
      accountId: job.account_id,
      userId: row.user_id,
      chatId: chat.chat_id,
      name: chat.name,
      creds,
      sessionId: job.session_id,
    })
    conversationId = group.id
    conversationCreated = !group.last_message_at
  } else {
    // The name the phone shows (contact-name.ts): the chat list's title is
    // the address-book name when the contact is saved; the contact's own
    // messages carry the verified and push names.
    const incoming = history.find((m) => !m.fromMe && m.contact)?.contact
    const best = nameFromWhatsApp({
      chatTitle: chat.name,
      savedName: incoming?.name,
      isMyContact: incoming?.isMyContact,
      verifiedName: incoming?.verifiedName,
      verifiedLevel: incoming?.verifiedLevel,
      isEnterprise: incoming?.isEnterprise,
      pushName: incoming?.pushName,
    })
    const contactOutcome = await findOrCreateContact(job.account_id, row.user_id, {
      phone: phone!,
      name: best?.name ?? '',
      ...(best ? { nameSource: best.source } : {}),
      pushName: incoming?.pushName ?? null,
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
    })
    if (!contactOutcome) throw new HistoryStoreError('contact')
    // A business name an earlier import made the title, of an account that
    // isn't official: back to the profile name it is (contact-name.ts).
    if (!contactOutcome.wasCreated && incoming && isUnofficialBusinessName(incoming)) {
      const demote = contactNamePatch(contactOutcome.contact, null, undefined, { unofficialBusiness: true })
      if (demote) {
        const { error } = await admin.from('contacts').update(demote).eq('id', contactOutcome.contact.id).eq('account_id', job.account_id)
        if (error) throw new HistoryStoreError('contact name', error)
      }
    }
    if (contactOutcome.wasCreated) {
      try {
        await pace(ctx)
        const pic = await getOpenWaProfilePicture(creds, job.session_id, chat.chat_id)
        if (pic.url) {
          await admin.from('contacts').update({ avatar_url: pic.url }).eq('id', contactOutcome.contact.id).eq('account_id', job.account_id)
        }
      } catch (err) {
        // Cosmetic — but a 429 still holds the next calls back.
        if (err instanceof OpenWaError && err.status === 429) {
          nextCallAt = Math.max(nextCallAt, ctx.now() + (err.retryAfterMs ?? THROTTLE_FALLBACK_MS))
        }
      }
    }
    const conv = await findOrCreateConversation(job.account_id, row.user_id, contactOutcome.contact.id)
    if (!conv) throw new HistoryStoreError('conversation')
    conversationId = conv.conversation.id as string
    conversationCreated = conv.created
  }
  // The phone's state of the chat: its id, archived, pinned (the
  // chat-state sync keeps them current afterwards).
  await applyChatState(admin, job.account_id, conversationId, chat)

  const now = new Date().toISOString()
  const rows = history.map((m) => {
    const row = messageRowFor(m)
    // WhatsApp listed it but hasn't delivered its content here yet: the
    // phone's "Aguardando mensagem" bubble until the real one arrives. Same
    // columns as every other row (a mixed batch would NULL the missing ones).
    if (!isContentlessPlaceholder(m)) return row
    return {
      ...row,
      content_type: 'text',
      content_text: null,
      content_meta: { kind: 'waiting' } as ContentMeta,
      media_url: null,
      media_type: null,
      revoked_at: null,
      media_meta: null,
    }
  })
  function messageRowFor(m: HistoryMessage) {
    const at = typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : now
    if (isGroup) {
      return {
        ...(groupMessageRow(m, conversationId, chat.chat_id, at) as MessageRow),
        imported_at: now,
        ingest_completed_at: now,
      }
    }
    const mapped = mapOpenWaMessage(m)
    return {
      conversation_id: conversationId,
      sender_type: m.fromMe ? 'agent' : 'customer',
      content_type: mapped.contentType,
      content_text: mapped.contentText,
      content_meta: mapped.meta,
      media_url: mapped.hasMedia ? openWaMediaProxyUrl(chat.chat_id, m.id!) : null,
      media_type: mapped.hasMedia ? (m.media?.mimetype ?? null) : null,
      message_id: m.id!,
      // The ticks the phone shows (WhatsApp's ack), not a flat "sent".
      status: m.fromMe ? statusFromAck(m.ack) : 'delivered',
      created_at: at,
      revoked_at: mapped.revoked ? at : null,
      ...forwardFlags(m),
      media_meta: mediaMetaFor(m),
      sender_name: null as string | null,
      imported_at: now,
      ingest_completed_at: now,
    }
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH)
    const { data, error } = await admin
      .from('messages')
      .upsert(batch, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
      .select('id, message_id')
    if (error) throw new HistoryStoreError('messages', error)
    inserted += data?.length ?? 0
    // Already stored (a re-import): WhatsApp's newer view of them.
    const fresh = new Set((data ?? []).map((r: { message_id: string }) => r.message_id))
    const stale = batch.filter((r) => !fresh.has(r.message_id))
    if (stale.length) await refreshStoredMessages(admin, conversationId, stale)
  }

  // Quotes: link replies to the quoted message when it is in the chat.
  const quoted = history.filter((m) => m.quotedMessage?.id)
  if (quoted.length) {
    const ids = [...new Set(quoted.map((m) => m.quotedMessage!.id!))]
    const byProvider = new Map<string, string>()
    // Sliced: a long chat quotes hundreds of messages, and the filter is in the URL.
    for (const slice of chunkForUrl(ids)) {
      const { data: targets } = await admin
        .from('messages')
        .select('id, message_id')
        .eq('conversation_id', conversationId)
        .in('message_id', slice)
      for (const t of (targets ?? []) as { id: string; message_id: string }[]) byProvider.set(t.message_id, t.id)
    }
    for (const m of quoted) {
      const target = byProvider.get(m.quotedMessage!.id!)
      if (!target) continue
      await admin
        .from('messages')
        .update({ reply_to_message_id: target })
        .eq('conversation_id', conversationId)
        .eq('message_id', m.id!)
        .is('reply_to_message_id', null)
    }
  }

  // The conversation shows its newest REAL message, like the phone, and
  // the chat's unread count (imported messages never count as unread).
  const real = rows.filter((r) => !isWaiting(r.content_meta))
  const newest = real.reduce<(typeof rows)[number] | null>(
    (a, b) => (!a || b.created_at > a.created_at ? b : a),
    null,
  )
  const { data: current } = await admin
    .from('conversations')
    .select('last_message_at, last_message_text')
    .eq('id', conversationId)
    .maybeSingle()
  const currentAt = (current as { last_message_at?: string | null } | null)?.last_message_at
  // Empty: only placeholders (or nothing) so far — the first real message takes the preview.
  const currentEmpty = !(current as { last_message_text?: string | null } | null)?.last_message_text
  // Placed where WhatsApp places the chat (its chat timestamp, migration 069).
  const chatAt = chat.chat_timestamp ? new Date(chat.chat_timestamp * 1000).toISOString() : null
  if (chatAt) {
    const { error } = await admin
      .from('conversations')
      .update({ wa_sort_at: chatAt })
      .eq('id', conversationId)
      .eq('account_id', job.account_id)
    if (error) throw new HistoryStoreError('conversation position', error)
  }
  if (!newest && (!currentAt || (currentEmpty && !chatAt))) {
    // Nothing WhatsApp delivered here yet: an empty preview at the chat's
    // time with the phone's unread count — never "Nenhuma mensagem ainda".
    // A chat with no time on the phone (timestamp 0: a group nobody wrote
    // in) gets none here either — never the import's time, which put it on
    // top — so it sits below every chat with activity, like on the phone.
    // A re-import takes that time back from rows an earlier import gave it.
    const { error } = await admin
      .from('conversations')
      .update({ last_message_text: '', last_message_at: chatAt, unread_count: chat.unread_count })
      .eq('id', conversationId)
      .eq('account_id', job.account_id)
    if (error) throw new HistoryStoreError('conversation summary', error)
  }
  if (newest) {
    // `<=`: a re-import refreshes the preview of the same newest message
    // (its voice length, its pages).
    if (!currentAt || Date.parse(currentAt) <= Date.parse(newest.created_at) || currentEmpty) {
      const { error } = await admin
        .from('conversations')
        .update({
          last_message_text: previewFor(newest.content_type, newest.content_meta, newest.content_text, {
            durationSeconds: (newest as { media_meta?: MediaMeta | null }).media_meta?.durationSeconds,
            pageCount: (newest as { media_meta?: MediaMeta | null }).media_meta?.pageCount,
            revoked: Boolean(newest.revoked_at),
            albumCount: trailingAlbumCount([...rows].sort((x, y) => (x.created_at < y.created_at ? 1 : -1))),
          }),
          // Never earlier than where the chat already sits (its chat time).
          last_message_at:
            currentAt && Date.parse(currentAt) > Date.parse(newest.created_at) ? currentAt : newest.created_at,
          ...(isGroup ? { last_message_sender: newest.sender_name ?? null } : {}),
          ...(conversationCreated || !currentAt ? { unread_count: chat.unread_count } : {}),
        })
        .eq('id', conversationId)
        .eq('account_id', job.account_id)
      if (error) throw new HistoryStoreError('conversation summary', error)
    }
  }

  const { error: chatErr } = await admin
    .from('whatsapp_history_import_chats')
    .update({
      status: 'done',
      messages_imported: inserted,
      conversation_id: conversationId,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', job.account_id)
    .eq('chat_id', chat.chat_id)
  if (chatErr) throw new HistoryStoreError('chat checkpoint', chatErr)
  return inserted
}

/**
 * Messages a re-import found already stored: their ticks go up, parity
 * details are filled and a waiting placeholder becomes the real message
 * (refreshPatch). Text edited or deleted here is never touched.
 */
async function refreshStoredMessages(
  admin: SupabaseClient,
  conversationId: string,
  rows: (IncomingMessageRow & { message_id: string })[],
): Promise<void> {
  // Sliced by URL length: the ids go in the query string, and a batch of
  // WhatsApp ids (50–100 characters each) overflows it — "URI too long".
  const byId = new Map<string, StoredMessageState & { message_id: string }>()
  for (const slice of chunkForUrl(rows.map((r) => r.message_id))) {
    const { data, error } = await admin
      .from('messages')
      .select('id, message_id, sender_type, status, content_meta, is_forwarded, forwarding_score, media_meta, revoked_at')
      .eq('conversation_id', conversationId)
      .in('message_id', slice)
    if (error) throw new HistoryStoreError('messages (refresh lookup)', error)
    for (const m of (data ?? []) as (StoredMessageState & { message_id: string })[]) byId.set(m.message_id, m)
  }
  for (const row of rows) {
    const existing = byId.get(row.message_id)
    const patch = existing ? refreshPatch(existing, row) : null
    if (!patch) continue
    const { error: upErr } = await admin.from('messages').update(patch).eq('id', existing!.id)
    if (upErr) throw new HistoryStoreError('messages (refresh)', upErr)
  }
}

type MessageRow = {
  conversation_id: string
  sender_type: string
  content_type: string
  content_text: string | null
  content_meta: ContentMeta | null
  media_url: string | null
  media_type: string | null
  message_id: string
  status: string
  created_at: string
  revoked_at: string | null
  sender_name: string | null
}

/**
 * The phone's state of a chat on its conversation: the chat id, archived,
 * pinned (pinned_at kept while pinned, so the order among pinned chats is
 * stable). Shared with the chat-state sync (chat-state.ts).
 */
export async function applyChatState(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string,
  chat: { chat_id: string; archived?: boolean; pinned?: boolean },
): Promise<void> {
  const { data: current } = await admin
    .from('conversations')
    .select('wa_chat_id, archived, pinned_at')
    .eq('id', conversationId)
    .maybeSingle()
  const c = current as { wa_chat_id: string | null; archived: boolean; pinned_at: string | null } | null
  const patch: Record<string, unknown> = {}
  if (!c?.wa_chat_id) patch.wa_chat_id = chat.chat_id
  if (Boolean(chat.archived) !== Boolean(c?.archived)) patch.archived = Boolean(chat.archived)
  if (chat.pinned && !c?.pinned_at) patch.pinned_at = new Date().toISOString()
  if (!chat.pinned && c?.pinned_at) patch.pinned_at = null
  if (!Object.keys(patch).length) return
  const { error } = await admin.from('conversations').update(patch).eq('id', conversationId).eq('account_id', accountId)
  // The chat id can belong to another row already (a duplicate contact): keep the rest.
  if (error && error.code === '23505' && 'wa_chat_id' in patch) {
    delete patch.wa_chat_id
    if (Object.keys(patch).length) await admin.from('conversations').update(patch).eq('id', conversationId)
  } else if (error) {
    throw new HistoryStoreError('chat state', error)
  }
}

/** Put chats that failed for a transient reason back in the queue. */
async function requeueTransientFailures(admin: SupabaseClient, job: HistoryImportJob): Promise<number> {
  const { data, error } = await admin
    .from('whatsapp_history_import_chats')
    .select('chat_id, error')
    .eq('account_id', job.account_id)
    .eq('status', 'failed')
  if (error) throw new HistoryStoreError('failed chats', error)
  const ids = ((data ?? []) as { chat_id: string; error: string | null }[])
    .filter((c) => c.error && TRANSIENT_CHAT_ERROR.test(c.error))
    .map((c) => c.chat_id)
  if (!ids.length) return 0
  for (const slice of chunkForUrl(ids)) {
    const { error: upErr } = await admin
      .from('whatsapp_history_import_chats')
      .update({ status: 'pending', attempts: 0, error: null, updated_at: new Date().toISOString() })
      .eq('account_id', job.account_id)
      .in('chat_id', slice)
    if (upErr) throw new HistoryStoreError('requeue', upErr)
  }
  // They were counted as errors when they failed; they aren't.
  const { count: failed, error: countErr } = await admin
    .from('whatsapp_history_import_chats')
    .select('chat_id', { count: 'exact', head: true })
    .eq('account_id', job.account_id)
    .eq('status', 'failed')
  if (countErr) throw new HistoryStoreError('failed count', countErr)
  job.errors = failed ?? 0
  await updateJob(admin, job.account_id, {
    errors: job.errors,
    ...(job.errors === 0 ? { last_error: null } : {}),
  })
  return ids.length
}

/**
 * Run due import jobs until `deadline` (epoch ms). Called by the
 * settings route right after a start, after a QR connect, and by the
 * existing cron (safety net and continuation).
 */
export async function runHistoryImport(
  admin: SupabaseClient,
  opts: {
    accountId?: string
    deadline: number
    now?: () => number
    pauseMs?: number
    listTimeoutMs?: number
    /** Gap between gateway calls (default: importCallIntervalMs()). */
    callIntervalMs?: number
  },
): Promise<HistoryImportJob | null> {
  const now = opts.now ?? Date.now
  const runStarted = now()
  const ctx: RunCtx = { deadline: opts.deadline, now, callIntervalMs: opts.callIntervalMs ?? importCallIntervalMs() }
  const { data, error } = await admin.rpc('claim_history_import', {
    p_account_id: opts.accountId ?? null,
    p_lease_seconds: HISTORY_LEASE_SECONDS,
  })
  if (error) throw new HistoryStoreError('claim', error)
  const job = (Array.isArray(data) ? data[0] : data) as HistoryImportJob | undefined
  if (!job) return null

  const { data: rowData, error: rowErr } = await admin
    .from('whatsapp_openwa_config')
    .select('*')
    .eq('account_id', job.account_id)
    .maybeSingle()
  if (rowErr) throw new HistoryStoreError('connection', rowErr)
  const row = rowData as OpenWaConnectionRow | null
  if (!row?.session_id || row.session_id !== job.session_id) {
    await updateJob(admin, job.account_id, { status: 'failed', last_error: 'The QR-code session changed; start the import again', lease_until: null })
    log(job.account_id, 'stopped: the QR-code session changed')
    return { ...job, status: 'failed' }
  }
  log(
    job.account_id,
    `run (${job.status}, ${job.chats_done + job.chats_skipped}/${job.chats_total} chats, ${job.messages_imported} messages, ` +
      `1 gateway call / ${ctx.callIntervalMs} ms)`,
  )
  // Chats sent back to the queue during THIS run (transient failure):
  // the next run retries them, this one moves on.
  const deferred = new Set<string>()

  try {
    const creds = requireOpenWaGateway()
    // Chats an earlier run gave up on for a transient reason (429, timeout)
    // go back to the queue: not the chat's fault, never a definitive error.
    const requeued = await requeueTransientFailures(admin, job)
    if (requeued) log(job.account_id, `${requeued} chats that failed on a 429/timeout are back in the queue`)
    if (job.status === 'queued' || job.status === 'listing' || job.status === 'waiting_session') {
      await updateJob(admin, job.account_id, { status: 'listing' })
      job.status = 'listing'
      const listStarted = now()
      const total = await listChats(admin, job, creds, { ...ctx, listTimeoutMs: opts.listTimeoutMs ?? LIST_TIMEOUT_MS })
      job.status = 'importing'
      job.chats_total = total
      await updateJob(admin, job.account_id, { status: 'importing', chats_total: total, last_error: null })
      log(job.account_id, `listed ${total} chats (one-to-one and groups) in ${((now() - listStarted) / 1000).toFixed(1)} s`)
    }

    while (now() < opts.deadline) {
      const { data: next, error: nextErr } = await admin
        .from('whatsapp_history_import_chats')
        .select('account_id, chat_id, name, unread_count, chat_timestamp, attempts, is_group, archived, pinned')
        .eq('account_id', job.account_id)
        .eq('status', 'pending')
        .order('chat_timestamp', { ascending: false })
        .limit(deferred.size + 1)
      if (nextErr) throw new HistoryStoreError('next chat', nextErr)
      const chat = ((next ?? []) as ChatRow[]).find((c) => !deferred.has(c.chat_id))
      if (!chat && deferred.size) {
        // Only chats that just failed transiently are left: retry shortly.
        const retryAt = now() + WARMING_RETRY_MS
        await updateJob(admin, job.account_id, { lease_until: null, next_run_at: new Date(retryAt).toISOString() })
        log(job.account_id, `${deferred.size} chats back in the queue (gateway busy or slow); next attempt at ${clock(retryAt)}`)
        return job
      }
      if (!chat) {
        // The final count: chats that are still failed now (a chat that
        // failed and was requeued and imported is not an error), and no
        // stale reason on the card when there are none.
        const { count: failed, error: countErr } = await admin
          .from('whatsapp_history_import_chats')
          .select('chat_id', { count: 'exact', head: true })
          .eq('account_id', job.account_id)
          .eq('status', 'failed')
        if (countErr) throw new HistoryStoreError('failed count', countErr)
        job.errors = failed ?? 0
        await updateJob(admin, job.account_id, {
          status: 'done',
          finished_at: new Date().toISOString(),
          lease_until: null,
          errors: job.errors,
          ...(job.errors === 0 ? { last_error: null } : {}),
        })
        log(
          job.account_id,
          `done: ${job.chats_done} chats, ${job.messages_imported} messages, ${job.chats_skipped} skipped, ${job.errors} errors`,
        )
        return { ...job, status: 'done' }
      }
      try {
        const n = await importChat(admin, job, row, creds, chat, ctx)
        if (typeof n !== 'number') {
          job.chats_skipped++
          await admin.from('whatsapp_history_import_chats')
            .update({ status: 'skipped', error: n.skipped, updated_at: new Date().toISOString() })
            .eq('account_id', job.account_id).eq('chat_id', chat.chat_id)
        } else {
          job.chats_done++
          job.messages_imported += n
        }
      } catch (err) {
        if (sessionNotReady(err)) throw err
        if (err instanceof HistoryStoreError) throw err
        // Rate limit: the whole run pauses; this chat stays queued as it was.
        if (err instanceof Throttled) throw err
        if (isTransient(err)) {
          // Timeout / gateway hiccup: back to the queue, not an error.
          deferred.add(chat.chat_id)
          const message = err instanceof Error ? err.message : String(err)
          await admin.from('whatsapp_history_import_chats')
            .update({ status: 'pending', error: `retrying: ${message}`.slice(0, 300), updated_at: new Date().toISOString() })
            .eq('account_id', job.account_id).eq('chat_id', chat.chat_id)
          continue
        }
        // `errors` counts chats that failed for good, not attempts.
        const gaveUp = chat.attempts + 1 >= MAX_CHAT_ATTEMPTS
        if (gaveUp) job.errors++
        const message = err instanceof Error ? err.message : String(err)
        await admin.from('whatsapp_history_import_chats')
          .update({
            status: gaveUp ? 'failed' : 'pending',
            attempts: chat.attempts + 1,
            error: message.slice(0, 300),
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', job.account_id).eq('chat_id', chat.chat_id)
        await updateJob(admin, job.account_id, { errors: job.errors, last_error: message.slice(0, 300) })
      }
      await updateJob(admin, job.account_id, {
        chats_done: job.chats_done,
        chats_skipped: job.chats_skipped,
        messages_imported: job.messages_imported,
      })
      await sleepMs(opts.pauseMs ?? CHAT_PAUSE_MS)
    }
    // Out of time: the next tick continues from the checkpoint.
    await updateJob(admin, job.account_id, { lease_until: null, next_run_at: new Date().toISOString() })
    log(
      job.account_id,
      `paused after ${((now() - runStarted) / 1000).toFixed(0)} s: ${job.chats_done + job.chats_skipped}/${job.chats_total} chats, ${job.messages_imported} messages; the next tick continues`,
    )
    return job
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof Throttled) {
      await updateJob(admin, job.account_id, {
        last_error: err.message,
        lease_until: null,
        next_run_at: new Date(err.retryAt).toISOString(),
      }).catch((updateErr) =>
        console.error('[history import] could not record the stop:', updateErr instanceof Error ? updateErr.message : updateErr),
      )
      log(
        job.account_id,
        `gateway rate limit (429): paused at ${job.chats_done + job.chats_skipped}/${job.chats_total} chats; resuming at ${clock(err.retryAt)}`,
      )
      return job
    }
    if (err instanceof OutOfTime) {
      await updateJob(admin, job.account_id, { lease_until: null, next_run_at: new Date().toISOString() })
      log(job.account_id, 'paused before the chat list (run deadline); the next tick continues')
      return job
    }
    const waiting = err instanceof GatewayWarming || sessionNotReady(err)
    const retryAt = now() + (err instanceof GatewayWarming ? WARMING_RETRY_MS : waiting ? SESSION_RETRY_MS : ERROR_RETRY_MS)
    await updateJob(admin, job.account_id, {
      ...(waiting ? { status: 'waiting_session' } : {}),
      last_error: message.slice(0, 300),
      lease_until: null,
      next_run_at: new Date(retryAt).toISOString(),
    }).catch((updateErr) =>
      // The lease still expires (HISTORY_LEASE_SECONDS) and the next tick reclaims it.
      console.error('[history import] could not record the stop:', updateErr instanceof Error ? updateErr.message : updateErr),
    )
    log(job.account_id, `${waiting ? 'waiting' : 'error'}: ${message.slice(0, 200)} — next attempt at ${clock(retryAt)}`)
    return { ...job, status: waiting ? 'waiting_session' : job.status }
  }
}
