// GET /api/whatsapp/openwa/media?chat=<chatId>&id=<messageId>
//
// Streams an attachment from the account's OpenWA gateway — live media
// when the mirror is off (or failed), and imported history media, which
// the gateway downloads from WhatsApp on first open (phase 5d). Once
// served, the bytes are mirrored into storage when the account keeps a
// copy of received media, so the next open doesn't go to WhatsApp. When
// WhatsApp no longer has the file (gateway 410) the message is marked
// `media_expired_at` and the bubble says so. Whoever can read the
// conversation may read it: the message is looked up with the caller's
// own client, so RLS decides (a personal number's media is its owner's
// alone, migration 086) and it must point at exactly this proxy URL, so
// the route can't be used to pull arbitrary media off the number. A
// personal number's copy goes to the private bucket.

import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { untrustedMediaHeaders } from '@/lib/media/safe-inline'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { downloadOpenWaMedia, OpenWaError } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { mirrorMediaId, openWaMediaProxyUrl } from '@/lib/whatsapp/openwa/events'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { loadConnection } from '@/lib/whatsapp/connections'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const chatId = url.searchParams.get('chat') ?? ''
    const messageId = url.searchParams.get('id') ?? ''
    if (!/^[\w.:-]+@[\w.]+$/.test(chatId) || !messageId || messageId.length > 200) {
      return NextResponse.json({ error: 'Invalid media reference' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: owned } = await supabase
      .from('messages')
      .select('id, media_type, conversations!inner(account_id, connection_id)')
      .eq('message_id', messageId)
      .eq('media_url', openWaMediaProxyUrl(chatId, messageId))
      .eq('conversations.account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const connectionId = (owned.conversations as unknown as { connection_id: string }).connection_id

    const row = await loadOpenWaRow(admin, connectionId)
    if (!row?.session_id) {
      return NextResponse.json({ error: 'WhatsApp (QR Code) not connected' }, { status: 400 })
    }

    let fetched: Awaited<ReturnType<typeof downloadOpenWaMedia>>
    try {
      fetched = await downloadOpenWaMedia(requireOpenWaGateway(), row.session_id, chatId, messageId)
    } catch (err) {
      if (err instanceof OpenWaError && err.status === 410) {
        // WhatsApp no longer has it: say so on the bubble, for good.
        await admin.from('messages').update({ media_expired_at: new Date().toISOString() }).eq('id', owned.id)
        return NextResponse.json({ error: 'Media expired on WhatsApp', code: 'media_expired' }, { status: 410 })
      }
      throw err
    }
    const { bytes, mimeType } = fetched

    // Keep a copy, like live media (the number's mirror_inbound_media):
    // the next open is a storage URL, not a trip to WhatsApp.
    after(async () => {
      try {
        const number = await loadConnection(admin, connectionId)
        if (!number || !number.mirrorInboundMedia) return
        const mirrored = await mirrorInboundMedia({
          privateTo: number.scope === 'personal' ? { connectionId } : null,
          storage: admin.storage,
          accountId,
          mediaId: mirrorMediaId(messageId),
          downloadUrl: 'openwa',
          accessToken: '',
          mimeType: owned.media_type || mimeType,
          fileSize: bytes.byteLength,
          download: async () => ({
            buffer: Buffer.from(bytes),
            contentType: owned.media_type || mimeType || 'application/octet-stream',
          }),
        })
        if (mirrored) {
          await admin
            .from('messages')
            .update({ media_url: mirrored })
            .eq('id', owned.id)
            .eq('media_url', openWaMediaProxyUrl(chatId, messageId))
        }
      } catch (err) {
        console.error('[openwa media] mirror after first open failed:', err instanceof Error ? err.message : err)
      }
    })

    // The bytes are whatever a WhatsApp sender sent: only inert types render inline;
    // anything else downloads, sandboxed (see untrustedMediaHeaders).
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: untrustedMediaHeaders(owned.media_type || mimeType, 'whatsapp-media'),
    })
  } catch (err) {
    if (err instanceof OpenWaError) {
      return NextResponse.json(
        { error: 'Media unavailable on the gateway' },
        { status: err.status === 404 ? 404 : err.status === 413 ? 413 : 502 },
      )
    }
    return toErrorResponse(err)
  }
}
