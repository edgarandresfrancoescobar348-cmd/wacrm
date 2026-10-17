// Mirrors the phone's chat list onto the QR-code inbox (phase 5e):
// archived, pinned, each chat's unread count, a group's name, and the
// name the phone shows for a contact (contact-name.ts). The gateway sends
// no webhook for archiving, pinning or reading on the phone, so the
// scheduler tick runs this (≤ once a minute per QR number), paced under
// the gateway's rate limit like the history import.
//
// Only the number's own conversations that already exist and know their
// chat id are touched; new chats arrive through the webhooks / the
// history import. A personal number's address-book name goes to the
// conversation (`saved_name`), never to the shared CRM contact (phase 6).

import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchAllPages } from '@/lib/supabase/paged-query'

import { contactNamePatch, nameFromWhatsApp } from '@/lib/whatsapp/contact-name'
import { listOpenWaChats, type OpenWaChatSummary } from './client'
import { openWaGateway } from './gateway'

const SYNC_EVERY_MS = 55_000
const PAGE = 100
const MAX_PAGES = 20
const lastSync = new Map<string, number>()

/** Test hook. */
export function __resetChatStateSyncForTests() {
  lastSync.clear()
}

interface ConversationState {
  id: string
  wa_chat_id: string
  is_group: boolean
  archived: boolean
  pinned_at: string | null
  unread_count: number | null
  group_name: string | null
  wa_sort_at?: string | null
  saved_name?: string | null
  contact: { id: string; name: string | null; name_source: string | null; push_name: string | null } | null
}

/** The column changes that make a conversation match its chat on the phone. */
export function chatStatePatch(conv: ConversationState, chat: OpenWaChatSummary, now: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (Boolean(chat.archived) !== conv.archived) patch.archived = Boolean(chat.archived)
  if (chat.pinned && !conv.pinned_at) patch.pinned_at = now
  if (!chat.pinned && conv.pinned_at) patch.pinned_at = null
  const unread = Math.max(0, chat.unreadCount ?? 0)
  if (unread !== (conv.unread_count ?? 0)) patch.unread_count = unread
  if (conv.is_group && chat.name && chat.name !== conv.group_name) patch.group_name = chat.name
  // The phone's order (phase 5f): WhatsApp's chat timestamp.
  if (chat.timestamp && chat.timestamp > 0) {
    const at = new Date(chat.timestamp * 1000).toISOString()
    if (Date.parse(conv.wa_sort_at ?? '') !== Date.parse(at)) patch.wa_sort_at = at
  }
  return patch
}

/** One QR number: read its chat list, write what changed. Returns rows changed. */
export async function syncAccountChatState(
  admin: SupabaseClient,
  args: {
    accountId: string
    connectionId: string
    /** A personal number: the phone's name for a contact stays on the conversation. */
    personal?: boolean
    sessionId: string
    deadline: number
    now?: () => number
  },
): Promise<number> {
  const gateway = openWaGateway()
  if (!gateway) return 0
  const now = args.now ?? Date.now
  const chats = new Map<string, OpenWaChatSummary>()
  for (let page = 0; page < MAX_PAGES && now() < args.deadline - 5_000; page++) {
    const batch = await listOpenWaChats(gateway, args.sessionId, { limit: PAGE, offset: page * PAGE }, { timeoutMs: 30_000 })
    for (const c of batch ?? []) chats.set(c.id, c)
    if (!batch || batch.length < PAGE) break
  }
  if (!chats.size) return 0

  // Every page: one select stops at PostgREST's max_rows (1000) — the
  // real account has 1401 chats, and the rest never synced (phase 5g).
  let data: unknown[]
  try {
    data = await fetchAllPages((from, to) =>
      admin
        .from('conversations')
        .select('id, wa_chat_id, is_group, archived, pinned_at, unread_count, group_name, wa_sort_at, saved_name, contact:contacts(id, name, name_source, push_name)')
        .eq('connection_id', args.connectionId)
        .not('wa_chat_id', 'is', null)
        .order('id')
        .range(from, to),
    )
  } catch (error) {
    throw new Error(`chat state lookup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const stamp = new Date(now()).toISOString()
  let changed = 0
  for (const conv of data as unknown as ConversationState[]) {
    const chat = chats.get(conv.wa_chat_id)
    if (!chat) continue
    const patch = chatStatePatch(conv, chat, stamp)
    if (Object.keys(patch).length) {
      const { error: upErr } = await admin.from('conversations').update(patch).eq('id', conv.id).eq('account_id', args.accountId)
      if (!upErr) changed++
    }
    // The phone's name for the contact: the chat title is the address-book
    // name when the contact is saved (a renamed entry follows too).
    if (args.personal) {
      const saved = conv.is_group ? null : (nameFromWhatsApp({ chatTitle: chat.name })?.name ?? null)
      if (saved && saved !== conv.saved_name) {
        await admin.from('conversations').update({ saved_name: saved }).eq('id', conv.id).eq('account_id', args.accountId)
      }
    } else if (conv.contact && !conv.is_group) {
      const namePatch = contactNamePatch(conv.contact, nameFromWhatsApp({ chatTitle: chat.name }))
      if (namePatch) {
        await admin.from('contacts').update(namePatch).eq('id', conv.contact.id).eq('account_id', args.accountId)
      }
    }
  }
  return changed
}

/** Every connected QR number, each at most once per SYNC_EVERY_MS. Never throws. */
export async function syncOpenWaChatState(admin: SupabaseClient, opts: { deadline: number }): Promise<void> {
  if (!openWaGateway()) return
  const { data, error } = await admin
    .from('whatsapp_openwa_config')
    .select('account_id, connection_id, session_id, status')
    .eq('status', 'ready')
    .not('session_id', 'is', null)
  if (error) {
    console.error('[chat state] numbers lookup failed:', error.message)
    return
  }
  const rows = (data ?? []) as { account_id: string; connection_id: string; session_id: string }[]
  const scopes = new Map<string, string>()
  if (rows.length) {
    const { data: numbers } = await admin
      .from('whatsapp_connections')
      .select('id, scope')
      .in('id', rows.map((r) => r.connection_id))
    for (const n of (numbers ?? []) as { id: string; scope: string }[]) scopes.set(n.id, n.scope)
  }
  for (const row of rows) {
    if (Date.now() >= opts.deadline) return
    if (Date.now() - (lastSync.get(row.connection_id) ?? 0) < SYNC_EVERY_MS) continue
    lastSync.set(row.connection_id, Date.now())
    try {
      const changed = await syncAccountChatState(admin, {
        accountId: row.account_id,
        connectionId: row.connection_id,
        personal: scopes.get(row.connection_id) === 'personal',
        sessionId: row.session_id,
        deadline: opts.deadline,
      })
      if (changed) console.info(`[chat state] ${row.connection_id.slice(0, 8)}: ${changed} conversations follow the phone`)
    } catch (err) {
      console.warn(`[chat state] ${row.connection_id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`)
    }
  }
}
