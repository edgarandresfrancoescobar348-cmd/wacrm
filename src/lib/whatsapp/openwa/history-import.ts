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
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { previewFor } from '@/lib/whatsapp/message-content'
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
import type { OpenWaConnectionRow } from './connection'

export const HISTORY_LEASE_SECONDS = 600
const CHATS_PAGE = 100
const HISTORY_LIMIT = 2000
const STORED_PAGE = 100
const INSERT_BATCH = 200
/** Pause between chats — the engine reads history from the phone. */
const CHAT_PAUSE_MS = 300
const RETRY_DELAYS_MS = [2_000, 5_000]
const MAX_CHAT_ATTEMPTS = 3

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
}

/** A message as OpenWA serves it from history (IncomingMessage shape). */
type HistoryMessage = Parameters<typeof mapOpenWaMessage>[0] & {
  quotedMessage?: { id?: string }
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await work()
    } catch (err) {
      const transient =
        err instanceof OpenWaError && (err.status === 429 || err.status === 503 || err.status === 0 || (err.status === 409 && !/not connected|not ready/i.test(err.message)))
      if (!transient || i >= RETRY_DELAYS_MS.length) throw err
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
async function listChats(admin: SupabaseClient, job: HistoryImportJob, creds: OpenWaCredentials): Promise<number> {
  let offset = 0
  let total = 0
  for (;;) {
    const page = await withRetry(() => listOpenWaChats(creds, job.session_id, { limit: CHATS_PAGE, offset }))
    const individual = (page ?? []).filter(isIndividualChat)
    if (individual.length) {
      const { error } = await admin.from('whatsapp_history_import_chats').upsert(
        individual.map((c) => ({
          account_id: job.account_id,
          chat_id: c.id,
          name: c.name || null,
          unread_count: c.unreadCount ?? 0,
          chat_timestamp: c.timestamp ?? null,
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
): Promise<HistoryMessage[]> {
  if (!job.limited_history) {
    try {
      const rows = await withRetry(() =>
        getOpenWaChatHistory(creds, job.session_id, chatId, { limit: HISTORY_LIMIT, deep: true }),
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
    const { messages } = await withRetry(() =>
      listOpenWaMessages(creds, job.session_id, { chatId, limit: STORED_PAGE, offset }),
    )
    out.push(...(messages ?? []).map((m) => storedToHistory(m)))
    if (!messages || messages.length < STORED_PAGE) break
  }
  return out
}

/** Import one chat. Returns the number of messages inserted, or null if skipped. */
async function importChat(
  admin: SupabaseClient,
  job: HistoryImportJob,
  row: OpenWaConnectionRow,
  creds: OpenWaCredentials,
  chat: ChatRow,
): Promise<number | null> {
  const phone =
    phoneFromChatId(chat.chat_id) ??
    (chat.chat_id.endsWith('@lid')
      ? await withRetry(() => getOpenWaContactPhone(creds, job.session_id, chat.chat_id)).then((r) =>
          r.phone ? normalizePhone(r.phone) || null : null,
        )
      : null)
  if (!phone) return null

  const name = chat.name && !/^\+?[\d\s()-]+$/.test(chat.name) ? chat.name : ''
  const contactOutcome = await findOrCreateContact(job.account_id, row.user_id, {
    phone,
    name,
    waUserId: null,
    waParentUserId: null,
    waUsername: null,
  })
  if (!contactOutcome) throw new HistoryStoreError('contact')
  if (contactOutcome.wasCreated) {
    try {
      const pic = await getOpenWaProfilePicture(creds, job.session_id, chat.chat_id)
      if (pic.url) {
        await admin.from('contacts').update({ avatar_url: pic.url }).eq('id', contactOutcome.contact.id).eq('account_id', job.account_id)
      }
    } catch {
      // Cosmetic.
    }
  }
  const conv = await findOrCreateConversation(job.account_id, row.user_id, contactOutcome.contact.id)
  if (!conv) throw new HistoryStoreError('conversation')
  const conversationId = conv.conversation.id as string

  const startedAtSec = Math.floor(Date.parse(job.started_at) / 1000)
  const history = (await chatMessages(admin, job, creds, chat.chat_id)).filter(
    (m) =>
      m.id &&
      !isContentlessPlaceholder(m) &&
      // Newer than the job: the live webhooks own it.
      (typeof m.timestamp !== 'number' || m.timestamp < startedAtSec),
  )

  const now = new Date().toISOString()
  const rows = history.map((m) => {
    const mapped = mapOpenWaMessage(m)
    const at = typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : now
    return {
      conversation_id: conversationId,
      sender_type: m.fromMe ? 'agent' : 'customer',
      content_type: mapped.contentType,
      content_text: mapped.contentText,
      content_meta: mapped.meta,
      media_url: mapped.hasMedia ? openWaMediaProxyUrl(chat.chat_id, m.id!) : null,
      media_type: mapped.hasMedia ? (m.media?.mimetype ?? null) : null,
      message_id: m.id!,
      status: m.fromMe ? 'sent' : 'delivered',
      created_at: at,
      revoked_at: mapped.revoked ? at : null,
      imported_at: now,
      ingest_completed_at: now,
    }
  })

  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { data, error } = await admin
      .from('messages')
      .upsert(rows.slice(i, i + INSERT_BATCH), { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw new HistoryStoreError('messages', error)
    inserted += data?.length ?? 0
  }

  // Quotes: link replies to the quoted message when it is in the chat.
  const quoted = history.filter((m) => m.quotedMessage?.id)
  if (quoted.length) {
    const ids = [...new Set(quoted.map((m) => m.quotedMessage!.id!))]
    const { data: targets } = await admin
      .from('messages')
      .select('id, message_id')
      .eq('conversation_id', conversationId)
      .in('message_id', ids)
    const byProvider = new Map((targets ?? []).map((t: { id: string; message_id: string }) => [t.message_id, t.id]))
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
  const newest = rows.reduce<(typeof rows)[number] | null>(
    (a, b) => (!a || b.created_at > a.created_at ? b : a),
    null,
  )
  if (newest) {
    const { data: current } = await admin
      .from('conversations')
      .select('last_message_at')
      .eq('id', conversationId)
      .maybeSingle()
    const currentAt = (current as { last_message_at?: string | null } | null)?.last_message_at
    if (!currentAt || Date.parse(currentAt) < Date.parse(newest.created_at)) {
      const { error } = await admin
        .from('conversations')
        .update({
          last_message_text: previewFor(newest.content_type, newest.content_meta, newest.content_text),
          last_message_at: newest.created_at,
          ...(conv.created || !currentAt ? { unread_count: chat.unread_count } : {}),
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
 * Run due import jobs until `deadline` (epoch ms). Called by the
 * settings route right after a start, after a QR connect, and by the
 * existing cron (safety net and continuation).
 */
export async function runHistoryImport(
  admin: SupabaseClient,
  opts: { accountId?: string; deadline: number; now?: () => number; pauseMs?: number },
): Promise<HistoryImportJob | null> {
  const now = opts.now ?? Date.now
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
    return { ...job, status: 'failed' }
  }
  const creds = requireOpenWaGateway()

  try {
    if (job.status === 'queued' || job.status === 'listing' || job.status === 'waiting_session') {
      await updateJob(admin, job.account_id, { status: 'listing' })
      const total = await listChats(admin, job, creds)
      job.status = 'importing'
      await updateJob(admin, job.account_id, { status: 'importing', chats_total: total })
    }

    while (now() < opts.deadline) {
      const { data: next, error: nextErr } = await admin
        .from('whatsapp_history_import_chats')
        .select('account_id, chat_id, name, unread_count, chat_timestamp, attempts')
        .eq('account_id', job.account_id)
        .eq('status', 'pending')
        .order('chat_timestamp', { ascending: false })
        .limit(1)
      if (nextErr) throw new HistoryStoreError('next chat', nextErr)
      const chat = (next ?? [])[0] as ChatRow | undefined
      if (!chat) {
        await updateJob(admin, job.account_id, { status: 'done', finished_at: new Date().toISOString(), lease_until: null })
        return { ...job, status: 'done' }
      }
      try {
        const n = await importChat(admin, job, row, creds, chat)
        if (n === null) {
          job.chats_skipped++
          await admin.from('whatsapp_history_import_chats')
            .update({ status: 'skipped', error: 'no phone number for this chat', updated_at: new Date().toISOString() })
            .eq('account_id', job.account_id).eq('chat_id', chat.chat_id)
        } else {
          job.chats_done++
          job.messages_imported += n
        }
      } catch (err) {
        if (sessionNotReady(err)) throw err
        if (err instanceof HistoryStoreError) throw err
        job.errors++
        const message = err instanceof Error ? err.message : String(err)
        await admin.from('whatsapp_history_import_chats')
          .update({
            status: chat.attempts + 1 >= MAX_CHAT_ATTEMPTS ? 'failed' : 'pending',
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
    // Out of time: the cron continues from the checkpoint.
    await updateJob(admin, job.account_id, { lease_until: null, next_run_at: new Date().toISOString() })
    return job
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (sessionNotReady(err)) {
      await updateJob(admin, job.account_id, {
        status: 'waiting_session',
        last_error: message.slice(0, 300),
        lease_until: null,
        next_run_at: new Date(now() + 2 * 60_000).toISOString(),
      })
      return { ...job, status: 'waiting_session' }
    }
    await updateJob(admin, job.account_id, {
      last_error: message.slice(0, 300),
      lease_until: null,
      next_run_at: new Date(now() + 5 * 60_000).toISOString(),
    }).catch(() => undefined)
    throw err
  }
}
