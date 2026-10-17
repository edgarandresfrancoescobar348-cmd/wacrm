// ============================================================
// A personal number's media (phase 6).
//
// chat-media is a PUBLIC bucket: its URLs bypass RLS. A personal
// number's files — received and sent — go to the PRIVATE bucket
// chat-media-private instead, under `connection-<id>/…`, which storage
// RLS lets only the number's owner read (migration 073). The message row
// stores `privateMediaUrl(path)`, an app route that downloads the file
// with the viewer's own session; a send hands the provider a short-lived
// signed link instead.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const PRIVATE_MEDIA_BUCKET = 'chat-media-private'

const ROUTE = '/api/whatsapp/media/private?path='

export function privateMediaPath(connectionId: string, objectName: string): string {
  return `connection-${connectionId}/${objectName}`
}

export function privateMediaUrl(path: string): string {
  return `${ROUTE}${encodeURIComponent(path)}`
}

/** The storage path of a private media URL, or null for any other URL. */
export function privateMediaPathOf(url: string | null | undefined): string | null {
  if (!url?.startsWith(ROUTE)) return null
  try {
    return decodeURIComponent(url.slice(ROUTE.length))
  } catch {
    return null
  }
}

/** How long the provider has to fetch a private file it is sending. */
const SEND_LINK_SECONDS = 15 * 60

/**
 * The link a provider fetches to send `mediaUrl`: a short-lived signed
 * URL for a private file (service role), the URL itself otherwise.
 */
export async function sendableMediaLink(admin: SupabaseClient, mediaUrl: string): Promise<string> {
  const path = privateMediaPathOf(mediaUrl)
  if (!path) return mediaUrl
  const { data, error } = await admin.storage.from(PRIVATE_MEDIA_BUCKET).createSignedUrl(path, SEND_LINK_SECONDS)
  if (error || !data?.signedUrl) throw new Error(`could not sign the media link: ${error?.message ?? 'no url'}`)
  return data.signedUrl
}
