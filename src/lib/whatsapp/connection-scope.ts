// ============================================================
// A number changes between Empresa and Pessoal (phase 6b). Server only,
// service role.
//
// The database does the change in one transaction under the number's lock
// (set_connection_scope, migration 076): scope and owner, who may,
// contacts.personal_only both ways, and on Empresa → Pessoal assignments
// to others, flow runs, pending automation executions, broadcasts and
// bound automations, plus the audit row.
//
// Media — the choice: a business number's files live in the PUBLIC bucket
// chat-media (their URLs bypass RLS); a personal number's in the PRIVATE
// one, chat-media-private, under `connection-<id>/…`, read by whoever sees
// the number (storage RLS on visible_connection_ids(), 073). So:
//   * Empresa → Pessoal moves the number's public files to the private
//     bucket and rewrites the messages' links; the public object is
//     deleted, so the old public link stops serving it. A file another
//     number's message still points at (a broadcast's image) is copied,
//     not moved — the other conversation keeps it.
//     The move runs right after the answer (a number with thousands of
//     files would time the request out); `media_private_pending` stays set
//     until every link is moved, and listing the numbers retries it (it is
//     idempotent).
//   * Pessoal → Empresa moves nothing: the private files become the
//     team's through the same storage RLS the moment the number does.
// The account's default business number is computed (072's
// default_business_connection: business numbers only), so a number that
// becomes personal leaves that role by itself.
//
// Open screens: everyone of the account gets a realtime broadcast on
// `numbers:<accountId>` ("changed", no data) and re-reads its numbers and
// conversations; RLS does the rest.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { MIRROR_BUCKET } from './mirror-inbound-media'
import { PRIVATE_MEDIA_BUCKET, privateMediaPath, privateMediaUrl } from './private-media'
import type { ConnectionScope, WaConnection } from './connections'

/** What set_connection_scope reports (the audit row keeps the same). */
export interface ScopeChange {
  changed: boolean
  scope: ConnectionScope
  owner_user_id: string | null
  contacts_changed?: number
  unassigned?: number
  flow_runs_ended?: number
  automation_executions_superseded?: number
  broadcasts_failed?: number
  automations_unbound?: number
  public_media?: number
}

export class ScopeChangeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message)
    this.name = 'ScopeChangeError'
  }
}

/** The account's realtime topic for "a number changed": no data on it. */
export const numbersTopic = (accountId: string) => `numbers:${accountId}`

export async function changeConnectionScope(
  admin: SupabaseClient,
  connection: WaConnection,
  args: { scope: ConnectionScope; ownerUserId: string | null; actorUserId: string },
): Promise<ScopeChange> {
  const { data, error } = await admin.rpc('set_connection_scope', {
    p_connection_id: connection.id,
    p_scope: args.scope,
    p_owner_user_id: args.ownerUserId,
    p_actor_user_id: args.actorUserId,
  })
  if (error) throw scopeError(error)
  const result = data as ScopeChange
  if (result.changed) await announceNumbersChanged(admin, connection.accountId)
  return result
}

function scopeError(error: { code?: string; message: string }): Error {
  if (error.code === '42501') return new ScopeChangeError(error.message, 403)
  if (error.code === 'P0002') return new ScopeChangeError(error.message, 404)
  if (error.code === '23514') return new ScopeChangeError(error.message, 400)
  return new Error(`Failed to change the number's scope: ${error.message}`)
}

const PUBLIC_MARK = `/storage/v1/object/public/${MIRROR_BUCKET}/`
const PAGE = 200

/** The object name inside chat-media of a public URL, or null. */
export function publicMediaObject(url: string | null | undefined): string | null {
  if (!url) return null
  const at = url.indexOf(PUBLIC_MARK)
  if (at < 0) return null
  const name = url.slice(at + PUBLIC_MARK.length).split('?')[0]
  try {
    return decodeURIComponent(name)
  } catch {
    return null
  }
}

/**
 * Move a personal number's files out of the public bucket (see the head
 * comment). Returns how many links now point at the private bucket;
 * clears `media_private_pending` when none is left. Safe to run again.
 */
export async function movePublicMediaPrivate(admin: SupabaseClient, connectionId: string): Promise<number> {
  const { data: convs, error: convErr } = await admin
    .from('conversations')
    .select('id')
    .eq('connection_id', connectionId)
  if (convErr) throw new Error(`media move: ${convErr.message}`)
  const ids = ((convs ?? []) as { id: string }[]).map((c) => c.id)
  let moved = 0
  let left = 0
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50)
    for (;;) {
      const { data: rows, error } = await admin
        .from('messages')
        .select('id, media_url')
        .in('conversation_id', slice)
        .like('media_url', `%${PUBLIC_MARK}%`)
        .limit(PAGE)
      if (error) throw new Error(`media move: ${error.message}`)
      const batch = (rows ?? []) as { id: string; media_url: string }[]
      if (!batch.length) break
      let progressed = false
      for (const row of batch) {
        const ok = await moveOne(admin, connectionId, row)
        if (ok) {
          moved++
          progressed = true
        } else left++
      }
      // A page where nothing moved would come back the same: stop here
      // and leave the flag set for a retry.
      if (!progressed || batch.length < PAGE) break
    }
  }
  if (!left) {
    await admin.from('whatsapp_connections').update({ media_private_pending: false }).eq('id', connectionId)
  }
  return moved
}

async function moveOne(
  admin: SupabaseClient,
  connectionId: string,
  row: { id: string; media_url: string },
): Promise<boolean> {
  const name = publicMediaObject(row.media_url)
  if (!name) return false
  const target = privateMediaPath(connectionId, name)
  const download = await admin.storage.from(MIRROR_BUCKET).download(name)
  if (download.error || !download.data) {
    // Gone from the bucket already (moved by an earlier, interrupted run
    // — or never there): point at the private copy if it exists.
    const exists = await admin.storage.from(PRIVATE_MEDIA_BUCKET).createSignedUrl(target, 10)
    if (exists.error) {
      console.warn('[numbers] media move: missing file', name)
      return false
    }
  } else {
    const up = await admin.storage
      .from(PRIVATE_MEDIA_BUCKET)
      .upload(target, download.data, { upsert: true, contentType: download.data.type || undefined })
    if (up.error) {
      console.warn('[numbers] media move: upload failed', name, up.error.message)
      return false
    }
  }
  const { error } = await admin.from('messages').update({ media_url: privateMediaUrl(target) }).eq('id', row.id)
  if (error) {
    console.warn('[numbers] media move: link update failed', row.id, error.message)
    return false
  }
  // Delete the public object unless a message elsewhere still uses it.
  const { count } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('media_url', row.media_url)
  if (!count) await admin.storage.from(MIRROR_BUCKET).remove([name])
  return true
}

/** Tell the account's open screens to re-read numbers and conversations. */
export async function announceNumbersChanged(admin: SupabaseClient, accountId: string): Promise<void> {
  try {
    const channel = admin.channel(numbersTopic(accountId))
    await channel.httpSend('changed', {})
    await admin.removeChannel(channel)
  } catch (err) {
    // Best effort: the screens also re-read on their poll (CONNECTION_POLL_MS).
    console.warn('[numbers] change broadcast failed:', err instanceof Error ? err.message : err)
  }
}
