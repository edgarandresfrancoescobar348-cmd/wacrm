// Re-importing a chat refreshes the messages already stored (phase 5f):
// the history keeps WhatsApp's newer view of them — the ticks went up, the
// forwarded flag, the media details the first import didn't have — and a
// "waiting for this message" placeholder becomes the real message once
// WhatsApp has delivered it. Monotonic and conservative: a status never
// goes down, a failed send is left alone, and text that was edited or
// deleted here is never touched.

import type { ContentMeta } from '@/lib/whatsapp/message-content'

/** sent < delivered < read; `sending` below them; `failed` is never moved. */
const STATUS_RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 }

export interface StoredMessageState {
  id: string
  sender_type: string
  status: string
  content_meta: ContentMeta | null
  is_forwarded: boolean | null
  forwarding_score: number | null
  media_meta: object | null
}

export interface IncomingMessageRow {
  sender_type: string
  status: string
  content_type: string
  content_text: string | null
  content_meta: ContentMeta | null
  media_url: string | null
  media_type: string | null
  revoked_at: string | null
  is_forwarded?: boolean
  forwarding_score?: number | null
  media_meta?: object | null
  sender_wa_id?: string | null
  sender_name?: string | null
}

export const isWaiting = (meta: ContentMeta | null | undefined): boolean => meta?.kind === 'waiting'

/** The columns to update on a stored message, or null when nothing changes. */
export function refreshPatch(existing: StoredMessageState, incoming: IncomingMessageRow): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // The placeholder's content arrived: the real message replaces it.
  if (isWaiting(existing.content_meta) && !isWaiting(incoming.content_meta)) {
    Object.assign(patch, {
      content_type: incoming.content_type,
      content_text: incoming.content_text,
      content_meta: incoming.content_meta,
      media_url: incoming.media_url,
      media_type: incoming.media_type,
      revoked_at: incoming.revoked_at,
      ...(incoming.sender_wa_id !== undefined ? { sender_wa_id: incoming.sender_wa_id } : {}),
      ...(incoming.sender_name !== undefined ? { sender_name: incoming.sender_name } : {}),
    })
  }

  // Ticks only go up, and only on what you sent.
  const own = existing.sender_type === 'agent' || existing.sender_type === 'bot'
  if (own && existing.status in STATUS_RANK && incoming.status in STATUS_RANK) {
    if (STATUS_RANK[incoming.status] > STATUS_RANK[existing.status]) patch.status = incoming.status
  }

  if (incoming.is_forwarded && !existing.is_forwarded) patch.is_forwarded = true
  if ((incoming.forwarding_score ?? 0) > (existing.forwarding_score ?? 0)) patch.forwarding_score = incoming.forwarding_score

  // Media details: fill what is missing, keep what is known (and "played").
  if (incoming.media_meta && Object.keys(incoming.media_meta).length) {
    const current = (existing.media_meta ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...current }
    for (const [k, v] of Object.entries(incoming.media_meta as Record<string, unknown>)) {
      if (v === null || v === undefined) continue
      if (k === 'played') merged.played = Boolean(current.played) || Boolean(v)
      else if (current[k] === null || current[k] === undefined) merged[k] = v
    }
    if (JSON.stringify(merged) !== JSON.stringify(current)) patch.media_meta = merged
  }

  return Object.keys(patch).length ? patch : null
}
