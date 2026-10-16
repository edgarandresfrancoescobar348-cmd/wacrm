// GET /api/whatsapp/openwa/media?chat=<chatId>&id=<messageId>
//
// Streams an inbound attachment from the account's OpenWA gateway. Used
// only when the media mirror is off (or failed) — mirrored media has a
// durable storage URL. Any member of the account may read it, the same
// audience as the conversation itself; the message must be one of the
// account's rows pointing at exactly this proxy URL, so the route can't
// be used to pull arbitrary media off the number.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { untrustedMediaHeaders } from '@/lib/media/safe-inline'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { downloadOpenWaMedia, OpenWaError } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { openWaMediaProxyUrl } from '@/lib/whatsapp/openwa/events'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const chatId = url.searchParams.get('chat') ?? ''
    const messageId = url.searchParams.get('id') ?? ''
    if (!/^[\w.:-]+@[\w.]+$/.test(chatId) || !messageId || messageId.length > 200) {
      return NextResponse.json({ error: 'Invalid media reference' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: owned } = await admin
      .from('messages')
      .select('id, media_type, conversations!inner(account_id)')
      .eq('message_id', messageId)
      .eq('media_url', openWaMediaProxyUrl(chatId, messageId))
      .eq('conversations.account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const row = await loadOpenWaRow(admin, accountId)
    if (!row?.session_id) {
      return NextResponse.json({ error: 'WhatsApp (QR Code) not connected' }, { status: 400 })
    }

    const { bytes, mimeType } = await downloadOpenWaMedia(
      requireOpenWaGateway(),
      row.session_id,
      chatId,
      messageId,
    )
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
        { status: err.status === 404 ? 404 : 502 },
      )
    }
    return toErrorResponse(err)
  }
}
