// ============================================================
// POST /api/whatsapp/broadcast/[id]/finalize — the dashboard wizard's
// last step. The wizard drives the first pass from the browser; recipients
// whose send attempt is still open (the gateway is still running it, or
// its outcome is being established) are finished by the server. This
// settles the status from the recipient rows and, when work is left,
// schedules the automatic continuation (broadcast-continue.ts) instead
// of the wizard writing a final status over it.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { finalizeBroadcastStatus, scheduleContinuation } from '@/lib/whatsapp/broadcast-core'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const { data: broadcast, error } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !broadcast) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })

    const admin = supabaseAdmin()
    const finished = await finalizeBroadcastStatus(admin, id)
    if (!finished) await scheduleContinuation(admin, id, Date.now())
    return NextResponse.json({ success: true, finished })
  } catch (error) {
    console.error('Error in broadcast finalize POST:', error)
    return toErrorResponse(error)
  }
}
