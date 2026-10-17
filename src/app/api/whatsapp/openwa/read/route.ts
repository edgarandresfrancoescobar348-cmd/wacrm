// POST /api/whatsapp/openwa/read { conversation_id }
//
// Reading a QR-code conversation in wacrm marks the chat read on the
// phone too (phase 5e) — otherwise the chat-state sync would bring the
// phone's unread count straight back. Anyone who can read the
// conversation: it is read with the caller's own client, so RLS decides
// (a personal number's chat is its owner's alone, migration 073).
// Best-effort: answers 204 whether or not the gateway took it.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { openWaMarkRead } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { openWaGateway } from '@/lib/whatsapp/openwa/gateway'

export async function POST(request: Request) {
  try {
    const { supabase } = await requireRole('viewer')
    const body = (await request.json().catch(() => null)) as { conversation_id?: unknown } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }
    const { data: conv } = await supabase
      .from('conversations')
      .select('wa_chat_id, connection_id')
      .eq('id', conversationId)
      .maybeSingle()
    const found = conv as { wa_chat_id?: string | null; connection_id?: string } | null
    const chatId = found?.wa_chat_id
    const gateway = openWaGateway()
    if (chatId && found?.connection_id && gateway) {
      const row = await loadOpenWaRow(supabaseAdmin(), found.connection_id)
      if (row?.session_id && row.status === 'ready') {
        await openWaMarkRead(gateway, row.session_id, { chatId }).catch((err) =>
          console.warn('[openwa] mark read on the phone failed:', err instanceof Error ? err.message : err),
        )
      }
    }
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
