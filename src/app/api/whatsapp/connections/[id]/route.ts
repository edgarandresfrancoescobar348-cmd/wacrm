// /api/whatsapp/connections/[id] — one WhatsApp number (phase 6).
//
//   PATCH  { label?, mirror_inbound_media? } — who may operate it
//          (a business number's admins, a personal number's owner).
//   DELETE — remove it: unlink the session / drop the credentials and
//          mark it removed; its conversations stay as history. Who may
//          operate it, plus an admin on a personal number (a member
//          leaving) — without ever seeing its chats.

import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { removeConnection } from '@/lib/whatsapp/connection-admin'
import { requireConnection } from '@/lib/whatsapp/connection-access'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { ctx, connection } = await requireConnection(id, 'operate')
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    const body = (await request.json().catch(() => ({}))) as { label?: unknown; mirror_inbound_media?: unknown }
    const patch: Record<string, unknown> = {}
    if ('label' in body) {
      if (body.label !== null && typeof body.label !== 'string') {
        return NextResponse.json({ error: 'label must be a string or null', field: 'label' }, { status: 400 })
      }
      patch.label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : null
    }
    if ('mirror_inbound_media' in body) {
      if (typeof body.mirror_inbound_media !== 'boolean') {
        return NextResponse.json({ error: 'mirror_inbound_media must be a boolean', field: 'mirror_inbound_media' }, { status: 400 })
      }
      patch.mirror_inbound_media = body.mirror_inbound_media
    }
    if (!Object.keys(patch).length) return NextResponse.json({ success: true })
    const { error } = await supabaseAdmin().from('whatsapp_connections').update(patch).eq('id', connection.id)
    if (error) {
      console.error('[numbers] update failed:', error.message)
      return NextResponse.json({ error: 'Failed to save the number' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { ctx, connection } = await requireConnection(id, 'disconnect')
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    if (connection.removedAt) return NextResponse.json({ success: true })
    await removeConnection(supabaseAdmin(), connection)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
